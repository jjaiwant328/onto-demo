# RT_onto_demo

Ontology-driven **domain → data-product catalog** (6 domains × 4 products = 24),
built with **OntoBricks** patterns (ontology design, schema mapping) and **Ontos**
patterns (governed data products, contracts, semantic models).

The deployed app is a **Databricks AppKit** (Node.js + React) application. The
original Python/Streamlit implementation is preserved under
[`legacy_streamlit_app/`](./legacy_streamlit_app/).

## Catalog: domains → products, derived at runtime

The header has two cascading selectors — **Domain** → **Data product**. Picking a
product runs the reusable "skill" `deriveProduct(product, schema)`
(`client/src/lib/deriveComponents.ts`), which turns ANY catalog entry into the
components every section needs — entities, column mappings (key/measure/attribute),
FK/lineage relationships, measures/KPIs, and the Cytoscape graphs — **deterministically,
client-side, from the real `fc_entdata_gold` schema** (`client/src/data/schema.json`).
Adding a product to `client/src/data/catalog.json` is all that's needed to light it up.

- **One** product is **live** — `jai_store_traffic_labor_efficiency` — backed by
  governed serving views + warehouse data (real KPIs/charts/filters).
- The other **23** are **schema-derived**: real source-table shapes and lineage,
  but no live serving layer — Business View shows a clear "schema-derived preview"
  (no warehouse query, no fabricated data).

The 24 products span domains: `store_operations_labor`, `fuel`,
`merchandise_inventory`, `sales_pos`, `finance_accounting`, `customer_marketing`.

### Customer → Schema(s), with combine

The data model is **Customer → Schema(s)**. Customers are always isolated (data is
never mixed across customers). The header has a **Customer** dropdown and, within the
selected customer, a **multi-select Schema picker**: choose **1** schema to view it
alone, or **2+** (or "Combine all") for a **Combined** view. Any choice regenerates
the whole app (domains → products → components → enterprise graph → contracts);
`{customerId, selectedSchemaIds}` is persisted (localStorage; default = Retailer / its
one schema, which keeps the live flagship).

Built-in customers:
- **Retailer** → one schema `fc_entdata_gold` (bundled `schema.json`). When that single
  schema is selected it uses the **curated** `catalog.json` + the **live flagship**
  `jai_store_traffic_labor_efficiency` (real warehouse KPIs) — unchanged behavior.
- **QSR** → one schema "QSR Supply Chain" (bundled `schema.qsr.json`, 278 tables),
  catalog **generated** via the usual pipeline (schema-derived; no live product).

Uploaded / live-connection schemas (below) are **assigned to a customer** in the
Load-schema popover, which **defaults to "New customer…"** so an upload never silently
pollutes a built-in customer (Retailer/QSR). To append to an existing customer, pick it
explicitly. The popover also has per-customer schema management: each schema entry has a
**Remove** control (the bundled entry of a built-in customer is not removable; appended
ones are), user-created customers can be **Deleted**, and **"Reset customers"** clears
persisted state and restores exactly Retailer + QSR with their bundled schemas.

**Combine + shared-dimension conformance** (`client/src/lib/combineSchemas.ts`): when
2+ schemas are selected, `combineSchemas` merges them into one `Schema`, **conforming
dimension tables** shared across schemas — two dims conform when their normalized base
name matches (lowercased; strip leading `dim_`/`stg_`/`int_`, trailing `_dim`) AND they
share ≥1 key column of the same name. A conformed dim becomes a SINGLE node whose columns
are the UNION (dedupe by name, keep first type), carrying `conformed: true` +
`sources: [schema labels]`. Facts are never merged; name collisions without shared keys
are disambiguated by source. The combined schema feeds the usual `buildCatalog`, so a
conformed shared dim (e.g. `dim_store`, `dim_calendar`, `dim_item`) links products/domains
that came from different source schemas in the enterprise graph. A combined view shows a
"Combined N schemas · M conformed shared dimensions (…)" note, and conformed dimension
nodes get a "conformed — shared across X, Y" badge in the graph inspector.

### Loading a new schema (regenerate the whole catalog)

The header **Schema** button (the upload popover) loads a schema two ways; either
runs the **same hybrid pipeline** and regenerates the catalog **session-scoped**:
heuristic grouping (always, offline, client-side — keyword-bucket domains, fact-like
anchors, joinable dims, ≤4 products/domain, derived names/outcomes/KPIs) + optional
**LLM polish** (the "Refine with Foundation Model" checkbox → `POST /api/generate-catalog`
→ the attached `databricks-claude-sonnet-4-5` via the AppKit `serving` plugin + OAuth SP
token; silent heuristic fallback on any failure; result sanitized so the model can't add
tables/columns not in the schema). **Reset to default** restores the bundled
`catalog.json`/`schema.json` (the flagship live product works on the default catalog).
Both options support wildcards (`*` or `%`).

