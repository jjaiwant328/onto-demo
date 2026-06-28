// Shared Cytoscape canvas for the Graph Explorer. Renders a set of element
// defs with a given stylesheet/layout, wires tap-to-select with neighbor
// highlighting (adapted from the databricks-industry-solutions model-viewer),
// and exposes zoom/fit controls. Cytoscape is the CDN global (window.cytoscape).
import { useEffect, useRef } from 'react';
import { Button } from '@databricks/appkit-ui/react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import type { CyCore, CyElementDef, CyStyle } from '../lib/cytoscape';

type Props = {
  elements: CyElementDef[];
  style: CyStyle[];
  layout: Record<string, unknown>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  height?: number;
};

export function CytoscapeCanvas({
  elements,
  style,
  layout,
  selectedId,
  onSelect,
  height = 560,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<CyCore | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // (re)build the graph when elements/style/layout change
  useEffect(() => {
    const cyto = window.cytoscape;
    const el = containerRef.current;
    if (!cyto || !el) return;

    const cy = cyto({
      container: el,
      elements,
      style,
      layout,
      wheelSensitivity: 0.3,
      minZoom: 0.2,
      maxZoom: 3,
      boxSelectionEnabled: false,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (e) => {
      const id = e.target.id();
      onSelectRef.current(id);
    });
    cy.on('tap', (e) => {
      // tap on empty background clears selection
      if ((e.target as unknown) === cy) onSelectRef.current(null);
    });

    cy.fit(40);

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [elements, style, layout]);

  // apply highlight classes when selection changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass('hl sel dim');
    if (!selectedId) return;
    const node = cy.getElementById(selectedId);
    if (!node || node.length === 0) return;
    const neighborhood = node
      .connectedEdges()
      .union(node.connectedEdges().connectedNodes())
      .union(node);
    cy.elements().addClass('dim');
    neighborhood.removeClass('dim').addClass('hl');
    node.removeClass('hl').addClass('sel');
  }, [selectedId]);

  const zoom = (factor: number) => {
    const cy = cyRef.current;
    if (cy) cy.zoom(cy.zoom() * factor);
  };
  const fit = () => {
    const cy = cyRef.current;
    if (cy) {
      cy.fit(40);
      onSelect(null);
    }
  };

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
