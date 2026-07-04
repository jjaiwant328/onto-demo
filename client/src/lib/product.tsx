// Catalog-driven app context, organized as a flat SCHEMA registry. Schemas are
// the top-level unit (no customer layer). One or more schema entries can be
// selected: a single schema = that schema alone; two-or-more = a COMBINED view
// that conforms shared dimensions (combineSchemas). The active dataset feeds the
// usual pipeline (buildCatalog → deriveProduct → enterprise graph → contracts).
// The bundled `fc_entdata_gold` schema keeps its CURATED catalog + live flagship
// when it is the sole selection (keyed on the schema id); everything else is
// schema-derived. Selection is the single source of truth in this context and
// persists across navigation and reloads.
import { createContext, useContext, useMemo, useState, useCallback, useEffect, useRef } from 'react';
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
  type GraphProductLink,
  type Schema,
} from './deriveComponents';
import { fetchProductLinks } from './productLinks';
import {
  fetchOntologyOverrides,
  saveOntologyOverride,
  deleteOntologyOverride,
  applyOntologyOverrides,
  type OntologyOverride,
} from './ontologyOverrides';
import { buildCatalog } from './catalogGen';
import { DEMO_DOMAINS } from '../../../shared/demoDomains';
import { combineSchemas, type SchemaEntry, type ConformanceInfo } from './combineSchemas';

const DEFAULT_CATALOG = catalogJson as unknown as Catalog;
const DEFAULT_SCHEMA = schemaJson as unknown as Schema;
const QSR_SCHEMA = schemaQsrJson as unknown as Schema;

const CURATED_SCHEMA_ID = 'fc_entdata_gold';
// scope sentinel: "All domains" / "All products" (the default, broadest scope)
export const ALL_SCOPE = '__all__';
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

// a schema in the flat registry (built-in, uploaded/live, or saved)
export type RegistrySchema = SchemaEntry & {
  bundled?: boolean; // built-in, non-removable
  curated?: boolean; // uses the curated catalog + live flagship when sole selection
  // cached refined catalog for a saved schema (from catalog_json). When present,
  // selecting the schema uses it directly and SKIPS the LLM refine (instant).
  cachedCatalog?: Catalog;
};

// saved-schema index row (from /api/saved-schemas)
export type SavedSchemaMeta = {
  schema_id: string;
  customer: string; // retained field name in the store; used as a grouping label only
  schema_name: string;
  source: string;
  catalog_ref?: string;
  table_count?: number;
  created_by?: string;
  created_at?: string;
  volume_path?: string;
};