**Schema noise filter (automatic, reversible).** On BOTH load paths, right after the
schema is parsed/introspected and before `buildCatalog`, `filterBusinessSchema`
(`client/src/lib/schemaFilter.ts`) drops **pipeline / test / DQ / framework** schemas
by case-insensitive name patterns — `dbt`, `dq`/`data_quality`, `*_test(s)`,
`information_schema`/`sys`/`system`, `artifacts`/`results`/`elementary`,
`quarantine`/`utils`/`framework`/`e2e` (plus minimal table-level noise: `dbt_*`,
`*_dbt_results`, `elementary_*`). It is **conservative** — generic operational tokens
(`pipeline`, `health`, `snapshot`, `source`, `sc_`) are never treated as noise, so
medallion + source layers (bronze/silver/gold/raw/staging/…) are always kept. So
uploading a full multi-thousand-table export auto-scopes to the business layers. It's
**transparent** (a "Filtered N pipeline/test/DQ schemas: …" note lists what was dropped)
and **reversible** (an "Include system/pipeline schemas" checkbox re-runs with the filter
off). Default = filter ON. The two bundled schemas are unaffected (`schema.qsr.json` is
pre-scoped; `schema.json` has no noise).

**Option 1 — script → CSV → upload.** Generate a `describe_table_extended.csv`
(`catalog, schema, table, column_name, data_type, comment`) with the included script,
then upload it via Schema → **Upload CSV**:

```bash
# one reachable schema
python scripts/generate_schema_csv.py \
  --profile jai-classic --warehouse-id bf7ffcda00a8c351 \
  --catalog jai_ontos --schema demo_schema --table '*' \
  --out inputs/jai_ontos_demo.csv

# every schema in a catalog
python scripts/generate_schema_csv.py --catalog jai_ontos --schema '*' --table '*' \
  --out inputs/jai_ontos_all.csv

# wildcards across catalogs, only dim_ tables (* or % both work)
python scripts/generate_schema_csv.py --catalog 'jai_*' --schema '*' --table 'dim_*' \
  --out inputs/jai_dims.csv
```

The script queries `<catalog>.information_schema.columns` with LIKE filters via the
SQL statement API and enumerates catalogs when `--catalog` is a wildcard.

**Option 2 — live connection (in the app).** Schema → **Live connection**: pick a
**Catalog** (dropdown from `SHOW CATALOGS`), then a **Schema** (dropdown from
`information_schema.schemata`), or type a **wildcard pattern** for
catalog/schema/table (e.g. catalog `jai_*`, schema `*`, table `dim_*` — patterns
override the dropdown). "Introspect & generate" calls `POST /api/introspect-schema`,
which reads `information_schema.columns` through the attached warehouse and feeds the
result into the same pipeline.

**App-SP grants & reachability.** The live option runs as the app service principal
(`bf309888-d7fa-4311-b847-22b6a8b19693`), which has `USE CATALOG` on `jai_ontos` and
`USE SCHEMA` + `SELECT` on `jai_ontos.demo_schema` (extend grants to introspect other
schemas). `information_schema` only shows objects the SP can see. Some catalogs are
**not reachable** in this workspace (e.g. `fc_entdata_gold`) — the app catches the
permission/empty case and shows a clear "no access / no tables matched" message
instead of crashing.

The active `{catalog, schema}` lives in the product context, so loading a schema
regenerates domains → products → components → enterprise graph → contracts as new.

## App = seven sections + a Copilot

All sections consume the selected product's derived `components`.

