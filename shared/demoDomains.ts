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
  dim_tables?: string[]; // related tables in the domain (multi-table flow demo)
  serving_example?: string; // an example serving object (already hand-built)
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
  // catalog.schema the backing `table` lives in; defaults to DEMO_BACKING_CATALOG_SCHEMA
  // (jai_ontos.qsr_demo). The QSR control-tower products override this to qsr_sc.
  backing_schema?: string;
  // curated prescriptive playbook (QSR layer): grounds the LLM and renders even
  // without a model. `source` is honest: 'db' = derivable from the data,
  // 'guidance' = operational best-practice not in the database.
  playbook?: { root_cause: string; recommended_action: string; source: 'db' | 'guidance' }[];
};

export type DemoDomain = {
  name: string; // catalog domain name (stable id)
  label: string;
  description: string;
  products: DemoProduct[];
};

// An ontology reasoning rule (Phase 5): a business rule expressed over ontology
// concepts. Illustrative/declarative — the app surfaces these, it does not
// execute them (decisions stay aggregate-level; no action is taken).
export type ReasoningRule = {
  id: string;
  domain: string; // DemoDomain.name it belongs to
  name: string;
  if_conditions: string[];
  then_conclusion: string;
  concepts: string[]; // ontology concepts / signals the rule reasons over
  evidence?: string; // where the signal shows up in the spine (table/column)
};

const SCHEMA = DEMO_BACKING_CATALOG_SCHEMA;
// backing schema for the QSR Supply Chain Control Tower spine (slice 1 data-gen)
export const QSR_SC_SCHEMA = 'jai_ontos.qsr_sc';

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
        dim_tables: [`${SCHEMA}.table_health`, `${SCHEMA}.pipeline_runs`],
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
        dim_tables: [`${SCHEMA}.dq_test_results`, `${SCHEMA}.pipeline_runs`],
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
        dim_tables: [`${SCHEMA}.dq_test_results`, `${SCHEMA}.table_health`],
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
        dim_tables: [`${SCHEMA}.inventory_position`, `${SCHEMA}.purchase_orders`],
        serving_example: `${SCHEMA}.jai_demand_planning_serving`,
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
        dim_tables: [`${SCHEMA}.forecast_accuracy`, `${SCHEMA}.purchase_orders`],
        serving_example: `${SCHEMA}.jai_demand_planning_serving`,
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
        dim_tables: [`${SCHEMA}.forecast_accuracy`, `${SCHEMA}.inventory_position`],
        serving_example: `${SCHEMA}.jai_demand_planning_serving`,
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

