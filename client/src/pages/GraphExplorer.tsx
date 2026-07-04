// Graph Explorer — Cytoscape-based viewer with a two-view toggle, driven by the
// selected product's DERIVED components (works for any catalog product):
//   Tab 1 "Explore"            — node-based TRAVEL (ego-graph focus+context).
//   Tab 2 "Ontology + lineage" — static layered overview map.
// Cytoscape is the CDN global (window.cytoscape); styling/interaction adapted
// from the databricks-industry-solutions model-viewer reference.
import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@databricks/appkit-ui/react';
import { X, Database, KeyRound, Link2, Info, Activity, Layers } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useProduct } from '../lib/product';
import { Badge } from '@databricks/appkit-ui/react';
import { CatalogLoadingSkeleton } from '../components/LoadingSkeleton';
import { CytoscapeCanvas } from './CytoscapeCanvas';
import { TravelCanvas } from './TravelCanvas';
import { ONTO_KIND_COLOR, type InspectorNode } from '../lib/graphData';
import { ENTERPRISE_KIND_COLOR, ENTERPRISE_KIND_LABEL } from '../lib/deriveComponents';
import type { CyStyle } from '../lib/cytoscape';

// canvas gets the majority of the screen
const CANVAS_HEIGHT = 760;

// ---------- Tab 1 (travel) stylesheet ---------------------------------------
const travelStyle: CyStyle[] = [
  {
    selector: '.travel-node',
    style: {
      shape: 'round-rectangle',
      'background-color': 'data(color)',
      'background-opacity': 0.9,
      'border-width': 2,
      'border-color': '#ffffff',
      label: 'data(label)',
      'font-size': 11,
      'font-weight': 600,
      color: '#ffffff',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': 130,
      width: 150,
      height: 40,
    },
  },
  {
    selector: '.center-node',
    style: {
      'border-width': 5,
      'border-color': '#f59e0b',
      width: 180,
      height: 52,
      'font-size': 13,
      'z-index': 10,
    },
  },
  { selector: '.fk-source', style: { 'border-color': '#10b981', 'border-width': 3 } }, // incoming
  { selector: '.fk-target', style: { 'border-color': '#f87171', 'border-width': 3 } }, // outgoing
  {
    selector: '.travel-edge',
    style: {
      width: 1.8,
      'line-color': '#cbd5e1',
      'target-arrow-color': '#94a3b8',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': 8,
      color: '#64748b',
      'text-background-color': '#ffffff',
      'text-background-opacity': 0.85,
      'text-background-padding': 2,
    },
  },
  { selector: '.in-edge', style: { 'line-color': '#10b981', 'target-arrow-color': '#10b981' } },
  { selector: '.out-edge', style: { 'line-color': '#f87171', 'target-arrow-color': '#f87171' } },
  // overview highlight (selection subtree) vs dimmed-but-visible rest
  { selector: 'node.dim', style: { opacity: 0.16 } },
  { selector: 'edge.dim', style: { opacity: 0.08 } },
  {
    selector: 'node.hl',
    style: { opacity: 1, 'border-width': 3, 'border-color': '#2563eb' },
  },
  {
    selector: 'edge.hl',
    style: { opacity: 1, width: 2.6, 'line-color': '#2563eb', 'target-arrow-color': '#2563eb' },
  },
];

