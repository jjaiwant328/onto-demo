// Single source of truth for the two DATA-BACKED "demo" domains overlaid on the
// QSR Supply Chain schema, plus the backing serving schema. Both the client
// (domain injection + "Data Avlbl" framing) and the server (exception SQL over
// appkit.analytics) read from here, so pointing at the real QSR catalog/schema
// later is a ONE-LINE change to DEMO_BACKING_CATALOG_SCHEMA.

// The backing serving schema (synthetic today; swap to the real QSR schema here).
export const DEMO_BACKING_CATALOG_SCHEMA = 'jai_ontos.qsr_demo';

// A data-backed product: a real backing table + the exception predicate that
// selects the actionable rows, plus a short issue/action framing for the LLM.
export type DemoProduct = {
  product_name: string; // catalog product_name (stable id)
  display_name: string;
  business_outcome: string;
  table: string; // backing table (unqualified; joined to DEMO_BACKING_CATALOG_SCHEMA)
  fact_tables: string[]; // qualified names for the derived catalog/graph
  kpis: string[];
  // exception selection: the WHERE predicate that flags actionable rows
  exception_where: string;
  // an ORDER BY that surfaces the worst offenders first (optional)
  exception_order_by?: string;
  // short framing used in the LLM prompt
  issue: string; // one-line description of the exception condition
  action_hint: string; // what a good recommended action looks like
  // SELECT list (over the exception-filtered rows) that produces ONE summary row
  // of aggregate stats — counts by category/severity, averages, worst offenders.
  aggregate_select: string;
};

export type DemoDomain = {
  name: string; // catalog domain name (stable id)
  label: string;
  description: string;
  products: DemoProduct[];
};

const SCHEMA = DEMO_BACKING_CATALOG_SCHEMA;

export const DEMO_DOMAINS: DemoDomain[] = [
  {
    name: 'data_quality_observability',
    label: 'Data Quality & Observability',
    description:
      'Data-backed DQ, freshness, and pipeline health over the QSR serving layer.',
    products: [
      {
        product_name: 'dq_test_failures',
        display_name: 'DQ Test Failures',
        business_outcome: 'Surface and triage failing data-quality tests before they reach consumers.',
        table: 'dq_test_results',
        fact_tables: [`${SCHEMA}.dq_test_results`],
        kpis: ['failed_tests', 'critical_failures', 'failed_rows'],
        exception_where: "status = 'fail'",
        exception_order_by:
          "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, failed_rows DESC",
        issue: 'Data-quality tests are failing (status = fail), weighted by severity and failed_rows.',
        action_hint:
          'Assign the owner_email to fix the failing test/table; prioritize critical/high severity and large failed_rows.',
        aggregate_select:
          "count(*) AS failed_tests, " +
          "sum(CASE WHEN severity='critical' THEN 1 ELSE 0 END) AS critical, " +
          "sum(CASE WHEN severity='high' THEN 1 ELSE 0 END) AS high, " +
          "count(distinct table_name) AS tables_affected, " +
          "sum(failed_rows) AS total_failed_rows, " +
          "max(failed_rows) AS worst_failed_rows",
      },
      {
        product_name: 'table_freshness',
        display_name: 'Table Freshness',
        business_outcome: 'Detect stale serving tables that miss their expected freshness SLA.',
        table: 'table_health',
        fact_tables: [`${SCHEMA}.table_health`],
        kpis: ['stale_tables', 'staleness_hours'],
        exception_where: 'is_stale = true',
        exception_order_by: 'staleness_hours DESC',
        issue: 'Tables are stale (is_stale = true) — staleness_hours exceeds expected_freshness_hours.',
        action_hint:
          'Re-run or unblock the upstream pipeline for the stale table; escalate to owner_email when staleness is large.',
        aggregate_select:
          "count(*) AS stale_tables, " +
          "round(avg(staleness_hours), 1) AS avg_staleness_hours, " +
          "max(staleness_hours) AS worst_staleness_hours, " +
          "count(distinct owner_email) AS owners_affected",
      },
      {
        product_name: 'pipeline_health',
        display_name: 'Pipeline Health',
        business_outcome: 'Catch failed pipeline runs and repeated retries early.',
        table: 'pipeline_runs',
        fact_tables: [`${SCHEMA}.pipeline_runs`],
        kpis: ['failed_runs', 'retries'],
        exception_where: "status = 'failed'",
        exception_order_by: 'retries DESC, run_ts DESC',
        issue: 'Pipeline runs are failing (status = failed), some with multiple retries.',
        action_hint:
          'Investigate the failing pipeline (logs/retries), fix the root cause, and re-run; watch high-retry pipelines.',
        aggregate_select:
          "count(*) AS failed_runs, " +
          "count(distinct pipeline) AS pipelines_affected, " +
          "sum(CASE WHEN retries >= 2 THEN 1 ELSE 0 END) AS high_retry_runs, " +
          "max(retries) AS worst_retries",
      },
    ],
  },
  {
    name: 'demand_forecasting_planning',
    label: 'Demand Forecasting & Planning',
    description:
      'Data-backed forecast accuracy, inventory risk, and PO fulfillment over the QSR serving layer.',
    products: [
      {
        product_name: 'forecast_accuracy',
        display_name: 'Forecast Accuracy',
        business_outcome: 'Find items whose demand forecast is materially off (high MAPE).',
        table: 'forecast_accuracy',
        fact_tables: [`${SCHEMA}.forecast_accuracy`],
        kpis: ['high_mape_items', 'mape_pct', 'bias_pct'],
        exception_where: 'mape_pct > 30',
        exception_order_by: 'mape_pct DESC',
        issue: 'Items have poor forecast accuracy (mape_pct > 30%), some with directional bias.',
        action_hint:
          'Retune the forecast for high-MAPE items; correct persistent bias and review promotions/seasonality.',
        aggregate_select:
          "count(*) AS high_mape_items, " +
          "round(avg(mape_pct), 1) AS avg_mape_pct, " +
          "max(mape_pct) AS worst_mape_pct, " +
          "sum(CASE WHEN abs(bias_pct) > 15 THEN 1 ELSE 0 END) AS strongly_biased_items, " +
          "count(distinct location_id) AS locations_affected",
      },
      {
        product_name: 'inventory_stockout_risk',
        display_name: 'Inventory & Stockout Risk',
        business_outcome: 'Prevent stockouts by flagging items below safety stock / low days of supply.',
        table: 'inventory_position',
        fact_tables: [`${SCHEMA}.inventory_position`],
        kpis: ['at_risk_items', 'days_of_supply'],
        exception_where: 'stockout_risk = true',
        exception_order_by: 'days_of_supply ASC',
        issue: 'Items are at stockout risk (stockout_risk = true) — low days_of_supply vs demand.',
        action_hint:
          'Expedite replenishment / raise safety stock for at-risk items with the fewest days_of_supply.',
        aggregate_select:
          "count(*) AS at_risk_items, " +
          "round(avg(days_of_supply), 1) AS avg_days_of_supply, " +
          "min(days_of_supply) AS worst_days_of_supply, " +
          "sum(CASE WHEN days_of_supply < 3 THEN 1 ELSE 0 END) AS critical_items, " +
          "count(distinct location_id) AS locations_affected",
      },
      {
        product_name: 'purchase_order_fulfillment',
        display_name: 'Purchase Order Fulfillment',
        business_outcome: 'Track late purchase orders and supplier reliability.',
        table: 'purchase_orders',
        fact_tables: [`${SCHEMA}.purchase_orders`],
        kpis: ['late_pos', 'days_late'],
        exception_where: "status = 'late'",
        exception_order_by: 'days_late DESC',
        issue: 'Purchase orders are late (status = late), some by many days.',
        action_hint:
          'Follow up with the supplier on the most-late POs; escalate chronic late suppliers.',
        aggregate_select:
          "count(*) AS late_pos, " +
          "count(distinct supplier) AS suppliers_affected, " +
          "round(avg(days_late), 1) AS avg_days_late, " +
          "max(days_late) AS worst_days_late, " +
          "sum(CASE WHEN days_late > 7 THEN 1 ELSE 0 END) AS severely_late",
      },
    ],
  },
];

