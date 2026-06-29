// deriveContract — a Data Contract per data product, following the ontos
// DataContract structure (see ontos/contracts/*.yaml). For the flagship (live)
// product we use the curated ontos contract; for all others we derive one from
// the product's components (schema, mappings, lineage).
import type { CatalogProduct } from './deriveComponents';
import type { DerivedComponents } from './deriveComponents';

export type ContractColumn = {
  name: string;
  type: string;
  nullable: boolean;
  key: boolean;
};
export type QualityCheck = { id: string; rule: string };

export type DataContract = {
  name: string;
  product: string;
  status: 'defined' | 'active' | 'breaking';
  serving_object: string;
  grain: string;
  live: boolean;
  schema: ContractColumn[];
  quality_checks: QualityCheck[];
  freshness: { sla: string; basis: string };
  scope: { included: string; excluded: string };
  assumptions: string[];
  lineage: { sources: string[]; serving: string };
};

const NUMERIC = /^(int|integer|bigint|smallint|tinyint|long|decimal|numeric|double|float|real)/i;
const shortTable = (t: string) => t.split('.').pop() ?? t;

// Curated ontos contract for the flagship (mirrors
// ontos/contracts/jai_store_traffic_labor_efficiency_contract.yaml).
const FLAGSHIP_CONTRACT: DataContract = {
  name: 'jai_store_traffic_labor_efficiency_contract',
  product: 'jai_store_traffic_labor_efficiency',
  status: 'defined',
  serving_object: 'jai_ontos.demo_schema.jai_store_day_traffic_labor',
  grain: 'one row per (store_number, calendar_day)',
  live: true,
  schema: [
    { name: 'store_number', type: 'int', nullable: false, key: true },
    { name: 'store_name', type: 'string', nullable: true, key: false },
    { name: 'store_city', type: 'string', nullable: true, key: false },
    { name: 'state_code', type: 'string', nullable: true, key: false },
    { name: 'region_name', type: 'string', nullable: true, key: false },
    { name: 'store_status', type: 'string', nullable: true, key: false },
    { name: 'date_key', type: 'int', nullable: false, key: true },
    { name: 'calendar_day', type: 'date', nullable: false, key: true },
    { name: 'total_customers', type: 'bigint', nullable: false, key: false },
    { name: 'shop_customers', type: 'bigint', nullable: false, key: false },
    { name: 'fuel_customers', type: 'bigint', nullable: false, key: false },
    { name: 'dual_customers', type: 'bigint', nullable: false, key: false },
    { name: 'total_labor_hours', type: 'decimal(18,2)', nullable: false, key: false },
    { name: 'total_labor_cost', type: 'decimal(18,2)', nullable: false, key: false },
    { name: 'labor_cost_per_customer', type: 'decimal(18,4)', nullable: true, key: false },
    { name: 'labor_hours_per_customer', type: 'decimal(18,4)', nullable: true, key: false },
    { name: 'dual_customer_conversion_rate_pct', type: 'decimal(18,2)', nullable: true, key: false },
  ],
  quality_checks: [
    { id: 'unique_grain', rule: 'count(*) = count(distinct store_number, date_key)' },
    { id: 'non_negative_customers', rule: 'min(total_customers) >= 0' },
    {
      id: 'kpi_divzero_guarded',
      rule: 'labor_cost_per_customer is null only when total_customers = 0',
    },
    {
      id: 'customer_parts_consistent',
      rule: 'shop_customers <= total_customers AND fuel_customers <= total_customers',
    },
  ],
  freshness: { sla: 'data available by 06:00 local for prior business_date', basis: 'calendar_day' },
  scope: {
    included: 'store-day traffic + labor + efficiency KPIs for active stores',
    excluded: 'fuel margin, shrink, bonuses, customer PII',
  },
  assumptions: [
    'Derived KPIs computed from re-aggregated base sums (see semantic_measures.yaml)',
    'region_name may be stale (monthly source) or null (A3)',
    'dual_customers loyalty-biased (A5)',
  ],
  lineage: {
    sources: [
      'fc_entdata_gold.cdm_bi.smmry_labor',
      'fc_entdata_gold.cdm_pos.sale_transaction_header',
      'fc_entdata_gold.cdm_dim.dim_store',
      'fc_entdata_gold.cdm_dim.dim_calendar',
      'fc_entdata_gold.cdm_bi.storebonuses',
    ],
    serving: 'jai_ontos.demo_schema.jai_store_day_traffic_labor',
  },
};

