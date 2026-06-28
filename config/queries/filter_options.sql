-- Distinct filter values for the Business View (region / state / store).
-- Returned as one long table so the client can build cascading filters.
-- Source: jai_ontos.demo_schema.jai_store_day_traffic_labor
SELECT DISTINCT 'region' AS kind, region_name AS value, region_name AS label
FROM jai_ontos.demo_schema.jai_store_day_traffic_labor
WHERE region_name IS NOT NULL
UNION ALL
SELECT DISTINCT 'state' AS kind, state_code AS value, state_code AS label
FROM jai_ontos.demo_schema.jai_store_day_traffic_labor
WHERE state_code IS NOT NULL
UNION ALL
SELECT DISTINCT 'store' AS kind,
       CAST(store_number AS STRING) AS value,
       CONCAT(CAST(store_number AS STRING), ' — ', store_name) AS label
FROM jai_ontos.demo_schema.jai_store_day_traffic_labor
ORDER BY kind, label;