export type ProductContextValue = {
  // flat schema registry
  schemaEntries: RegistrySchema[];
  selectedSchemaIds: string[];
  toggleSchema: (id: string) => void;
  setSelectedSchemas: (ids: string[]) => void;
  combineAll: () => void;
  combined: boolean;
  conformance: ConformanceInfo | null;
  catalogSource: CatalogSource;
  // add an uploaded/live schema to the registry (and select it)
  addSchema: (entry: SchemaEntry) => void;
  // registry management
  isBundledSchema: (schemaId: string) => boolean;
  removeSchema: (schemaId: string) => void;
  resetSchemas: () => void;
  // durable schema store (Delta + Volume)
  savedSchemas: SavedSchemaMeta[];
  refreshSavedSchemas: () => Promise<void>;
  saveSchema: (
    args: { customer: string; schemaName: string; source: string; catalogRef?: string; schema: Schema }
  ) => Promise<{ ok: boolean; error?: string }>;
  deleteSavedSchema: (schemaId: string) => Promise<void>;
  schema: Schema;
  catalog: Catalog;
  // loading indicators for the schema-switch / catalog-regeneration lag
  catalogLoading: boolean; // active catalog is (re)building / content lazy-loading
  llmRefining: boolean; // async /api/generate-catalog label polish is in flight
  // scope selection (controlled solely by the left panel). domainScope /
  // productScope are ALL_SCOPE by default, or a concrete name.
  domains: CatalogDomain[];
  domainScope: string;
  productScope: string;
  domainScopeAll: boolean;
  productScopeAll: boolean;
  scopedDomains: CatalogDomain[]; // domains in scope (all, or the single pick)
  scopedProducts: CatalogProduct[]; // products in scope (all, or the single pick)
  selectedDomain: CatalogDomain; // concrete effective focus (detail pages)
  setSelectedDomain: (name: string) => void;
  productsInDomain: CatalogProduct[]; // all products available under domain scope
  selectedProduct: CatalogProduct; // concrete effective focus (detail pages)
  setSelectedProduct: (name: string) => void;
  components: DerivedComponents;
  // session-level catalog editing (domains) — edits the ACTIVE catalog only,
  // never the bundled JSON. Keyed to the active schema signature so switching
  // schemas discards edits and recomputes from scratch (isolation).
  deleteDomain: (name: string) => void;
  combineDomains: (names: string[], label?: string) => void;
  unmergeDomain: (name: string) => void;
  // enterprise map + highlight
  enterpriseGraph: EnterpriseGraph;
  enterpriseHighlight: Set<string>;
  // token that changes whenever the active schema selection changes; session-
  // scoped panels (Action queue, Copilot conversation) reset on it so no
  // schema's state leaks into another.
  isolationKey: string;
  // when true, in-section interactions (Graph Explorer node travel, Data Products
  // row clicks) update the left-panel Domain/Product scope. Default false =
  // view-only. Persisted to localStorage.
  syncScopeFromSections: boolean;
  setSyncScopeFromSections: (v: boolean) => void;
  // nav visibility toggles (persisted). Action Center + Business View default OFF
  // ("actions later" / redundant); user can re-enable via the settings menu.
  showActionCenter: boolean;
  setShowActionCenter: (v: boolean) => void;
  showBusinessView: boolean;
  setShowBusinessView: (v: boolean) => void;
  // leading catalog/namespace segment of the active schema's tables (for
  // schema-accurate data contracts); null when it can't be determined.
  activeSourceCatalog: string | null;
  // ontology curation (overrides layered over derived components, per schema)
  activeSchemaLabel: string;
  ontologyOverrides: OntologyOverride[];
  saveOntologyOverride: (args: {
    product?: string;
    kind: OntologyOverride['kind'];
    ref: string;
    action: OntologyOverride['action'];
    value?: unknown;
  }) => Promise<{ ok: boolean; id?: string; error?: string }>;
  deleteOntologyOverride: (id: string) => Promise<boolean>;
  // scope signature (schema|domain|product) — the key for per-scope caches and
  // the "rebuilding" indicator; changes on any schema/domain/product change.
  scopeSig: string;
  // brief true window after a scope change while components/catalog/graph recompute
  rebuilding: boolean;
  // per-scope cache of generated results (data-exceptions / scenario) so they
  // survive tab navigation but never bleed across scopes.
  getScopeCache: <T>(bucket: string) => T | undefined;
  setScopeCache: <T>(bucket: string, value: T) => void;
};

const ProductContext = createContext<ProductContextValue | null>(null);

// built-in schemas (non-removable). fc_entdata_gold is curated (live flagship).
function builtinSchemas(): RegistrySchema[] {
  return [
    {
      id: CURATED_SCHEMA_ID,
      label: 'fc_entdata_gold (Retailer)',
      schema: DEFAULT_SCHEMA,
      bundled: true,
      curated: true,
    },
    { id: 'qsr_scd', label: 'QSR Supply Chain', schema: QSR_SCHEMA, bundled: true },
  ];
}

// apply session domain edits (delete / combine / unmerge) to a catalog, returning
// a NEW catalog. Never mutates the input (so the bundled/curated JSON is
// untouched). The `base` catalog is the unedited catalog used to restore
// constituent domains on un-merge.
type DomainEditOp =
  | { kind: 'delete'; names: string[] }
  | { kind: 'combine'; names: string[]; label?: string }
  | { kind: 'unmerge'; name: string }; // name = the merged domain to revert
