# jai_solution_overview

Phase 0 intake report for the **RT_onto** ontology-driven app (Store Traffic & Labor Efficiency use case).

## Target environment

| Setting | Value |
| --- | --- |
| Workspace | `jai_classic_ws` |
| Local physical catalog | `jai_ontos` |
| Local physical schema | `rt_str_lbr` |
| Artifact catalog | `jai_ontos` |
| Artifact schema | `demo_schema` |
| Artifact prefix (required) | `jai_` |
| Warehouse ID (required) | `310314146ebd3230` |
| App name | `RT_onto_demo` |

## What was inspected

* The repo (`RT_onto`) — was empty except for `docs/`. Full scaffold created in Phase 1.
* The schema inventory CSV: `inputs/describe_table_extended.csv`
  (copied from `~/Downloads/describe_table_extended.csv`; 4,144 rows, columns:
  `catalog, schema, table, column_name, data_type, comment`).
* Live `jai_ontos.rt_str_lbr` — **could not be inspected**: the Databricks CLI
  credentials are expired (`databricks auth login` is interactive and must be
  run by the operator). See **Assumptions & open items**.

## Schema inventory summary

The inventory describes **one source catalog**, `fc_entdata_gold` (the Retailer
enterprise gold layer), across three schemas / **98 distinct tables**:

| Catalog.Schema | Tables | Role |
| --- | --- | --- |
| `fc_entdata_gold.cdm_dim` | 2,061 cols | Conformed dimensions (store, customer, calendar, fuel) |
| `fc_entdata_gold.cdm_bi` | 1,010 cols | BI summaries (labor, fuel sales, eligible days, bonuses) |
| `fc_entdata_gold.cdm_pos` | 1,073 cols | POS transactions (sale/void/other transaction headers & details) |

This inventory is the **business reference model**. The runbook is explicit that
these are *vocabulary*, not a guarantee of local physical tables. The app maps
business concepts onto whatever physical objects exist, via a semantic adapter.

## Candidate tables for the first use case

| Business concept | Reference table | Key columns |
| --- | --- | --- |
| CalendarDay | `cdm_dim.dim_calendar` | `date_key`, `date`, `day_nm`, `month_nm`, `year` |
| Store | `cdm_dim.dim_store` / `dim_store_attr` | `store_number`, `store_name`, `store_city`, `state_code`, `store_status` |
| Store geo (region) | `cdm_bi.storebonuses` | `storenumber`, `region_nm` (monthly grain) |
| StoreLaborDay | `cdm_bi.smmry_labor` | `store_number`, `transaction_date_key`, `labor_hours`, `labor_amount`, `labor_position` |
| StoreTrafficDay | `cdm_pos.sale_transaction_header` | `store_num`, `business_date`/`business_date_key`, `cust_id`, `outside_sale_flag`, `txn_type` |

## Traffic & customer semantics (derived)

The reference model has **no pre-aggregated daily traffic table**. Customer
counts are derived from POS `sale_transaction_header`:

* **total_customers** — distinct customer visits per store-day
  (`count(distinct cust_id)`, falling back to `count(distinct txn_key)` when
  `cust_id` is null/anonymous).
* **shop_customers** — visits with an inside/shop sale (`outside_sale_flag = 'N'`).
* **fuel_customers** — visits with an outside-court/fuel sale (`outside_sale_flag = 'Y'`).
* **dual_customers** — customers with both shop and fuel activity on the same store-day.
* KPIs (labor cost/customer, labor hours/customer, dual conversion %) are defined
  once in `ontology/semantic_measures.yaml` and computed in the SQL serving layer.

## Live deployment status (verified 2026-06-27)

After authenticating (`databricks auth login -p jai-classic`):

* `jai_ontos.rt_str_lbr` exists but is **empty** (no tables).
* `jai_ontos.demo_schema` exists.
* The reference catalog **`fc_entdata_gold` is NOT reachable** from
  `jai_classic_ws` (not in the catalog list). `rtdemo` exists but holds unrelated
  demos (fuel demand, RGM, shopper rec) — not the cdm_* source tables.