// The backing tables' column shapes (from the jai_ontos.qsr_demo DDL). Merged
// into the active schema when the demo domains are active so the derived
// ontology (relationships/mappings) + Suggest/Validate/Generate operate on the
// real columns. Keys are catalog-qualified to match fact_tables/dim_tables.
export const DEMO_SCHEMA: Record<string, { name: string; type: string }[]> = {
  [`${SCHEMA}.dq_test_results`]: [
    { name: 'test_id', type: 'string' },
    { name: 'test_name', type: 'string' },
    { name: 'table_name', type: 'string' },
    { name: 'run_ts', type: 'timestamp' },
    { name: 'status', type: 'string' },
    { name: 'failed_rows', type: 'bigint' },
    { name: 'threshold_rows', type: 'bigint' },
    { name: 'severity', type: 'string' },
    { name: 'owner_email', type: 'string' },
  ],
  [`${SCHEMA}.table_health`]: [
    { name: 'table_name', type: 'string' },
    { name: 'last_refresh_ts', type: 'timestamp' },
    { name: 'expected_freshness_hours', type: 'int' },
    { name: 'staleness_hours', type: 'double' },
    { name: 'row_count', type: 'bigint' },
    { name: 'is_stale', type: 'boolean' },
    { name: 'owner_email', type: 'string' },
  ],
  [`${SCHEMA}.pipeline_runs`]: [
    { name: 'run_id', type: 'string' },
    { name: 'pipeline', type: 'string' },
    { name: 'run_ts', type: 'timestamp' },
    { name: 'status', type: 'string' },
    { name: 'duration_min', type: 'double' },
    { name: 'expected_min', type: 'double' },
    { name: 'retries', type: 'int' },
  ],
  [`${SCHEMA}.forecast_accuracy`]: [
    { name: 'item_id', type: 'string' },
    { name: 'item_name', type: 'string' },
    { name: 'location_id', type: 'string' },
    { name: 'week', type: 'date' },
    { name: 'forecast_qty', type: 'double' },
    { name: 'actual_qty', type: 'double' },
    { name: 'mape_pct', type: 'double' },
    { name: 'bias_pct', type: 'double' },
  ],
  [`${SCHEMA}.inventory_position`]: [
    { name: 'item_id', type: 'string' },
    { name: 'item_name', type: 'string' },
    { name: 'location_id', type: 'string' },
    { name: 'on_hand', type: 'double' },
    { name: 'safety_stock', type: 'double' },
    { name: 'avg_daily_demand', type: 'double' },
    { name: 'days_of_supply', type: 'double' },
    { name: 'stockout_risk', type: 'boolean' },
  ],
  [`${SCHEMA}.purchase_orders`]: [
    { name: 'po_id', type: 'string' },
    { name: 'supplier', type: 'string' },
    { name: 'item_id', type: 'string' },
    { name: 'order_date', type: 'date' },
    { name: 'promised_date', type: 'date' },
    { name: 'received_date', type: 'date' },
    { name: 'status', type: 'string' },
    { name: 'days_late', type: 'int' },
  ],
};

