-- =============================================================================
-- jai_store_efficiency_summary  (STORE-LEVEL ROLLUP — grain: store)
-- Rolls the conformed store-day view to per-store KPIs over its full date range.
-- Derived KPIs are recomputed from re-aggregated base sums (NOT averaged ratios).
-- Target: jai_ontos.demo_schema | Warehouse: 310314146ebd3230
-- =============================================================================
CREATE OR REPLACE VIEW jai_ontos.demo_schema.jai_store_efficiency_summary AS
SELECT
  store_number,
  MAX(store_name)   AS store_name,
  MAX(store_city)   AS store_city,
  MAX(state_code)   AS state_code,
  MAX(region_name)  AS region_name,
  MAX(store_status) AS store_status,
  COUNT(DISTINCT calendar_day)              AS active_days,
  MIN(calendar_day)                         AS first_day,
  MAX(calendar_day)                         AS last_day,
  SUM(total_customers)                      AS total_customers,
  SUM(shop_customers)                       AS shop_customers,
  SUM(fuel_customers)                       AS fuel_customers,
  SUM(dual_customers)                       AS dual_customers,
  CAST(SUM(total_labor_hours) AS DECIMAL(18,2)) AS total_labor_hours,
  CAST(SUM(total_labor_cost)  AS DECIMAL(18,2)) AS total_labor_cost,
  -- ---- centralized KPIs (== semantic_measures.yaml) -----------------------
  CAST(SUM(total_labor_cost)  / NULLIF(SUM(total_customers), 0) AS DECIMAL(18,4)) AS labor_cost_per_customer,
  CAST(SUM(total_labor_hours) / NULLIF(SUM(total_customers), 0) AS DECIMAL(18,4)) AS labor_hours_per_customer,
  CAST(100.0 * SUM(dual_customers) / NULLIF(SUM(total_customers), 0) AS DECIMAL(18,2)) AS dual_customer_conversion_rate_pct,
  CAST(SUM(total_customers) * 1.0 / NULLIF(COUNT(DISTINCT calendar_day), 0) AS DECIMAL(18,2)) AS avg_daily_customers
FROM jai_ontos.demo_schema.jai_store_day_traffic_labor
GROUP BY store_number;
