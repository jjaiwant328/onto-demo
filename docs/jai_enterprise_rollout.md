# jai_enterprise_rollout

How RT_onto scales from one use case (Store Traffic & Labor Efficiency) to an
enterprise data-product selector over the full `fc_entdata_gold` inventory (98
tables). The app is **product-driven**: new products appear by adding registry
rows + artifacts, not by changing app code.

## 1. How to add a new data product

Repeat the same loop that produced `jai_store_traffic_labor_efficiency`:

1. **Scope** the use case (`docs/jai_use_case_scope.md` as a template).
2. **Inventory → candidates** — run the `schema_inventory` skill to group tables
   into a candidate product (a fact + its conformed dims).
3. **Ontology draft** — run `ontology_draft`: classes → relationships →
   datatype properties → physical mapping. Write
   `ontology/<product>.ttl` + extend `ontology/source_mapping.yaml`.
4. **Measures** — add KPI definitions to `ontology/semantic_measures.yaml`
   (one source of truth).
5. **Serving** — run `serving_view_generation`: create `jai_`-prefixed views in
   `jai_ontos.demo_schema` (`sql/NN_jai_<product>_*.sql`). Resolve grain in SQL.
6. **Register** — run `data_product_registration`: add
   `ontos/products/<product>.yaml`, `ontos/contracts/<product>_contract.yaml`,
   `ontos/semantics/<product>_semantic_model.yaml`, an entry in
   `ontology/data_products.yaml`, and a row in `sql/04_jai_product_registry.sql`.
7. **Enable** — set `app_enabled: true`. It now appears in the product selector.
8. **Smoke test** — run `app_smoke_test` / `pytest tests/`.

No app code changes are required for steps 1–8 — the app reads the registry,
ontology service, and serving views generically by product.

## 2. Deriving candidate products from the schema inventory

`inputs/describe_table_extended.csv` is the enterprise asset inventory. Heuristics
(encoded in `skills/schema_inventory`):

| Signal | Interpretation |
| --- | --- |
| `dim_*`, `vw_*` | dimensions (Store, Customer, Calendar, Fuel grade…) |
| `smmry_*` | pre-aggregated BI facts (labor, fuel sales, eligible days) |
| `sale_*`, `void_*`, `other_*`, `fin_*` | POS / transaction facts |
| `*_key`, `*_id`, `*_number`, `*_num` | keys / join columns |
| `*_date*`, `date_key` | time grain |
| numeric on a fact | candidate measures |

A **candidate product** = one fact table + the dims it joins to, with a clear
grain and ≥1 measure. Example future products from this inventory:

* `jai_fuel_sales_performance` — `cdm_bi.smmry_fuel_sales` × `dim_store` × `dim_calendar`
* `jai_store_shrink_margin` — `cdm_bi.storebonuses` (shrink, cm_margin) × `dim_store`
* `jai_transaction_basket` — `cdm_pos.sale_transaction_*` (basket / tender mix)

Flag for review: tables with no key, no date, or ambiguous grain.

## 3. OntoBricks vs Ontos — responsibilities

| Concern | OntoBricks (`ontobricks/`, `ontology/`) | Ontos (`ontos/`) |
| --- | --- | --- |
| Ontology classes & relationships | **owns** | references |
| Source → concept mapping | **owns** (authors mappings) | references for lineage |
| Graph materialization config | **owns** | — |
| Mapping validation / review | **owns** | consumes status |
| Data product registration | — | **owns** |
| Data contract + SLA + quality | — | **owns** |
| Semantic model of record | drafts | **registers** |
| Discovery metadata (owner/domain/tags) | — | **owns** |

Rule of thumb: **OntoBricks makes the meaning; Ontos makes it governable.** The
ontology/mapping is the *design*; the product/contract/semantic-model is the
*governed contract* the org discovers and trusts.

## 4. From one use case to enterprise coverage

Staged, not big-bang (per `CLAUDE.md`):

1. **Single product proven** (done) — one ontology, one contract, one serving
   view, one app view.
2. **Few hand-curated products** — repeat §1 for 3–5 high-value use cases; the
   selector now has real breadth. Keep KPIs centralized.
3. **Inventory-assisted drafting** — use `schema_inventory` to *propose* candidate
   products and *draft* ontologies (`ontology_draft`), human-reviewed before
   registration. Add a `docs/jai_candidate_products.md`.
4. **Governed self-service** — products flow through the Ontos path (contract +
   semantic model + approval) before `app_enabled`. The registry becomes the
   catalog; the app becomes the discovery + validation surface.
5. **Graph projection (optional)** — flip `ontobricks/config/materialization.yaml`
   `graph.enabled: true` to enable cross-product relationship queries
   (Store→Region→Product…) in the Semantic Explorer.

### Guardrails that must hold at every stage

* Every created object is `jai_`-prefixed and lives in `jai_ontos.demo_schema`.
* Warehouse is always `310314146ebd3230`.
* KPI logic stays centralized (`semantic_measures.yaml` + SQL views); the app
  never recomputes KPIs from scratch.
* Synthetic data stays minimal, labeled, and separate from governed views.
* Don't automate enterprise-wide registration before the single-product loop is
  solid and tested.

## 5. Operational checklist for the next product

- [ ] Use case scoped
- [ ] Candidate tables identified from inventory (no invented tables)
- [ ] Ontology + mapping drafted and mapping-validated
- [ ] KPIs added to `semantic_measures.yaml`
- [ ] `jai_` serving views created in `jai_ontos.demo_schema`
- [ ] Product + contract + semantic model registered in `ontos/`
- [ ] Registry row added (YAML + `sql/04`)
- [ ] `app_enabled: true`
- [ ] `pytest tests/` green
