-- =============================================================================
-- jai_store_day_traffic_labor  (CONFORMED SERVING VIEW — SEED-BACKED variant)
-- Target: jai_ontos.demo_schema   |  Warehouse: bf7ffcda00a8c351
--
-- Use this when the physical source is unavailable (fc_entdata_gold not reachable,
-- jai_ontos.rt_str_lbr empty). It reads the labeled synthetic base table created
-- by sql/00 instead of the reference tables. KPI formulas are identical to
-- sql/01 and ontology/semantic_measures.yaml — only the FROM clause differs.
--
-- When real source data lands, switch back to sql/01_jai_store_day_traffic_labor.sql.
-- =============================================================================
CREATE OR REPLACE VIEW jai_ontos.demo_schema.jai_store_day_traffic_labor AS
SELECT
  store_number, store_name, store_city, state_code, region_name, store_status,
  date_key, calendar_day,
  total_customers, shop_customers, fuel_customers, dual_customers,
  total_labor_hours, total_labor_cost,
  -- ---- centralized KPIs (== semantic_measures.yaml / sql/01) ----------------
  CAST(total_labor_cost  / NULLIF(total_customers, 0) AS DECIMAL(18,4)) AS labor_cost_per_customer,
  CAST(total_labor_hours / NULLIF(total_customers, 0) AS DECIMAL(18,4)) AS labor_hours_per_customer,
  CAST(100.0 * dual_customers / NULLIF(total_customers, 0) AS DECIMAL(18,2)) AS dual_customer_conversion_rate_pct
FROM jai_ontos.demo_schema.jai_synthetic_store_day_seed;
