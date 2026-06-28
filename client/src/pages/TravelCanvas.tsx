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
// product). Adapted from the databricks-industry-solutions model-viewer.
import { useEffect, useRef } from 'react';
import { Button } from '@databricks/appkit-ui/react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import type { CyCore, CyElementDef, CyStyle } from '../lib/cytoscape';
import type { UnifiedGraph } from '../lib/graphData';

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

  // rebuild the graph when focus / graph changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const center = focusId && graph.nodes[focusId] ? focusId : null;

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
      // FOCUS: ego-graph (center + ring of direct neighbors)
      const incoming: string[] = [];
      const outgoing: string[] = [];
      const edgesToAdd: { id: string; source: string; target: string; label: string; cls: string }[] =
        [];
      for (const ed of graph.edges) {
        if (ed.source === center && ed.target !== center) {
          outgoing.push(ed.target);
          edgesToAdd.push({ ...ed, cls: 'travel-edge out-edge' });
        } else if (ed.target === center && ed.source !== center) {
          incoming.push(ed.source);
          edgesToAdd.push({ ...ed, cls: 'travel-edge in-edge' });
        }
      }
      const visibleNodeIds = [center, ...new Set([...outgoing, ...incoming])];
      const inSet = new Set(incoming);
      const outSet = new Set(outgoing);
      for (const id of visibleNodeIds) {
        const n = graph.nodes[id];
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
      cy.layout({ name: 'preset', fit: true, padding: 60, animate: true, animationDuration: 350 }).run();
    }
  }, [focusId, graph, rootId]);

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
