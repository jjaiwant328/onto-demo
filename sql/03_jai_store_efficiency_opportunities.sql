-- =============================================================================
-- jai_store_efficiency_opportunities  (RANKED OPPORTUNITIES — grain: store)
-- Ranks stores by how far their labor_cost_per_customer exceeds a peer benchmark
-- (region median, falling back to company median when region is null/sparse).
-- "opportunity_usd" = estimated excess labor cost vs benchmark, scaled to volume.
-- Target: jai_ontos.demo_schema | Warehouse: 310314146ebd3230
-- =============================================================================
CREATE OR REPLACE VIEW jai_ontos.demo_schema.jai_store_efficiency_opportunities AS
WITH s AS (
  SELECT * FROM jai_ontos.demo_schema.jai_store_efficiency_summary
  WHERE total_customers > 0
),
bench AS (
  SELECT
    s.*,
    PERCENTILE(labor_cost_per_customer, 0.5)
      OVER (PARTITION BY COALESCE(region_name, '∅'))           AS region_median_lcpc,
    PERCENTILE(labor_cost_per_customer, 0.5) OVER ()           AS company_median_lcpc
  FROM s
),
scored AS (
  SELECT
    *,
    COALESCE(region_median_lcpc, company_median_lcpc)          AS benchmark_lcpc,
    labor_cost_per_customer
      - COALESCE(region_median_lcpc, company_median_lcpc)      AS lcpc_gap
  FROM bench
)
SELECT
  store_number,
  store_name,
  store_city,
  state_code,
  region_name,
  store_status,
  active_days,
  total_customers,
  avg_daily_customers,
  labor_cost_per_customer,
  labor_hours_per_customer,
  dual_customer_conversion_rate_pct,
  CAST(benchmark_lcpc AS DECIMAL(18,4))                         AS benchmark_lcpc,
  CAST(lcpc_gap       AS DECIMAL(18,4))                         AS lcpc_gap,
  -- excess labor cost vs benchmark over the observed period (only positive gaps)
  CAST(GREATEST(lcpc_gap, 0) * total_customers AS DECIMAL(18,2)) AS opportunity_usd,
  CASE
    WHEN lcpc_gap > 0 THEN 'over_cost_vs_peers'
    WHEN lcpc_gap < 0 THEN 'efficient_vs_peers'
    ELSE 'at_benchmark'
  END                                                          AS opportunity_flag,
  RANK() OVER (ORDER BY GREATEST(lcpc_gap, 0) * total_customers DESC) AS opportunity_rank
FROM scored
ORDER BY opportunity_usd DESC;