| Section | What it shows |
| --- | --- |
| **Data Products** | The domains (cards), the selected domain's products (table with maturity + live/schema-derived status), and the selected product's detail (outcome, fact/dim source tables, KPIs) + "Data Contract" / "Export PDF" actions. |
| **Ontology Studio** | Derived entities (one per source table) + column mappings with role badges (key/measure/attribute). Validation queries the warehouse only for the live product; others show "schema-derived (no live serving layer)". |
| **Semantic Explorer** | Derived lineage relationships (shared-key FKs) + measures (base fact measures) and the product's headline KPIs + entity→property drill-down. |
| **Graph Explorer** | Cytoscape.js viewer with a two-view toggle: **Explore** — ONE enterprise-wide map (enterprise → domains → products → deduplicated shared tables → metric views), concentric layered layout. The current selection is **highlighted** while the rest stays visible-but-dimmed; clicking any node centers it and rings its neighbors so you can *travel* across the map — with breadcrumb / Back / Overview. A focused **KPI node shows a "Drivers" panel** ("affected by" base measures/columns + joined dims, and related measures). **Ontology + lineage** — the per-product static layered map. Cytoscape via CDN. |
| **Data Contract** | The ontos-style DataContract per product (`deriveContract`): serving object, grain, schema, quality checks, freshness SLA, scope, lineage, assumptions. Curated for the flagship; derived for the rest. Has **Export PDF**. |
| **Action Center** | A prescriptive action layer: **Exceptions** (live products — real `opportunities` rows → HIGH/MEDIUM queue items, LLM-enriched root-cause/recommended-action/confidence, deterministic fallback if the LLM is down) + **Scenario signals** (a form → LLM-prioritized, clearly "Scenario-driven" actions). Lifecycle is **in-session only**: Approve / Modify / Reject with a SIMULATED execution trail and a header summary. No external writes. |
| **Business View** | **Live product:** warehouse-backed KPI cards, daily trend, filters, diagnostics, opportunity rankings (derived KPIs recomputed from base sums in SQL — see `config/queries/*.sql`). **Schema-derived products:** a "schema-derived preview" notice + KPI definitions + fact-table column shapes (no warehouse query, no fabricated data). |

The header **Copilot** opens a chat panel that answers questions grounded in the
selected product's components (ontology classes, measures+formulas, relationships,
KPIs); for live products the server also attaches a compact `opportunities` snapshot.
If the answer proposes an action, an "Add to action queue" button pushes it into the
Action Center (shared via the in-session `actions` context). Gated on
`GET /api/llm-status` — disabled with an explanation if no endpoint is configured.

### Action layer (Action Center + Copilot + graph drivers)

The prescriptive layer reuses the existing infra and degrades gracefully when the
Foundation Model endpoint is absent:
- `client/src/lib/actions.ts` — action types, a **deterministic** action-builder from
  `opportunities` rows (the LLM-down fallback), and the in-session queue context.
- `POST /api/recommend-actions` (`mode: exceptions|scenario`) and `POST /api/copilot`
  call `appkit.serving('llm').invoke` (alias `llm`, endpoint
  `databricks-claude-sonnet-4-5`); copilot may call `appkit.analytics.query` for a live
  flagship snapshot. Both fall back cleanly (exceptions still render from the
  deterministic builder; copilot returns a short "unavailable" note).
- Graph "drivers" are **deterministic** (`deriveComponents.ts` parses each measure's
  formula for referenced base measures/columns + adds joined dims; `related` = measures
  sharing an input) with an optional best-effort one-line LLM narration via `/api/copilot`.

### Data Contract + Export PDF

Every product has a **Data Contract** (`client/src/lib/contract.ts` → `deriveContract`)
following the ontos DataContract structure (the flagship uses the curated
`ontos/contracts/*.yaml`; others are derived from the product's components, with
sensible quality checks — unique grain, non-negative measures, parts ≤ total).
**Export PDF** opens a zero-dependency print-optimized document
(`/print/:product`, `@media print` CSS, `window.print()`) containing the product
summary, the contract, the ontology (entities/mappings/measures), and a
lineage snapshot — a clean save-as-PDF brief.

The flagship's live KPIs are always **recomputed from base sums in SQL**
(`sum(total_labor_cost)/sum(total_customers)`), never averaged from per-row ratios.

## AppKit project structure

