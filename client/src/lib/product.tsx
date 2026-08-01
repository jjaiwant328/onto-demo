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
import schemaQsrScJson from '../data/schema.qsr_sc.json';
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
import { DEMO_DOMAINS, DEMO_SCHEMA, QSR_SC_DOMAINS } from '../../../shared/demoDomains';
import {
  assembleArtifactInput,
  artifactSignature,
  generateArtifact,
  fetchArtifact,
  type StoredArtifact,
  type ArtifactRuleInput,
} from './ontologyArtifact';
import { combineSchemas, type SchemaEntry, type ConformanceInfo } from './combineSchemas';
import {
  analysisSignature,
  generateDomainAnalysis,
  fetchDomainAnalysis,
  toAnalysisProduct,
  type DomainAnalysis,
  type DomainAnalysisResult,
  type UseCase,
} from './domainAnalysis';
import {
  describeUseCaseProduct,
  fetchUseCaseProducts,
  setUseCaseProductStatus,
  updateUseCaseProduct,
  deleteUseCaseProduct,
  type UseCaseProductDraft,
  type UseCaseProductSpec,
  type DescribeResult,
  type DraftStatus,
} from './useCaseProduct';

const DEFAULT_CATALOG = catalogJson as unknown as Catalog;
const DEFAULT_SCHEMA = schemaJson as unknown as Schema;
const QSR_SCHEMA = schemaQsrJson as unknown as Schema;
const QSR_SC_SCHEMA_JSON = schemaQsrScJson as unknown as Schema;

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
  // persist an already-loaded (ephemeral) registry entry to the durable store,
  // converting it in place (keeps its loaded content; no duplicate entry).
  storeSchema: (
    entryId: string,
    opts?: { customer?: string }
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
  // re-fetch product links (Genie/dashboard) overlaid on the enterprise graph.
  // Call after attaching/detaching a link so the graph reflects it without a reload.
  refreshGraphLinks: () => Promise<void>;
  // attached Genie/dashboard links for the SELECTED product (live from Lakebase);
  // overlaid onto the ontology+lineage graph so they appear/update without a reload.
  productLinks: GraphProductLink[];
  // generated ontology artifact (OWL/TTL + JSON-LD + graph) for the selected product
  artifact: StoredArtifact | null;
  artifactStale: boolean;
  regenerateArtifact: (opts?: { rules?: ArtifactRuleInput[]; servingViewPresent?: boolean }) => Promise<void>;
  // domain analysis (ROI-ranked use cases + data gaps) for the selected domain
  domainAnalysis: DomainAnalysis | null;
  domainAnalysisStale: boolean;
  domainAnalyzing: boolean;
  domainAnalysisLabel: string;
  regenerateDomainAnalysis: () => Promise<DomainAnalysisResult>;
  // use-case data-product drafts (staging; completed ones surface in Data Products)
  useCaseDrafts: UseCaseProductDraft[];
  describeUseCaseAsProduct: (useCase: UseCase) => Promise<DescribeResult>;
  setUseCaseDraftStatus: (draftId: string, status: DraftStatus) => Promise<boolean>;
  removeUseCaseDraft: (draftId: string) => Promise<boolean>;
  updateUseCaseDraft: (draftId: string, spec: UseCaseProductSpec) => Promise<boolean>;
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
  // Control Tower demo nav group (Home / Action Inbox / Scenario & Impact /
  // Action Center) — the supply-chain control-tower decision surfaces built for
  // the flagship demo. Default ON; toggle OFF to show only the generic ontology
  // tooling. Persisted to localStorage.
  showControlTower: boolean;
  setShowControlTower: (v: boolean) => void;
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
    { id: 'qsr_sc', label: 'QSR Supply Chain Control Tower', schema: QSR_SC_SCHEMA_JSON, bundled: true },
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
const SHOW_CT_KEY = 'rt_onto_show_control_tower'; // Control Tower demo nav group (default ON)
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

  // toggle: whether in-section interactions update the left-panel scope (and the
  // Explore↔Scope bidirectional sync). Default ON now (user wants sync); an
  // explicit '0' in localStorage still disables it.
  const [syncScopeFromSections, setSyncScopeFromSectionsState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SYNC_KEY) !== '0'; // unset or '1' → ON
    } catch {
      return true;
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
  // Control Tower demo group defaults ON (unset or '1' → shown; explicit '0' hides).
  const [showControlTower, setShowControlTowerState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_CT_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const setShowControlTower = useCallback((v: boolean) => {
    setShowControlTowerState(v);
    try {
      localStorage.setItem(SHOW_CT_KEY, v ? '1' : '0');
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
  // saved:* ids persisted in the last selection but not yet in the registry
  // (their content lazy-loads via refreshSavedSchemas); re-selected once merged.
  const pendingSavedSelRef = useRef<string[]>([]);

  const schemaEntries = schemasReg;
  const selected = useMemo(
    () => schemaEntries.filter((s) => selectedSchemaIds.includes(s.id)),
    [schemaEntries, selectedSchemaIds]
  );
  const combined = selected.length > 1;

  // ---- active schema (single or combined+conformed) ----
  const { schema, conformance } = useMemo(() => {
    let base: Schema;
    let conf: ConformanceInfo | null = null;
    if (selected.length === 0) base = schemaEntries[0]?.schema ?? {};
    else if (selected.length === 1) base = selected[0].schema;
    else {
      const r = combineSchemas(selected);
      base = r.schema;
      conf = r.info;
    }
    // When the QSR schema is active, merge the data-backed demo tables' real
    // column shapes so the demo products are genuinely multi-table (Suggest /
    // Validate / Generate-serving-view operate on real columns).
    if (selectedSchemaIds.includes('qsr_scd')) {
      base = { ...base, ...(DEMO_SCHEMA as Schema) };
    }
    return { schema: base, conformance: conf };
  }, [selected, schemaEntries, selectedSchemaIds]);

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

  // Overlay the DATA-BACKED demo domains when a backing schema is active. These
  // are real, query-backed domains (badged "Data Avlbl") prepended ahead of the
  // generated domains, which are left as-is. Config lives in shared/demoDomains:
  //  • qsr_scd  → the qsr_demo demo domains (DQ / Demand)
  //  • qsr_sc   → the QSR Supply Chain Control Tower domains (3 ontology layers)
  const qsrActive = selectedSchemaIds.includes('qsr_scd');
  const qsrScActive = selectedSchemaIds.includes('qsr_sc');
  const baseCatalog = useMemo(() => {
    const source = qsrActive ? DEMO_DOMAINS : qsrScActive ? QSR_SC_DOMAINS : null;
    if (!source) return generatedCatalog;
    const demoDomains: CatalogDomain[] = source.map((d) => ({
      name: d.name,
      label: d.label,
      description: d.description,
      dataAvailable: true,
      products: d.products.map((p) => ({
        product_name: p.product_name,
        display_name: p.display_name,
        business_outcome: p.business_outcome,
        fact_tables: p.fact_tables,
        dim_tables: p.dim_tables ?? [],
        kpis: p.kpis,
        maturity: 'ga',
        dataAvailable: true,
      })),
    }));
    // de-dupe by domain name (avoid a second injection if edits reintroduce them)
    const existing = new Set(demoDomains.map((d) => d.name));
    const rest = generatedCatalog.domains.filter((d) => !existing.has(d.name));
    return { domains: [...demoDomains, ...rest] };
  }, [qsrActive, qsrScActive, generatedCatalog]);

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
        // 1) scope-sig cache (Lakebase) — covers combined + built-in scopes, so
        // the LLM polish runs ONCE per scope and later reloads are instant.
        try {
          const cacheResp = await fetch(`/api/catalog-cache?sig=${encodeURIComponent(sig)}`);
          const cached = await cacheResp.json();
          if (!cancelled && cached?.catalog?.domains?.length) {
            setLlmCatalog({ sig, catalog: sanitizeCatalog(cached.catalog as Catalog, schema) });
            return; // cache hit → skip the LLM entirely
          }
        } catch {
          /* cache unavailable → fall through to the LLM */
        }
        if (cancelled) return;

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
          // 2) persist to the scope-sig cache so ANY later reload of this scope
          // (combined or not) skips the LLM.
          void fetch('/api/catalog-cache', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sig, catalog_json: JSON.stringify(refined) }),
          }).catch(() => {});
          // also persist against the saved schema + in-session registry entry
          // (kept for the single-saved-schema fast path in getCuratedCatalogId).
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

  // Persist an ephemeral (loaded-but-unsaved) entry to the durable store and convert
  // it in place: give it the returned saved id so it becomes the durable entry
  // (keeps its already-loaded content, and mergeSaved won't add a duplicate).
  const storeSchema = useCallback(
    async (
      entryId: string,
      opts?: { customer?: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      const entry = schemasReg.find((s) => s.id === entryId);
      if (!entry) return { ok: false, error: 'not found' };
      if (entry.bundled || entry.savedId) return { ok: false, error: 'already persistent' };
      try {
        const resp = await fetch('/api/save-schema', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            customer: opts?.customer?.trim() || entry.label,
            schemaName: entry.label,
            source: 'stored',
            schema: entry.schema,
          }),
        });
        const data = await resp.json();
        if (!data?.ok || !data.schema_id) return { ok: false, error: data?.error ?? 'save failed' };
        const newId = `saved:${data.schema_id}`;
        setSchemasReg((prev) => prev.map((s) => (s.id === entryId ? { ...s, id: newId, savedId: data.schema_id } : s)));
        setSelectedSchemaIds((prev) => prev.map((id) => (id === entryId ? newId : id)));
        await refreshSavedSchemas();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [schemasReg, refreshSavedSchemas]
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
  // Restores VISIBLE built-in ids immediately; saved:* ids are stashed as pending
  // and re-selected once refreshSavedSchemas merges their (lazy) registry entries,
  // so a stored schema stays ACTIVE across reloads instead of reverting to default.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { selectedSchemaIds?: string[] };
        const persisted = p.selectedSchemaIds ?? [];
        const visibleIds = new Set(visibleBuiltinSchemas().map((s) => s.id));
        const builtinSel = persisted.filter((id) => visibleIds.has(id));
        const savedSel = persisted.filter((id) => id.startsWith('saved:'));
        if (builtinSel.length) setSelectedSchemaIds(builtinSel);
        // defer saved-schema re-selection until their entries exist in the registry
        pendingSavedSelRef.current = savedSel;
      }
    } catch {
      /* ignore */
    } finally {
      // restore is complete — the persist effect may now write freely
      restoredRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // once saved schemas are merged into the registry, re-select any that the
  // persisted selection referenced (fixes "saved schema loses selection on reload").
  useEffect(() => {
    const pending = pendingSavedSelRef.current;
    if (!pending.length) return;
    const ready = pending.filter((id) => schemasReg.some((s) => s.id === id));
    if (ready.length) {
      setSelectedSchemaIds(ready);
      pendingSavedSelRef.current = [];
    }
  }, [schemasReg]);

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
  const refreshGraphLinks = useCallback(async () => {
    const all = await fetchProductLinks();
    setGraphLinks(
      all.map((l) => ({ product: l.product ?? '', link_type: l.link_type, url: l.url, label: l.label }))
    );
  }, []);
  useEffect(() => {
    void refreshGraphLinks();
  }, [refreshGraphLinks]);

  // ---- derived artifacts ----
  // effective components = heuristic/LLM derivation with user overrides layered on
  const components = useMemo(
    () => applyOntologyOverrides(deriveProduct(selectedProduct, schema), ontologyOverrides),
    [selectedProduct, schema, ontologyOverrides]
  );

  // ---- ontology artifact (OWL/TTL + JSON-LD + graph) per selected product ----
  const [artifact, setArtifact] = useState<StoredArtifact | null>(null);
  // extras supplied by Ontology Studio (rules, live serving-view presence)
  const [artifactExtras, setArtifactExtras] = useState<{
    rules?: ArtifactRuleInput[];
    servingViewPresent?: boolean;
  }>({});
  const servingObject = `jai_ontos.demo_schema.jai_${selectedProduct.product_name}_serving`;
  const productLinksForArtifact = useMemo(
    () => graphLinks.filter((l) => l.product === selectedProduct.display_name),
    [graphLinks, selectedProduct]
  );
  const currentArtifactModel = useMemo(
    () =>
      assembleArtifactInput({
        components,
        links: productLinksForArtifact,
        rules: artifactExtras.rules,
        servingObject,
        servingViewPresent: artifactExtras.servingViewPresent,
      }),
    [components, productLinksForArtifact, artifactExtras, servingObject]
  );
  const artifactStale = useMemo(() => {
    if (!artifact?.model_json) return true;
    try {
      return artifactSignature(currentArtifactModel) !== artifactSignature(JSON.parse(artifact.model_json));
    } catch {
      return true;
    }
  }, [artifact, currentArtifactModel]);
  useEffect(() => {
    let cancelled = false;
    void fetchArtifact(activeSchemaLabel, selectedProduct.product_name).then((a) => {
      if (!cancelled) setArtifact(a);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSchemaLabel, selectedProduct.product_name]);
  const regenerateArtifact = useCallback(
    async (opts?: { rules?: ArtifactRuleInput[]; servingViewPresent?: boolean }) => {
      if (opts) setArtifactExtras((prev) => ({ ...prev, ...opts }));
      const model = assembleArtifactInput({
        components,
        links: productLinksForArtifact,
        rules: opts?.rules ?? artifactExtras.rules,
        servingObject,
        servingViewPresent: opts?.servingViewPresent ?? artifactExtras.servingViewPresent,
      });
      await generateArtifact(activeSchemaLabel, selectedProduct.product_name, model);
      setArtifact(await fetchArtifact(activeSchemaLabel, selectedProduct.product_name));
    },
    [components, productLinksForArtifact, artifactExtras, servingObject, activeSchemaLabel, selectedProduct.product_name]
  );
  // auto-refresh: if an artifact already exists and drifts stale (curation / link /
  // dashboard / rule change), regenerate it after a short debounce.
  useEffect(() => {
    if (!artifact || !artifactStale) return;
    const t = setTimeout(() => void regenerateArtifact(), 1000);
    return () => clearTimeout(t);
  }, [artifact, artifactStale, regenerateArtifact]);

  // ---- domain analysis (ROI-ranked use cases + data-gap analysis) per domain ----
  // Scoped to the selected domain (all its products). Persisted in Lakebase and
  // loaded back; regenerable, with a signature-based staleness indicator.
  const [domainAnalysis, setDomainAnalysisState] = useState<DomainAnalysis | null>(null);
  const [domainAnalysisSig, setDomainAnalysisSig] = useState<string | null>(null);
  const [domainAnalyzing, setDomainAnalyzing] = useState(false);
  // the domain key + label the analysis is scoped to (ALL_SCOPE → all domains)
  const analysisDomainName = domainScopeAll ? ALL_SCOPE : selectedDomain?.name ?? ALL_SCOPE;
  const analysisDomainLabel = domainScopeAll ? 'All domains' : selectedDomain?.label ?? 'All domains';
  const analysisProducts = useMemo(
    () => productsInDomain.map(toAnalysisProduct),
    [productsInDomain]
  );
  const currentAnalysisSig = useMemo(
    () => analysisSignature(analysisProducts),
    [analysisProducts]
  );
  const domainAnalysisStale = useMemo(() => {
    if (!domainAnalysis) return true;
    return domainAnalysisSig !== currentAnalysisSig;
  }, [domainAnalysis, domainAnalysisSig, currentAnalysisSig]);
  useEffect(() => {
    let cancelled = false;
    void fetchDomainAnalysis(activeSchemaLabel, analysisDomainName).then((r) => {
      if (cancelled) return;
      setDomainAnalysisState(r.analysis);
      setDomainAnalysisSig(r.signature ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSchemaLabel, analysisDomainName]);
  const regenerateDomainAnalysis = useCallback(async () => {
    setDomainAnalyzing(true);
    try {
      const r = await generateDomainAnalysis({
        schema_label: activeSchemaLabel,
        domain_name: analysisDomainName,
        domain_label: analysisDomainLabel,
        signature: currentAnalysisSig,
        products: analysisProducts,
      });
      if (r.ok && r.analysis) {
        setDomainAnalysisState(r.analysis);
        setDomainAnalysisSig(currentAnalysisSig);
      }
      return r;
    } finally {
      setDomainAnalyzing(false);
    }
  }, [activeSchemaLabel, analysisDomainName, analysisDomainLabel, currentAnalysisSig, analysisProducts]);

  // ---- use-case data-product drafts (staging → completed) ----
  const [useCaseDrafts, setUseCaseDrafts] = useState<UseCaseProductDraft[]>([]);
  const refreshUseCaseDrafts = useCallback(async () => {
    if (!activeSchemaLabel) {
      setUseCaseDrafts([]);
      return;
    }
    setUseCaseDrafts(await fetchUseCaseProducts(activeSchemaLabel));
  }, [activeSchemaLabel]);
  useEffect(() => {
    void refreshUseCaseDrafts();
  }, [refreshUseCaseDrafts]);
  const describeUseCaseAsProduct = useCallback(
    async (useCase: UseCase): Promise<DescribeResult> => {
      // surface the domain data gaps that unblock THIS use case (or, if none are
      // explicitly linked, all domain gaps) so the draft can call them out.
      const allGaps = domainAnalysis?.data_gaps ?? [];
      const linked = allGaps.filter((g) => (g.unblocks ?? []).includes(useCase.title));
      const gaps = (linked.length ? linked : allGaps).map((g) => ({
        gap: g.gap,
        why_it_matters: g.why_it_matters,
        severity: g.severity,
      }));
      const r = await describeUseCaseProduct({
        schema_label: activeSchemaLabel,
        domain_name: analysisDomainName,
        use_case: useCase,
        data_gaps: gaps,
      });
      if (r.ok) await refreshUseCaseDrafts();
      return r;
    },
    [activeSchemaLabel, analysisDomainName, refreshUseCaseDrafts, domainAnalysis]
  );
  const setUseCaseDraftStatus = useCallback(
    async (draftId: string, status: DraftStatus) => {
      const ok = await setUseCaseProductStatus(draftId, status);
      if (ok) await refreshUseCaseDrafts();
      return ok;
    },
    [refreshUseCaseDrafts]
  );
  const removeUseCaseDraft = useCallback(
    async (draftId: string) => {
      const ok = await deleteUseCaseProduct(draftId);
      if (ok) await refreshUseCaseDrafts();
      return ok;
    },
    [refreshUseCaseDrafts]
  );
  const updateUseCaseDraft = useCallback(
    async (draftId: string, spec: UseCaseProductSpec) => {
      const ok = await updateUseCaseProduct(draftId, spec);
      if (ok) await refreshUseCaseDrafts();
      return ok;
    },
    [refreshUseCaseDrafts]
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
    storeSchema,
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
    refreshGraphLinks,
    productLinks: productLinksForArtifact,
    artifact,
    artifactStale,
    regenerateArtifact,
    domainAnalysis,
    domainAnalysisStale,
    domainAnalyzing,
    domainAnalysisLabel: analysisDomainLabel,
    regenerateDomainAnalysis,
    useCaseDrafts,
    describeUseCaseAsProduct,
    setUseCaseDraftStatus,
    removeUseCaseDraft,
    updateUseCaseDraft,
    isolationKey: sig,
    syncScopeFromSections,
    setSyncScopeFromSections,
    showActionCenter,
    setShowActionCenter,
    showBusinessView,
    setShowBusinessView,
    showControlTower,
    setShowControlTower,
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