// ── QSR Supply Chain Control Tower — 3 ontology layers over the jai_ontos.qsr_sc
// spine (slice 1). Data-backed (badged "Data Avlbl"); the ontology/graph derive
// from these fact/dim tables. Backing schema = QSR_SC_SCHEMA. ──────────────────
const SC = QSR_SC_SCHEMA;
export const QSR_SC_DOMAINS: DemoDomain[] = [
  {
    name: 'qsr_demand_inventory_waste',
    label: 'Demand, Inventory & Waste',
    description:
      'Ontology layer 1 — demand signals, inventory position, and waste across restaurants and ingredients.',
    products: [
      {
        product_name: 'sc_inventory_stockout',
        display_name: 'Inventory & Stockout Risk',
        business_outcome: 'Flag restaurant/ingredient positions at stockout risk before service is impacted.',
        table: 'jai_inventory_event',
        backing_schema: SC,
        fact_tables: [`${SC}.jai_inventory_event`],
        dim_tables: [`${SC}.jai_dim_restaurant`, `${SC}.jai_dim_ingredient`],
        kpis: ['at_risk_items', 'days_of_supply'],
        exception_where: 'stockout_risk = true',
        exception_order_by: 'days_of_supply ASC',
        issue: 'Ingredient positions at stockout risk (low days_of_supply, or supplier-outage impacted).',
        action_hint: 'Expedite replenishment / find alternate supply for the lowest days_of_supply positions.',
        playbook: [
          { root_cause: 'A single-source supplier outage is blocking replenishment (impacted_by_supplier_outage = true on the at-risk rows).', recommended_action: 'Activate the qualified alternate supplier for the affected ingredient lines and expedite an emergency shipment to the DC serving those restaurants.', source: 'db' },
          { root_cause: 'Demand ran ahead of forecast so days_of_supply fell below the safety threshold.', recommended_action: 'Raise safety stock for high-variance SKUs and pull the next replenishment forward.', source: 'guidance' },
        ],
        aggregate_select:
          'count(*) AS at_risk_items, ' +
          'round(avg(days_of_supply),1) AS avg_days_of_supply, ' +
          'round(min(days_of_supply),1) AS worst_days_of_supply, ' +
          'sum(CASE WHEN impacted_by_supplier_outage THEN 1 ELSE 0 END) AS outage_driven, ' +
          'count(distinct restaurant_id) AS restaurants_affected',
      },
      {
        product_name: 'sc_waste',
        display_name: 'Waste Events',
        business_outcome: 'Reduce waste by surfacing high-dollar waste and its drivers (weather, shelf life).',
        table: 'jai_waste_event',
        backing_schema: SC,
        fact_tables: [`${SC}.jai_waste_event`],
        dim_tables: [`${SC}.jai_dim_restaurant`, `${SC}.jai_dim_ingredient`],
        kpis: ['waste_units', 'waste_usd'],
        exception_where: 'waste_usd > 120',
        exception_order_by: 'waste_usd DESC',
        issue: 'High-dollar waste events; weather-driven traffic drops and short shelf life are common drivers.',
        action_hint: 'Adjust thaw/production plans for the highest-waste stores; review weather-impacted regions.',
        aggregate_select:
          'count(*) AS waste_events, ' +
          'round(sum(waste_usd),0) AS total_waste_usd, ' +
          'round(avg(waste_units),1) AS avg_waste_units, ' +
          'count(distinct restaurant_id) AS restaurants_affected, ' +
          'count(distinct region) AS regions_affected',
      },
      {
        product_name: 'sc_forecast_demand',
        display_name: 'Forecast & Demand Surge',
        business_outcome: 'Anticipate demand surges (heat wave, promotions) to align production.',
        table: 'jai_forecast',
        backing_schema: SC,
        fact_tables: [`${SC}.jai_forecast`],
        dim_tables: [`${SC}.jai_dim_restaurant`, `${SC}.jai_dim_calendar`],
        kpis: ['forecast_transactions', 'beverage_demand_index'],
        exception_where: 'heat_wave_active = true OR promo_active = true',
        exception_order_by: 'beverage_demand_index DESC',
        issue: 'Demand-surge days driven by heat wave or promotion (elevated beverage demand index).',
        action_hint: 'Pre-position beverage/high-demand items for surge days; confirm production uplift.',
        aggregate_select:
          'count(*) AS surge_days, ' +
          'round(avg(beverage_demand_index),2) AS avg_beverage_index, ' +
          'round(max(beverage_demand_index),2) AS peak_beverage_index, ' +
          'count(distinct restaurant_id) AS restaurants_affected',
      },
    ],
  },
  {
    name: 'qsr_supplier_distribution',
    label: 'Supplier & Distribution',
    description:
      'Ontology layer 2 — suppliers, purchase orders, distribution-center capacity, and lead-time risk.',
    products: [
      {
        product_name: 'sc_po_fulfillment',
        display_name: 'Purchase Order Fulfillment',
        business_outcome: 'Track late purchase orders and the suppliers/outages driving them.',
        table: 'jai_purchase_order',
        backing_schema: SC,
        fact_tables: [`${SC}.jai_purchase_order`],
        dim_tables: [`${SC}.jai_dim_supplier`, `${SC}.jai_dim_distribution_center`],
        kpis: ['late_pos', 'days_late'],
        exception_where: "status = 'late'",
        exception_order_by: 'days_late DESC',
        issue: 'Purchase orders are late; a single-source supplier outage is a major driver.',
        action_hint: 'Escalate the most-late POs; activate alternate suppliers for outage-impacted lines.',
        playbook: [
          { root_cause: 'Outage-impacted POs (impacted_by_outage = true) concentrate on one single-source supplier.', recommended_action: 'Escalate with that supplier and split volume to a secondary source for the most-late POs (highest days_late first).', source: 'db' },
          { root_cause: 'Chronic lateness from suppliers with on_time_rate below target.', recommended_action: 'Trigger a supplier scorecard review and add a backup supplier to the contract.', source: 'guidance' },
        ],
        aggregate_select:
          'count(*) AS late_pos, ' +
          'count(distinct supplier_id) AS suppliers_affected, ' +
          'round(avg(days_late),1) AS avg_days_late, ' +
          'max(days_late) AS worst_days_late, ' +
          'sum(CASE WHEN impacted_by_outage THEN 1 ELSE 0 END) AS outage_driven',
      },
      {
        product_name: 'sc_supplier_risk',
        display_name: 'Supplier Risk',
        business_outcome: 'Surface single-source and low-reliability suppliers before they disrupt supply.',
        table: 'jai_dim_supplier',
        backing_schema: SC,
        fact_tables: [`${SC}.jai_dim_supplier`],
        dim_tables: [`${SC}.jai_dim_ingredient`],
        kpis: ['on_time_rate', 'avg_lead_time_days'],
        exception_where: 'single_source = true OR on_time_rate < 0.9',
        exception_order_by: 'on_time_rate ASC',
        issue: 'Suppliers that are single-source or below a 90% on-time rate — elevated dependency risk.',
        action_hint: 'Qualify alternate suppliers for single-source lines; review contracts for chronic late suppliers.',
        aggregate_select:
          'count(*) AS at_risk_suppliers, ' +
          'sum(CASE WHEN single_source THEN 1 ELSE 0 END) AS single_source_suppliers, ' +
          'round(avg(on_time_rate),3) AS avg_on_time_rate, ' +
          'round(max(avg_lead_time_days),1) AS worst_lead_time_days',
      },
      {
        product_name: 'sc_dc_capacity',
        display_name: 'Distribution Center Capacity',
        business_outcome: 'Identify capacity-constrained distribution centers before they bottleneck.',
        table: 'jai_dim_distribution_center',
        backing_schema: SC,
        fact_tables: [`${SC}.jai_dim_distribution_center`],
        dim_tables: [`${SC}.jai_dim_restaurant`],
        kpis: ['utilization_pct', 'capacity_cases'],
        exception_where: 'utilization_pct > 0.85',
        exception_order_by: 'utilization_pct DESC',
        issue: 'Distribution centers running above 85% utilization — capacity constrained.',
        action_hint: 'Rebalance volume to lower-utilization DCs; plan capacity for the most-constrained centers.',
        aggregate_select:
          'count(*) AS constrained_dcs, ' +
          'round(avg(utilization_pct),3) AS avg_utilization, ' +
          'round(max(utilization_pct),3) AS peak_utilization, ' +
          'sum(capacity_cases) AS total_capacity_cases',
      },
    ],
  },
  {
    name: 'qsr_restaurant_operations',
    label: 'Restaurant Operations',
    description:
      'Ontology layer 3 — kitchen equipment health, maintenance, and labor/staffing at the restaurant.',
    products: [
      {
        product_name: 'sc_equipment_health',
        display_name: 'Equipment Health',
        business_outcome: 'Catch failing/at-risk kitchen equipment before it disrupts production.',
        table: 'jai_equipment_health',
        backing_schema: SC,
        fact_tables: [`${SC}.jai_equipment_health`],
        dim_tables: [`${SC}.jai_equipment`, `${SC}.jai_dim_restaurant`],
        kpis: ['health_score'],
        exception_where: "status = 'Failure' OR health_score < 40",
        exception_order_by: 'health_score ASC',
        issue: 'Equipment readings in failure or low-health state (e.g. fryer failures) — production risk.',
        action_hint: 'Dispatch maintenance to the lowest-health units; adjust production where equipment is down.',
        playbook: [
          { root_cause: 'A pressure fryer is in a failure state at an affected restaurant (status = Failure).', recommended_action: 'Dispatch field maintenance today and shift affected menu-item production to a backup line until restored.', source: 'db' },
          { root_cause: 'Units trending toward failure (declining health_score) without a scheduled service.', recommended_action: 'Schedule preventive maintenance for units below the health threshold before they fail.', source: 'guidance' },
        ],
        aggregate_select:
          'count(*) AS unhealthy_readings, ' +
          'count(distinct restaurant_id) AS restaurants_affected, ' +
          'round(avg(health_score),1) AS avg_health_score, ' +
          'round(min(health_score),1) AS worst_health_score, ' +
          "sum(CASE WHEN status='Failure' THEN 1 ELSE 0 END) AS failures",
      },
      {
        product_name: 'sc_labor_staffing',
        display_name: 'Labor & Staffing',
        business_outcome: 'Flag understaffed shifts that degrade drive-thru service.',
        table: 'jai_labor_shift',
        backing_schema: SC,
        fact_tables: [`${SC}.jai_labor_shift`],
        dim_tables: [`${SC}.jai_dim_restaurant`, `${SC}.jai_dim_calendar`],
        kpis: ['staffing_ratio'],
        exception_where: 'staffing_ratio < 0.8',
        exception_order_by: 'staffing_ratio ASC',
        issue: 'Shifts running below 80% of planned staff — service degradation risk (labor shortage regions).',
        action_hint: 'Shift labor to understaffed stores; prioritize hiring in chronically short regions.',
        aggregate_select:
          'count(*) AS understaffed_shifts, ' +
          'count(distinct restaurant_id) AS restaurants_affected, ' +
          'round(avg(staffing_ratio),2) AS avg_staffing_ratio, ' +
          'round(min(staffing_ratio),2) AS worst_staffing_ratio',
      },
    ],
  },
];

