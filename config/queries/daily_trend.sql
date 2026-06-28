-- Daily trend for the Business View. Each KPI is recomputed from base sums at the
-- day grain (derived KPIs are NOT averages of per-row ratios).
-- Optional filters are comma-separated strings; empty string = no filter.
-- @param regions STRING
-- @param states STRING
-- @param stores STRING
SELECT
  calendar_day,
  SUM(total_customers)                                            AS total_customers,
  SUM(total_labor_cost)  / NULLIF(SUM(total_customers), 0)        AS labor_cost_per_customer,
  SUM(total_labor_hours) / NULLIF(SUM(total_customers), 0)        AS labor_hours_per_customer,
  100.0 * SUM(dual_customers) / NULLIF(SUM(total_customers), 0)   AS dual_customer_conversion_rate_pct
FROM jai_ontos.demo_schema.jai_store_day_traffic_labor
WHERE (:regions = '' OR array_contains(split(:regions, ','), region_name))
  AND (:states  = '' OR array_contains(split(:states,  ','), state_code))
  AND (:stores  = '' OR array_contains(split(:stores,  ','), CAST(store_number AS STRING)))
GROUP BY calendar_day
ORDER BY calendar_day;
