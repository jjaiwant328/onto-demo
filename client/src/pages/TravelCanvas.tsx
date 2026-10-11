// TravelCanvas — enterprise map + node-based "travel".
//
// Overview (no focus): the FULL graph is rendered with a hierarchical layout
// (breadthfirst rooted at the enterprise node). The current selection's subtree
// is highlighted (full opacity + colored border / blue edges); everything else
// stays VISIBLE but dimmed — highlight, not filter.
//
// Focus (a node is clicked): ego-graph — the focused node is centered and its
// direct neighbors are ringed (fk-source = incoming, fk-target = outgoing), so a
// user can travel across the map (incl. through a shared dimension to another
// product). On focus the node is FIRST expanded live through the server's
// ontobricks proxy (GET /api/graph/neighbors); neighbors that come back are
// merged into the ego ring. When the proxy has nothing (unconfigured / the node
// is not in the ontology graph / the companion app is down), the native
// edges-table expansion below renders exactly as before — the offline path.
// Adapted from the databricks-industry-solutions model-viewer.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@databricks/appkit-ui/react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import type { CyCore, CyElementDef, CyStyle } from '../lib/cytoscape';
import { UNIFIED_KIND_COLOR, UNIFIED_KIND_LABEL } from '../lib/graphData';
import type { UnifiedGraph, UnifiedNode, UnifiedEdge } from '../lib/graphData';
import type { GraphNeighbor } from '../../../shared/ontobricksTypes';

type Props = {
  graph: UnifiedGraph;
  style: CyStyle[];
  focusId: string | null; // null = enterprise overview
  onTravel: (id: string) => void;
  highlightIds?: Set<string> | null; // overview highlight set (selection subtree)
  rootId?: string; // hierarchical layout root for overview
  height?: number;
};

// Ring layout math: r = chord / (2 sin(π/n)); angles from the top (-π/2).
function ringPositions(n: number): { x: number; y: number }[] {
  if (n === 0) return [];
  const chord = 150;
  const r = n <= 1 ? 260 : Math.max(300, chord / (2 * Math.sin(Math.PI / n)));
  return Array.from({ length: n }, (_, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
  });
}

// GET /api/graph/neighbors response. Client failures also come back HTTP 200
// with `error` in the body and empty neighbors — read the body, not the status.
type NeighborsResponse = {
  source?: string;
  neighbors?: GraphNeighbor[];
  error?: string;
};

// Live ontobricks edges for the focused node, mapped onto the canvas edge
// shape. `focusId` guards staleness: edges only merge when they belong to the
// node currently centered.
type LiveEdges = { focusId: string; edges: UnifiedEdge[] };

// Map a fetched GraphNeighbor pair (edge + the neighbor node it was found on)
// onto the canvas shapes. Neighbor nodes keep their raw IRI as id so clicking
// one travels into the live ontology graph (the server resolves IRIs natively).
function liveNeighborElements(
  focusId: string,
  neighbors: GraphNeighbor[]
): { nodes: Record<string, UnifiedNode>; edges: UnifiedEdge[] } {
  const nodes: Record<string, UnifiedNode> = {};
  const edges: UnifiedEdge[] = [];
  let e = 0;
  for (const nb of neighbors) {
    const id = nb.iri;
    nodes[id] = {
      id,
      label: nb.label || nb.iri,
      // types are ontology class names (__typename) — the 'class' kind is the
      // canvas' native rendering for ontology entities (see graphData.ts)
      kind: 'class',
      kindLabel: UNIFIED_KIND_LABEL.class,
      color: UNIFIED_KIND_COLOR.class,
      detail: nb.types.length
        ? `Ontology class: ${nb.types.join(', ')} — via ontobricks`
        : 'Ontology neighbor — via ontobricks',
    };
    // direction 'out': origin -predicate-> neighbor; 'in': neighbor -> origin
    edges.push({
      id: `ob:${e++}`,
      source: nb.direction === 'in' ? id : focusId,
      target: nb.direction === 'in' ? focusId : id,
      label: nb.predicate,
    });
  }
  return { nodes, edges };
}