* The runbook-required warehouse **`310314146ebd3230` does not exist** here.
  Operator directed use of **`bf7ffcda00a8c351`** (jai-sql-warehouse). See A6.

**Decision (per runbook fallback):** since no usable physical source is reachable,
a **minimal labeled synthetic seed layer was materialized in
`jai_ontos.demo_schema`** and the governed `jai_` serving views were built on top:

| Object | Type | Rows |
| --- | --- | --- |
| `jai_ontos.demo_schema.jai_synthetic_store_day_seed` | TABLE (synthetic) | 2,700 (30 stores × 90 days) |
| `jai_ontos.demo_schema.jai_store_day_traffic_labor` | VIEW | 2,700 |
| `jai_ontos.demo_schema.jai_store_efficiency_summary` | VIEW | 30 |
| `jai_ontos.demo_schema.jai_store_efficiency_opportunities` | VIEW | 30 |
| `jai_ontos.demo_schema.jai_product_registry` | VIEW | 1 |
| `jai_ontos.demo_schema.jai_seed_files` | VOLUME | seed parquet |

Reproduce with `sql/00_jai_seed_demo_layer.sql` → `sql/01b` → `02` → `03` → `04`.
The app verified end-to-end in **warehouse mode** against these live views
(`RT_ONTO_DATA_MODE=warehouse`, profile auth, no PAT required).

## Readiness verdict

The project works in either mode:

1. **Mapped mode** — point `app/config.py` (`SOURCE_CATALOG`/`SOURCE_SCHEMA`) and
   the SQL templates at the real source (`fc_entdata_gold` reference tables, or a
   local `jai_ontos.rt_str_lbr` if it mirrors them) and run `sql/01..04` on
   warehouse `310314146ebd3230`. Serving views are created in `jai_ontos.demo_schema`.
2. **Seed mode (default, offline)** — a clearly-labeled synthetic seed
   (`app/seed/`, generated by `app/seed/generate_seed.py`) lets the app render KPI
   cards, trends, filters, and opportunity rankings without any live connection.
   This is **demo data**, kept separate from governed serving views.

## Assumptions & open items

* **A1 — Auth:** CLI credentials are expired. To run live SQL/deploy, the operator
  runs `databricks auth login -p jai-classic` (host `fe-vm-jai-classic-ws.cloud.databricks.com`).
* **A2 — Source location:** SQL templates default to the documented reference
  catalog `fc_entdata_gold`. If the local `jai_ontos.rt_str_lbr` holds the real
  physical tables, override `SOURCE_CATALOG`/`SOURCE_SCHEMA` — no other changes needed.
* **A3 — Region/division/area:** only `region_nm` exists (in `storebonuses`, monthly
  grain). Division/area are exposed as optional, null-tolerant columns; the app
  degrades gracefully when they are absent.
* **A4 — Fuel vs shop split:** uses `outside_sale_flag`. If Retailer models this
  differently (e.g. `txn_type` or `store_banner`), adjust `ontology/source_mapping.yaml`.
* **A5 — Customer identity:** `cust_id` is sparse (loyalty only). Dual-customer
  metrics are loyalty-biased; documented in `semantic_measures.yaml`.
* **A6 — Warehouse:** required `310314146ebd3230` does not exist in `jai_classic_ws`.
  Operator directed use of `bf7ffcda00a8c351` (jai-sql-warehouse). `config.py`
  defaults to it; override via `RT_ONTO_WAREHOUSE_ID`. The `jai_` prefix /
  `demo_schema` location guardrails are unaffected (warehouse = compute only).
* **A7 — Source availability:** `fc_entdata_gold` unreachable + `rt_str_lbr` empty,
  so a labeled synthetic seed layer was materialized in `demo_schema` (sql/00, 01b).
  Swap `sql/01b` → `sql/01` (and point sources) when real data lands.

## What exists after the first pass

See `docs/jai_use_case_scope.md` for scope and `docs/jai_enterprise_rollout.md`
(Phase 6) for scaling to many products.
