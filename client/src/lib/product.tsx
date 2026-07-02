// Catalog-driven app context, organized as CUSTOMER → SCHEMA(S). Customers are
// always isolated (never mix data across customers). Within a customer, one or
// more schema entries can be selected: a single schema = that schema alone;
// two-or-more = a COMBINED view that conforms shared dimensions (combineSchemas).
// The active dataset feeds the usual pipeline (buildCatalog → deriveProduct →
// enterprise graph → contracts). Retailer's single bundled schema keeps its
// CURATED catalog + live flagship; everything else is schema-derived.
import { createContext, useContext, useMemo, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import catalogJson from '../data/catalog.json';
import schemaJson from '../data/schema.json';
import schemaQsrJson from '../data/schema.qsr.json';
import {
  deriveProduct,
  buildEnterpriseGraph,
  type Catalog,
  type CatalogDomain,
  type CatalogProduct,
  type DerivedComponents,
  type EnterpriseGraph,
  type Schema,
} from './deriveComponents';
import { buildCatalog } from './catalogGen';
import { combineSchemas, type SchemaEntry, type ConformanceInfo } from './combineSchemas';

const DEFAULT_CATALOG = catalogJson as unknown as Catalog;
const DEFAULT_SCHEMA = schemaJson as unknown as Schema;
const QSR_SCHEMA = schemaQsrJson as unknown as Schema;

const DEFAULT_DOMAIN = 'store_operations_labor';
const DEFAULT_PRODUCT = 'jai_store_traffic_labor_efficiency';
const LS_KEY = 'rt_onto_selection';

// Fallback catalog for an empty/loading schema so downstream never sees an
// undefined domain/product (guards the lazy-load window for saved schemas).
const PLACEHOLDER_CATALOG: Catalog = {
  domains: [
    {
      name: 'loading',
      label: 'Loading…',
      description: 'Loading schema…',
      products: [
        {
          product_name: 'loading',
          display_name: 'Loading…',
          business_outcome: 'Loading schema content…',
          fact_tables: [],
          dim_tables: [],
          kpis: [],
          maturity: 'incubating',
        },
      ],
    },
  ],
};

export type CatalogSource = 'curated' | 'generated' | 'generated+llm' | 'combined' | 'combined+llm';

// customer registry entry
export type Customer = {
  id: string;
  label: string;
  schemas: SchemaEntry[];
  // built-in (non-removable) schema ids for this customer (the bundled ones)
  bundledSchemaIds?: string[];
  // whether this customer is a built-in (Retailer/QSR) — user-created ones are deletable
  builtin?: boolean;
  // when this customer's curated schema is the sole selection, use the curated
  // catalog (keeps the live flagship) instead of generating one
  curatedSchemaId?: string;
  curatedCatalog?: Catalog;
};

// saved-schema index row (from /api/saved-schemas)
export type SavedSchemaMeta = {
  schema_id: string;
  customer: string;
  schema_name: string;
  source: string;
  catalog_ref?: string;
  table_count?: number;
  created_by?: string;
  created_at?: string;
  volume_path?: string;
};

export type ProductContextValue = {
  // customer → schema(s)
  customers: Customer[];
  customerId: string;
  setCustomer: (id: string) => void;
  schemaEntries: SchemaEntry[]; // schemas in the selected customer
  selectedSchemaIds: string[];
  toggleSchema: (id: string) => void;
  setSelectedSchemas: (ids: string[]) => void;
  combineAll: () => void;
  combined: boolean;
  conformance: ConformanceInfo | null;
  catalogSource: CatalogSource;
  // add an uploaded/live schema to a customer (existing or new)
  addSchema: (customerLabelOrId: string, entry: SchemaEntry, isNewCustomer: boolean) => void;
  // customer management
  isBundledSchema: (customerId: string, schemaId: string) => boolean;
  removeSchema: (customerId: string, schemaId: string) => void;
  removeCustomer: (customerId: string) => void;
  resetCustomers: () => void;
  resetToDefault: () => void;
  // durable schema store (Delta + Volume)
  savedSchemas: SavedSchemaMeta[];
  refreshSavedSchemas: () => Promise<void>;
  saveSchema: (
    args: { customer: string; schemaName: string; source: string; catalogRef?: string; schema: Schema }
  ) => Promise<{ ok: boolean; error?: string }>;
  deleteSavedSchema: (schemaId: string) => Promise<void>;
  schema: Schema;
  catalog: Catalog;
  // product selection
  domains: CatalogDomain[];
  selectedDomain: CatalogDomain;
  setSelectedDomain: (name: string) => void;
  productsInDomain: CatalogProduct[];
  selectedProduct: CatalogProduct;
  setSelectedProduct: (name: string) => void;
  components: DerivedComponents;
  // enterprise map + highlight
  enterpriseGraph: EnterpriseGraph;
  enterpriseHighlight: Set<string>;
};

const ProductContext = createContext<ProductContextValue | null>(null);

// built-in customers (each starts with one bundled, non-removable schema entry)
function builtinCustomers(): Customer[] {
  return [
    {
      id: 'retailer',
      label: 'Retailer',
      builtin: true,
      bundledSchemaIds: ['fc_entdata_gold'],
      curatedSchemaId: 'fc_entdata_gold',
      curatedCatalog: DEFAULT_CATALOG,
      schemas: [{ id: 'fc_entdata_gold', label: 'fc_entdata_gold', schema: DEFAULT_SCHEMA }],
    },
    {
      id: 'qsr',
      label: 'QSR',
      builtin: true,
      bundledSchemaIds: ['qsr_scd'],
      schemas: [{ id: 'qsr_scd', label: 'QSR Supply Chain', schema: QSR_SCHEMA }],
    },
  ];
}

export function ProductProvider({ children }: { children: ReactNode }) {
  const [customers, setCustomers] = useState<Customer[]>(builtinCustomers);
  const [customerId, setCustomerId] = useState<string>('retailer');
  const [selectedSchemaIds, setSelectedSchemaIds] = useState<string[]>(['fc_entdata_gold']);

  // llm refinement result overlay (applied async, keyed by a signature)
  const [llmCatalog, setLlmCatalog] = useState<{ sig: string; catalog: Catalog } | null>(null);

  const [domainName, setDomainName] = useState<string>(DEFAULT_DOMAIN);
  const [productName, setProductName] = useState<string>(DEFAULT_PRODUCT);

  const customer = useMemo(
    () => customers.find((c) => c.id === customerId) ?? customers[0],
    [customers, customerId]
  );
  const schemaEntries = customer.schemas;
  const selected = useMemo(
    () => schemaEntries.filter((s) => selectedSchemaIds.includes(s.id)),
    [schemaEntries, selectedSchemaIds]
  );
  const combined = selected.length > 1;

  // ---- active schema (single or combined+conformed) ----
  const { schema, conformance } = useMemo(() => {
    if (selected.length === 0) {
      return { schema: schemaEntries[0]?.schema ?? {}, conformance: null };
    }
    if (selected.length === 1) return { schema: selected[0].schema, conformance: null };
    const r = combineSchemas(selected);
    return { schema: r.schema, conformance: r.info };
  }, [selected, schemaEntries]);

  // ---- active catalog: curated (single curated schema) else generated ----
  const isCuratedSingle =
    !combined &&
    customer.curatedCatalog != null &&
    selected.length === 1 &&
    selected[0].id === customer.curatedSchemaId;

  // signature of the current dataset (for the async LLM overlay match)
  const sig = `${customerId}|${[...selectedSchemaIds].sort().join(',')}`;

  const heuristicCatalog = useMemo(() => {
    if (isCuratedSingle) return customer.curatedCatalog as Catalog;
    const built = buildCatalog(schema);
    // Empty schema (e.g. a saved entry whose content is still lazy-loading, or an
    // empty selection) yields 0 domains — synthesize a placeholder so every section
    // has a defined domain/product and never crashes on undefined.fact_tables.
    if (built.domains.length === 0) return PLACEHOLDER_CATALOG;
    return built;
  }, [isCuratedSingle, customer, schema]);

  const catalog =
    !isCuratedSingle && llmCatalog && llmCatalog.sig === sig ? llmCatalog.catalog : heuristicCatalog;

  const catalogSource: CatalogSource = isCuratedSingle
    ? 'curated'
    : combined
      ? llmCatalog && llmCatalog.sig === sig
        ? 'combined+llm'
        : 'combined'
      : llmCatalog && llmCatalog.sig === sig
        ? 'generated+llm'
        : 'generated';

  const domains = catalog.domains;
  const selectedDomain = useMemo(
    () => domains.find((d) => d.name === domainName) ?? domains[0],
    [domains, domainName]
  );
  const productsInDomain = selectedDomain?.products ?? [];
  const selectedProduct = useMemo(
    () => productsInDomain.find((p) => p.product_name === productName) ?? productsInDomain[0],
    [productsInDomain, productName]
  );

  const setSelectedDomain = (name: string) => {
    const d = domains.find((x) => x.name === name) ?? domains[0];
    setDomainName(d.name);
    setProductName(d.products[0]?.product_name ?? '');
  };
  const setSelectedProduct = (name: string) => {
    const owning = domains.find((d) => d.products.some((p) => p.product_name === name));
    if (owning && owning.name !== domainName) setDomainName(owning.name);
    setProductName(name);
  };

  // point selection at the first domain/product of the active catalog
  const focusFirst = useCallback((c: Catalog, preferDomain?: string, preferProduct?: string) => {
    const d0 = (preferDomain && c.domains.find((d) => d.name === preferDomain)) || c.domains[0];
    setDomainName(d0?.name ?? '');
    const p0 =
      (preferProduct && d0?.products.find((p) => p.product_name === preferProduct)) || d0?.products[0];
    setProductName(p0?.product_name ?? '');
  }, []);

  // when the dataset (customer/selection) changes, refocus + kick async LLM refine
  useEffect(() => {
    focusFirst(
      heuristicCatalog,
      isCuratedSingle ? DEFAULT_DOMAIN : undefined,
      isCuratedSingle ? DEFAULT_PRODUCT : undefined
    );
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ customerId, selectedSchemaIds }));
    } catch {
      /* ignore */
    }
    if (isCuratedSingle) return; // curated catalog — no generation
    // best-effort LLM polish of the generated/combined catalog (graceful fallback)
    let cancelled = false;
    (async () => {
      try {
        const summary = Object.entries(schema)
          .map(([t, cols]) => `${t}: ${cols.slice(0, 8).map((c) => c.name).join(', ')}`)
          .join('\n')
          .slice(0, 12000);
        const resp = await fetch('/api/generate-catalog', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draft: heuristicCatalog, summary }),
        });
        const data = await resp.json();
        if (!cancelled && data?.llm && data?.catalog?.domains?.length) {
          setLlmCatalog({ sig, catalog: sanitizeCatalog(data.catalog as Catalog, schema) });
        }
      } catch {
        /* keep heuristic */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // ---- selectors ----
  const setCustomer = useCallback(
    (id: string) => {
      const c = customers.find((x) => x.id === id) ?? customers[0];
      setCustomerId(c.id);
      // default selection = the customer's first schema (curated stays curated)
      setSelectedSchemaIds(c.schemas[0] ? [c.schemas[0].id] : []);
    },
    [customers]
  );

  const toggleSchema = useCallback(
    (id: string) => {
      setSelectedSchemaIds((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
        return next.length ? next : [id]; // never empty
      });
    },
    []
  );
  const setSelectedSchemas = useCallback((ids: string[]) => {
    setSelectedSchemaIds(ids.length ? ids : []);
  }, []);
  const combineAll = useCallback(() => {
    setSelectedSchemaIds(customer.schemas.map((s) => s.id));
  }, [customer]);

  const addSchema = useCallback(
    (customerLabelOrId: string, entry: SchemaEntry, isNewCustomer: boolean) => {
      if (isNewCustomer) {
        const id = `cust_${customerLabelOrId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString(36)}`;
        const newCust: Customer = { id, label: customerLabelOrId, schemas: [entry] };
        setCustomers((prev) => [...prev, newCust]);
        setCustomerId(id);
        setSelectedSchemaIds([entry.id]);
      } else {
        setCustomers((prev) =>
          prev.map((c) =>
            c.id === customerLabelOrId ? { ...c, schemas: [...c.schemas, entry] } : c
          )
        );
        setCustomerId(customerLabelOrId);
        setSelectedSchemaIds([entry.id]);
      }
    },
    []
  );

  const resetToDefault = useCallback(() => {
    setCustomerId('retailer');
    setSelectedSchemaIds(['fc_entdata_gold']);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ customerId: 'retailer', selectedSchemaIds: ['fc_entdata_gold'] }));
    } catch {
      /* ignore */
    }
  }, []);

  // ---- customer management (remove schema / customer, reset all) ----
  const isBundledSchema = useCallback(
    (cid: string, sid: string) => {
      const c = customers.find((x) => x.id === cid);
      return Boolean(c?.bundledSchemaIds?.includes(sid));
    },
    [customers]
  );

  const removeSchema = useCallback(
    (cid: string, sid: string) => {
      const c = customers.find((x) => x.id === cid);
      if (!c) return;
      if (c.bundledSchemaIds?.includes(sid)) return; // bundled schema is not removable
      const remaining = c.schemas.filter((s) => s.id !== sid);
      // built-in customer must always keep at least its bundled schema
      if (remaining.length === 0 && c.builtin) return;
      if (remaining.length === 0 && !c.builtin) {
        // user-created customer with no schemas left → delete it, fall back to Retailer
        setCustomers((prev) => prev.filter((x) => x.id !== cid));
        setCustomerId('retailer');
        setSelectedSchemaIds(['fc_entdata_gold']);
        return;
      }
      setCustomers((prev) =>
        prev.map((x) => (x.id === cid ? { ...x, schemas: remaining } : x))
      );
      // if the removed schema was selected, drop it from the selection
      setSelectedSchemaIds((prev) => {
        const next = prev.filter((id) => id !== sid);
        return next.length ? next : [remaining[0].id];
      });
    },
    [customers]
  );

  const removeCustomer = useCallback(
    (cid: string) => {
      const c = customers.find((x) => x.id === cid);
      if (!c || c.builtin) return; // built-ins are not deletable
      setCustomers((prev) => prev.filter((x) => x.id !== cid));
      if (customerId === cid) {
        setCustomerId('retailer');
        setSelectedSchemaIds(['fc_entdata_gold']);
      }
    },
    [customers, customerId]
  );

  // clear persisted state and restore exactly Retailer + QSR with bundled schemas
  const resetCustomers = useCallback(() => {
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
    setCustomers(builtinCustomers());
    setCustomerId('retailer');
    setSelectedSchemaIds(['fc_entdata_gold']);
  }, []);

  // ---- durable schema store (Delta index + Volume content) ----
  const [savedSchemas, setSavedSchemas] = useState<SavedSchemaMeta[]>([]);

  // merge saved-schema index rows into the customer registry as (lazy) entries.
  // A saved schema belongs to a user customer keyed by its `customer` label.
  const mergeSaved = useCallback((rows: SavedSchemaMeta[]) => {
    setCustomers((prev) => {
      const next = prev.map((c) => ({ ...c, schemas: [...c.schemas] }));
      const byLabel = new Map(next.map((c) => [c.label.toLowerCase(), c] as const));
      for (const r of rows) {
        const entryId = `saved:${r.schema_id}`;
        // built-ins never receive saved schemas (isolation); use/create a user customer
        let cust = byLabel.get(r.customer.toLowerCase());
        if (cust && cust.builtin) cust = undefined;
        if (!cust) {
          cust = {
            id: `cust_${r.customer.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
            label: r.customer,
            schemas: [],
          };
          next.push(cust);
          byLabel.set(r.customer.toLowerCase(), cust);
        }
        if (!cust.schemas.some((s) => s.id === entryId)) {
          // lazy entry: empty schema until first selected (content in the volume)
          cust.schemas.push({
            id: entryId,
            label: `${r.schema_name} · saved`,
            schema: {},
            savedId: r.schema_id,
          });
        }
      }
      return next;
    });
  }, []);

  const refreshSavedSchemas = useCallback(async () => {
    try {
      const resp = await fetch('/api/saved-schemas');
      const data = await resp.json();
      const rows: SavedSchemaMeta[] = Array.isArray(data?.schemas) ? data.schemas : [];
      setSavedSchemas(rows);
      mergeSaved(rows);
    } catch {
      /* store unavailable — app still works without it */
    }
  }, [mergeSaved]);

  const saveSchema = useCallback(
    async (args: {
      customer: string;
      schemaName: string;
      source: string;
      catalogRef?: string;
      schema: Schema;
    }) => {
      try {
        const resp = await fetch('/api/save-schema', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
        });
        const data = await resp.json();
        if (!data?.ok) return { ok: false, error: data?.error ?? 'save failed' };
        await refreshSavedSchemas();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [refreshSavedSchemas]
  );

  const deleteSavedSchema = useCallback(
    async (schemaId: string) => {
      try {
        await fetch('/api/delete-saved-schema', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schema_id: schemaId }),
        });
      } catch {
        /* ignore */
      }
      const entryId = `saved:${schemaId}`;
      setCustomers((prev) =>
        prev
          .map((c) => ({ ...c, schemas: c.schemas.filter((s) => s.id !== entryId) }))
          // drop user customers left empty
          .filter((c) => c.builtin || c.schemas.length > 0)
      );
      setSelectedSchemaIds((prev) => prev.filter((id) => id !== entryId));
      setSavedSchemas((prev) => prev.filter((s) => s.schema_id !== schemaId));
    },
    []
  );

  // lazily fetch content for a selected saved entry that hasn't loaded yet
  useEffect(() => {
    const lazy = customer.schemas.filter(
      (s) => s.savedId && selectedSchemaIds.includes(s.id) && Object.keys(s.schema).length === 0
    );
    if (lazy.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const entry of lazy) {
        try {
          const resp = await fetch(`/api/saved-schema/${entry.savedId}`);
          const data = await resp.json();
          if (cancelled || !data?.schema) continue;
          setCustomers((prev) =>
            prev.map((c) =>
              c.id === customer.id
                ? { ...c, schemas: c.schemas.map((s) => (s.id === entry.id ? { ...s, schema: data.schema } : s)) }
                : c
            )
          );
        } catch {
          /* leave empty; section will render an empty catalog gracefully */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customer, selectedSchemaIds]);

  // load saved schemas once on startup
  useEffect(() => {
    void refreshSavedSchemas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // restore persisted selection on first load (default = Retailer / its schema)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { customerId?: string; selectedSchemaIds?: string[] };
        const c = builtinCustomers().find((x) => x.id === p.customerId);
        if (c && p.selectedSchemaIds?.length) {
          const valid = p.selectedSchemaIds.filter((id) => c.schemas.some((s) => s.id === id));
          if (valid.length) {
            setCustomerId(c.id);
            setSelectedSchemaIds(valid);
          }
        }
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- derived artifacts ----
  const components = useMemo(() => deriveProduct(selectedProduct, schema), [selectedProduct, schema]);
  const enterpriseGraph = useMemo(
    () => buildEnterpriseGraph(catalog, schema, conformance?.conformedTables),
    [catalog, schema, conformance]
  );
  const enterpriseHighlight = useMemo(
    () =>
      selectedDomain && selectedProduct
        ? enterpriseGraph.highlightFor(selectedDomain.name, selectedProduct.product_name)
        : new Set<string>(),
    [enterpriseGraph, selectedDomain, selectedProduct]
  );

  const value: ProductContextValue = {
    customers,
    customerId,
    setCustomer,
    schemaEntries,
    selectedSchemaIds,
    toggleSchema,
    setSelectedSchemas,
    combineAll,
    combined,
    conformance,
    catalogSource,
    addSchema,
    isBundledSchema,
    removeSchema,
    removeCustomer,
    resetCustomers,
    resetToDefault,
    savedSchemas,
    refreshSavedSchemas,
    saveSchema,
    deleteSavedSchema,
    schema,
    catalog,
    domains,
    selectedDomain,
    setSelectedDomain,
    productsInDomain,
    selectedProduct,
    setSelectedProduct,
    components,
    enterpriseGraph,
    enterpriseHighlight,
  };

  return <ProductContext.Provider value={value}>{children}</ProductContext.Provider>;
}

export function useProduct(): ProductContextValue {
  const ctx = useContext(ProductContext);
  if (!ctx) throw new Error('useProduct must be used within ProductProvider');
  return ctx;
}

// keep only domains/products that reference tables present in the schema
function sanitizeCatalog(catalog: Catalog, schema: Schema): Catalog {
  const has = (t: string) => Object.prototype.hasOwnProperty.call(schema, t);
  const domains = catalog.domains
    .map((d) => ({
      ...d,
      products: d.products
        .map((p) => ({
          ...p,
          fact_tables: (p.fact_tables ?? []).filter(has),
          dim_tables: (p.dim_tables ?? []).filter(has),
          kpis: Array.isArray(p.kpis) && p.kpis.length ? p.kpis : ['record_count'],
          maturity: p.maturity ?? 'incubating',
        }))
        .filter((p) => p.fact_tables.length > 0)
        .slice(0, 4),
    }))
    .filter((d) => d.products.length > 0);
  return { domains: domains.length ? domains : catalog.domains };
}