// Phase 5 — ontology reasoning rules for the QSR control tower (illustrative;
// surfaced in Ontology Studio, not executed).
export const QSR_SC_REASONING_RULES: ReasoningRule[] = [
  {
    id: 'RR1',
    domain: 'qsr_demand_inventory_waste',
    name: 'Heat wave drives beverage demand',
    if_conditions: ['Temperature > 90°F (heat-wave signal)', 'Promotion active or peak daypart'],
    then_conclusion: 'Increase beverage demand → pre-position beverage inventory',
    concepts: ['WeatherEvent', 'Promotion', 'Forecast', 'Ingredient(Beverage)'],
    evidence: 'jai_weather_daily.temp_f, jai_forecast.beverage_demand_index',
  },
  {
    id: 'RR2',
    domain: 'qsr_demand_inventory_waste',
    name: 'Shelf life below forecast consumption → waste risk',
    if_conditions: ['Shelf-life remaining < forecast consumption window'],
    then_conclusion: 'Waste risk HIGH → reduce thaw/production plan',
    concepts: ['Ingredient(ShelfLife)', 'Forecast', 'WasteEvent'],
    evidence: 'jai_inventory_event.at_waste_risk, jai_dim_ingredient.shelf_life_days',
  },
  {
    id: 'RR3',
    domain: 'qsr_demand_inventory_waste',
    name: 'Snowstorm suppresses traffic → over-production waste',
    if_conditions: ['Snowstorm in region', 'Production schedule not adjusted'],
    then_conclusion: 'Excess inventory → elevated waste',
    concepts: ['WeatherEvent', 'Restaurant', 'WasteEvent'],
    evidence: 'jai_weather_daily.condition, jai_waste_event.waste_reason',
  },
  {
    id: 'RR4',
    domain: 'qsr_supplier_distribution',
    name: 'Supplier delay + no alternate → stockout risk',
    if_conditions: ['Supplier delay / outage', 'Ingredient is single-source'],
    then_conclusion: 'Restaurant stockout risk → expedite / activate alternate supplier',
    concepts: ['Supplier(single_source)', 'PurchaseOrder', 'InventoryPosition'],
    evidence: 'jai_dim_supplier.single_source, jai_purchase_order.days_late, jai_inventory_event.stockout_risk',
  },
  {
    id: 'RR5',
    domain: 'qsr_supplier_distribution',
    name: 'DC utilization high → capacity constraint',
    if_conditions: ['Distribution-center utilization > 85%'],
    then_conclusion: 'Capacity constrained → rebalance volume to other DCs',
    concepts: ['DistributionCenter', 'Shipment'],
    evidence: 'jai_dim_distribution_center.utilization_pct',
  },
  {
    id: 'RR6',
    domain: 'qsr_restaurant_operations',
    name: 'Fryer failure → production down',
    if_conditions: ['Pressure fryer in failure state'],
    then_conclusion: 'Menu-item availability risk → dispatch maintenance, adjust production',
    concepts: ['Equipment', 'EquipmentHealth', 'Production', 'MenuItem'],
    evidence: "jai_equipment_health.status = 'Failure'",
  },
  {
    id: 'RR7',
    domain: 'qsr_restaurant_operations',
    name: 'Labor shortage → service degradation',
    if_conditions: ['Staffing ratio < 0.8'],
    then_conclusion: 'Drive-thru service degradation → reallocate labor',
    concepts: ['LaborShift', 'Restaurant', 'Queue'],
    evidence: 'jai_labor_shift.staffing_ratio, jai_labor_shift.labor_shortage',
  },
];

