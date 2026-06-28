---
name: data_product_registration
description: Generate governed Ontos product metadata and contract files with standardized owner, domain, source, KPI, freshness, and lineage fields.
---

# data_product_registration

Turn a validated ontology + serving view into a governed Ontos data product.
Keep all registration files machine-readable (YAML).

## Steps

1. Choose a `jai_`-prefixed product name (e.g. `jai_store_traffic_labor_efficiency`).
   **Reject names without the prefix.**
2. Create `ontos/products/<name>.yaml` with:
   `product_name, display_name, domain, business_outcome, serving_view,
   ontology_file, semantic_measures_file, contract_file, source_tables, owner,
   maturity, tags, kpis, lineage`.
3. Create `ontos/contracts/<name>_contract.yaml` with the serving schema
   (columns + types), grain, freshness SLA, quality checks, and scope/assumptions.
4. Create `ontos/semantics/<name>_semantic_model.yaml` linking ontology classes ↔
   semantic measures ↔ serving columns.
5. Add the product to `ontology/data_products.yaml` (the file-based registry) and
   ensure `sql/04_jai_product_registry.sql` emits a row for it.

## Required fields (product)

`product_name` (jai_), `display_name`, `domain`, `business_outcome`,
`serving_view`, `ontology_file`, `semantic_measures_file`, `contract_file`,
`source_tables`, `owner`, `maturity`, `tags`.

## Guardrails

* Require `jai_` prefixed product and object names.
* Record semantic model reference and full source lineage.
* Record contract scope and every assumption (A1–A5 style).
* Never register a product whose serving view does not exist (or is not seeded).
