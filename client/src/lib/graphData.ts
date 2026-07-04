// Graph-data builders for the Graph Explorer's two Cytoscape views.
//   buildModelGraph()    — ER model from client/src/data/model.json (tables + FK
//                          edges, grouped into domain/subdomain compound nodes).
//   buildOntologyGraph() — ontology + lineage from ontology.json (source tables
//                          -> classes -> serving views -> product -> KPIs).
import ontology from '../data/ontology.json';
import modelJson from '../data/model.json';
import type { CyElementDef } from './cytoscape';

// ---------- model.json typed view --------------------------------------------
// The JSON import infers narrow per-element union types (not every attribute has
// foreign_key_to / primary_key / description), so we project it onto an explicit
// shape for ergonomic, type-safe access.
type ModelAttribute = {
  name: string;
  type: string;
  primary_key?: boolean;
  foreign_key_to?: string;
  description?: string;
};
type ModelProduct = {
  name: string;
  subdomain: string;
  description?: string;
  tags?: string[];
  attributes: ModelAttribute[];
};
type ModelDomain = {
  name: string;
  description?: string;
  division?: string;
  products: ModelProduct[];
};
type Model = { name: string; version: string; domains: ModelDomain[] };

const model = modelJson as unknown as Model;

// ---------- shared inspector model -------------------------------------------
export type Column = {
  name: string;
  type: string;
  pk: boolean;
  fk?: string; // foreign_key_to target
  description?: string;
};

export type InspectorNode = {
  id: string;
  label: string;
  kind: string; // table | domain | subdomain | source | class | view | product | kpi
  kindLabel: string;
  detail?: string;
  columns?: Column[];
  formula?: string;
  source?: string;
  // Feature 3 — graph "drivers" overlay for KPI/measure nodes
  drivers?: string[];
  related?: string[];
  // conformed shared dimension (combined view) — sources it was merged from
  conformed?: boolean;
  conformedSources?: string[];
  // section the "Open in" button should navigate to (ontology view only)
  openIn?: 'data-products' | 'ontology-studio' | 'business-view' | null;
  // external URL to open in a new window (genie / dashboard link nodes)
  openUrl?: string;
};

export type GraphData = {
  elements: CyElementDef[];
  nodes: Record<string, InspectorNode>;
};

// ===================== Tab 2: Ontology + lineage =============================
type Kind = 'source' | 'class' | 'view' | 'product' | 'kpi';
const KIND_LABEL: Record<Kind, string> = {
  source: 'Source table',
  class: 'Ontology class',
  view: 'Serving view',
  product: 'Data product',
  kpi: 'KPI',
};
const COL: Record<Kind, number> = { source: 0, class: 1, view: 2, product: 3, kpi: 4 };

const VIEWS = [
  'jai_store_day_traffic_labor',
  'jai_store_efficiency_summary',
  'jai_store_efficiency_opportunities',
];

const shortTable = (t: string) => t.split('.').pop() ?? t;

