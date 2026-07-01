// Catalog-driven app context, sourced from the ACTIVE catalog. The active schema
// comes from a named registry: a curated "Retailer" default (bundled schema.json +
// curated catalog.json — keeps the live flagship), a generated "QSR Supply Chain"
// schema (bundled schema.qsr.json → buildCatalog heuristic + optional LLM polish),
// and any transient uploaded/live-connection schema. Selecting a product derives
// its components via deriveProduct — the reusable "skill" every section consumes.
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
import { parseDescribeCsv, buildCatalog } from './catalogGen';

const DEFAULT_CATALOG = catalogJson as unknown as Catalog;
const DEFAULT_SCHEMA = schemaJson as unknown as Schema;
const QSR_SCHEMA = schemaQsrJson as unknown as Schema;

const DEFAULT_DOMAIN = 'store_operations_labor';
const DEFAULT_PRODUCT = 'jai_store_traffic_labor_efficiency';
const LS_KEY = 'rt_onto_active_schema';

export type CatalogSource = 'default' | 'generated' | 'generated+llm' | 'uploaded' | 'uploaded+llm';

// A selectable entry in the schema registry.
export type SchemaOption = {
  id: string; // 'default' | 'qsr_scd' | 'uploaded'
  label: string;
  transient?: boolean; // uploaded/live entries
};

type ActiveState = {
  id: string;
  catalog: Catalog;
  schema: Schema;
  source: CatalogSource;
};

