// Runtime source for the curated KPI definitions in ontology/semantic_measures
// .yaml — the file the client bundles at build time (scripts/build-ontology-json
// .mjs → client/src/data/ontology.json, consumed at client/src/lib/derive
// Components.ts ~165). /api/measures serves the SAME shape from disk at first
// request so the client can replace its bundled copy at runtime.
//
// js-yaml is deliberately not a dependency here (the Databricks Apps npm proxy
// does not carry it — see scripts/build-ontology-json.mjs), so this parses the
// subset the measures file actually uses: nested mappings, quoted and plain
// scalars, folded multi-line plain scalars, flow sequences, and comments.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A curated KPI, in exactly the shape the bundled ontology.json carries. */
export interface CuratedMeasure {
  measure: string;
  type: string;
  unit: string;
  formula: string;
  description: string;
  depends_on: string[];
}

/** What /api/measures responds with; `error` is set only when loading failed. */
export interface CuratedMeasuresResult {
  measures: CuratedMeasure[];
  error?: string;
}

const MEASURES_PATH = 'ontology/semantic_measures.yaml';
// indents the measures file uses: `measures:` at 0, names at 2, fields at 4,
// folded scalar continuations at 6+
const NAME_INDENT = 2;
const FIELD_INDENT = 4;
const KEY_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;

const errMsg = (err: unknown): string => String((err as { message?: string })?.message ?? err);

// Cut a trailing comment — but only a `#` outside double quotes (formula_sql
// values are quoted and may legitimately contain #).
function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === '#' && !inQuote && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter(Boolean);
  }
  if (s.startsWith('"')) return unquote(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// map a parsed fields record onto the bundled measure shape (mirrors
// flattenMeasures in scripts/build-ontology-json.mjs)
function toMeasure(name: string, fields: Record<string, unknown>): CuratedMeasure {
  const deps = Array.isArray(fields.depends_on) ? (fields.depends_on as unknown[]) : [];
  return {
    measure: name,
    type: typeof fields.type === 'string' ? fields.type : 'base',
    unit: typeof fields.unit === 'string' ? fields.unit : '',
    formula: typeof fields.formula_sql === 'string' ? fields.formula_sql : '',
    description: typeof fields.description === 'string' ? fields.description.trim() : '',
    depends_on: deps.filter((d): d is string => typeof d === 'string'),
  };
}

// Parse the measures block of semantic_measures.yaml. Anything structurally
// unexpected throws — the route turns that into the error shape, and the client
// falls back to its bundled copy.
export function parseMeasuresYaml(text: string): CuratedMeasure[] {
  const entries: Array<{ name: string; fields: Record<string, unknown> }> = [];
  let inMeasures = false;
  let fields: Record<string, unknown> | null = null;
  // the field whose plain (unquoted) scalar may fold onto following lines
  let plainField: string | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      inMeasures = trimmed === 'measures:';
      fields = null;
      plainField = null;
      continue;
    }
    if (!inMeasures) continue;

    if (indent === NAME_INDENT) {
      const m = KEY_LINE.exec(line);
      if (!m || m[3] !== undefined) {
        throw new Error(`unexpected measures entry: "${trimmed.slice(0, 60)}"`);
      }
      fields = {};
      plainField = null;
      entries.push({ name: m[2], fields });
      continue;
    }
    if (indent === FIELD_INDENT && fields) {
      const m = KEY_LINE.exec(line);
      if (!m || m[3] === undefined) {
        throw new Error(`unsupported field entry: "${trimmed.slice(0, 60)}"`);
      }
      const value = parseScalar(m[3]);
      fields[m[2]] = value;
      plainField = typeof value === 'string' ? m[2] : null;
      continue;
    }
    if (indent > FIELD_INDENT && fields && plainField) {
      // folded continuation of a plain scalar: join with a single space
      const prev = fields[plainField];
      fields[plainField] = `${typeof prev === 'string' ? prev : ''} ${trimmed}`.trim();
      continue;
    }
    throw new Error(`unrecognized line in measures: "${trimmed.slice(0, 60)}"`);
  }

  if (entries.length === 0) throw new Error('no measures block found');
  return entries.map((e) => toMeasure(e.name, e.fields));
}

// Loaded once at first request, then cached in module state for the process
// lifetime — the file is the committed source of truth, not per-request input.
let cached: CuratedMeasuresResult | null = null;

export function loadCuratedMeasures(): CuratedMeasuresResult {
  cached ??= readOnce();
  return cached;
}

// Try the app-root path first (dev + Apps runtime both start at the repo root),
// then module-relative (covers a server run from an arbitrary cwd).
function readOnce(): CuratedMeasuresResult {
  const candidates = [
    path.resolve(process.cwd(), MEASURES_PATH),
    fileURLToPath(new URL(`../${MEASURES_PATH}`, import.meta.url)),
  ];
  for (const p of candidates) {
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    try {
      return { measures: parseMeasuresYaml(text) };
    } catch (err) {
      return {
        measures: [],
        error: `could not parse ${MEASURES_PATH} (${errMsg(err)}) — the bundled copy applies`,
      };
    }
  }
  return { measures: [], error: `${MEASURES_PATH} not found — the bundled copy applies` };
}