// Curated QSR subclass taxonomy: a class (by short name) → a superclass label
// and the subclasses it specializes into. Emitted as rdfs:subClassOf axioms in
// the ontology artifact (e.g. Ingredient → Chicken/Produce/Sauce/…). QSR layer;
// engine stays generic (products without a taxonomy entry emit no subclasses).
export const QSR_SUBCLASS_TAXONOMY: Record<string, { superclass: string; subclasses: string[] }> = {
  jai_dim_ingredient: {
    superclass: 'Ingredient',
    subclasses: ['Chicken', 'Produce', 'Sauce', 'Beverage', 'Packaging', 'Dairy', 'Bread'],
  },
};

// all data-backed domains (qsr_demo + qsr_sc control tower)
export const ALL_DEMO_DOMAINS: DemoDomain[] = [...DEMO_DOMAINS, ...QSR_SC_DOMAINS];

// flat product lookup by product_name (used by the server exception endpoint) —
// spans BOTH the qsr_demo demo domains and the qsr_sc control-tower domains.
export const DEMO_PRODUCTS: Record<string, DemoProduct & { domainLabel: string }> = Object.fromEntries(
  ALL_DEMO_DOMAINS.flatMap((d) => d.products.map((p) => [p.product_name, { ...p, domainLabel: d.label }]))
);

