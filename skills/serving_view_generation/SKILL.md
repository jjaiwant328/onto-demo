---
name: serving_view_generation
description: Generate conformed SQL serving views in jai_ontos.demo_schema, resolve grain mismatches between source tables, and centralize KPI calculations.
---

# serving_view_generation

Build conformed, `jai_`-prefixed serving views that the app and contracts depend on.

## Rules

* Build views in **`jai_ontos.demo_schema`**.
* Every created object name starts with **`jai_`**.
* **Views first.** Materialize to a table only if performance requires it (then
  still keep the `jai_` prefix and note it in the contract).
* Resolve grain mismatches **in SQL**, never in the UI.
* Centralize every KPI formula — keep them identical to
  `ontology/semantic_measures.yaml`.
* Parameterize the source: read from `${SOURCE_CATALOG}.${SOURCE_SCHEMA}` (defaults
  to the documented reference `fc_entdata_gold`; override for `jai_ontos.rt_str_lbr`).

## Standard layer

| File | View | Grain |
| --- | --- | --- |
| `sql/01_*` | `jai_store_day_traffic_labor` | store × day (conformed traffic + labor) |
| `sql/02_*` | `jai_store_efficiency_summary` | store (period rollup + KPIs) |
| `sql/03_*` | `jai_store_efficiency_opportunities` | store (ranked opportunities) |
| `sql/04_*` | `jai_product_registry` | one row per product |

## Steps

1. Build the day-grain conformed view first (`01`): aggregate labor to store-day,
   derive traffic/customer counts from POS to store-day, join on store+day.
2. Roll up to store-level KPIs (`02`).
3. Rank opportunities (`03`) — biggest gap vs. peer/median efficiency.
4. Emit the registry (`04`).

## Run

```bash
databricks sql query --warehouse-id 310314146ebd3230 -p jai-classic --file sql/01_jai_store_day_traffic_labor.sql
```

## Guardrails

* Do not reference tables not present in the inventory or confirmed live.
* Keep KPI definitions in exactly one place; views import the definition, the app
  never recomputes KPIs.
