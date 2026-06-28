-- Governed data-product registry. Keeps the app product-driven (not table-driven).
-- Source: jai_ontos.demo_schema.jai_product_registry
SELECT
  product_name,
  display_name,
  domain,
  business_outcome,
  serving_object_name,
  ontology_status,
  contract_status,
  app_enabled,
  owner,
  tags
FROM jai_ontos.demo_schema.jai_product_registry
ORDER BY product_name;
