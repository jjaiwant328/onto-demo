-- Per-store rollup for the Business View "Store diagnostics" table.
-- Pre-aggregated by the governed serving view (jai_store_efficiency_summary);
-- the app reads it as-is and never recomputes KPIs.
-- Optional filters are comma-separated strings; empty string = no filter.
-- @param regions STRING
-- @param states STRING
-- @param stores STRING
SELECT
  store_number,
  store_name,
  region_name,
  state_code,
  active_days,
  total_customers,
  avg_daily_customers,
  labor_cost_per_customer,
  labor_hours_per_customer,
  dual_customer_conversion_rate_pct
FROM jai_ontos.demo_schema.jai_store_efficiency_summary
WHERE (:regions = '' OR array_contains(split(:regions, ','), region_name))
  AND (:states  = '' OR array_contains(split(:states,  ','), state_code))
  AND (:stores  = '' OR array_contains(split(:stores,  ','), CAST(store_number AS STRING)))
ORDER BY labor_cost_per_customer DESC;
