-- =============================================================================
-- jai_product_registry  (PRODUCT REGISTRY — one row per governed data product)
-- The app reads this to stay product-driven (not table-driven). Add a row per
-- product as the platform expands. Mirrors ontology/data_products.yaml.
-- Target: jai_ontos.demo_schema | Warehouse: 310314146ebd3230
-- =============================================================================
CREATE OR REPLACE VIEW jai_ontos.demo_schema.jai_product_registry AS
SELECT * FROM VALUES
  (
    'jai_store_traffic_labor_efficiency',                       -- product_name
    'Store Traffic & Labor Efficiency',                        -- display_name
    'retail_store_operations',                                 -- domain
    'Rank stores by labor cost per customer and surface staffing efficiency opportunities.', -- business_outcome
    'jai_ontos.demo_schema.jai_store_day_traffic_labor',       -- serving_object_name
    'draft',                                                   -- ontology_status
    'defined',                                                 -- contract_status
    true,                                                      -- app_enabled
    'jaiwant.jonathan@databricks.com',                         -- owner
    'retail,labor,traffic,efficiency,store-ops'                -- tags (csv)
  )
AS jai_product_registry(
  product_name, display_name, domain, business_outcome,
  serving_object_name, ontology_status, contract_status, app_enabled, owner, tags
);