type ProductContextValue = {
  // named-schema registry + selector
  schemaOptions: SchemaOption[];
  activeSchemaId: string;
  selectSchema: (id: string) => void;
  catalogSource: CatalogSource;
  // upload / live-connection path (kept)
  loadFromCsv: (csvText: string) => { domains: number; products: number };
  applyGeneratedCatalog: (catalog: Catalog, schema: Schema, source: CatalogSource) => void;
  resetToDefault: () => void;
  schema: Schema;
  catalog: Catalog;
  // selection
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

// registry of the two bundled, named schemas (uploaded is added transiently)
const BUNDLED_OPTIONS: SchemaOption[] = [
  { id: 'default', label: 'Retailer (fc_entdata_gold)' },
  { id: 'qsr_scd', label: 'QSR Supply Chain (qsrscdoprod_primary)' },
];

export function ProductProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveState>({
    id: 'default',
    catalog: DEFAULT_CATALOG,
    schema: DEFAULT_SCHEMA,
    source: 'default',
  });
  const [hasUpload, setHasUpload] = useState(false);
  const { catalog, schema } = active;
  const domains = catalog.domains;

  const [domainName, setDomainName] = useState<string>(DEFAULT_DOMAIN);
  const [productName, setProductName] = useState<string>(DEFAULT_PRODUCT);

  const selectedDomain = useMemo(
    () => domains.find((d) => d.name === domainName) ?? domains[0],
    [domains, domainName]
  );
  const productsInDomain = selectedDomain.products;
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

  // point selection at the first domain/product of a freshly-activated catalog
  const focusFirst = useCallback((c: Catalog, preferDomain?: string, preferProduct?: string) => {
    const d0 = (preferDomain && c.domains.find((d) => d.name === preferDomain)) || c.domains[0];
    setDomainName(d0?.name ?? '');
    const p0 =
      (preferProduct && d0?.products.find((p) => p.product_name === preferProduct)) ||
      d0?.products[0];
    setProductName(p0?.product_name ?? '');
  }, []);

  // ---- upload / live-connection path (kept; registers a transient entry) ----
  const applyGeneratedCatalog = useCallback(
    (newCatalog: Catalog, newSchema: Schema, source: CatalogSource) => {
      setActive({ id: 'uploaded', catalog: newCatalog, schema: newSchema, source });
      setHasUpload(true);
      focusFirst(newCatalog);
    },
    [focusFirst]
  );

  const loadFromCsv = useCallback(
    (csvText: string) => {
      const newSchema = parseDescribeCsv(csvText);
      const newCatalog = buildCatalog(newSchema);
      applyGeneratedCatalog(newCatalog, newSchema, 'uploaded');
      return {
        domains: newCatalog.domains.length,
        products: newCatalog.domains.reduce((n, d) => n + d.products.length, 0),
      };
    },
    [applyGeneratedCatalog]
  );

  // ---- named-schema registry selector ----
  const activateDefault = useCallback(() => {
    setActive({ id: 'default', catalog: DEFAULT_CATALOG, schema: DEFAULT_SCHEMA, source: 'default' });
    focusFirst(DEFAULT_CATALOG, DEFAULT_DOMAIN, DEFAULT_PRODUCT);
  }, [focusFirst]);

  const activateQsr = useCallback(() => {
    // heuristic first (synchronous, always works), then best-effort LLM polish
    const heuristic = buildCatalog(QSR_SCHEMA);
    setActive({ id: 'qsr_scd', catalog: heuristic, schema: QSR_SCHEMA, source: 'generated' });
    focusFirst(heuristic);
    // async LLM refine — non-blocking, graceful fallback
    (async () => {
      try {
        const summary = Object.entries(QSR_SCHEMA)
          .map(([t, cols]) => `${t}: ${cols.slice(0, 8).map((c) => c.name).join(', ')}`)
          .join('\n')
          .slice(0, 12000);
        const resp = await fetch('/api/generate-catalog', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draft: heuristic, summary }),
        });
        const data = await resp.json();
        if (data?.llm && data?.catalog?.domains?.length) {
          const refined = sanitizeCatalog(data.catalog as Catalog, QSR_SCHEMA);
          // only apply if the user is still on QSR
          setActive((cur) =>
            cur.id === 'qsr_scd'
              ? { id: 'qsr_scd', catalog: refined, schema: QSR_SCHEMA, source: 'generated+llm' }
              : cur
          );
        }
      } catch {
        /* keep heuristic */
      }
    })();
  }, [focusFirst]);

  const selectSchema = useCallback(
    (id: string) => {
      try {
        localStorage.setItem(LS_KEY, id);
      } catch {
        /* ignore */
      }
      if (id === 'qsr_scd') activateQsr();
      else if (id === 'uploaded' && hasUpload) {
        /* already active or previously uploaded — no-op if not held; default otherwise */
        if (active.id !== 'uploaded') activateDefault();
      } else activateDefault();
    },
    [activateQsr, activateDefault, hasUpload, active.id]
  );

  const resetToDefault = useCallback(() => {
    try {
      localStorage.setItem(LS_KEY, 'default');
    } catch {
      /* ignore */
    }
    activateDefault();
  }, [activateDefault]);

  // restore persisted choice on first load (default = Retailer)
  useEffect(() => {
    let persisted: string | null = null;
    try {
      persisted = localStorage.getItem(LS_KEY);
    } catch {
      /* ignore */
    }
    if (persisted === 'qsr_scd') activateQsr();
    // 'default'/'uploaded'/null → keep the initial default state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- derived artifacts ----
  const components = useMemo(() => deriveProduct(selectedProduct, schema), [selectedProduct, schema]);
  const enterpriseGraph = useMemo(() => buildEnterpriseGraph(catalog, schema), [catalog, schema]);
  const enterpriseHighlight = useMemo(
    () => enterpriseGraph.highlightFor(selectedDomain.name, selectedProduct.product_name),
    [enterpriseGraph, selectedDomain.name, selectedProduct.product_name]
  );

  const schemaOptions: SchemaOption[] = hasUpload
    ? [...BUNDLED_OPTIONS, { id: 'uploaded', label: 'Uploaded / live schema', transient: true }]
    : BUNDLED_OPTIONS;

  const value: ProductContextValue = {
    schemaOptions,
    activeSchemaId: active.id,
    selectSchema,
    catalogSource: active.source,
    loadFromCsv,
    applyGeneratedCatalog,
    resetToDefault,
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

// keep only domains/products that reference tables present in the schema (guards
// against the LLM introducing tables/columns that don't exist).
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