// flat product lookup by product_name (used by the server exception endpoint)
export const DEMO_PRODUCTS: Record<string, DemoProduct & { domainLabel: string }> = Object.fromEntries(
  DEMO_DOMAINS.flatMap((d) => d.products.map((p) => [p.product_name, { ...p, domainLabel: d.label }]))
);

// is a product_name one of the data-backed demo products?
export function isDemoProduct(productName: string | undefined): boolean {
  return Boolean(productName && productName in DEMO_PRODUCTS);
}

// build the exception SQL for a demo product (capped)
export function demoExceptionSql(productName: string, limit = 25): string | null {
  const p = DEMO_PRODUCTS[productName];
  if (!p) return null;
  const order = p.exception_order_by ? ` ORDER BY ${p.exception_order_by}` : '';
  return `SELECT * FROM ${DEMO_BACKING_CATALOG_SCHEMA}.${p.table} WHERE ${p.exception_where}${order} LIMIT ${limit}`;
}

// aggregate summary stats over the exception-filtered rows (ONE row). Used to
// produce a handful of high-level aggregate actions instead of one-per-row.
export function demoAggregateSql(productName: string): string | null {
  const p = DEMO_PRODUCTS[productName];
  if (!p) return null;
  return `SELECT ${p.aggregate_select} FROM ${DEMO_BACKING_CATALOG_SCHEMA}.${p.table} WHERE ${p.exception_where}`;
}

// a compact "snapshot" query set for the copilot (counts + top rows per product)
export function demoSnapshotSql(productName: string, topN = 10): { count: string; top: string } | null {
  const p = DEMO_PRODUCTS[productName];
  if (!p) return null;
  const order = p.exception_order_by ? ` ORDER BY ${p.exception_order_by}` : '';
  return {
    count: `SELECT count(*) AS exception_count FROM ${DEMO_BACKING_CATALOG_SCHEMA}.${p.table} WHERE ${p.exception_where}`,
    top: `SELECT * FROM ${DEMO_BACKING_CATALOG_SCHEMA}.${p.table} WHERE ${p.exception_where}${order} LIMIT ${topN}`,
  };
}