export function buildOntologyGraph(productName: string, productLabel: string): GraphData {
  const elements: CyElementDef[] = [];
  const nodes: Record<string, InspectorNode> = {};
  const colCount: Record<number, number> = {};

  const addNode = (
    id: string,
    label: string,
    kind: Kind,
    extra: Partial<InspectorNode> = {}
  ) => {
    const col = COL[kind];
    const row = colCount[col] ?? 0;
    colCount[col] = row + 1;
    elements.push({
      group: 'nodes',
      data: { id, label, kind },
      classes: `onto-node kind-${kind}`,
      position: { x: 80 + col * 250, y: 70 + row * 90 },
    });
    nodes[id] = {
      id,
      label,
      kind,
      kindLabel: KIND_LABEL[kind],
      openIn:
        kind === 'product'
          ? 'data-products'
          : kind === 'kpi' || kind === 'view'
            ? 'business-view'
            : 'ontology-studio',
      ...extra,
    };
  };
  let e = 0;
  const addEdge = (source: string, target: string, label?: string) => {
    if (!nodes[source] || !nodes[target]) return;
    elements.push({
      group: 'edges',
      data: { id: `oe:${e++}`, source, target, label: label ?? '' },
      classes: 'onto-edge',
    });
  };

  // 1. classes + their source tables
  const sourceSeen = new Set<string>();
  for (const c of ontology.classes) {
    addNode(`class:${c.class}`, c.label || c.class, 'class', {
      detail: c.comment || (c.derived ? 'Derived class' : `Grain: ${c.grain}`),
      source: c.source_table,
    });
    if (!c.derived && c.source_table && c.source_table !== '(derived)') {
      const tbl = shortTable(c.source_table);
      const sid = `source:${tbl}`;
      if (!sourceSeen.has(tbl)) {
        sourceSeen.add(tbl);
        addNode(sid, tbl, 'source', { detail: c.source_table });
      }
      addEdge(sid, `class:${c.class}`, 'maps to');
    }
  }
  if (!sourceSeen.has('storebonuses')) {
    addNode('source:storebonuses', 'storebonuses', 'source', { detail: 'region enrichment (A3)' });
  }
  addEdge('source:storebonuses', 'class:Store', 'region');

  // 2. ontology object properties (class -> class)
  for (const r of ontology.relationships) {
    for (const from of r.from) {
      addEdge(`class:${from}`, `class:${r.to}`, r.label);
    }
  }

  // 3. serving views
  for (const v of VIEWS) addNode(`view:${v}`, v, 'view', { detail: 'jai_ontos.demo_schema' });
  addEdge('class:StoreDayEfficiency', 'view:jai_store_day_traffic_labor', 'materializes');
  addEdge('view:jai_store_day_traffic_labor', 'view:jai_store_efficiency_summary', 'rolls up');
  addEdge('view:jai_store_efficiency_summary', 'view:jai_store_efficiency_opportunities', 'ranks');

  // 4. product
  const pid = `product:${productName}`;
  addNode(pid, productLabel, 'product', { detail: 'Governed data product' });
  for (const v of VIEWS) addEdge(`view:${v}`, pid, 'serves');

  // 5. derived KPIs
  for (const m of ontology.measures.filter((x) => x.type === 'derived')) {
    addNode(`kpi:${m.measure}`, m.measure, 'kpi', { detail: m.description, formula: m.formula });
    addEdge(pid, `kpi:${m.measure}`);
  }

  return { elements, nodes };
}

export const ONTO_KIND_COLOR: Record<string, string> = {
  source: '#64748b',
  class: '#2563eb',
  view: '#0891b2',
  product: '#7c3aed',
  kpi: '#16a34a',
};
export const ONTO_KIND_LABEL = KIND_LABEL;

// ===================== Explore (node-based travel) ===========================
// One merged graph over the ER entities (tables + FK edges from model.json) AND
// the ontology/lineage relationships (source tables -> classes -> serving views
// -> product -> KPIs). The travel UI ego-centers any node and rings its direct
// neighbors, so a user can walk source table -> serving view -> product -> KPI.

export type UnifiedNode = InspectorNode & { color: string };
export type UnifiedEdge = { id: string; source: string; target: string; label: string };
export type UnifiedGraph = {
  nodes: Record<string, UnifiedNode>;
  edges: UnifiedEdge[];
  // ids of the "entry point" overview (top of the lineage: the data product)
  entryIds: string[];
};

// kind -> color + legend label for the unified/travel graph
export const UNIFIED_KIND_COLOR: Record<string, string> = {
  dimension: '#0891b2', // cyan  (Dimensions)
  fact: '#64748b', // slate (Source facts)
  view: '#7c3aed', // violet (Serving views)
  class: '#2563eb', // blue  (Ontology classes)
  product: '#db2777', // pink  (Data product)
  kpi: '#16a34a', // green (KPIs)
};
export const UNIFIED_KIND_LABEL: Record<string, string> = {
  dimension: 'Dimension table',
  fact: 'Source fact',
  view: 'Serving view',
  class: 'Ontology class',
  product: 'Data product',
  kpi: 'KPI',
};