// is a product_name one of the data-backed demo products?
export function isDemoProduct(productName: string | undefined): boolean {
  return Boolean(productName && productName in DEMO_PRODUCTS);
}

// build the exception SQL for a demo product (capped)
export function demoExceptionSql(productName: string, limit = 25): string | null {
  const p = DEMO_PRODUCTS[productName];
  if (!p) return null;
  const schema = p.backing_schema ?? DEMO_BACKING_CATALOG_SCHEMA;
  const order = p.exception_order_by ? ` ORDER BY ${p.exception_order_by}` : '';
  return `SELECT * FROM ${schema}.${p.table} WHERE ${p.exception_where}${order} LIMIT ${limit}`;
}

// aggregate summary stats over the exception-filtered rows (ONE row). Used to
// produce a handful of high-level aggregate actions instead of one-per-row.
export function demoAggregateSql(productName: string): string | null {
  const p = DEMO_PRODUCTS[productName];
  if (!p) return null;
  const schema = p.backing_schema ?? DEMO_BACKING_CATALOG_SCHEMA;
  return `SELECT ${p.aggregate_select} FROM ${schema}.${p.table} WHERE ${p.exception_where}`;
}

// a compact "snapshot" query set for the copilot (counts + top rows per product)
export function demoSnapshotSql(productName: string, topN = 10): { count: string; top: string } | null {
  const p = DEMO_PRODUCTS[productName];
  if (!p) return null;
  const schema = p.backing_schema ?? DEMO_BACKING_CATALOG_SCHEMA;
  const order = p.exception_order_by ? ` ORDER BY ${p.exception_order_by}` : '';
  return {
    count: `SELECT count(*) AS exception_count FROM ${schema}.${p.table} WHERE ${p.exception_where}`,
    top: `SELECT * FROM ${schema}.${p.table} WHERE ${p.exception_where}${order} LIMIT ${topN}`,
  };
}