// ---------- Tab 2 (ontology overview) stylesheet ----------------------------
const baseHighlight: CyStyle[] = [
  { selector: '.dim', style: { opacity: 0.18 } },
  { selector: '.hl', style: { opacity: 1 } },
];
const ontoStyle: CyStyle[] = [
  {
    selector: '.onto-node',
    style: {
      shape: 'round-rectangle',
      'background-color': '#ffffff',
      'border-width': 2,
      label: 'data(label)',
      'font-size': 10,
      'font-weight': 600,
      color: '#0f172a',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': 140,
      width: 160,
      height: 40,
    },
  },
  { selector: '.kind-source', style: { 'border-color': ONTO_KIND_COLOR.source } },
  { selector: '.kind-class', style: { 'border-color': ONTO_KIND_COLOR.class } },
  { selector: '.kind-view', style: { 'border-color': ONTO_KIND_COLOR.view } },
  { selector: '.kind-product', style: { 'border-color': ONTO_KIND_COLOR.product } },
  { selector: '.kind-kpi', style: { 'border-color': ONTO_KIND_COLOR.kpi } },
  {
    selector: '.onto-edge',
    style: {
      width: 1.4,
      'line-color': '#cbd5e1',
      'target-arrow-color': '#94a3b8',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': 8,
      color: '#64748b',
      'text-background-color': '#ffffff',
      'text-background-opacity': 0.8,
      'text-background-padding': 2,
    },
  },
  { selector: '.onto-node.sel', style: { 'border-width': 4, 'border-color': '#f59e0b' } },
  {
    selector: '.onto-edge.hl',
    style: { 'line-color': '#2563eb', 'target-arrow-color': '#2563eb', width: 2.5 },
  },
  ...baseHighlight,
];
const ONTO_LAYOUT = { name: 'preset', animate: false, fit: true, padding: 40 };

const LEGEND = (Object.keys(ENTERPRISE_KIND_LABEL) as (keyof typeof ENTERPRISE_KIND_LABEL)[]).map(
  (k) => ({ label: ENTERPRISE_KIND_LABEL[k], color: ENTERPRISE_KIND_COLOR[k] })
);

