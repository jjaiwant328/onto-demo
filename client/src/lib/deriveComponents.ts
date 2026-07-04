// deriveComponents — the reusable "skill" that turns ANY catalog product into the
// components every section needs, deterministically and client-side at selection
// time (near real time, from the real fc_entdata_gold schema). No synthetic data.
//
// Adding a product to catalog.json is all that's required to light it up: every
// section consumes deriveProduct()'s output.
import type {
  GraphData,
  InspectorNode,
  UnifiedGraph,
  UnifiedNode,
  UnifiedEdge,
} from './graphData';
import { UNIFIED_KIND_COLOR, UNIFIED_KIND_LABEL, ONTO_KIND_COLOR } from './graphData';

// ---------- catalog / schema types ------------------------------------------
export type CatalogProduct = {
  product_name: string;
  display_name: string;
  business_outcome: string;
  fact_tables: string[];
  dim_tables: string[];
  kpis: string[];
  live?: boolean;
  maturity: string;
  // data-backed demo product: real backing table + exception data in the serving
  // schema. Surfaced as a "Data Avlbl" badge and enables the "Use Data Avlbl" path.
  dataAvailable?: boolean;
};
export type CatalogDomain = {
  name: string;
  label: string;
  description: string;
  products: CatalogProduct[];
  // when this domain is a session merge of others, the original domain names
  // (used to offer an "un-merge" that restores the constituents from the base).
  mergedFrom?: string[];
  // true for the injected data-backed demo domains
  dataAvailable?: boolean;
};
export type Catalog = { domains: CatalogDomain[] };

export type SchemaColumn = { name: string; type: string; comment?: string };
export type Schema = Record<string, SchemaColumn[]>;

// ---------- derived component shapes (consumed by every section) -------------
export type ColRole = 'key' | 'measure' | 'attribute';

export type DerivedClass = {
  class: string; // id-ish (humanized table)
  label: string;
  grain: string;
  source_table: string;
  derived: boolean;
  role: 'fact' | 'dim' | 'product' | 'view';
  comment: string;
};
// provenance of an inferred component
export type Origin = 'heuristic' | 'llm' | 'user';
export type DerivedMapping = {
  class: string;
  property: string;
  role: ColRole;
  source: string;
  column: string;
  type: string;
  pii?: boolean; // user-flagged PII
  origin?: Origin; // 'user' once a role/pii override is applied
};
export type DerivedRelationship = {
  predicate: string;
  label: string;
  from: string[];
  to: string;
  origin?: Origin; // heuristic | llm | user
  confidence?: number; // 0..1
  status?: 'confirmed' | 'rejected'; // user confirm/reject (edge_status override)
};
export type DerivedMeasure = {
  measure: string;
  type: 'base' | 'derived';
  unit: string;
  formula: string;
  description: string;
  // Feature 3 — graph "drivers" overlay (deterministic, no new data):
  drivers?: string[]; // base measures/columns + joined dims this measure depends on
  related?: string[]; // other measures sharing an input with this one
};
export type DerivedTable = {
  table: string; // "cdm_xx.table"
  label: string;
  role: 'fact' | 'dim';
  columns: { name: string; type: string; role: ColRole; comment?: string }[];
};

export type DerivedComponents = {
  productName: string;
  productLabel: string;
  live: boolean;
  classes: DerivedClass[];
  mappings: DerivedMapping[];
  relationships: DerivedRelationship[];
  measures: DerivedMeasure[];
  kpis: string[];
  tables: DerivedTable[];
  unified: UnifiedGraph; // Explore (travel)
  ontologyGraph: GraphData; // Ontology + lineage tab
};

// ---------- helpers ----------------------------------------------------------
const NUMERIC = /^(int|integer|bigint|smallint|tinyint|long|decimal|numeric|double|float|real)/i;
const KEYISH = /(_key$|_id$|_number$|_num$|_code$)/i;
const WELL_KNOWN_KEYS = new Set([
  'store_number',
  'store_num',
  'store_key',
  'date_key',
  'business_date_key',
  'transaction_date_key',
  'item_key',
  'item_id',
  'customer_id',
  'cust_id',
  'product_key',
]);

