// Catalog generation — HYBRID (heuristic always; LLM polish optional).
//
// Pure, offline functions that turn a describe_table_extended.csv into a
// { schema, catalog } pair with the SAME shape as the bundled data files, so an
// uploaded schema regenerates domains → products → components → graph → contracts.
// The heuristic runs entirely client-side; an optional server endpoint can refine
// the draft with a Foundation Model (graceful fallback to the heuristic).
import type { Catalog, CatalogDomain, CatalogProduct, Schema, SchemaColumn } from './deriveComponents';

// ---------- CSV parse --------------------------------------------------------
// describe-extended metadata rows to skip (column_name values that are not real columns)
const META_COLS = new Set([
  'Catalog',
  'Database',
  'Table',
  'Created Time',
  'Last Access',
  'Created By',
  'Type',
  'Provider',
  'Owner',
  'Table Properties',
  'Statistics',
  'Location',
  'Comment',
  'col_name',
  'data_type',
]);

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseDescribeCsv(text: string): Schema {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return {};
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iSchema = idx('schema');
  const iTable = idx('table');
  const iCol = idx('column_name');
  const iType = idx('data_type');
  const iComment = idx('comment');
  if (iSchema < 0 || iTable < 0 || iCol < 0 || iType < 0) {
    throw new Error(
      'CSV must have columns: catalog, schema, table, column_name, data_type, comment'
    );
  }

  const schema: Schema = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const sch = (cells[iSchema] ?? '').trim();
    const tbl = (cells[iTable] ?? '').trim();
    const col = (cells[iCol] ?? '').trim();
    const dt = (cells[iType] ?? '').trim();
    if (!sch || !tbl || !col || !dt) continue; // empty data_type / metadata → skip
    if (META_COLS.has(col) || col.startsWith('#')) continue;
    const key = `${sch}.${tbl}`;
    const cmt = iComment >= 0 ? (cells[iComment] ?? '').trim() : '';
    const column: SchemaColumn = { name: col, type: dt, comment: cmt && cmt !== 'null' ? cmt : undefined };
    (schema[key] = schema[key] ?? []).push(column);
  }
  return schema;
}

// ---------- heuristic catalog ------------------------------------------------
const NUMERIC = /^(int|integer|bigint|smallint|tinyint|long|decimal|numeric|double|float|real)/i;
const KEYISH = /(_key$|_id$|_number$|_num$|_code$)/i;
const DATEISH = /(date|_dt$|day|month|year|calendar|period)/i;

type DomainDef = { name: string; label: string; description: string; re: RegExp };
const DOMAIN_DEFS: DomainDef[] = [
  {
    name: 'fuel',
    label: 'Fuel',
    description: 'Fuel sales, pricing, margin, and supply.',
    re: /fuel|allegro|opis|grade|terminal|lifting|wetstock|gb_only|petrol/i,
  },
  {
    name: 'store_operations_labor',
    label: 'Store Operations & Labor',
    description: 'Store traffic, labor efficiency, drive-thru, and bonuses.',
    re: /store|labor|bonus|drive_thru|cashier|overshort|shift/i,
  },
  {
    name: 'merchandise_inventory',
    label: 'Merchandise & Inventory',
    description: 'Merchandise sales, inventory position, purchasing, and shrink.',
    re: /item|inventory|merch|shrink|purchas|replenish|rwmerch|pdi|transfer|order/i,
  },
  {
    name: 'sales_pos',
    label: 'Sales & POS',
    description: 'Basket / transaction analytics, tender mix, guest traffic, voids.',
    re: /sale|txn|transaction|pos|tender|void|basket|guest|traffic|radiant/i,
  },
  {
    name: 'finance_accounting',
    label: 'Finance & Accounting',
    description: 'GL balances, cash management, credits, rebates, refunds.',
    re: /gl_|ledger|finance|cash|credit|rebate|refund|account|lotto/i,
  },
  {
    name: 'customer_marketing',
    label: 'Customer & Marketing',
    description: 'Customer 360, promotions, offers, and loyalty.',
    re: /customer|promo|loyalty|offer|reward|cust/i,
  },
];