export function GraphExplorer() {
  const navigate = useNavigate();
  const {
    components,
    selectedProduct,
    enterpriseGraph,
    enterpriseHighlight,
    setSelectedProduct,
    syncScopeFromSections,
    catalogLoading,
    rebuilding,
  } = useProduct();
  const ontoData = components.ontologyGraph;
  const productKey = selectedProduct.product_name;

  const [tab, setTab] = useState<'explore' | 'onto'>('explore');

  // travel state (Tab 1 — over the enterprise map)
  const [focusId, setFocusId] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);

  const travelTo = (id: string) => {
    // when the "Selections update scope" toggle is ON, clicking a product node
    // also updates the left-panel scope; OFF (default) = view-only travel.
    if (syncScopeFromSections && id.startsWith('prod:')) setSelectedProduct(id.slice('prod:'.length));
    if (id === focusId) return;
    setTrail((t) => (focusId ? [...t, focusId] : t));
    setFocusId(id);
  };
  const goBack = () => {
    setTrail((t) => {
      if (t.length === 0) {
        setFocusId(null);
        return t;
      }
      setFocusId(t[t.length - 1]);
      return t.slice(0, -1);
    });
  };
  const reset = () => {
    setFocusId(null);
    setTrail([]);
  };
  const jumpTrail = (idx: number) => {
    setFocusId(trail[idx]);
    setTrail(trail.slice(0, idx));
  };

  const [selOntoId, setSelOntoId] = useState<string | null>(null);

  const isExplore = tab === 'explore';
  const travelNode = focusId ? (enterpriseGraph.nodes[focusId] ?? null) : null;
  const selectedNode: InspectorNode | null = isExplore
    ? travelNode
    : selOntoId
      ? (ontoData.nodes[selOntoId] ?? null)
      : null;

  if (catalogLoading) return <CatalogLoadingSkeleton label="Generating graph…" />;
  if (rebuilding) return <CatalogLoadingSkeleton label="Rebuilding…" />;

  return (
    <div className="space-y-3 max-w-[1600px]">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Graph Explorer</h2>
        {/* single compact help line at the TOP (guidance moved out of the inspector) */}
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {isExplore
            ? 'Explore: the full enterprise map (enterprise → domains → products → shared tables → metric views). Your domain/product selection is highlighted; the rest stays visible but dimmed. Click any node to center it and ring its neighbors (green = incoming, red = outgoing) and travel — even across a shared dimension to another product. Back / Overview returns to the full map.'
            : 'Ontology + lineage: a per-product bird’s-eye map (source tables → serving view → product → KPIs). Click a node to highlight its connections. Drag to pan, scroll to zoom.'}
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'explore' | 'onto')}>
        <TabsList>
          <TabsTrigger value="explore">Explore</TabsTrigger>
          <TabsTrigger value="onto">Ontology + lineage</TabsTrigger>
        </TabsList>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4 mt-3">
          <Card className="shadow-sm overflow-hidden">
            <CardHeader className="py-2.5 gap-2">
              <TabsContent value="explore" className="m-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Button variant="outline" size="sm" onClick={goBack} disabled={!focusId}>
                    Back
                  </Button>
                  <Button variant="outline" size="sm" onClick={reset} disabled={!focusId}>
                    Overview
                  </Button>
                  <Breadcrumb
                    trail={trail}
                    focusId={focusId}
                    nodes={enterpriseGraph.nodes}
                    onJump={jumpTrail}
                    onReset={reset}
                  />
                </div>
              </TabsContent>
              <div className="flex flex-wrap gap-3">
                {LEGEND.map((l) => (
                  <span
                    key={l.label}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: l.color }}
                    />
                    {l.label}
                  </span>
                ))}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <TabsContent value="explore" className="m-0">
                {/* one enterprise map for the whole app; selection highlights, not filters */}
                <TravelCanvas
                  graph={enterpriseGraph}
                  style={travelStyle}
                  focusId={focusId}
                  onTravel={travelTo}
                  highlightIds={enterpriseHighlight}
                  rootId={'ent:root'}
                  height={CANVAS_HEIGHT}
                />
              </TabsContent>
              <TabsContent value="onto" className="m-0">
                <CytoscapeCanvas
                  key={`onto-${productKey}`}
                  elements={ontoData.elements}
                  style={ontoStyle}
                  layout={ONTO_LAYOUT}
                  selectedId={selOntoId}
                  onSelect={setSelOntoId}
                  height={CANVAS_HEIGHT}
                />
              </TabsContent>
            </CardContent>
          </Card>

          <Inspector
            node={selectedNode}
            sharedProducts={
              isExplore && focusId ? enterpriseGraph.productsForNode(focusId) : []
            }
            onOpenProduct={(pn) => {
              if (syncScopeFromSections) setSelectedProduct(pn);
              const pnode = `prod:${pn}`;
              if (enterpriseGraph.nodes[pnode]) travelTo(pnode);
            }}
            onClear={() => (isExplore ? reset() : setSelOntoId(null))}
            onJump={(n) => {
              // genie/dashboard link nodes → open the external URL in a new window
              if (n.openUrl) {
                window.open(n.openUrl, '_blank');
                return;
              }
              if (n.openIn) navigate(`/${n.openIn}`);
            }}
          />
        </div>
      </Tabs>

      {/* Shared dimensions — the enterprise-ontology payoff: conformed/shared
          tables and the products they connect (click a product to travel).
          Always rendered (with a count, or a "none in scope" note) so it's
          discoverable regardless of tab / focus / travel state. */}
      <Card className="shadow-sm mt-4">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" /> Shared dimensions
            <Badge variant="secondary">{enterpriseGraph.sharedDimensions.length}</Badge>
          </CardTitle>
          <CardDescription>
            Tables connected to 2+ products — cross-product / cross-domain lineage across the active
            catalog. Click a product to travel to it in the Explore map.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {enterpriseGraph.sharedDimensions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shared dimensions in this scope.</p>
          ) : (
            enterpriseGraph.sharedDimensions.slice(0, 30).map((sd) => (
              <div
                key={sd.nodeId}
                className="flex flex-wrap items-center gap-2 text-sm border-b pb-2 last:border-b-0"
              >
                <span className="font-medium">{sd.label}</span>
                <Badge variant="outline" className="text-[10px]">
                  {sd.products.length} products
                </Badge>
                <span className="text-xs text-muted-foreground">shared across</span>
                {sd.products.map((p) => (
                  <button
                    key={p.product_name}
                    type="button"
                    className="text-xs rounded-full border px-2 py-0.5 hover:bg-muted"
                    onClick={() => {
                      if (syncScopeFromSections) setSelectedProduct(p.product_name);
                      const pnode = `prod:${p.product_name}`;
                      if (enterpriseGraph.nodes[pnode]) {
                        setTab('explore');
                        travelTo(pnode);
                      }
                    }}
                  >
                    {p.display_name}
                  </button>
                ))}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Breadcrumb({
  trail,
  focusId,
  nodes,
  onJump,
  onReset,
}: {
  trail: string[];
  focusId: string | null;
  nodes: Record<string, { label: string }>;
  onJump: (idx: number) => void;
  onReset: () => void;
}) {
  if (!focusId) return null;
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground overflow-x-auto">
      <button className="hover:text-foreground" onClick={onReset}>
        Overview
      </button>
      {trail.map((id, i) => (
        <span key={`${id}-${i}`} className="flex items-center gap-1">
          <span className="shrink-0">›</span>
          <button className="hover:text-foreground whitespace-nowrap" onClick={() => onJump(i)}>
            {nodes[id]?.label ?? id}
          </button>
        </span>
      ))}
      <span className="shrink-0">›</span>
      <span className="font-medium text-foreground whitespace-nowrap">
        {nodes[focusId]?.label ?? focusId}
      </span>
    </div>
  );
}

// Lean inspector: selected-node details only (no instructional prose).
function Inspector({
  node,
  onClear,
  onJump,
  sharedProducts = [],
  onOpenProduct,
}: {
  node: InspectorNode | null;
  onClear: () => void;
  onJump: (n: InspectorNode) => void;
  sharedProducts?: { product_name: string; display_name: string }[];
  onOpenProduct?: (productName: string) => void;
}) {
  return (
    <Card className="shadow-sm h-fit">
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base break-words">{node ? node.label : 'Inspector'}</CardTitle>
          {node && (
            <Button variant="ghost" size="icon" onClick={onClear} aria-label="Clear selection">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        {node && <CardDescription>{node.kindLabel}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        {!node && <p className="text-sm text-muted-foreground">No node selected.</p>}
        {node && (
          <>
            {node.conformed && node.conformedSources && (
              <div className="rounded-md border border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/20 p-2 text-xs">
                <Badge variant="default" className="gap-1 mb-1">
                  <Layers className="h-3 w-3" /> conformed dimension
                </Badge>
                <div className="text-muted-foreground">
                  Shared across: {node.conformedSources.join(', ')} (columns unioned).
                </div>
              </div>
            )}
            {sharedProducts.length > 1 && (
              <div className="rounded-md border p-2 text-xs space-y-1">
                <div className="font-medium flex items-center gap-1.5">
                  <Layers className="h-3 w-3" /> Shared across {sharedProducts.length} products
                </div>
                <div className="flex flex-wrap gap-1">
                  {sharedProducts.map((p) => (
                    <button
                      key={p.product_name}
                      type="button"
                      className="rounded-full border px-2 py-0.5 hover:bg-muted"
                      onClick={() => onOpenProduct?.(p.product_name)}
                    >
                      {p.display_name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {node.detail && (
              <p className="text-sm text-muted-foreground break-words">{node.detail}</p>
            )}
            {node.source && (
              <div className="text-xs">
                <span className="text-muted-foreground">Source: </span>
                <code>{node.source}</code>
              </div>
            )}
            {node.formula && (
              <div className="text-xs">
                <div className="text-muted-foreground mb-1">Formula:</div>
                <code className="whitespace-pre-wrap block bg-muted/50 rounded p-2">
                  {node.formula}
                </code>
              </div>
            )}
            {(node.drivers?.length || node.related?.length) && (
              <DriversPanel node={node} />
            )}
            {node.columns && node.columns.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Database className="h-3.5 w-3.5" /> Columns ({node.columns.length})
                </div>
                <div className="flex flex-col gap-0.5 max-h-80 overflow-auto">
                  {node.columns.map((c) => (
                    <div
                      key={c.name}
                      className="flex items-center gap-1.5 text-xs rounded px-1.5 py-1 hover:bg-muted"
                    >
                      {c.pk && <KeyRound className="h-3 w-3 text-amber-500 shrink-0" />}
                      {c.fk && <Link2 className="h-3 w-3 text-blue-500 shrink-0" />}
                      <span className="font-medium">{c.name}</span>
                      <span className="text-muted-foreground">{c.type}</span>
                      {c.fk && (
                        <span
                          className="text-muted-foreground italic ml-auto truncate"
                          title={c.fk}
                        >
                          → {c.fk.split('.').slice(1).join('.')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground pt-2">
                  <KeyRound className="h-3 w-3 text-amber-500" /> key
                  <Link2 className="h-3 w-3 text-blue-500 ml-2" /> foreign key
                </p>
              </div>
            )}
            {node.openUrl && (
              <Button variant="default" size="sm" className="w-full" onClick={() => onJump(node)}>
                Open {node.kindLabel} in a new window
              </Button>
            )}
            {!node.openUrl && node.openIn && (
              <Button variant="outline" size="sm" className="w-full" onClick={() => onJump(node)}>
                Open in{' '}
                {node.openIn === 'data-products'
                  ? 'Data Products'
                  : node.openIn === 'business-view'
                    ? 'Business View'
                    : 'Ontology Studio'}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Feature 3 — graph "drivers" overlay for a focused KPI/measure node.
// Shows deterministic drivers ("affected by") + related measures, plus an optional
// best-effort one-line LLM narration (non-blocking; silent if the LLM is absent).
function DriversPanel({ node }: { node: InspectorNode }) {
  const { selectedProduct, components } = useProduct();
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNote(null);
    if (!node.drivers?.length) return;
    fetch('/api/copilot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: `In one short sentence, what drives the KPI "${node.label}" and what should an operator watch? Drivers: ${node.drivers.join(', ')}.`,
        product: selectedProduct.product_name,
        live: components.live,
        productContext: `KPI ${node.label} formula: ${node.formula ?? 'n/a'}; drivers: ${node.drivers.join(', ')}`,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d?.answer && !/not configured|unavailable/i.test(d.answer)) {
          setNote(String(d.answer).split('\n')[0].slice(0, 240));
        }
      })
      .catch(() => {
        /* non-blocking */
      });
    return () => {
      cancelled = true;
    };
  }, [node.label, node.formula, node.drivers, selectedProduct.product_name, components.live]);

  return (
    <div className="rounded-md border bg-muted/30 p-2 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Activity className="h-3.5 w-3.5" /> Drivers
      </div>
      {node.drivers && node.drivers.length > 0 && (
        <div className="text-xs">
          <span className="text-muted-foreground">Affected by: </span>
          <span className="flex flex-wrap gap-1 mt-1">
            {node.drivers.map((d) => (
              <Badge key={d} variant="outline">
                {d}
              </Badge>
            ))}
          </span>
        </div>
      )}
      {node.related && node.related.length > 0 && (
        <div className="text-xs">
          <span className="text-muted-foreground">Related measures: </span>
          <span className="flex flex-wrap gap-1 mt-1">
            {node.related.map((r) => (
              <Badge key={r} variant="secondary">
                {r}
              </Badge>
            ))}
          </span>
        </div>
      )}
      {note && <p className="text-xs text-muted-foreground italic border-t pt-1.5">{note}</p>}
    </div>
  );
}
