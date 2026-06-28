-- =============================================================================
-- jai_store_day_traffic_labor  (CONFORMED SERVING VIEW — grain: store x day)
-- Target : jai_ontos.demo_schema   |  Warehouse: 310314146ebd3230
-- KPI defs MUST match ontology/semantic_measures.yaml.
--
-- SOURCE OVERRIDE: this script reads the documented reference model
--   fc_entdata_gold.{cdm_dim,cdm_bi,cdm_pos}
-- To run against the local physical schema, find/replace those 3 source
-- references with jai_ontos.rt_str_lbr (see ontology/source_mapping.yaml, A2).
-- Resolves grain mismatches HERE (labor=store-position-day, POS=transaction).
-- =============================================================================
CREATE OR REPLACE VIEW jai_ontos.demo_schema.jai_store_day_traffic_labor AS
WITH cust_day AS (   -- one row per store-day-customer with shop/fuel flags
  SELECT
    store_num                              AS store_number,
    business_date_key                      AS date_key,
    CAST(business_date AS DATE)            AS calendar_day,
    COALESCE(cust_id, txn_key)             AS customer_ref,
    cust_id,
    MAX(CASE WHEN outside_sale_flag = 'N' THEN 1 ELSE 0 END) AS has_shop,
    MAX(CASE WHEN outside_sale_flag = 'Y' THEN 1 ELSE 0 END) AS has_fuel
  FROM fc_entdata_gold.cdm_pos.sale_transaction_header
  WHERE COALESCE(suspend_flag,'N') <> 'Y'
    AND COALESCE(training_mode_flag,'N') <> 'Y'
  GROUP BY store_num, business_date_key, CAST(business_date AS DATE),
           COALESCE(cust_id, txn_key), cust_id
),
traffic AS (         -- StoreTrafficDay measures
  SELECT
    store_number, date_key, calendar_day,
    COUNT(DISTINCT customer_ref)                                          AS total_customers,
    COUNT(DISTINCT CASE WHEN has_shop = 1 THEN customer_ref END)          AS shop_customers,
    COUNT(DISTINCT CASE WHEN has_fuel = 1 THEN customer_ref END)          AS fuel_customers,
    COUNT(DISTINCT CASE WHEN has_shop = 1 AND has_fuel = 1 THEN cust_id END) AS dual_customers
  FROM cust_day
  GROUP BY store_number, date_key, calendar_day
),
labor AS (           -- StoreLaborDay measures (sum sub-daily positions to store-day)
  SELECT
    store_number,
    transaction_date_key                         AS date_key,
    CAST(SUM(labor_hours)  AS DECIMAL(18,2))     AS total_labor_hours,
    CAST(SUM(labor_amount) AS DECIMAL(18,2))     AS total_labor_cost
  FROM fc_entdata_gold.cdm_bi.smmry_labor
  GROUP BY store_number, transaction_date_key
),
region AS (          -- latest known region per store (monthly source; A3)
  SELECT store_number, region_nm FROM (
    SELECT storenumber AS store_number, region_nm,
           ROW_NUMBER() OVER (PARTITION BY storenumber ORDER BY report_month DESC) AS rn
    FROM fc_entdata_gold.cdm_bi.storebonuses
  ) WHERE rn = 1
),
base AS (            -- StoreDayEfficiency: full join keeps days with labor xor traffic
  SELECT
    COALESCE(t.store_number, l.store_number)  AS store_number,
    COALESCE(t.date_key,     l.date_key)      AS date_key,
    t.calendar_day,
    COALESCE(t.total_customers, 0) AS total_customers,
    COALESCE(t.shop_customers,  0) AS shop_customers,
    COALESCE(t.fuel_customers,  0) AS fuel_customers,
    COALESCE(t.dual_customers,  0) AS dual_customers,
    COALESCE(l.total_labor_hours, 0) AS total_labor_hours,
    COALESCE(l.total_labor_cost,  0) AS total_labor_cost
  FROM traffic t
  FULL OUTER JOIN labor l
    ON t.store_number = l.store_number AND t.date_key = l.date_key
)
SELECT
  b.store_number,
  s.store_name,
  s.store_city,
  s.state_code,
  r.region_nm                                AS region_name,
  s.store_status,
  b.date_key,
  COALESCE(b.calendar_day, CAST(c.date AS DATE)) AS calendar_day,
  b.total_customers,
  b.shop_customers,
  b.fuel_customers,
  b.dual_customers,
  b.total_labor_hours,
  b.total_labor_cost,
  -- ---- centralized KPIs (== semantic_measures.yaml) -----------------------
  CAST(b.total_labor_cost  / NULLIF(b.total_customers, 0) AS DECIMAL(18,4)) AS labor_cost_per_customer,
  CAST(b.total_labor_hours / NULLIF(b.total_customers, 0) AS DECIMAL(18,4)) AS labor_hours_per_customer,
  CAST(100.0 * b.dual_customers / NULLIF(b.total_customers, 0) AS DECIMAL(18,2)) AS dual_customer_conversion_rate_pct
FROM base b
LEFT JOIN fc_entdata_gold.cdm_dim.dim_store    s ON b.store_number = s.store_number
LEFT JOIN fc_entdata_gold.cdm_dim.dim_calendar c ON b.date_key     = c.date_key
LEFT JOIN region r                               ON b.store_number = r.store_number;