export function TravelCanvas({
  graph,
  style,
  focusId,
  onTravel,
  highlightIds = null,
  rootId,
  height = 560,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<CyCore | null>(null);
  const onTravelRef = useRef(onTravel);
  onTravelRef.current = onTravel;

  // init cytoscape once
  useEffect(() => {
    const cyto = window.cytoscape;
    const el = containerRef.current;
    if (!cyto || !el) return;
    const cy = cyto({
      container: el,
      elements: [],
      style,
      layout: { name: 'preset' },
      wheelSensitivity: 0.3,
      minZoom: 0.1,
      maxZoom: 3,
      boxSelectionEnabled: false,
    });
    cyRef.current = cy;
    cy.on('tap', 'node', (ev) => onTravelRef.current(ev.target.id()));
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // live ontobricks expansion for the focused node (falls back to the native
  // edges-table path below when the proxy has nothing — see the focus branch)
  const [liveEdges, setLiveEdges] = useState<LiveEdges | null>(null);
  // cumulative cache of every live node ever fetched: keeps raw-IRI nodes
  // focusable (travel into the live ontology graph and back) without holding
  // stale edges — edges are always the current focus's fetch only.
  const liveNodesRef = useRef<Record<string, UnifiedNode>>({});
  useEffect(() => {
    setLiveEdges(null);
    if (!focusId) return;
    let cancelled = false;
    const expand = async () => {
      try {
        // hops=1 matches the ego-ring UX (direct neighbors only)
        const r = await fetch(
          `/api/graph/neighbors?node=${encodeURIComponent(focusId)}&hops=1`
        );
        const d = (await r.json()) as NeighborsResponse;
        if (cancelled) return;
        // 'none' (unconfigured) / empty / error body → native expand path
        if (d?.source !== 'ontobricks' || d.error) return;
        if (!Array.isArray(d.neighbors) || d.neighbors.length === 0) return;
        const mapped = liveNeighborElements(focusId, d.neighbors);
        liveNodesRef.current = { ...liveNodesRef.current, ...mapped.nodes };
        setLiveEdges({ focusId, edges: mapped.edges });
      } catch {
        /* offline / server down → the native expand path renders */
      }
    };
    void expand();
    return () => {
      cancelled = true;
    };
  }, [focusId]);

  // rebuild the graph when focus / graph changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const center =
      focusId && (graph.nodes[focusId] || liveNodesRef.current[focusId]) ? focusId : null;

    const elements: CyElementDef[] = [];

    if (!center) {
      // OVERVIEW: render the FULL graph
      for (const id of Object.keys(graph.nodes)) {
        const n = graph.nodes[id];
        elements.push({
          group: 'nodes',
          data: { id, label: n.label, color: n.color },
          classes: `travel-node ukind-${n.kind}`,
        });
      }
      for (const ed of graph.edges) {
        elements.push({
          group: 'edges',
          data: { id: ed.id, source: ed.source, target: ed.target, label: ed.label },
          classes: 'travel-edge',
        });
      }
      cy.elements().remove();
      cy.add(elements);
      // Concentric layered layout: enterprise at center, each kind on its own
      // ring outward (domain → product → table → metric view). Manual preset
      // positions keep ~100+ nodes readable in 2D (breadthfirst squashed them
      // into a thin line) and make travel-back deterministic.
      void rootId;
      const RING_RADIUS: Record<number, number> = { 0: 0, 1: 420, 2: 820, 3: 1280, 4: 1720 };
      const byDepth: Record<number, string[]> = { 0: [], 1: [], 2: [], 3: [], 4: [] };
      for (const id of Object.keys(graph.nodes)) {
        byDepth[kindDepth(graph.nodes[id].kind)].push(id);
      }
      for (const depthStr of Object.keys(byDepth)) {
        const depth = Number(depthStr);
        const ids = byDepth[depth];
        const r = RING_RADIUS[depth] ?? 2000;
        if (depth === 0) {
          ids.forEach((id) => cy.getElementById(id).position({ x: 0, y: 0 }));
          continue;
        }
        const n = ids.length;
        ids.forEach((id, i) => {
          const angle = (2 * Math.PI * i) / n - Math.PI / 2;
          cy.getElementById(id).position({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
        });
      }
      cy.layout({ name: 'preset', fit: true, padding: 60, animate: true, animationDuration: 350 }).run();
    } else {
      // FOCUS: ego-graph (center + ring of direct neighbors). Neighbors come
      // from the native edges table, PLUS the live ontobricks expansion when
      // the current focus has one (deduped by endpoint pair, native first —
      // the same rule the graph builders' addEdge uses).
      const live = liveEdges && liveEdges.focusId === center ? liveEdges : null;
      const nodeById = (id: string): UnifiedNode | undefined =>
        graph.nodes[id] ?? liveNodesRef.current[id];
      const incoming: string[] = [];
      const outgoing: string[] = [];
      const edgesToAdd: { id: string; source: string; target: string; label: string; cls: string }[] =
        [];
      const seenPair = new Set<string>();
      for (const ed of live ? [...graph.edges, ...live.edges] : graph.edges) {
        if (ed.source === center && ed.target !== center) {
          const pair = `${ed.source}->${ed.target}`;
          if (seenPair.has(pair)) continue;
          seenPair.add(pair);
          outgoing.push(ed.target);
          edgesToAdd.push({ ...ed, cls: 'travel-edge out-edge' });
        } else if (ed.target === center && ed.source !== center) {
          const pair = `${ed.source}->${ed.target}`;
          if (seenPair.has(pair)) continue;
          seenPair.add(pair);
          incoming.push(ed.source);
          edgesToAdd.push({ ...ed, cls: 'travel-edge in-edge' });
        }
      }
      const visibleNodeIds = [center, ...new Set([...outgoing, ...incoming])];
      const inSet = new Set(incoming);
      const outSet = new Set(outgoing);
      for (const id of visibleNodeIds) {
        const n = nodeById(id);
        if (!n) continue;
        let cls = 'travel-node';
        if (id === center) cls += ' center-node';
        else if (inSet.has(id)) cls += ' fk-source';
        else if (outSet.has(id)) cls += ' fk-target';
        cls += ` ukind-${n.kind}`;
        elements.push({ group: 'nodes', data: { id, label: n.label, color: n.color }, classes: cls });
      }
      for (const ed of edgesToAdd) {
        elements.push({
          group: 'edges',
          data: { id: ed.id, source: ed.source, target: ed.target, label: ed.label },
          classes: ed.cls,
        });
      }
      cy.elements().remove();
      cy.add(elements);
      const ring = visibleNodeIds.filter((id) => id !== center);
      const pos = ringPositions(ring.length);
      cy.getElementById(center).position({ x: 0, y: 0 });
      ring.forEach((id, i) => cy.getElementById(id).position(pos[i]));
      const layout = cy.layout({ name: 'preset', fit: true, padding: 80, animate: true, animationDuration: 350 });
      // a small ego-graph must not balloon to fill the whole canvas — cap at 100%
      layout.one('layoutstop', () => {
        if (cy.zoom() > 1) {
          cy.animate({ zoom: 1, center: { eles: cy.getElementById(center) } }, { duration: 200 });
        }
      });
      layout.run();
    }
  }, [focusId, graph, rootId, liveEdges]);

  // apply highlight in OVERVIEW (dim the rest); cleared in focus mode
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass('hl dim sel');
    if (focusId) return; // focus mode handles its own emphasis
    if (!highlightIds || highlightIds.size === 0) return;
    cy.nodes().forEach((node) => {
      if (highlightIds.has(node.id())) node.addClass('hl');
      else node.addClass('dim');
    });
    cy.edges().forEach((edge) => {
      const s = String(edge.data('source'));
      const t = String(edge.data('target'));
      if (highlightIds.has(s) && highlightIds.has(t)) edge.addClass('hl');
      else edge.addClass('dim');
    });
  }, [highlightIds, focusId, graph]);

  const zoom = (f: number) => {
    const cy = cyRef.current;
    if (cy) cy.zoom(cy.zoom() * f);
  };
  const fit = () => cyRef.current?.fit(40);

  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        <Button variant="outline" size="icon" onClick={() => zoom(1.25)} aria-label="Zoom in">
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={() => zoom(0.8)} aria-label="Zoom out">
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={fit} aria-label="Fit to screen">
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>
      <div ref={containerRef} style={{ height }} className="w-full rounded-md bg-muted/20" />
    </div>
  );
}

// enterprise-map layer depth per node kind (for the concentric overview)
function kindDepth(kind: string): number {
  switch (kind) {
    case 'enterprise':
      return 0;
    case 'domain':
      return 1;
    case 'product':
      return 2;
    case 'metric_view':
      return 4;
    default:
      return 3; // fact / dim / table
  }
}
