# jai_use_case_scope

## Use case: Store Traffic & Labor Efficiency

**Business question:** Where are we over- or under-staffing relative to customer
traffic, and which stores have the biggest efficiency opportunity?

**Outcome:** Rank stores by labor cost per customer (and labor hours per
customer) against traffic, surface the worst/best performers, and let an operator
drill from region → store → day.

## In scope (first pass)

* One governed data product: `jai_store_traffic_labor_efficiency`
* Concepts: Store, CalendarDay, StoreTrafficDay, StoreLaborDay, StoreDayEfficiency
* One conformed serving view: `jai_ontos.demo_schema.jai_store_day_traffic_labor`
* Summary + opportunity views, product registry view
* KPI cards, trends, store/region filters, opportunity rankings
* Ontology classes + source mappings + validation status surfaced in the app

## Out of scope (first pass, see enterprise rollout)

* Automated multi-product ontology generation across all 98 inventory tables
* Materialized tables (views first; materialize only if performance requires)
* Live write-back / governance approvals workflow
* Fuel margin, shrink, and bonus analytics (available in inventory, future products)

## Grain

* **StoreTrafficDay / StoreLaborDay / StoreDayEfficiency:** one row per
  `store_number` × `calendar_day`.
* Labor (`smmry_labor`) is sub-daily (per position/type) and is summed to store-day.
* Traffic is per-transaction in POS and aggregated to store-day.
* Grain mismatches are resolved in SQL (`sql/01_*`), never in the UI.

## KPIs (defined once in `ontology/semantic_measures.yaml`)

total_customers · shop_customers · fuel_customers · dual_customers ·
total_labor_hours · total_labor_cost · dual_customer_conversion_rate_pct ·
labor_cost_per_customer · labor_hours_per_customer

## Success criteria

One product, one contract, one ontology draft, one mapping file, one conformed
serving view, one registry view, one app rendering the business view, and a set
of reusable local skills. See `docs/jai_solution_overview.md`.
