// Generate a conformed CREATE VIEW (serving object) from a product's fact
// table(s) + CONFIRMED relationships, joining fact→dims on the confirmed keys.
// DDL execution is deferred (needs a one-time CREATE grant) — this only
// generates + previews.
//
// The target namespace is derived from the product's OWN source tables, not a
// constant: emitting `jai_ontos.demo_schema.…` for an uploaded schema would hand
// the user DDL pointing at this demo's catalog, which they may not have (or worse,
// may share with someone else). Falls back to a clearly-fake placeholder so a
// missing namespace reads as "fill this in" rather than a real-looking target.
import type { CatalogProduct, DerivedComponents } from './deriveComponents';

// Where governed views are expected to live within the source catalog. A naming
// convention, not a fact — flagged as such in the generated DDL comment.
const GOVERNED_SCHEMA = 'governed';
const UNKNOWN_CATALOG = '<your_catalog>';

// The catalog/namespace the product's own tables live in ("cat.schema.table" →
// "cat.schema"; "schema.table" → "schema").
function sourceNamespace(product: CatalogProduct, components: DerivedComponents): string | null {
  const anchor =
    (product.fact_tables ?? []).find(Boolean) ??
    components.tables.find((t) => t.role === 'fact')?.table ??
    components.tables[0]?.table;
  if (!anchor) return null;
  const parts = anchor.split('.');
  if (parts.length >= 3) return parts.slice(0, -1).join('.');
  if (parts.length === 2) return parts[0];
  return null;
}

function shortName(t: string): string {
  return t.split('.').pop() ?? t;
}
function alias(t: string, i: number): string {
  return `${shortName(t).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 8)}_${i}`;
}

export type GeneratedServingView = {
  name: string; // catalog-qualified target view name
  sql: string; // CREATE VIEW … AS SELECT …
  joins: number; // number of confirmed-FK joins used
  note: string;
};

// build the serving-view SQL. Uses the FIRST fact table as the base, and joins
// each confirmed relationship whose 'from' table is the fact (fact→dim).
export function generateServingView(
  product: CatalogProduct,
  components: DerivedComponents
): GeneratedServingView {
  const factTables = (product.fact_tables ?? []).filter(Boolean);
  const fact = factTables[0] ?? components.tables.find((t) => t.role === 'fact')?.table;
  // target lives alongside the product's own data, never in this demo's catalog
  const ns = sourceNamespace(product, components);
  const servingSchema = ns ? `${ns.split('.')[0]}.${GOVERNED_SCHEMA}` : `${UNKNOWN_CATALOG}.${GOVERNED_SCHEMA}`;
  const targetName = `${servingSchema}.jai_${product.product_name}_serving`;

  if (!fact) {
    return {
      name: targetName,
      sql: `-- No fact table available for ${product.display_name}; cannot generate a serving view.`,
      joins: 0,
      note: 'No fact table.',
    };
  }

  // map short table name → full catalog-qualified name (from the product's tables)
  const fullByShort = new Map<string, string>();
  for (const t of components.tables) fullByShort.set(shortName(t.table), t.table);
  for (const t of [...(product.fact_tables ?? []), ...(product.dim_tables ?? [])]) {
    fullByShort.set(shortName(t), t);
  }

  const factShort = shortName(fact);
  const factAlias = 'f';

  // known columns per short table name — so we never emit a column the schema
  // doesn't have (the root cause of "unresolved column" CREATE VIEW failures).
  const colsByShort = new Map<string, Set<string>>();
  for (const t of components.tables) {
    colsByShort.set(shortName(t.table), new Set(t.columns.map((c) => c.name)));
  }
  const factColSet = colsByShort.get(factShort) ?? new Set<string>();

  // confirmed relationships (origin user OR status confirmed) whose from = fact
  const confirmed = components.relationships.filter(
    (r) => r.status === 'confirmed' || r.origin === 'user'
  );
  const joins: string[] = [];
  const dimSelects: string[] = [];
  const skipped: string[] = [];
  let i = 0;
  const seenDim = new Set<string>();
  for (const r of confirmed) {
    const fromShort = r.from.map(shortName);
    if (!fromShort.includes(factShort)) continue; // only fact→dim joins from the base
    const dimShort = shortName(r.to);
    if (dimShort === factShort || seenDim.has(dimShort)) continue;
    const dimFull = fullByShort.get(dimShort);
    if (!dimFull) continue;
    // resolve the REAL join columns — predicate is only a label for LLM
    // suggestions; fromColumn/toColumn carry the actual (possibly different) keys
    const fromCol = r.fromColumn ?? r.predicate;
    const toCol = r.toColumn ?? r.predicate;
    const dimColSet = colsByShort.get(dimShort) ?? new Set<string>();
    // only emit a join whose columns provably exist on both sides
    if (!factColSet.has(fromCol) || !dimColSet.has(toCol)) {
      skipped.push(`${dimShort} (unresolved key ${fromCol}=${toCol})`);
      continue;
    }
    seenDim.add(dimShort);
    const a = alias(dimFull, i++);
    joins.push(`  LEFT JOIN ${dimFull} ${a}\n    ON ${factAlias}.${fromCol} = ${a}.${toCol}`);
    // pull a couple of descriptive (non-key) dim columns, aliased to avoid
    // ambiguous/duplicate column names in the view output
    const descriptive = (components.tables.find((t) => shortName(t.table) === dimShort)?.columns ?? [])
      .filter((c) => c.role !== 'key' && c.name !== toCol)
      .slice(0, 2);
    for (const c of descriptive) dimSelects.push(`${a}.${c.name} AS ${dimShort}_${c.name}`);
  }

  // select the fact's columns + a few descriptive columns from joined dims
  const factCols = (components.tables.find((t) => shortName(t.table) === factShort)?.columns ?? []).map(
    (c) => `${factAlias}.${c.name}`
  );
  const selectCols = [...factCols, ...dimSelects];
  const selectList = selectCols.length ? selectCols.join(',\n  ') : `${factAlias}.*`;

  const sql =
    `-- Serving view for ${product.display_name}\n` +
    `-- Deferred: executing this DDL needs a one-time CREATE grant on ${servingSchema}.\n` +
    `-- Target namespace is a suggested convention derived from the source tables —\n` +
    `-- change it to wherever your governed views actually live.\n` +
    `CREATE OR REPLACE VIEW ${targetName} AS\n` +
    `SELECT\n  ${selectList}\n` +
    `FROM ${fact} ${factAlias}\n` +
    (joins.length ? joins.join('\n') + '\n' : '') +
    `;`;

  const skippedNote = skipped.length ? ` Skipped ${skipped.length}: ${skipped.join('; ')}.` : '';
  return {
    name: targetName,
    sql,
    joins: joins.length,
    note:
      (joins.length
        ? `Joined ${joins.length} confirmed relationship(s).`
        : 'No confirmed fact→dim relationships — the view selects the fact table only. Confirm relationships (or accept a suggestion) to add joins.') +
      skippedNote,
  };
}
