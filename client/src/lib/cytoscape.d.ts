// Minimal ambient types for the CDN-loaded Cytoscape global (window.cytoscape).
// Cytoscape is loaded via a <script> tag in client/index.html (not npm), so we
// declare just the surface the Graph Explorer uses. Intentionally loose.

export type CyElementDef = {
  group?: 'nodes' | 'edges';
  data: Record<string, unknown> & { id?: string };
  classes?: string;
  position?: { x: number; y: number };
};

export type CyStyle = { selector: string; style: Record<string, unknown> };

export interface CyCollection {
  addClass(c: string): CyCollection;
  removeClass(c: string): CyCollection;
  remove(): CyCollection;
  position(pos?: { x: number; y: number }): { x: number; y: number };
  data(key?: string): unknown;
  id(): string;
  outgoers(sel?: string): CyCollection;
  incomers(sel?: string): CyCollection;
  connectedEdges(): CyCollection;
  connectedNodes(): CyCollection;
  nodes(sel?: string): CyCollection;
  edges(sel?: string): CyCollection;
  union(other: CyCollection): CyCollection;
  forEach(fn: (ele: CyCollection) => void): void;
  length: number;
}

export interface CyCore {
  add(els: CyElementDef[]): void;
  on(evt: string, selector: string, cb: (e: { target: CyCollection }) => void): void;
  on(evt: string, cb: (e: { target: CyCore }) => void): void;
  elements(sel?: string): CyCollection;
  nodes(sel?: string): CyCollection;
  edges(sel?: string): CyCollection;
  getElementById(id: string): CyCollection;
  layout(opts: Record<string, unknown>): { run(): void };
  fit(padding?: number): void;
  center(): void;
  zoom(level?: number): number;
  resize(): void;
  destroy(): void;
}

export type CyOptions = {
  container: HTMLElement;
  elements?: CyElementDef[];
  style?: CyStyle[];
  layout?: Record<string, unknown>;
  wheelSensitivity?: number;
  minZoom?: number;
  maxZoom?: number;
  boxSelectionEnabled?: boolean;
};

declare global {
  interface Window {
    cytoscape?: (opts: CyOptions) => CyCore;
  }
}

export {};