function shortName(table: string): string {
  return table.split('.').pop() ?? table;
}
function humanize(table: string): string {
  return shortName(table)
    .replace(/^(dim_|fact_|smmry_|summary_)/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
function isNumeric(type: string): boolean {
  return NUMERIC.test(type.trim());
}
function colRole(name: string, type: string, isFact: boolean): ColRole {
  const lower = name.toLowerCase();
  if (WELL_KNOWN_KEYS.has(lower) || KEYISH.test(lower)) return 'key';
  if (isFact && isNumeric(type)) return 'measure';
  return 'attribute';
}

// FK heuristic: a (key) column on table A whose name is also a key column on a dim
// table B implies A -> B. Plus a few normalized aliases (store_num -> store_number).
const KEY_ALIASES: Record<string, string> = {
  store_num: 'store_number',
  storenumber: 'store_number',
  business_date_key: 'date_key',
  transaction_date_key: 'date_key',
};
function normalizeKey(name: string): string {
  const l = name.toLowerCase();
  return KEY_ALIASES[l] ?? l;
}

export function deriveProduct(product: CatalogProduct, schema: Schema): DerivedComponents {
  const factTables = product.fact_tables.filter((t) => schema[t]);
  const dimTables = product.dim_tables.filter((t) => schema[t]);
  const allTables = [...factTables, ...dimTables];

  // ----- tables (with column shapes) -----
  const tables: DerivedTable[] = allTables.map((t) => {
    const isFact = factTables.includes(t);
    return {
      table: t,
      label: humanize(t),
      role: isFact ? 'fact' : 'dim',
      columns: (schema[t] ?? []).map((c) => ({
        name: c.name,
        type: c.type,
        role: colRole(c.name, c.type, isFact),
        comment: c.comment && c.comment !== 'null' ? c.comment : undefined,
      })),
    };
  });

  // ----- classes (one per table) -----
  const classes: DerivedClass[] = allTables.map((t) => {
    const isFact = factTables.includes(t);
    return {
      class: shortName(t),
      label: humanize(t),
      grain: isFact ? 'fact (event/measure grain)' : 'dimension',
      source_table: t,
      derived: false,
      role: isFact ? 'fact' : 'dim',
      comment: isFact ? 'Fact / measure source' : 'Conformed dimension',
    };
  });

  // ----- mappings (columns) -----
  const mappings: DerivedMapping[] = [];
  for (const t of allTables) {
    const isFact = factTables.includes(t);
    for (const c of schema[t] ?? []) {
      mappings.push({
        class: shortName(t),
        property: c.name,
        role: colRole(c.name, c.type, isFact),
        source: t,
        column: c.name,
        type: c.type,
        origin: 'heuristic',
      });
    }
  }

  // ----- FK relationships (shared-key heuristic: fact key cols -> dim) -----
  // Build dim key index: normalizedKey -> dim short table name(s)
  const dimKeyIndex = new Map<string, string[]>();
  for (const t of dimTables) {
    for (const c of schema[t] ?? []) {
      if (colRole(c.name, c.type, false) !== 'key') continue;
      const k = normalizeKey(c.name);
      const arr = dimKeyIndex.get(k) ?? [];
      if (!arr.includes(shortName(t))) arr.push(shortName(t));
      dimKeyIndex.set(k, arr);
    }
  }
  const relationships: DerivedRelationship[] = [];
  const fkEdges: { from: string; to: string; label: string }[] = [];
  const seenRel = new Set<string>();
  for (const t of factTables) {
    for (const c of schema[t] ?? []) {
      if (colRole(c.name, c.type, true) !== 'key') continue;
      const k = normalizeKey(c.name);
      const targets = dimKeyIndex.get(k) ?? [];
      for (const dim of targets) {
        if (shortName(t) === dim) continue;
        const id = `${shortName(t)}->${dim}:${c.name}`;
        if (seenRel.has(id)) continue;
        seenRel.add(id);
        // shared-key exact match on a key column both sides → high confidence
        const exactName = schema[t]?.some((x) => x.name === c.name) &&
          (dimTables.find((d) => shortName(d) === dim)
            ? (schema[dimTables.find((d) => shortName(d) === dim) as string] ?? []).some(
                (x) => x.name === c.name
              )
            : false);
        relationships.push({
          predicate: c.name,
          label: `${c.name} → ${dim}`,
          from: [shortName(t)],
          to: dim,
          origin: 'heuristic',
          confidence: exactName ? 0.9 : 0.6, // exact key-name match = high; normalized-only = medium
        });
        fkEdges.push({ from: shortName(t), to: dim, label: `${c.name} (FK)` });
      }
    }
  }

  // ----- measures: numeric measure-columns on fact tables + headline KPIs -----
  const measures: DerivedMeasure[] = [];
  const seenMeasure = new Set<string>();
  for (const t of factTables) {
    const isFact = true;
    for (const c of schema[t] ?? []) {
      if (colRole(c.name, c.type, isFact) !== 'measure') continue;
      if (seenMeasure.has(c.name)) continue;
      seenMeasure.add(c.name);
      measures.push({
        measure: c.name,
        type: 'base',
        unit: c.type,
        formula: `sum(${c.name})`,
        description: `Additive measure from ${shortName(t)}`,
      });
    }
  }
  for (const k of product.kpis) {
    if (seenMeasure.has(k)) continue;
    seenMeasure.add(k);
    measures.push({
      measure: k,
      type: 'derived',
      unit: 'kpi',
      formula: 'headline KPI (definition curated in the product contract)',
      description: 'Headline KPI for this product',
    });
  }

  // ----- Feature 3: per-measure drivers + related (deterministic) -----
  // A measure's drivers = the base measures / columns referenced in its formula,
  // plus the joined dimension tables (the conformed context it's sliced by).
  const measureNames = new Set(measures.map((m) => m.measure));
  const factColNames = new Set(
    factTables.flatMap((t) => (schema[t] ?? []).map((c) => c.name.toLowerCase()))
  );
  const joinedDims = dimTables.map((t) => shortName(t));
  const driverMap: Record<string, string[]> = {};
  for (const m of measures) {
    const idents = (m.formula.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []).filter(
      (tok) => !['sum', 'count', 'distinct', 'nullif', 'case', 'when', 'then', 'end', 'avg', 'min', 'max', 'and', 'or', 'else', 'null', 'as', 'coalesce'].includes(tok)
    );
    const refs = new Set<string>();
    for (const id of idents) {
      if (id === m.measure.toLowerCase()) continue;
      if (measureNames.has(id) || factColNames.has(id)) refs.add(id);
    }
    // derived KPIs without a parsed formula: fall back to the base measures
    if (m.type === 'derived' && refs.size === 0) {
      for (const bm of measures) if (bm.type === 'base') refs.add(bm.measure);
    }
    const drivers = [...refs, ...joinedDims.map((d) => `${d} (dim)`)];
    driverMap[m.measure] = [...refs]; // for relatedness (measures/cols only)
    m.drivers = drivers;
  }
  // related = measures that share at least one driver input
  for (const m of measures) {
    const mine = new Set(driverMap[m.measure] ?? []);
    m.related = measures
      .filter((o) => o.measure !== m.measure && (driverMap[o.measure] ?? []).some((d) => mine.has(d)))
      .map((o) => o.measure);
  }

  // ----- unified travel graph (tables + FK + serving view + product + KPIs) ---
  const nodes: Record<string, UnifiedNode> = {};
  const edges: UnifiedEdge[] = [];
  let e = 0;
  const addEdge = (source: string, target: string, label = '') => {
    if (!nodes[source] || !nodes[target] || source === target) return;
    if (edges.some((x) => x.source === source && x.target === target)) return;
    edges.push({ id: `de:${e++}`, source, target, label });
  };

  const tableNodeId = (t: string) => `tbl:${shortName(t)}`;
  for (const t of allTables) {
    const isFact = factTables.includes(t);
    const kind = isFact ? 'fact' : 'dimension';
    const id = tableNodeId(t);
    nodes[id] = {
      id,
      label: shortName(t),
      kind,
      kindLabel: UNIFIED_KIND_LABEL[kind],
      color: UNIFIED_KIND_COLOR[kind],
      detail: `${isFact ? 'Fact' : 'Dimension'} · ${t}`,
      openIn: 'ontology-studio',
      columns: (schema[t] ?? []).map((c) => ({
        name: c.name,
        type: c.type,
        pk: colRole(c.name, c.type, isFact) === 'key',
        description: c.comment && c.comment !== 'null' ? c.comment : undefined,
      })),
    };
  }
  for (const fk of fkEdges) addEdge(`tbl:${fk.from}`, `tbl:${fk.to}`, fk.label);

  // serving-view node only for live products
  let viewId: string | null = null;
  if (product.live) {
    viewId = `view:${product.product_name}`;
    nodes[viewId] = {
      id: viewId,
      label: `${product.product_name} (serving)`,
      kind: 'view',
      kindLabel: UNIFIED_KIND_LABEL.view,
      color: UNIFIED_KIND_COLOR.view,
      detail: 'Governed serving view (jai_ontos.demo_schema)',
      openIn: 'business-view',
    };
    for (const t of factTables) addEdge(tableNodeId(t), viewId, 'serves');
  }

  // product node
  const pid = `product:${product.product_name}`;
  nodes[pid] = {
    id: pid,
    label: product.display_name,
    kind: 'product',
    kindLabel: UNIFIED_KIND_LABEL.product,
    color: UNIFIED_KIND_COLOR.product,
    detail: product.business_outcome,
    openIn: 'data-products',
  };
  if (viewId) addEdge(viewId, pid, 'produces');
  else for (const t of factTables) addEdge(tableNodeId(t), pid, 'feeds');

  // KPI nodes (carry drivers/related for the graph "drivers" overlay)
  const measureByName = new Map(measures.map((m) => [m.measure, m]));
  for (const k of product.kpis) {
    const id = `kpi:${k}`;
    const m = measureByName.get(k);
    nodes[id] = {
      id,
      label: k,
      kind: 'kpi',
      kindLabel: UNIFIED_KIND_LABEL.kpi,
      color: UNIFIED_KIND_COLOR.kpi,
      detail: 'Headline KPI',
      formula: m?.formula,
      drivers: m?.drivers,
      related: m?.related,
      openIn: 'business-view',
    };
    addEdge(pid, id);
  }

  const unified: UnifiedGraph = { nodes, edges, entryIds: [pid] };

  // ----- ontology+lineage graph (static layered: tables -> view? -> product -> KPIs) -----
  const ontoEls: GraphData['elements'] = [];
  const ontoNodes: Record<string, InspectorNode> = {};
  const colCount: Record<number, number> = {};
  const addOnto = (
    id: string,
    label: string,
    cssKind: 'source' | 'class' | 'view' | 'product' | 'kpi',
    col: number,
    extra: Partial<InspectorNode> = {}
  ) => {
    const row = colCount[col] ?? 0;
    colCount[col] = row + 1;
    ontoEls.push({
      group: 'nodes',
      data: { id, label, kind: cssKind },
      classes: `onto-node kind-${cssKind}`,
      position: { x: 80 + col * 250, y: 60 + row * 84 },
    });
    ontoNodes[id] = { id, label, kind: cssKind, kindLabel: cssKind, ...extra };
  };
  let oe = 0;
  const addOntoEdge = (s: string, t: string, label = '') => {
    if (!ontoNodes[s] || !ontoNodes[t]) return;
    ontoEls.push({ group: 'edges', data: { id: `oe:${oe++}`, source: s, target: t, label }, classes: 'onto-edge' });
  };
  for (const t of allTables) {
    addOnto(`o:${shortName(t)}`, shortName(t), 'source', 0, {
      detail: t,
      kindLabel: factTables.includes(t) ? 'Fact table' : 'Dimension table',
      openIn: 'ontology-studio',
    });
  }
  const oviewId = product.live ? `o:view` : null;
  if (oviewId) {
    addOnto(oviewId, `${product.product_name} (serving)`, 'view', 1, {
      detail: 'Governed serving view',
      kindLabel: 'Serving view',
      openIn: 'business-view',
    });
    for (const t of factTables) addOntoEdge(`o:${shortName(t)}`, oviewId, 'serves');
  }
  const opid = `o:product`;
  addOnto(opid, product.display_name, 'product', 2, {
    detail: product.business_outcome,
    kindLabel: 'Data product',
    openIn: 'data-products',
  });
  if (oviewId) addOntoEdge(oviewId, opid, 'produces');
  else for (const t of factTables) addOntoEdge(`o:${shortName(t)}`, opid, 'feeds');
  for (const k of product.kpis) {
    addOnto(`o:kpi:${k}`, k, 'kpi', 3, { detail: 'Headline KPI', kindLabel: 'KPI', openIn: 'business-view' });
    addOntoEdge(opid, `o:kpi:${k}`);
  }
  // a touch of color parity with the curated ontology view
  void ONTO_KIND_COLOR;

  const ontologyGraph: GraphData = { elements: ontoEls, nodes: ontoNodes };

  return {
    productName: product.product_name,
    productLabel: product.display_name,
    live: !!product.live,
    classes,
    mappings,
    relationships,
    measures,
    kpis: product.kpis,
    tables,
    unified,
    ontologyGraph,
  };
}

// ===================== Enterprise map (one full graph) =======================
// One graph spanning everything: enterprise -> 6 domains -> 24 products ->
// deduplicated tables (shared dims are a single node linked to every product) ->
// metric views (live serving views for the flagship; one "planned" node per
// non-live product). The Explore tab renders this whole map and HIGHLIGHTS the
// current selection rather than filtering it.

export const ENTERPRISE_KIND_COLOR: Record<string, string> = {
  enterprise: '#0f172a', // near-black
  domain: '#7c3aed', // violet
  product: '#db2777', // pink
  fact: '#64748b', // slate
  dim: '#0891b2', // cyan
  metric_view: '#16a34a', // green
  genie: '#9333ea', // purple — Genie Space
  dashboard: '#ea580c', // orange — AI/BI dashboard
};
export const ENTERPRISE_KIND_LABEL: Record<string, string> = {
  enterprise: 'Enterprise',
  domain: 'Domain',
  product: 'Data product',
  fact: 'Fact table',
  dim: 'Dimension table',
  metric_view: 'Metric view',
  genie: 'Genie Space',
  dashboard: 'Dashboard',
};

// a product link to overlay on the enterprise graph (from product_links)
export type GraphProductLink = {
  product: string; // matches CatalogProduct.display_name
  link_type: 'genie' | 'dashboard' | string;
  url: string;
  label?: string;
};

export const ENTERPRISE_ROOT_ID = 'ent:root';

// a shared dimension/table and the products it connects (conformed lineage)
export type SharedDimension = {
  nodeId: string;
  label: string;
  products: { product_name: string; display_name: string }[];
  domains: string[];
};
export type EnterpriseGraph = UnifiedGraph & {
  // membership: nodeId -> set of product ids it belongs to (for highlight calc)
  highlightFor: (domainName: string | null, productName: string | null) => Set<string>;
  // products connected to a given node (for the "Shared across" inspector panel)
  productsForNode: (nodeId: string) => { product_name: string; display_name: string }[];
  // dimensions/tables shared across 2+ products (the enterprise-ontology payoff)
  sharedDimensions: SharedDimension[];
};

const SERVING_VIEWS_LIVE = [
  'jai_store_day_traffic_labor',
  'jai_store_efficiency_summary',
  'jai_store_efficiency_opportunities',
];

export function buildEnterpriseGraph(
  catalog: Catalog,
  schema: Schema,
  conformedTables?: Record<string, string[]>,
  productLinks?: GraphProductLink[]
): EnterpriseGraph {
  // index attached links by product display_name for quick per-product lookup
  const linksByProduct = new Map<string, GraphProductLink[]>();
  for (const l of productLinks ?? []) {
    if (!l.url) continue;
    (linksByProduct.get(l.product) ?? linksByProduct.set(l.product, []).get(l.product)!).push(l);
  }
  // index conformed provenance by short table name (enterprise nodes key on it)
  const conformedByShort = new Map<string, string[]>();
  for (const [key, sources] of Object.entries(conformedTables ?? {})) {
    conformedByShort.set(shortName(key), sources);
  }
  const nodes: Record<string, UnifiedNode> = {};
  const edges: UnifiedEdge[] = [];
  let e = 0;
  const addEdge = (source: string, target: string, label = '') => {
    if (!nodes[source] || !nodes[target] || source === target) return;
    if (edges.some((x) => x.source === source && x.target === target)) return;
    edges.push({ id: `ee:${e++}`, source, target, label });
  };

  // per-node membership in products (drives highlight); domain membership too.
  const nodeProducts = new Map<string, Set<string>>();
  const nodeDomains = new Map<string, Set<string>>();
  const tag = (id: string, productName: string, domainName: string) => {
    (nodeProducts.get(id) ?? nodeProducts.set(id, new Set()).get(id)!).add(productName);
    (nodeDomains.get(id) ?? nodeDomains.set(id, new Set()).get(id)!).add(domainName);
  };
  // product_name → display_name (for the "Shared across" panel)
  const productDisplay = new Map<string, string>();
  for (const d of catalog.domains) for (const p of d.products) productDisplay.set(p.product_name, p.display_name);

  // 1. enterprise root — derive the label from the ACTIVE schema (never hardcode
  // a specific schema name, or a non-Retailer selection appears to leak Retailer).
  const rootPrefix = (() => {
    const firstTable = Object.keys(schema)[0] ?? '';
    const ucSchema = firstTable.includes('.') ? firstTable.split('.')[0] : firstTable;
    return ucSchema || 'Active';
  })();
  nodes[ENTERPRISE_ROOT_ID] = {
    id: ENTERPRISE_ROOT_ID,
    label: `${rootPrefix} Enterprise`,
    kind: 'enterprise',
    kindLabel: ENTERPRISE_KIND_LABEL.enterprise,
    color: ENTERPRISE_KIND_COLOR.enterprise,
    detail: `${catalog.domains.length} domains · ${catalog.domains.reduce((n, d) => n + d.products.length, 0)} data products`,
  };

  // global dim-key index (across ALL dim tables) for the FK heuristic
  const dimKeyIndex = new Map<string, Set<string>>(); // normalizedKey -> short dim table names
  const allDimTables = new Set<string>();
  for (const d of catalog.domains) for (const p of d.products) for (const t of p.dim_tables) allDimTables.add(t);
  for (const t of allDimTables) {
    for (const c of schema[t] ?? []) {
      if (colRole(c.name, c.type, false) !== 'key') continue;
      const k = normalizeKey(c.name);
      (dimKeyIndex.get(k) ?? dimKeyIndex.set(k, new Set()).get(k)!).add(shortName(t));
    }
  }
  const tableNodeId = (t: string) => `etbl:${shortName(t)}`;
  // track how each unique table is used (fact in any product => fact)
  const tableIsFact = new Map<string, boolean>();
  const tableFullName = new Map<string, string>();
  for (const d of catalog.domains) {
    for (const p of d.products) {
      for (const t of p.fact_tables) {
        tableIsFact.set(shortName(t), true);
        tableFullName.set(shortName(t), t);
      }
      for (const t of p.dim_tables) {
        if (!tableIsFact.has(shortName(t))) tableIsFact.set(shortName(t), false);
        tableFullName.set(shortName(t), t);
      }
    }
  }

  for (const d of catalog.domains) {
    // 2. domain node
    const did = `dom:${d.name}`;
    nodes[did] = {
      id: did,
      label: d.label,
      kind: 'domain',
      kindLabel: ENTERPRISE_KIND_LABEL.domain,
      color: ENTERPRISE_KIND_COLOR.domain,
      detail: d.description,
    };
    addEdge(ENTERPRISE_ROOT_ID, did, 'contains');

    for (const p of d.products) {
      // 3. product node
      const pid = `prod:${p.product_name}`;
      nodes[pid] = {
        id: pid,
        label: p.display_name,
        kind: 'product',
        kindLabel: ENTERPRISE_KIND_LABEL.product,
        color: ENTERPRISE_KIND_COLOR.product,
        detail: p.business_outcome,
        openIn: 'data-products',
      };
      tag(pid, p.product_name, d.name);
      tag(did, p.product_name, d.name);
      addEdge(did, pid, 'contains');

      // 3b. attached links (Genie Space / Dashboard) as first-class child nodes
      for (const link of linksByProduct.get(p.display_name) ?? []) {
        const kind = link.link_type === 'dashboard' ? 'dashboard' : 'genie';
        const lid = `link:${kind}:${p.product_name}`;
        nodes[lid] = {
          id: lid,
          label: link.label || ENTERPRISE_KIND_LABEL[kind],
          kind,
          kindLabel: ENTERPRISE_KIND_LABEL[kind],
          color: ENTERPRISE_KIND_COLOR[kind],
          detail: `${ENTERPRISE_KIND_LABEL[kind]} — click to open in a new window`,
          openUrl: link.url,
        };
        tag(lid, p.product_name, d.name);
        addEdge(pid, lid, kind === 'dashboard' ? 'dashboard' : 'explore');
      }

      // 4. tables (dedup shared nodes; tag membership per product)
      const factShorts = new Set(p.fact_tables.map(shortName));
      for (const t of [...p.fact_tables, ...p.dim_tables]) {
        if (!schema[t]) continue;
        const sid = tableNodeId(t);
        const isFact = factShorts.has(shortName(t));
        if (!nodes[sid]) {
          const usedAsFact = tableIsFact.get(shortName(t)) === true;
          const kind = usedAsFact ? 'fact' : 'dim';
          const conformedSources = conformedByShort.get(shortName(t));
          nodes[sid] = {
            id: sid,
            label: shortName(t),
            kind,
            kindLabel: conformedSources
              ? `${ENTERPRISE_KIND_LABEL[kind]} · conformed`
              : ENTERPRISE_KIND_LABEL[kind],
            color: ENTERPRISE_KIND_COLOR[kind],
            detail: conformedSources
              ? `${t} · ${(schema[t] ?? []).length} columns · conformed shared dimension across ${conformedSources.join(', ')}`
              : `${t} · ${(schema[t] ?? []).length} columns`,
            source: t,
            conformed: Boolean(conformedSources),
            conformedSources,
            openIn: 'ontology-studio',
            columns: (schema[t] ?? []).map((c) => ({
              name: c.name,
              type: c.type,
              pk: colRole(c.name, c.type, usedAsFact) === 'key',
              description: c.comment && c.comment !== 'null' ? c.comment : undefined,
            })),
          };
        }
        tag(sid, p.product_name, d.name);
        addEdge(pid, sid, isFact ? 'uses fact' : 'uses dim');
      }
      // fact -> dim FK edges (within the product's tables, via global dim index)
      for (const ft of p.fact_tables) {
        if (!schema[ft]) continue;
        for (const c of schema[ft] ?? []) {
          if (colRole(c.name, c.type, true) !== 'key') continue;
          const targets = dimKeyIndex.get(normalizeKey(c.name)) ?? new Set();
          for (const dimShort of targets) {
            if (dimShort === shortName(ft)) continue;
            // only link to a dim the product actually uses
            if (!p.dim_tables.some((dt) => shortName(dt) === dimShort)) continue;
            addEdge(tableNodeId(ft), `etbl:${dimShort}`, `${c.name} (FK)`);
          }
        }
      }

      // 5. metric views
      if (p.live) {
        for (const v of SERVING_VIEWS_LIVE) {
          const mid = `mv:${v}`;
          if (!nodes[mid]) {
            nodes[mid] = {
              id: mid,
              label: v,
              kind: 'metric_view',
              kindLabel: ENTERPRISE_KIND_LABEL.metric_view,
              color: ENTERPRISE_KIND_COLOR.metric_view,
              detail: 'Governed serving view (jai_ontos.demo_schema) — live',
              openIn: 'business-view',
            };
          }
          tag(mid, p.product_name, d.name);
          addEdge(pid, mid, 'serves');
        }
      } else {
        const mid = `mv:${p.product_name}`;
        nodes[mid] = {
          id: mid,
          label: `${p.product_name} (planned)`,
          kind: 'metric_view',
          kindLabel: ENTERPRISE_KIND_LABEL.metric_view,
          color: ENTERPRISE_KIND_COLOR.metric_view,
          detail: 'Planned metric view — not yet materialized (no live serving layer)',
          openIn: 'business-view',
        };
        tag(mid, p.product_name, d.name);
        addEdge(pid, mid, 'planned');
      }
    }
  }

  const highlightFor = (domainName: string | null, productName: string | null): Set<string> => {
    const set = new Set<string>([ENTERPRISE_ROOT_ID]);
    if (productName) {
      for (const [id, prods] of nodeProducts) if (prods.has(productName)) set.add(id);
      // include the product's domain node
      for (const [id, doms] of nodeDomains) {
        if (domainName && doms.has(domainName) && id.startsWith('dom:')) set.add(id);
      }
    } else if (domainName) {
      for (const [id, doms] of nodeDomains) if (doms.has(domainName)) set.add(id);
    }
    return set;
  };

  const productsForNode = (nodeId: string): { product_name: string; display_name: string }[] => {
    const prods = nodeProducts.get(nodeId);
    if (!prods) return [];
    return [...prods]
      .map((pn) => ({ product_name: pn, display_name: productDisplay.get(pn) ?? pn }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  };

  // dimensions/tables (etbl: nodes) connected to 2+ products = shared/conformed
  const sharedDimensions: SharedDimension[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (!id.startsWith('etbl:')) continue;
    const prods = productsForNode(id);
    if (prods.length < 2) continue;
    const domains = [...(nodeDomains.get(id) ?? new Set<string>())];
    sharedDimensions.push({ nodeId: id, label: node.label, products: prods, domains });
  }
  sharedDimensions.sort((a, b) => b.products.length - a.products.length);

  return {
    nodes,
    edges,
    entryIds: [ENTERPRISE_ROOT_ID],
    highlightFor,
    productsForNode,
    sharedDimensions,
  };
}