```
client/                      React 19 + Vite + Tailwind frontend
  index.html                 Loads Cytoscape.js from CDN (window.cytoscape)
  src/
    App.tsx                  Layout, 6-section router, Domain + Product selectors
    components/SchemaLoader.tsx  Upload describe-CSV → regenerate catalog (+LLM, +reset)
    lib/product.tsx          Active-catalog context: domains/products + deriveProduct()
                             + enterprise map + load/reset controls
    lib/deriveComponents.ts  THE SKILL: deriveProduct(product, schema) -> components;
                             buildEnterpriseGraph(catalog, schema) -> the full map
    lib/catalogGen.ts        parseDescribeCsv() + buildCatalog() (heuristic generation)
    lib/schemaFilter.ts      filterBusinessSchema() — auto-drop pipeline/test/DQ schemas
    lib/combineSchemas.ts    combineSchemas() — merge + conform shared dims (combine view)
    lib/contract.ts          deriveContract(product, components) -> ontos DataContract
    lib/actions.ts           action types + deterministic builder + in-session queue ctx
    lib/summary.ts           componentsSummary() — compact LLM grounding context
    lib/format.ts            KPI formatters (coerce string→number; comma + 3 decimals)
    lib/graphData.ts         Shared graph node/edge types + kind colors/labels
    lib/cytoscape.d.ts       Ambient types for the CDN cytoscape global
    components/SchemaLoader.tsx   Upload CSV / Live connection schema loaders
    components/Copilot.tsx        Ontology Copilot chat panel (Sheet)
    data/catalog.json        curated Retailer catalog (one product live: true)
    data/schema.json         98 fc_entdata_gold tables (Retailer) — drives derivation
    data/schema.qsr.json     278 qsrscdoprod_primary tables (QSR Supply Chain)
    data/ontology.json       Curated ontology artifacts (flagship reference)
    data/model.json          Curated ER model (flagship reference)
    pages/                   DataProducts, OntologyStudio (+ LiveValidation),
                             SemanticExplorer, GraphExplorer (+ Drivers panel),
                             DataContract, ActionCenter, BusinessView,
                             TravelCanvas (Explore: enterprise map + travel),
                             CytoscapeCanvas (Ontology tab),
                             PrintProduct (/print/:product — PDF export)
config/queries/              Type-safe SQL queries (analytics plugin)
  product_registry.sql  filter_options.sql  kpi_summary.sql
  daily_trend.sql  store_diagnostics.sql  opportunities.sql
server/server.ts             AppKit server (analytics + serving + server plugins);
                             /api/generate-catalog, /api/recommend-actions, /api/copilot,
                             /api/introspect-schema, /api/catalogs, /api/llm-status
scripts/build-ontology-json.mjs   TTL/YAML → client/src/data/ontology.json
shared/appkit-types/         Auto-generated query/serving types (typegen)
app.yaml                     Databricks Apps manifest (npm run start)
databricks.yml               Asset Bundle (app + sql-warehouse + serving-endpoint)
```

The AppKit **analytics plugin** executes the `config/queries/*.sql` files against
the SQL warehouse and generates TypeScript types from their result shapes
(`npm run typegen`), so the React `useAnalyticsQuery('kpi_summary', …)` calls are
fully type-checked end to end.

## Run locally

Prereqs: Node v22+, Databricks CLI authenticated (profile `jai-classic`).

```bash
npm install
DATABRICKS_CONFIG_PROFILE=jai-classic npm run dev      # hot-reload dev server
# or production build + serve:
DATABRICKS_CONFIG_PROFILE=jai-classic npm run build
DATABRICKS_APP_PORT=8000 npm start                     # serves on :8000
```

The server binds to `$DATABRICKS_APP_PORT` (default 8000) — the port the
Databricks Apps gateway routes to.

## Deploy to Databricks Apps (`rt-onto-demo`)

```bash
DATABRICKS_CONFIG_PROFILE=jai-classic npm run build
databricks sync . /Workspace/Users/jaiwant.jonathan@databricks.com/rt-onto-demo \
  --exclude node_modules --exclude .venv --exclude .git -p jai-classic
databricks apps deploy rt-onto-demo \
  --source-code-path /Workspace/Users/jaiwant.jonathan@databricks.com/rt-onto-demo -p jai-classic
```

The app runs as a service principal that has `USE CATALOG`/`USE SCHEMA`/`SELECT`
on `jai_ontos.demo_schema` and `CAN_USE` on warehouse `bf7ffcda00a8c351`.

## Data layer

The governed views are live in `jai_ontos.demo_schema` on warehouse
`bf7ffcda00a8c351` (jai-sql-warehouse). The SQL that builds them lives in `sql/`
and is unchanged. The ontology/contract source of truth lives in `ontology/`,
`ontobricks/`, and `ontos/`.

> Note: the runbook-specified warehouse `310314146ebd3230` does not exist in this
> workspace; `bf7ffcda00a8c351` is used instead.

## Layout

| Layer | Owner | Artifacts |
| --- | --- | --- |
| Ontology design & mapping | OntoBricks | `ontology/`, `ontobricks/` |
| Governed products & contracts | Ontos | `ontos/` |
| Serving | SQL | `sql/` (views in `jai_ontos.demo_schema`, `jai_`-prefixed) |
| Experience (deployed) | AppKit | `client/`, `server/`, `config/queries/` |
| Experience (legacy) | Streamlit | `legacy_streamlit_app/` |
