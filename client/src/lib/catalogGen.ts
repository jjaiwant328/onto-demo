// Catalog generation — HYBRID (heuristic always; LLM polish optional).
//
// Pure, offline functions that turn a describe_table_extended.csv into a
// { schema, catalog } pair with the SAME shape as the bundled data files, so an
// uploaded schema regenerates domains → products → components → graph → contracts.
// The heuristic runs entirely client-side; an optional server endpoint can refine
// the draft with a Foundation Model (graceful fallback to the heuristic).
import type {
  Catalog,
  CatalogDomain,
  CatalogProduct,
  Origin,
  Schema,
  SchemaColumn,
} from './deriveComponents';

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

// Domain matching, with the evidence kept.
//
// The DOMAIN_DEFS keywords describe convenience retail. On any other estate most
// tables either miss entirely or — worse — hit on an incidental word: a healthcare
// `patient_transfer` matches /transfer/ and lands in "Merchandise & Inventory" with
// no hint that the match was a coincidence. First-match-wins also silently discards
// the fact that a table matched two domains.
//
// So: score every domain, keep the runners-up, and report how the match was made so
// the UI can distinguish a confident grouping from a guess (and offer a correction).
export type DomainMatch = {
  domain: DomainDef | null;
  /** how many distinct domain keywords matched the table name */
  hits: number;
  /** other domains that also matched, best-first — candidates for a re-assignment */
  alternates: DomainDef[];
};

function matchDomain(table: string): DomainMatch {
  const name = shortTable(table).toLowerCase();
  const scored = DOMAIN_DEFS.map((d) => {
    // count distinct alternatives in the domain's pattern that hit, so a table
    // matching several of a domain's keywords ranks above an incidental single hit
    const alts = d.re.source.split('|');
    const hits = alts.filter((a) => {
      try {
        return new RegExp(a, 'i').test(name);
      } catch {
        return false;
      }
    }).length;
    return { d, hits };
  })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (scored.length === 0) return { domain: null, hits: 0, alternates: [] };
  return {
    domain: scored[0].d,
    hits: scored[0].hits,
    alternates: scored.slice(1).map((s) => s.d),
  };
}

// Domain key prefix for tables no business-domain keyword matched.
const UNCLASSIFIED_PREFIX = 'unclassified_';

// The business domains tables are matched against. Exported so the About page can
// describe the real list instead of duplicating it (and drifting from it).
export const DOMAIN_LABELS: string[] = DOMAIN_DEFS.map((d) => d.label);
// How many products a single domain may carry (see buildCatalogFromSchema).
export const MAX_PRODUCTS_PER_DOMAIN = 4;
// How many leading numeric measures become a product's headline KPIs.
export const MAX_KPIS_PER_PRODUCT = 3;

export function buildCatalogFromSchema(schema: Schema): Catalog {
  const tables = Object.keys(schema);

  // group tables by domain (keyword bucket; unmatched tables are grouped by source
  // schema and labelled as such, rather than being quietly folded into a business
  // domain they were never matched to)
  const domainTables = new Map<string, string[]>();
  const domainMeta = new Map<
    string,
    { label: string; description: string; origin?: Origin; evidence?: string }
  >();
  for (const d of DOMAIN_DEFS) domainMeta.set(d.name, { label: d.label, description: d.description });

  // per-domain evidence, so the UI can show why a table landed where it did
  const matchHits = new Map<string, number>();
  const altsByTable = new Map<string, string[]>();

  for (const t of tables) {
    const m = matchDomain(t);
    const ucSchema = t.split('.')[0];
    const key = m.domain ? m.domain.name : `${UNCLASSIFIED_PREFIX}${ucSchema}`;
    if (!domainMeta.has(key)) {
      // Unmatched: name it after the source schema and SAY it is unclassified, so a
      // user can see how much of their estate the keyword rules did not understand.
      domainMeta.set(key, {
        label: `${humanize(ucSchema)} (unclassified)`,
        description: `Tables in ${ucSchema} that did not match any known business domain. Group and rename these in Ontology Studio.`,
        origin: 'heuristic',
        evidence: 'no business-domain keyword matched these table names',
      });
    }
    if (m.domain) {
      matchHits.set(key, Math.max(matchHits.get(key) ?? 0, m.hits));
      if (m.alternates.length) altsByTable.set(t, m.alternates.map((a) => a.label));
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
    anchors = anchors.slice(0, MAX_PRODUCTS_PER_DOMAIN);

    const products: CatalogProduct[] = anchors.map((anchor) => {
      const anchorCols = schema[anchor] ?? [];
      const anchorKeys = tableKeys(anchorCols);
      // attach dims that share a key column with the anchor
      const joined = dimPool.filter((dim) => {
        const dk = tableKeys(schema[dim] ?? []);
        for (const k of dk) if (anchorKeys.has(k)) return true;
        return false;
      });
      // Ensure a couple of conformed dims if no shared key matched. The fallback
      // used to name dim_store/dim_calendar specifically, which found nothing outside
      // convenience retail — prefer any dimension table in the domain instead.
      const dimTables = joined.length ? joined.slice(0, 4) : dims.slice(0, 2);

      const measures = anchorCols
        .filter((c) => isNumeric(c.type) && !isKey(c.name))
        .map((c) => c.name);
      const kpis = measures.slice(0, MAX_KPIS_PER_PRODUCT);

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
    const hits = matchHits.get(domName) ?? 0;
    const unclassified = domName.startsWith(UNCLASSIFIED_PREFIX);
    domains.push({
      name: domName,
      label: meta.label,
      description: meta.description,
      products,
      // How this grouping was arrived at. A single incidental keyword hit is a much
      // weaker claim than several, and the UI shows the difference.
      labelOrigin: meta.origin ?? 'heuristic',
      matchStrength: unclassified ? 'none' : hits >= 2 ? 'strong' : 'weak',
      matchEvidence:
        meta.evidence ??
        (hits >= 2
          ? `${hits} domain keywords matched these table names`
          : 'one domain keyword matched a table name — verify this grouping'),
      // other domains whose keywords also matched, offered as one-click corrections
      alternateDomains: [
        ...new Set(tbls.flatMap((t) => altsByTable.get(t) ?? [])),
      ].filter((l) => l !== meta.label),
    });
  }

  return { domains };
}

// merge a freshly-built catalog with the curated flagship so the live product
// keeps its exact tables/KPIs when the default schema is (re)generated.
export function buildCatalog(schema: Schema): Catalog {
  return buildCatalogFromSchema(schema);
}