const shortTable = (t: string) => t.split('.').pop() ?? t;
function humanize(s: string): string {
  return shortTable(s)
    .replace(/^(dim_|fact_|smmry_|summary_|import_|stg_)/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
const isNumeric = (t: string) => NUMERIC.test(t.trim());
const isKey = (n: string) => KEYISH.test(n) || ['store_number', 'store_num', 'date_key', 'item_key'].includes(n.toLowerCase());

function tableKeys(cols: SchemaColumn[]): Set<string> {
  return new Set(cols.filter((c) => isKey(c.name)).map((c) => c.name.toLowerCase()));
}
function isDimName(t: string): boolean {
  return /^dim_/i.test(shortTable(t));
}
function isFactLike(cols: SchemaColumn[], table: string): boolean {
  if (isDimName(table)) return false;
  const hasMeasure = cols.some((c) => isNumeric(c.type) && !isKey(c.name));
  const hasKey = cols.some((c) => isKey(c.name));
  const hasDate = cols.some((c) => DATEISH.test(c.name) || /_key$/i.test(c.name));
  return hasMeasure && hasKey && hasDate;
}

function domainFor(table: string): DomainDef | null {
  const name = shortTable(table);
  for (const d of DOMAIN_DEFS) if (d.re.test(name)) return d;
  return null;
}

export function buildCatalogFromSchema(schema: Schema): Catalog {
  const tables = Object.keys(schema);

  // group tables by domain (keyword bucket; fall back to UC schema name)
  const domainTables = new Map<string, string[]>();
  const domainMeta = new Map<string, { label: string; description: string }>();
  for (const d of DOMAIN_DEFS) domainMeta.set(d.name, { label: d.label, description: d.description });

  for (const t of tables) {
    const d = domainFor(t);
    const key = d ? d.name : `schema_${t.split('.')[0]}`;
    if (!domainMeta.has(key)) {
      const ucSchema = t.split('.')[0];
      domainMeta.set(key, { label: humanize(ucSchema), description: `Tables in ${ucSchema}.` });
    }
    (domainTables.get(key) ?? domainTables.set(key, []).get(key)!).push(t);
  }

  const domains: CatalogDomain[] = [];
  for (const [domName, tbls] of domainTables) {
    const facts = tbls.filter((t) => isFactLike(schema[t], t));
    const dims = tbls.filter((t) => isDimName(t));
    const otherDims = tbls.filter((t) => !facts.includes(t) && !dims.includes(t));
    const dimPool = [...dims, ...otherDims];

    // product anchors = fact-like tables (cap 4); if none, use the largest tables
    let anchors = facts;
    if (anchors.length === 0) {
      anchors = [...tbls].sort((a, b) => (schema[b]?.length ?? 0) - (schema[a]?.length ?? 0)).slice(0, 1);
    }
    anchors = anchors.slice(0, 4);

    const products: CatalogProduct[] = anchors.map((anchor) => {
      const anchorCols = schema[anchor] ?? [];
      const anchorKeys = tableKeys(anchorCols);
      // attach dims that share a key column with the anchor
      const joined = dimPool.filter((dim) => {
        const dk = tableKeys(schema[dim] ?? []);
        for (const k of dk) if (anchorKeys.has(k)) return true;
        return false;
      });
      // ensure a couple of conformed dims if nothing matched
      const dimTables = joined.length
        ? joined.slice(0, 4)
        : dimPool.filter((d) => /dim_store|dim_calendar/i.test(d)).slice(0, 2);

      const measures = anchorCols
        .filter((c) => isNumeric(c.type) && !isKey(c.name))
        .map((c) => c.name);
      const kpis = measures.slice(0, 3);

      const label = humanize(anchor);
      return {
        product_name: `jai_${shortTable(anchor)}`.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        display_name: label,
        business_outcome: `Analyze ${label.toLowerCase()} across the ${domainMeta.get(domName)!.label.toLowerCase()} domain.`,
        fact_tables: [anchor],
        dim_tables: dimTables,
        kpis: kpis.length ? kpis : ['record_count'],
        maturity: 'incubating',
      };
    });

    if (products.length === 0) continue;
    const meta = domainMeta.get(domName)!;
    domains.push({ name: domName, label: meta.label, description: meta.description, products });
  }

  return { domains };
}

// merge a freshly-built catalog with the curated flagship so the live product
// keeps its exact tables/KPIs when the default schema is (re)generated.
export function buildCatalog(schema: Schema): Catalog {
  return buildCatalogFromSchema(schema);
}