function applyDomainEdits(catalog: Catalog, edits: DomainEditOp[]): Catalog {
  if (!edits.length) return catalog;
  const base = catalog;
  let domains = catalog.domains.map((d) => ({ ...d, products: [...d.products] }));
  for (const edit of edits) {
    if (edit.kind === 'delete') {
      const drop = new Set(edit.names);
      domains = domains.filter((d) => !drop.has(d.name));
    } else if (edit.kind === 'unmerge') {
      const idx = domains.findIndex((d) => d.name === edit.name);
      if (idx < 0) continue;
      const merged = domains[idx];
      const originals = merged.mergedFrom ?? [];
      // restore the constituent domains from the BASE (unedited) catalog
      const restored = originals
        .map((n) => base.domains.find((d) => d.name === n))
        .filter((d): d is CatalogDomain => Boolean(d))
        .map((d) => ({ ...d, products: [...d.products] }));
      domains.splice(idx, 1, ...restored);
    } else {
      const merge = edit.names;
      const members = domains.filter((d) => merge.includes(d.name));
      if (members.length < 2) continue;
      const seen = new Set<string>();
      const products: CatalogProduct[] = [];
      for (const m of members) {
        for (const p of m.products) {
          if (seen.has(p.product_name)) continue;
          seen.add(p.product_name);
          products.push(p);
        }
      }
      const first = members[0];
      const mergedName = `${first.name}__merged`;
      const mergedLabel = edit.label || members.map((m) => m.label).join(' + ');
      const merged: CatalogDomain = {
        name: mergedName,
        label: mergedLabel,
        description: `Merged domain: ${members.map((m) => m.label).join(', ')}`,
        products,
        mergedFrom: members.map((m) => m.name),
      };
      const firstIdx = domains.findIndex((d) => d.name === first.name);
      const rest = new Set(merge);
      domains = domains.filter((d) => !rest.has(d.name));
      domains.splice(Math.max(0, firstIdx), 0, merged);
    }
  }
  return { domains: domains.length ? domains : catalog.domains };
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

const SYNC_KEY = 'rt_onto_sync_scope';
const SHOW_AC_KEY = 'rt_onto_show_action_center'; // nav toggle (default OFF)
const SHOW_BV_KEY = 'rt_onto_show_business_view'; // nav toggle (default OFF)
// ids of built-in schemas the user has deleted (hidden). Built-ins aren't in
// Lakebase, so we hide them via localStorage rather than DB-delete.
const HIDDEN_KEY = 'rt_onto_hidden_builtins';

function readHiddenBuiltins(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeHiddenBuiltins(ids: string[]): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    /* ignore */
  }
}
// built-in schemas minus any the user has hidden
function visibleBuiltinSchemas(): RegistrySchema[] {
  const hidden = new Set(readHiddenBuiltins());
  return builtinSchemas().filter((s) => !hidden.has(s.id));
}

