// Schema noise filter — a reusable skill that drops pipeline / test / DQ /
// framework schemas (dbt, data-quality, tests, information_schema, artifacts,
// elementary, quarantine, utils, framework, e2e, …) whenever a schema is loaded,
// so an upload/live-introspection of a full export auto-scopes to the business
// (medallion + source) layers. Conservative by design: generic operational tokens
// (pipeline, health, snapshot, source, sc_) are NEVER treated as noise.
import type { Schema, SchemaColumn } from './deriveComponents';

// Match on the SCHEMA name (the part before the first ".").
const NOISE_SCHEMA_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /(^|_)dbt($|_)/i, reason: 'dbt tooling' },
  { re: /(^|_)dq(_|$)/i, reason: 'data quality' },
  { re: /data_quality/i, reason: 'data quality' },
  { re: /_tests?$/i, reason: 'tests' },
  { re: /^tests?$/i, reason: 'tests' },
  { re: /information_schema/i, reason: 'catalog metadata' },
  { re: /^sys$/i, reason: 'system' },
  { re: /^system$/i, reason: 'system' },
  { re: /artifacts?$/i, reason: 'artifacts' },
  { re: /_artifacts/i, reason: 'artifacts' },
  { re: /results?$/i, reason: 'results/tooling' },
  { re: /elementary/i, reason: 'observability tooling' },
  { re: /quarantine/i, reason: 'quarantine' },
  { re: /_utils$/i, reason: 'utils' },
  { re: /^utils$/i, reason: 'utils' },
  { re: /framework/i, reason: 'framework' },
  { re: /(^|_)e2e(_|$)/i, reason: 'e2e tests' },
];

// Minimal table-level noise inside kept schemas.
const NOISE_TABLE_PATTERNS: RegExp[] = [/^dbt_/i, /_dbt_results$/i, /^elementary_/i];

export type SchemaFilterExclusion = { schema: string; tableCount: number; reason: string };
export type SchemaFilterResult = {
  schema: Schema;
  excluded: SchemaFilterExclusion[];
  keptSchemas: string[];
  droppedSchemas: string[];
};

export type SchemaFilterOpts = { disable?: boolean };

function schemaOf(key: string): string {
  return key.split('.')[0];
}
function tableOf(key: string): string {
  return key.split('.').slice(1).join('.');
}

function noiseReason(schemaName: string): string | null {
  for (const p of NOISE_SCHEMA_PATTERNS) if (p.re.test(schemaName)) return p.reason;
  return null;
}

export function filterBusinessSchema(schema: Schema, opts: SchemaFilterOpts = {}): SchemaFilterResult {
  const allSchemas = Array.from(new Set(Object.keys(schema).map(schemaOf)));

  if (opts.disable) {
    return { schema, excluded: [], keptSchemas: allSchemas, droppedSchemas: [] };
  }

  // count tables per schema (for the exclusion report)
  const perSchemaTableCount = new Map<string, number>();
  for (const key of Object.keys(schema)) {
    const s = schemaOf(key);
    perSchemaTableCount.set(s, (perSchemaTableCount.get(s) ?? 0) + 1);
  }

  const droppedReason = new Map<string, string>();
  for (const s of allSchemas) {
    const reason = noiseReason(s);
    if (reason) droppedReason.set(s, reason);
  }

  const out: Schema = {};
  for (const [key, cols] of Object.entries(schema)) {
    const s = schemaOf(key);
    if (droppedReason.has(s)) continue; // drop whole noise schema
    // secondary: minimal table-level noise inside kept schemas
    const t = tableOf(key);
    if (NOISE_TABLE_PATTERNS.some((re) => re.test(t))) continue;
    out[key] = cols as SchemaColumn[];
  }

  const droppedSchemas = [...droppedReason.keys()].sort();
  const keptSchemas = allSchemas.filter((s) => !droppedReason.has(s)).sort();
  const excluded: SchemaFilterExclusion[] = droppedSchemas.map((s) => ({
    schema: s,
    tableCount: perSchemaTableCount.get(s) ?? 0,
    reason: droppedReason.get(s) ?? 'noise',
  }));

  // safety: never return an empty schema — if the filter dropped everything
  // (pathological), fall back to the unfiltered input.
  if (Object.keys(out).length === 0) {
    return { schema, excluded: [], keptSchemas: allSchemas, droppedSchemas: [] };
  }

  return { schema: out, excluded, keptSchemas, droppedSchemas };
}
