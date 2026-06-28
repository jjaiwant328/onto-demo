-- Ranked efficiency opportunities for the Business View.
-- Source: jai_ontos.demo_schema.jai_store_efficiency_opportunities (governed view).
-- Optional filters are comma-separated strings; empty string = no filter.
-- @param regions STRING
-- @param states STRING
-- @param stores STRING
SELECT
  opportunity_rank,
  store_number,
  store_name,
  region_name,
  labor_cost_per_customer,
  benchmark_lcpc,
  lcpc_gap,
  opportunity_usd,
  opportunity_flag
FROM jai_ontos.demo_schema.jai_store_efficiency_opportunities
WHERE (:regions = '' OR array_contains(split(:regions, ','), region_name))
  AND (:states  = '' OR array_contains(split(:states,  ','), state_code))
  AND (:stores  = '' OR array_contains(split(:stores,  ','), CAST(store_number AS STRING)))
ORDER BY opportunity_rank;
