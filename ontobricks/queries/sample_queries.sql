-- Executable equivalents of sample_queries.graphql over the serving views.
-- Warehouse: 310314146ebd3230

-- 1. Efficiency trend for one store
SELECT calendar_day, store_number, store_name, region_name,
       labor_cost_per_customer, labor_hours_per_customer, dual_customer_conversion_rate_pct
FROM jai_ontos.demo_schema.jai_store_day_traffic_labor
WHERE store_number = 1234
  AND calendar_day BETWEEN DATE'2026-01-01' AND DATE'2026-01-31'
ORDER BY calendar_day;

-- 2. Worst-efficiency stores in a region (last 30 days)
SELECT store_number, store_name,
       sum(total_labor_cost) / nullif(sum(total_customers),0) AS labor_cost_per_customer,
       sum(total_customers) AS total_customers
FROM jai_ontos.demo_schema.jai_store_day_traffic_labor
WHERE region_name = 'Southeast'
  AND calendar_day >= current_date() - INTERVAL 30 DAYS
GROUP BY store_number, store_name
ORDER BY labor_cost_per_customer DESC
LIMIT 20;

-- 3. Dual-customer conversion by store (last 30 days)
SELECT store_number, store_name,
       100.0 * sum(dual_customers) / nullif(sum(total_customers),0) AS dual_customer_conversion_rate_pct
FROM jai_ontos.demo_schema.jai_store_day_traffic_labor
WHERE calendar_day >= current_date() - INTERVAL 30 DAYS
GROUP BY store_number, store_name
ORDER BY dual_customer_conversion_rate_pct DESC;

-- 4. Pre-aggregated convenience (matches jai_store_efficiency_summary)
SELECT * FROM jai_ontos.demo_schema.jai_store_efficiency_summary ORDER BY labor_cost_per_customer DESC;
