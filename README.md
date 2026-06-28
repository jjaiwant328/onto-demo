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

## App = five sections

All five sections consume the selected product's derived `components`.

| Section | What it shows |
| --- | --- |
| **Data Products** | The 6 domains (cards), the selected domain's 4 products (table with maturity + live/schema-derived status), and the selected product's detail (outcome, fact/dim source tables, KPIs). |
| **Ontology Studio** | Derived entities (one per source table) + column mappings with role badges (key/measure/attribute). Validation queries the warehouse only for the live product; others show "schema-derived (no live serving layer)". |
| **Semantic Explorer** | Derived lineage relationships (shared-key FKs) + measures (base fact measures) and the product's headline KPIs + entity→property drill-down. |
| **Graph Explorer** | Cytoscape.js viewer with a two-view toggle: **Explore** — ONE enterprise-wide map (enterprise → 6 domains → 24 products → deduplicated shared tables → metric views), rendered in a concentric layered layout. The current domain/product selection is **highlighted** while the rest stays visible-but-dimmed (highlight, not filter); clicking any node centers it and rings its neighbors so you can *travel* across the map — including hopping through a shared dimension (e.g. `dim_store`, used by 20 products) to another product — with breadcrumb / Back / Overview. **Ontology + lineage** — the per-product static layered map. Inspector shows columns/PK/FK for tables or a KPI formula. Cytoscape loads via CDN (no npm dep); focus-navigation adapted from the databricks-industry-solutions model-viewer. |
| **Business View** | **Live product:** warehouse-backed KPI cards, daily trend, region/state/store filters, store diagnostics, opportunity rankings (derived KPIs recomputed from base sums in SQL — see `config/queries/*.sql`). **Schema-derived products:** a "schema-derived preview" notice + KPI definitions + fact-table column shapes (no warehouse query, no fabricated data). |

The flagship's live KPIs are always **recomputed from base sums in SQL**
(`sum(total_labor_cost)/sum(total_customers)`), never averaged from per-row ratios.

## AppKit project structure

```
client/                      React 19 + Vite + Tailwind frontend
  index.html                 Loads Cytoscape.js from CDN (window.cytoscape)
  src/
    App.tsx                  Layout, 5-section router, Domain + Product selectors
    lib/product.tsx          Catalog context: domains/products + deriveProduct()
                             + the one-time enterprise map & selection highlight
    lib/deriveComponents.ts  THE SKILL: deriveProduct(product, schema) -> components;
                             buildEnterpriseGraph(catalog, schema) -> the full map
    lib/format.ts            KPI display formatters
    lib/graphData.ts         Shared graph node/edge types + kind colors/labels
    lib/cytoscape.d.ts       Ambient types for the CDN cytoscape global
    data/catalog.json        6 domains × 4 products (one product live: true)
    data/schema.json         98 fc_entdata_gold tables (columns) — drives derivation
    data/ontology.json       Curated ontology artifacts (flagship reference)
    data/model.json          Curated ER model (flagship reference)
    pages/                   DataProducts, OntologyStudio (+ LiveValidation),
                             SemanticExplorer, GraphExplorer,
                             TravelCanvas (Explore: enterprise map + travel),
                             CytoscapeCanvas (Ontology tab), BusinessView
config/queries/              Type-safe SQL queries (analytics plugin)
  product_registry.sql  filter_options.sql  kpi_summary.sql
  daily_trend.sql  store_diagnostics.sql  opportunities.sql
server/server.ts             AppKit server (analytics + server plugins)
scripts/build-ontology-json.mjs   TTL/YAML → client/src/data/ontology.json
shared/appkit-types/         Auto-generated query/serving types (typegen)
app.yaml                     Databricks Apps manifest (npm run start)
databricks.yml               Asset Bundle (app + sql-warehouse resource)
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