export function ProductProvider({ children }: { children: ReactNode }) {
  const [schemasReg, setSchemasReg] = useState<RegistrySchema[]>(visibleBuiltinSchemas);
  const [selectedSchemaIds, setSelectedSchemaIds] = useState<string[]>(() => {
    const vis = visibleBuiltinSchemas();
    const first = vis.find((s) => s.id === CURATED_SCHEMA_ID) ?? vis[0];
    return first ? [first.id] : [];
  });

  // toggle: whether in-section interactions update the left-panel scope.
  // Default false (view-only); restored from localStorage on mount.
  const [syncScopeFromSections, setSyncScopeFromSectionsState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SYNC_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setSyncScopeFromSections = useCallback((v: boolean) => {
    setSyncScopeFromSectionsState(v);
    try {
      localStorage.setItem(SYNC_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  // nav visibility toggles (persisted; default OFF)
  const mkToggle = (key: string) => {
    const read = () => {
      try {
        return localStorage.getItem(key) === '1';
      } catch {
        return false;
      }
    };
    return read;
  };
  const [showActionCenter, setShowActionCenterState] = useState<boolean>(mkToggle(SHOW_AC_KEY));
  const [showBusinessView, setShowBusinessViewState] = useState<boolean>(mkToggle(SHOW_BV_KEY));
  const setShowActionCenter = useCallback((v: boolean) => {
    setShowActionCenterState(v);
    try {
      localStorage.setItem(SHOW_AC_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);
  const setShowBusinessView = useCallback((v: boolean) => {
    setShowBusinessViewState(v);
    try {
      localStorage.setItem(SHOW_BV_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  // llm refinement result overlay (applied async, keyed by a signature)
  const [llmCatalog, setLlmCatalog] = useState<{ sig: string; catalog: Catalog } | null>(null);
  // loading indicators for the schema-switch / catalog-regeneration lag:
  //  • llmRefining — the async /api/generate-catalog polish is in flight
  const [llmRefining, setLlmRefining] = useState(false);

  // Scope selection (controlled solely by the left panel). Defaults to the
  // broadest view: ALL domains + ALL products.
  const [domainName, setDomainName] = useState<string>(ALL_SCOPE);
  const [productName, setProductName] = useState<string>(ALL_SCOPE);

  // Guards the persist write so it never overwrites a stored selection before
  // the restore effect has run (both fire on mount; the [sig] persist effect
  // would otherwise clobber the saved selection with the initial default).
  const restoredRef = useRef(false);

  const schemaEntries = schemasReg;
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
    !combined && selected.length === 1 && Boolean(selected[0].curated) && selected[0].id === CURATED_SCHEMA_ID;

  // a sole-selected SAVED schema whose refined catalog is already cached →
  // use it directly and SKIP the LLM refine (instant on reselect).
  const cachedSaved =
    !combined && selected.length === 1 && selected[0].savedId && selected[0].cachedCatalog?.domains?.length
      ? (selected[0].cachedCatalog as Catalog)
      : null;

  // signature of the current dataset (for the async LLM overlay match + isolation)
  const sig = [...selectedSchemaIds].sort().join(',');

  const heuristicCatalog = useMemo(() => {
    if (isCuratedSingle) return DEFAULT_CATALOG;
    if (cachedSaved) return cachedSaved;
    const built = buildCatalog(schema);
    // Empty schema (e.g. a saved entry whose content is still lazy-loading, or an
    // empty selection) yields 0 domains — synthesize a placeholder so every section
    // has a defined domain/product and never crashes on undefined.fact_tables.
    if (built.domains.length === 0) return PLACEHOLDER_CATALOG;
    return built;
  }, [isCuratedSingle, cachedSaved, schema]);

  const generatedCatalog =
    !isCuratedSingle && !cachedSaved && llmCatalog && llmCatalog.sig === sig
      ? llmCatalog.catalog
      : heuristicCatalog;

  // Overlay the two DATA-BACKED demo domains when the QSR schema is active. These
  // are real, query-backed domains (badged "Data Avlbl") prepended ahead of the
  // generated QSR domains, which are left as-is. Config lives in shared/demoDomains.
  const qsrActive = selectedSchemaIds.includes('qsr_scd');
  const baseCatalog = useMemo(() => {
    if (!qsrActive) return generatedCatalog;
    const demoDomains: CatalogDomain[] = DEMO_DOMAINS.map((d) => ({
      name: d.name,
      label: d.label,
      description: d.description,
      dataAvailable: true,
      products: d.products.map((p) => ({
        product_name: p.product_name,
        display_name: p.display_name,
        business_outcome: p.business_outcome,
        fact_tables: p.fact_tables,
        dim_tables: [],
        kpis: p.kpis,
        maturity: 'ga',
        dataAvailable: true,
      })),
    }));
    // de-dupe by domain name (avoid a second injection if edits reintroduce them)
    const existing = new Set(demoDomains.map((d) => d.name));
    const rest = generatedCatalog.domains.filter((d) => !existing.has(d.name));
    return { domains: [...demoDomains, ...rest] };
  }, [qsrActive, generatedCatalog]);

  // ---- session domain edits (delete / combine / unmerge) on top of baseCatalog ----
  // Stored as an ordered list of operations, scoped to the current dataset `sig`
  // so switching schema(s) drops them (isolation) and recomputes cleanly.
  type DomainEdit = DomainEditOp;
  const [domainEdits, setDomainEdits] = useState<{ sig: string; edits: DomainEdit[] }>({
    sig,
    edits: [],
  });
  const activeEdits = domainEdits.sig === sig ? domainEdits.edits : [];

  const catalog = useMemo(
    () => applyDomainEdits(baseCatalog, activeEdits),
    [baseCatalog, activeEdits]
  );

  // catalogLoading — the active catalog isn't ready yet: either the schema is
  // empty (a selected saved entry whose content is still lazy-loading → the
  // placeholder catalog is showing) or there is genuinely nothing to show.
  const isPlaceholder =
    catalog.domains.length === 1 && catalog.domains[0]?.name === 'loading';
  const selectedSavedLoading = useMemo(
    () =>
      schemaEntries.some(
        (s) => s.savedId && selectedSchemaIds.includes(s.id) && Object.keys(s.schema).length === 0
      ),
    [schemaEntries, selectedSchemaIds]
  );
  const catalogLoading = isPlaceholder || selectedSavedLoading;

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

  // scope flags (default = All). "All domains" spans every domain; a single
  // domain narrows to it. "All products" spans every product in the scoped
  // domain set; a single product narrows to it.
  const domainScopeAll = domainName === ALL_SCOPE;
  const productScopeAll = productName === ALL_SCOPE;

  // the domain(s) in scope (for pages that render broadly)
  const scopedDomains = useMemo(
    () => (domainScopeAll ? domains : domains.filter((d) => d.name === domainName)),
    [domains, domainScopeAll, domainName]
  );

  // concrete "effective" domain focus for detail-oriented pages (never undefined)
  const selectedDomain = useMemo(
    () => domains.find((d) => d.name === domainName) ?? domains[0],
    [domains, domainName]
  );

  // products available under the current domain scope
  const productsInDomain = useMemo(() => {
    const src = domainScopeAll ? domains : [selectedDomain].filter(Boolean);
    const seen = new Set<string>();
    const out: CatalogProduct[] = [];
    for (const d of src) {
      for (const p of d.products) {
        if (seen.has(p.product_name)) continue;
        seen.add(p.product_name);
        out.push(p);
      }
    }
    return out;
  }, [domains, domainScopeAll, selectedDomain]);

  // concrete "effective" product focus (never undefined)
  const selectedProduct = useMemo(
    () => productsInDomain.find((p) => p.product_name === productName) ?? productsInDomain[0],
    [productsInDomain, productName]
  );

  // products actually in scope (respects both "All products" and a single pick)
  const scopedProducts = useMemo(
    () => (productScopeAll ? productsInDomain : productsInDomain.filter((p) => p.product_name === productName)),
    [productsInDomain, productScopeAll, productName]
  );

  // left-panel Scope setters. Picking a domain resets product scope to All.
  const setSelectedDomain = (name: string) => {
    if (name === ALL_SCOPE) {
      setDomainName(ALL_SCOPE);
      setProductName(ALL_SCOPE);
      return;
    }
    const d = domains.find((x) => x.name === name) ?? domains[0];
    setDomainName(d?.name ?? ALL_SCOPE);
    setProductName(ALL_SCOPE);
  };
  const setSelectedProduct = (name: string) => {
    if (name === ALL_SCOPE) {
      setProductName(ALL_SCOPE);
      return;
    }
    setProductName(name);
  };

  // append a session domain edit (scoped to the current dataset signature)
  const pushDomainEdit = useCallback(
    (edit: DomainEdit) => {
      setDomainEdits((prev) => {
        const edits = prev.sig === sig ? [...prev.edits, edit] : [edit];
        return { sig, edits };
      });
    },
    [sig]
  );
  const deleteDomain = useCallback(
    (name: string) => pushDomainEdit({ kind: 'delete', names: [name] }),
    [pushDomainEdit]
  );
  const combineDomains = useCallback(
    (names: string[], label?: string) => {
      if (names.length < 2) return;
      pushDomainEdit({ kind: 'combine', names, label });
    },
    [pushDomainEdit]
  );
  // revert a merged domain → restore its constituents from the base catalog
  const unmergeDomain = useCallback(
    (name: string) => pushDomainEdit({ kind: 'unmerge', name }),
    [pushDomainEdit]
  );

  // when the dataset (schema selection) changes, reset scope to the broadest
  // view (All domains + All products) + kick async LLM refine
  useEffect(() => {
    setDomainName(ALL_SCOPE);
    setProductName(ALL_SCOPE);
    // only persist AFTER restore has completed (see restoredRef) so the initial
    // default never clobbers a stored non-default schema selection
    if (restoredRef.current) {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ selectedSchemaIds }));
      } catch {
        /* ignore */
      }
    }
    if (isCuratedSingle || cachedSaved) {
      // curated catalog, or a saved schema whose refined catalog is cached →
      // instant, no LLM call.
      setLlmRefining(false);
      return;
    }
    // Skip while a saved entry's content is still lazy-loading (empty schema) —
    // the effect re-runs once content arrives (schema change bumps deps via sig?).
    if (Object.keys(schema).length === 0) {
      setLlmRefining(false);
      return;
    }
    // the sole-selected saved entry (to persist its refined catalog for reuse)
    const soleSaved =
      !combined && selected.length === 1 && selected[0].savedId ? selected[0].savedId : null;
    // best-effort LLM polish of the generated/combined catalog (graceful fallback)
    let cancelled = false;
    setLlmRefining(true);
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
          const refined = sanitizeCatalog(data.catalog as Catalog, schema);
          setLlmCatalog({ sig, catalog: refined });
          // persist the refined catalog with the saved schema so the next select
          // skips the LLM entirely; also cache it on the registry entry in-session.
          if (soleSaved) {
            setSchemasReg((prev) =>
              prev.map((s) => (s.savedId === soleSaved ? { ...s, cachedCatalog: refined } : s))
            );
            void fetch('/api/save-catalog', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ schema_id: soleSaved, catalog_json: JSON.stringify(refined) }),
            }).catch(() => {});
          }
        }
      } catch {
        /* keep heuristic */
      } finally {
        if (!cancelled) setLlmRefining(false);
      }
    })();
    return () => {
      cancelled = true;
      setLlmRefining(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, schema]);

  // after a session domain edit removes/renames a singly-selected domain, fall
  // back to All (leave ALL scope and valid single selections untouched)
  useEffect(() => {
    if (domainName !== ALL_SCOPE && !domains.some((d) => d.name === domainName)) {
      setDomainName(ALL_SCOPE);
      setProductName(ALL_SCOPE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  // ---- selectors ----
  const toggleSchema = useCallback((id: string) => {
    setSelectedSchemaIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      return next.length ? next : [id]; // never empty
    });
  }, []);
  const setSelectedSchemas = useCallback((ids: string[]) => {
    setSelectedSchemaIds(ids.length ? ids : []);
  }, []);
  const combineAll = useCallback(() => {
    setSelectedSchemaIds(schemasReg.map((s) => s.id));
  }, [schemasReg]);

  const addSchema = useCallback((entry: SchemaEntry) => {
    setSchemasReg((prev) => (prev.some((s) => s.id === entry.id) ? prev : [...prev, entry]));
    setSelectedSchemaIds([entry.id]);
  }, []);

  // ---- registry management (remove schema, reset all) ----
  const isBundledSchema = useCallback(
    (sid: string) => Boolean(schemasReg.find((s) => s.id === sid)?.bundled),
    [schemasReg]
  );

  // Delete ANY schema — including the built-ins (Retailer / QSR). Built-ins are
  // hidden via localStorage (they aren't in Lakebase); saved schemas call
  // delete-saved-schema. Never leaves the registry empty.
  const removeSchema = useCallback((sid: string) => {
    let savedId: string | undefined;
    let wasBundled = false;
    let fallbackId: string | undefined;
    setSchemasReg((prev) => {
      const entry = prev.find((s) => s.id === sid);
      if (!entry) return prev;
      savedId = entry.savedId;
      wasBundled = Boolean(entry.bundled);
      const remaining = prev.filter((s) => s.id !== sid);
      // never leave the registry empty — if this was the last one, restore built-ins
      if (remaining.length === 0) {
        const restored = builtinSchemas();
        fallbackId = restored[0]?.id;
        return restored;
      }
      fallbackId = remaining[0]?.id;
      return remaining;
    });
    // built-in → persist as hidden so it stays gone after reload
    if (wasBundled) {
      writeHiddenBuiltins([...readHiddenBuiltins(), sid]);
    }
    setSelectedSchemaIds((prev) => {
      const next = prev.filter((id) => id !== sid);
      return next.length ? next : fallbackId ? [fallbackId] : [];
    });
    // a SAVED schema must be deleted server-side too, or it returns on reload.
    if (savedId) {
      setSavedSchemas((prev) => prev.filter((s) => s.schema_id !== savedId));
      void fetch('/api/delete-saved-schema', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema_id: savedId }),
      }).catch(() => {});
    }
  }, []);

  // clear persisted state (incl. hidden built-ins) and restore ALL built-ins
  const resetSchemas = useCallback(() => {
    try {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(HIDDEN_KEY);
    } catch {
      /* ignore */
    }
    setSchemasReg(builtinSchemas());
    setSelectedSchemaIds([CURATED_SCHEMA_ID]);
    setDomainEdits({ sig: CURATED_SCHEMA_ID, edits: [] });
    setDomainName(ALL_SCOPE);
    setProductName(ALL_SCOPE);
  }, []);

  // ---- durable schema store (Delta index + Volume content) ----
  const [savedSchemas, setSavedSchemas] = useState<SavedSchemaMeta[]>([]);

  // merge saved-schema index rows into the flat registry as (lazy) entries.
  // De-dupes by schema_name+customer (rows arrive newest-first, so the first
  // occurrence wins) AND by entry id, so the same schema never appears twice.
  const mergeSaved = useCallback((rows: SavedSchemaMeta[]) => {
    setSchemasReg((prev) => {
      const next = [...prev];
      const seenKey = new Set<string>();
      for (const r of rows) {
        const key = `${(r.schema_name ?? '').toLowerCase()}|${(r.customer ?? '').toLowerCase()}`;
        if (seenKey.has(key)) continue; // duplicate name+customer in the index
        seenKey.add(key);
        const entryId = `saved:${r.schema_id}`;
        if (next.some((s) => s.id === entryId)) continue;
        // lazy entry: empty schema until first selected (content in the volume)
        next.push({
          id: entryId,
          label: `${r.schema_name} · ${r.customer} · saved`,
          schema: {},
          savedId: r.schema_id,
        });
      }
      return next;
    });
  }, []);

  const refreshSavedSchemas = useCallback(async () => {
    try {
      const resp = await fetch('/api/saved-schemas');
      const data = await resp.json();
      const raw: SavedSchemaMeta[] = Array.isArray(data?.schemas) ? data.schemas : [];
      // de-dupe by schema_name+customer (index is newest-first → first wins)
      const seen = new Set<string>();
      const rows = raw.filter((r) => {
        const key = `${(r.schema_name ?? '').toLowerCase()}|${(r.customer ?? '').toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
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

  const deleteSavedSchema = useCallback(async (schemaId: string) => {
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
    setSchemasReg((prev) => prev.filter((s) => s.id !== entryId));
    setSelectedSchemaIds((prev) => {
      const next = prev.filter((id) => id !== entryId);
      return next.length ? next : [CURATED_SCHEMA_ID];
    });
    setSavedSchemas((prev) => prev.filter((s) => s.schema_id !== schemaId));
  }, []);

  // lazily fetch content for a selected saved entry that hasn't loaded yet
  useEffect(() => {
    const lazy = schemasReg.filter(
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
          // capture the cached refined catalog too (if the server has one) so the
          // select is instant and the LLM refine is skipped.
          const cached =
            data.catalog && typeof data.catalog === 'object' && data.catalog.domains?.length
              ? (data.catalog as Catalog)
              : undefined;
          setSchemasReg((prev) =>
            prev.map((s) =>
              s.id === entry.id ? { ...s, schema: data.schema, ...(cached ? { cachedCatalog: cached } : {}) } : s
            )
          );
        } catch {
          /* leave empty; section renders an empty catalog gracefully */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [schemasReg, selectedSchemaIds]);

  // load saved schemas once on startup
  useEffect(() => {
    void refreshSavedSchemas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // restore persisted selection on first load (default = curated schema).
  // Only restores built-in schema ids (saved/uploaded ids are session/store-driven
  // and re-appear via the saved-schemas fetch); guards against stale ids.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { selectedSchemaIds?: string[] };
        // only restore VISIBLE built-in ids (skip ones the user has hidden/deleted)
        const visibleIds = new Set(visibleBuiltinSchemas().map((s) => s.id));
        const valid = (p.selectedSchemaIds ?? []).filter((id) => visibleIds.has(id));
        if (valid.length) setSelectedSchemaIds(valid);
      }
    } catch {
      /* ignore */
    } finally {
      // restore is complete — the persist effect may now write freely
      restoredRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // leading catalog/namespace of the active schema's tables (for contracts)
  const activeSourceCatalog = useMemo(() => {
    const first = Object.keys(schema)[0] ?? '';
    const seg = first.split('.')[0];
    return seg && seg !== first ? seg : (seg || null);
  }, [schema]);

  // active schema label — the key for per-schema ontology overrides. Single
  // selection = that entry's label; combined = joined labels.
  const activeSchemaLabel = useMemo(() => {
    if (selected.length === 1) return selected[0].label;
    if (selected.length > 1) return selected.map((s) => s.label).sort().join(' + ');
    return schemaEntries[0]?.label ?? '';
  }, [selected, schemaEntries]);

  // ---- ontology overrides (user curation, persisted per schema in Lakebase) ----
  const [ontologyOverrides, setOntologyOverrides] = useState<OntologyOverride[]>([]);
  const refreshOntologyOverrides = useCallback(async () => {
    if (!activeSchemaLabel) {
      setOntologyOverrides([]);
      return;
    }
    setOntologyOverrides(await fetchOntologyOverrides(activeSchemaLabel));
  }, [activeSchemaLabel]);
  // reload overrides whenever the active schema changes
  useEffect(() => {
    void refreshOntologyOverrides();
  }, [refreshOntologyOverrides]);

  const saveOntologyOverrideFn = useCallback(
    async (args: {
      product?: string;
      kind: OntologyOverride['kind'];
      ref: string;
      action: OntologyOverride['action'];
      value?: unknown;
    }) => {
      const r = await saveOntologyOverride({ schema_label: activeSchemaLabel, ...args });
      if (r.ok) await refreshOntologyOverrides();
      return r;
    },
    [activeSchemaLabel, refreshOntologyOverrides]
  );
  const deleteOntologyOverrideFn = useCallback(
    async (id: string) => {
      const ok = await deleteOntologyOverride(id);
      if (ok) await refreshOntologyOverrides();
      return ok;
    },
    [refreshOntologyOverrides]
  );

  // scope signature: changes on any schema / domain / product change
  const scopeSig = `${sig}|${domainName}|${productName}`;

  // brief "rebuilding" window on scope change (components/catalog/graph recompute)
  const [rebuilding, setRebuilding] = useState(false);
  useEffect(() => {
    setRebuilding(true);
    const t = setTimeout(() => setRebuilding(false), 450);
    return () => clearTimeout(t);
  }, [scopeSig]);

  // per-scope cache of generated results (data-exceptions / scenario). Survives
  // tab navigation (context persists) but is keyed by scope so no cross-product bleed.
  const scopeCacheRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const getScopeCache = useCallback(
    <T,>(bucket: string): T | undefined =>
      scopeCacheRef.current.get(scopeSig)?.[bucket] as T | undefined,
    [scopeSig]
  );
  const setScopeCache = useCallback(
    <T,>(bucket: string, value: T) => {
      const cur = scopeCacheRef.current.get(scopeSig) ?? {};
      scopeCacheRef.current.set(scopeSig, { ...cur, [bucket]: value });
    },
    [scopeSig]
  );

  // product links (Genie / dashboard) overlaid onto the enterprise graph. Loaded
  // once on startup from Lakebase; refreshed when links are attached/detached.
  const [graphLinks, setGraphLinks] = useState<GraphProductLink[]>([]);
  useEffect(() => {
    void (async () => {
      const all = await fetchProductLinks();
      setGraphLinks(
        all.map((l) => ({ product: l.product ?? '', link_type: l.link_type, url: l.url, label: l.label }))
      );
    })();
  }, []);

  // ---- derived artifacts ----
  // effective components = heuristic/LLM derivation with user overrides layered on
  const components = useMemo(
    () => applyOntologyOverrides(deriveProduct(selectedProduct, schema), ontologyOverrides),
    [selectedProduct, schema, ontologyOverrides]
  );
  const enterpriseGraph = useMemo(
    () => buildEnterpriseGraph(catalog, schema, conformance?.conformedTables, graphLinks),
    [catalog, schema, conformance, graphLinks]
  );
  // Scope-driven enterprise-graph highlight (recomputes on scope/schema change):
  //  • All domains + All products → highlight EVERYTHING (no dimming).
  //  • A specific product → that product's subtree.
  //  • A specific domain (product = All) → union of the scoped domains' subtrees.
  //  • Combined/subset domains → union across the scoped domains.
  const enterpriseHighlight = useMemo(() => {
    // broadest scope: highlight every node (nothing dimmed)
    if (domainScopeAll && productScopeAll) {
      return new Set<string>(Object.keys(enterpriseGraph.nodes));
    }
    const set = new Set<string>();
    if (!productScopeAll) {
      // a specific product is chosen → highlight its subtree (within its domain)
      for (const p of scopedProducts) {
        const owningDomain = scopedDomains.find((d) => d.products.some((x) => x.product_name === p.product_name));
        for (const id of enterpriseGraph.highlightFor(owningDomain?.name ?? null, p.product_name)) {
          set.add(id);
        }
      }
    } else {
      // product = All → union of each scoped domain's subtree
      for (const d of scopedDomains) {
        for (const id of enterpriseGraph.highlightFor(d.name, null)) set.add(id);
      }
    }
    // fall back to everything if we somehow computed an empty set
    return set.size ? set : new Set<string>(Object.keys(enterpriseGraph.nodes));
  }, [enterpriseGraph, domainScopeAll, productScopeAll, scopedDomains, scopedProducts]);

  const value: ProductContextValue = {
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
    resetSchemas,
    savedSchemas,
    refreshSavedSchemas,
    saveSchema,
    deleteSavedSchema,
    schema,
    catalog,
    catalogLoading,
    llmRefining,
    domains,
    domainScope: domainName,
    productScope: productName,
    domainScopeAll,
    productScopeAll,
    scopedDomains,
    scopedProducts,
    selectedDomain,
    setSelectedDomain,
    productsInDomain,
    selectedProduct,
    setSelectedProduct,
    components,
    deleteDomain,
    combineDomains,
    unmergeDomain,
    enterpriseGraph,
    enterpriseHighlight,
    isolationKey: sig,
    syncScopeFromSections,
    setSyncScopeFromSections,
    showActionCenter,
    setShowActionCenter,
    showBusinessView,
    setShowBusinessView,
    activeSourceCatalog,
    activeSchemaLabel,
    ontologyOverrides,
    saveOntologyOverride: saveOntologyOverrideFn,
    deleteOntologyOverride: deleteOntologyOverrideFn,
    scopeSig,
    rebuilding,
    getScopeCache,
    setScopeCache,
  };

  return <ProductContext.Provider value={value}>{children}</ProductContext.Provider>;
}

export function useProduct(): ProductContextValue {
  const ctx = useContext(ProductContext);
  if (!ctx) throw new Error('useProduct must be used within ProductProvider');
  return ctx;
}
