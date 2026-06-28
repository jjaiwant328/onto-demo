---
name: app_smoke_test
description: Validate that the RT_onto_demo app can load the product registry, ontology metadata, filters, and KPI views, and that one product drill-down works.
---

# app_smoke_test

Fast confidence check that the app's data plane is wired correctly, in either
`seed` or `warehouse` mode.

## Checks

1. **Product list loads** — `product_registry.load_products()` returns ≥ 1 row and
   includes `jai_store_traffic_labor_efficiency` with the expected columns
   (`product_name, display_name, domain, business_outcome, serving_object_name,
   ontology_status, contract_status, app_enabled, owner, tags`).
2. **Ontology payload loads** — `ontology_service.get_ontology(product)` returns
   classes, mappings (class→table→columns), and a validation status.
3. **KPI view renders** — `data_access.get_store_day(product)` returns rows with
   the contract columns; `get_efficiency_summary` exposes
   `labor_cost_per_customer`, `labor_hours_per_customer`,
   `dual_customer_conversion_rate_pct`.
4. **Filters work** — region/store filters reduce the row set without error;
   empty/absent geo columns degrade gracefully.
5. **Drill-down** — selecting the product → Business View → a single store yields a
   trend series and an opportunity rank.

## Run

```bash
python app/seed/generate_seed.py        # seed mode
pytest tests/ -q                        # all shape/measure/registry/filter tests
python -c "import app.product_registry as r; print(len(r.load_products()))"
```

## Guardrails

* Smoke test must pass in `seed` mode with **no** network/warehouse.
* In `warehouse` mode it additionally requires auth + the `sql/01..04` views to exist.