const SUBDOMAIN_KIND: Record<string, keyof typeof UNIFIED_KIND_COLOR> = {
  Dimensions: 'dimension',
  'Source facts': 'fact',
  'Serving views': 'view',
};

export function buildUnifiedGraph(productName: string, productLabel: string): UnifiedGraph {
  const nodes: Record<string, UnifiedNode> = {};
  const edges: UnifiedEdge[] = [];
  let e = 0;
  const addEdge = (source: string, target: string, label = '') => {
    if (!nodes[source] || !nodes[target] || source === target) return;
    if (edges.some((x) => x.source === source && x.target === target)) return;
    edges.push({ id: `ue:${e++}`, source, target, label });
  };

  const domain = model.domains[0];

  // 1. tables (dimensions / facts / serving views) with columns + FK info
  for (const p of domain.products) {
    const kind = SUBDOMAIN_KIND[p.subdomain] ?? 'fact';
    const id = `tbl:${p.name}`;
    nodes[id] = {
      id,
      label: p.name,
      kind,
      kindLabel: UNIFIED_KIND_LABEL[kind],
      color: UNIFIED_KIND_COLOR[kind],
      detail: p.description,
      openIn: kind === 'view' ? 'business-view' : 'ontology-studio',
      columns: p.attributes.map((a) => ({
        name: a.name,
        type: a.type,
        pk: a.primary_key === true,
        fk: a.foreign_key_to,
        description: a.description,
      })),
    };
  }
  // FK edges between tables
  for (const p of domain.products) {
    for (const a of p.attributes) {
      if (!a.foreign_key_to) continue;
      const target = `tbl:${a.foreign_key_to.split('.')[1]}`;
      addEdge(`tbl:${p.name}`, target, `${a.name} (FK)`);
    }
  }

  // 2. ontology classes + class<->source-table + class<->class edges
  for (const c of ontology.classes) {
    const id = `class:${c.class}`;
    nodes[id] = {
      id,
      label: c.label || c.class,
      kind: 'class',
      kindLabel: UNIFIED_KIND_LABEL.class,
      color: UNIFIED_KIND_COLOR.class,
      detail: c.comment || (c.derived ? 'Derived class' : `Grain: ${c.grain}`),
      source: c.source_table,
      openIn: 'ontology-studio',
    };
    if (!c.derived && c.source_table && c.source_table !== '(derived)') {
      addEdge(`tbl:${shortTable(c.source_table)}`, id, 'maps to');
    }
  }
  for (const r of ontology.relationships) {
    for (const from of r.from) addEdge(`class:${from}`, `class:${r.to}`, r.label);
  }
  // derived class materializes into the day-grain serving view
  addEdge('class:StoreDayEfficiency', 'tbl:jai_store_day_traffic_labor', 'materializes');

  // 3. product + KPIs (serving views -> product -> KPIs)
  const pid = `product:${productName}`;
  nodes[pid] = {
    id: pid,
    label: productLabel,
    kind: 'product',
    kindLabel: UNIFIED_KIND_LABEL.product,
    color: UNIFIED_KIND_COLOR.product,
    detail: 'Governed data product',
    openIn: 'data-products',
  };
  for (const v of VIEWS) addEdge(`tbl:${v}`, pid, 'serves');

  for (const m of ontology.measures.filter((x) => x.type === 'derived')) {
    const id = `kpi:${m.measure}`;
    nodes[id] = {
      id,
      label: m.measure,
      kind: 'kpi',
      kindLabel: UNIFIED_KIND_LABEL.kpi,
      color: UNIFIED_KIND_COLOR.kpi,
      detail: m.description,
      formula: m.formula,
      openIn: 'business-view',
    };
    addEdge(pid, id);
  }

  return { nodes, edges, entryIds: [pid] };
}