export function deriveContract(
  product: CatalogProduct,
  components: DerivedComponents
): DataContract {
  if (product.live && product.product_name === FLAGSHIP_CONTRACT.product) {
    return FLAGSHIP_CONTRACT;
  }

  // schema = union of the product's fact-table columns (the serving grain),
  // taken from the derived mappings/tables.
  const factTables = components.tables.filter((t) => t.role === 'fact');
  const primaryFact = factTables[0];
  const keyCols: ContractColumn[] = [];
  const otherCols: ContractColumn[] = [];
  const seen = new Set<string>();
  for (const t of factTables) {
    for (const c of t.columns) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      const col: ContractColumn = {
        name: c.name,
        type: c.type,
        nullable: c.role !== 'key',
        key: c.role === 'key',
      };
      (col.key ? keyCols : otherCols).push(col);
    }
  }
  const schema = [...keyCols, ...otherCols];

  // grain from key columns of the primary fact
  const grainKeys = keyCols.map((c) => c.name);
  const grain = grainKeys.length
    ? `one row per (${grainKeys.join(', ')})`
    : 'one row per source event';

  // quality checks — derived but sensible
  const quality_checks: QualityCheck[] = [];
  if (grainKeys.length) {
    quality_checks.push({
      id: 'unique_grain',
      rule: `count(*) = count(distinct ${grainKeys.join(', ')})`,
    });
  }
  const measureCols = (primaryFact?.columns ?? []).filter(
    (c) => c.role === 'measure' && NUMERIC.test(c.type)
  );
  for (const m of measureCols.slice(0, 3)) {
    quality_checks.push({ id: `non_negative_${m.name}`, rule: `min(${m.name}) >= 0` });
  }
  // parts <= total heuristic (a *_total / total_* measure dominates its siblings)
  const totalCol = measureCols.find((c) => /total/i.test(c.name));
  const partCols = measureCols.filter((c) => c !== totalCol && /(shop|fuel|dual|part|sub)/i.test(c.name));
  if (totalCol && partCols.length) {
    quality_checks.push({
      id: 'parts_le_total',
      rule: partCols.map((p) => `${p.name} <= ${totalCol.name}`).join(' AND '),
    });
  }
  if (quality_checks.length === 0) {
    quality_checks.push({ id: 'row_count_positive', rule: 'count(*) > 0' });
  }

  const sources = [...factTables.map((t) => t.table), ...components.tables.filter((t) => t.role === 'dim').map((t) => t.table)];

  return {
    name: `${product.product_name}_contract`,
    product: product.product_name,
    status: 'defined',
    serving_object: `jai_ontos.demo_schema.${product.product_name} (planned)`,
    grain,
    live: false,
    schema,
    quality_checks,
    freshness: {
      sla: 'planned — no live serving layer yet (target: daily by 06:00 local)',
      basis: grainKeys.find((k) => /date|day/i.test(k)) ?? 'load timestamp',
    },
    scope: {
      included: `${product.kpis.join(', ')} over ${factTables.map((t) => shortTable(t.table)).join(', ')}`,
      excluded: 'customer PII; cross-domain measures not in the listed sources',
    },
    assumptions: [
      'Schema-derived from the live fc_entdata_gold catalog — not yet materialized as a governed serving view.',
      'Keys/measures inferred heuristically from column names + types.',
      'Quality checks are candidate rules to confirm with the data owner.',
    ],
    lineage: { sources, serving: `jai_ontos.demo_schema.${product.product_name} (planned)` },
  };
}
