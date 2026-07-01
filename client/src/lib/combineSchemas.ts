// combineSchemas — merge several loaded schema maps (within ONE customer) into a
// single Schema for the pipeline, CONFORMING dimension tables that appear in more
// than one schema (shared dims like dim_store / dim_calendar / dim_item). Two
// tables conform when their normalized base name matches AND they share ≥1 key
// column of the same name; the conformed table's columns are the UNION. Provenance
// is carried so the UI/graph can badge "conformed — shared across <schemas>".
import type { Schema, SchemaColumn } from './deriveComponents';

export type SchemaEntry = {
  id: string;
  label: string;
  schema: Schema;
};

// Which conformed table id → the source schema labels it was merged from.
export type ConformanceInfo = {
  conformedTables: Record<string, string[]>; // "schema.table" (canonical) -> [labels]
  count: number; // number of conformed shared dimensions
  sharedNames: string[]; // short base names of conformed dims (for the note)
};

export type CombineResult = {
  schema: Schema;
  info: ConformanceInfo;
};

const KEYISH = /(_key$|_id$|_number$|_num$|_code$)/i;
const WELL_KNOWN_KEYS = new Set([
  'store_number',
  'store_num',
  'store_key',
  'date_key',
  'item_key',
  'item_id',
  'customer_id',
  'cust_id',
  'product_key',
  'location_id',
]);

function shortTable(key: string): string {
  return key.split('.').pop() ?? key;
}
function isKeyCol(name: string): boolean {
  return KEYISH.test(name) || WELL_KNOWN_KEYS.has(name.toLowerCase());
}
function isDimName(key: string): boolean {
  return /^dim_|_dim$|(^|_)(calendar|date|store|item|location|customer|product|vendor|grade)($|_)/i.test(
    shortTable(key)
  );
}
// normalized base name: lowercased, strip leading dim_/stg_/int_ and trailing _dim
function baseName(key: string): string {
  return shortTable(key)
    .toLowerCase()
    .replace(/^(dim_|stg_|int_)/, '')
    .replace(/_dim$/, '');
}
function keyCols(cols: SchemaColumn[]): Set<string> {
  return new Set(cols.filter((c) => isKeyCol(c.name)).map((c) => c.name.toLowerCase()));
}
function shareKey(a: SchemaColumn[], b: SchemaColumn[]): boolean {
  const ka = keyCols(a);
  for (const k of keyCols(b)) if (ka.has(k)) return true;
  return false;
}
function unionColumns(a: SchemaColumn[], b: SchemaColumn[]): SchemaColumn[] {
  const seen = new Map<string, SchemaColumn>();
  for (const c of [...a, ...b]) if (!seen.has(c.name)) seen.set(c.name, c); // keep first type
  return [...seen.values()];
}

export function combineSchemas(entries: SchemaEntry[]): CombineResult {
  if (entries.length === 0) return { schema: {}, info: { conformedTables: {}, count: 0, sharedNames: [] } };
  if (entries.length === 1)
    return { schema: entries[0].schema, info: { conformedTables: {}, count: 0, sharedNames: [] } };

  // out: canonical key -> { cols, sources }
  type Acc = { key: string; cols: SchemaColumn[]; sources: string[]; isDim: boolean };
  const out: Record<string, Acc> = {};
  // index of dim base-name -> existing canonical keys (candidates to conform against)
  const dimIndex = new Map<string, string[]>();

  for (const entry of entries) {
    for (const [key, cols] of Object.entries(entry.schema)) {
      const dim = isDimName(key);
      // try to conform ONLY dimension tables (never merge facts)
      if (dim) {
        const bn = baseName(key);
        const candidates = dimIndex.get(bn) ?? [];
        let conformedTo: string | null = null;
        for (const cand of candidates) {
          if (shareKey(out[cand].cols, cols)) {
            conformedTo = cand;
            break;
          }
        }
        if (conformedTo) {
          out[conformedTo].cols = unionColumns(out[conformedTo].cols, cols);
          if (!out[conformedTo].sources.includes(entry.label))
            out[conformedTo].sources.push(entry.label);
          continue;
        }
        // new dim node (canonical id = its own key; disambiguate collisions)
        const cid = out[key] ? `${key}#${entry.id}` : key;
        out[cid] = { key: cid, cols: [...cols], sources: [entry.label], isDim: true };
        const arr = dimIndex.get(bn) ?? [];
        arr.push(cid);
        dimIndex.set(bn, arr);
        continue;
      }
      // fact / non-dim: keep stable id, disambiguate name collisions by source
      const fid = out[key] ? `${key}#${entry.id}` : key;
      out[fid] = { key: fid, cols: [...cols], sources: [entry.label], isDim: false };
    }
  }

  const schema: Schema = {};
  const conformedTables: Record<string, string[]> = {};
  const sharedNames: string[] = [];
  for (const acc of Object.values(out)) {
    schema[acc.key] = acc.cols;
    if (acc.sources.length > 1) {
      conformedTables[acc.key] = acc.sources;
      sharedNames.push(shortTable(acc.key));
    }
  }

  return {
    schema,
    info: {
      conformedTables,
      count: Object.keys(conformedTables).length,
      sharedNames: [...new Set(sharedNames)],
    },
  };
}
