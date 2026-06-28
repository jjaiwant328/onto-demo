# RT_onto_demo — AppKit app notes

The deployed app is a **Databricks AppKit** (Node.js + React) application at the
repo root. The original Python/Streamlit app is preserved in
`legacy_streamlit_app/`. This doc captures the structure and the
deployment gotchas that matter for redeploys.

## Structure

```
client/            React 19 + Vite + Tailwind (4 sections)
  src/App.tsx      Layout, router, product picker
  src/lib/         product context (registry) + KPI formatters
  src/data/ontology.json   generated from ontology/ at build time
  src/pages/       DataProducts / OntologyStudio / SemanticExplorer / BusinessView
config/queries/    type-safe SQL (analytics plugin):
  product_registry, filter_options, kpi_summary, daily_trend,
  store_diagnostics, opportunities
server/server.ts   AppKit createApp({ plugins: [analytics(), server()] })
scripts/build-ontology-json.mjs   TTL/YAML -> client/src/data/ontology.json
shared/appkit-types/   auto-generated query types (npm run typegen)
app.yaml           command: npm run start; DATABRICKS_WAREHOUSE_ID <- sql-warehouse
databricks.yml     bundle (app + sql-warehouse resource)
```

The 4 sections reproduce the legacy Streamlit UX:
1. **Data Products** — registry table + selected-product details (`jai_product_registry`).
2. **Ontology Studio** — classes, business→physical mappings, live validation.
3. **Semantic Explorer** — class relationships + 9 semantic measures (base/derived).
4. **Business View** — KPI cards, daily trend chart, region/state/store filters,
   store diagnostics, opportunity rankings.

Derived KPIs are recomputed from base sums **in SQL** (e.g.
`labor_cost_per_customer = sum(total_labor_cost)/sum(total_customers)`), never
averaged from per-row ratios — see `config/queries/*.sql`.

## Build / run / deploy

```bash
npm install
DATABRICKS_CONFIG_PROFILE=jai-classic npm run build      # ontology + typegen + tsc/vite
DATABRICKS_APP_PORT=8000 npm start                        # local production server on :8000

# Deploy to the existing app:
databricks sync . /Workspace/Users/jaiwant.jonathan@databricks.com/rt-onto-demo \
  --exclude node_modules --exclude .venv --exclude .git \
  --exclude legacy_streamlit_app/** \
  --include 'dist/**' --include 'client/dist/**' --include 'shared/**' -p jai-classic
databricks apps deploy rt-onto-demo \
  --source-code-path /Workspace/Users/jaiwant.jonathan@databricks.com/rt-onto-demo -p jai-classic
```

Live URL: https://rt-onto-demo-687974281268075.aws.databricksapps.com

## Gotchas (learned the hard way)

1. **Port = $DATABRICKS_APP_PORT (8000).** The AppKit `server` plugin already
   binds to `$DATABRICKS_APP_PORT` (default 8000), which is what the Apps gateway
   routes to. Deployed logs confirm `Server running on http://0.0.0.0:8000`. Do
   not hardcode another port.

2. **package-lock `resolved` URLs must point at `registry.npmjs.org`, not the
   Databricks npm proxy.** A local `~/.npmrc` with
   `registry=https://npm-proxy.cloud.databricks.com/` makes `npm install` write
   proxy tarball URLs into `package-lock.json`. The Apps build environment then
   tries to fetch those exact proxy URLs and gets **404** (e.g.
   `js-yaml-4.1.1.tgz not in this registry`), failing the deploy at
   "Error installing packages". Fix: ensure all `resolved` URLs use
   `https://registry.npmjs.org/` (the Apps builder rewrites them through its own
   proxy correctly). If you regenerate the lock locally, rewrite the host back:
   `sed -i '' 's#https://npm-proxy.cloud.databricks.com/#https://registry.npmjs.org/#g' package-lock.json`

3. **The Apps builder runs `npm install` + `npm run build`, so devDependencies
   (tsc, vite, tsx, tsdown) MUST install.** Do NOT set `NODE_ENV=production` in
   `app.yaml` env and do NOT add `.npmrc` `omit=dev` — either prunes devDeps and
   the build fails with `tsc: not found`. The `start` script sets
   `NODE_ENV=production` for the *running* server, which is the correct place.

4. **js-yaml is not a package.json dependency.** It is only needed locally to
   regenerate `client/src/data/ontology.json` (which is committed). Pin it via an
   override only if a transitive devDep needs a version absent from the proxy; to
   regenerate ontology JSON: `npm i -D js-yaml && npm run ontology`.

5. **The app's service principal** (`bf309888-d7fa-4311-b847-22b6a8b19693`) needs
   `CAN_USE` on warehouse `bf7ffcda00a8c351` (attached as the `sql-warehouse`
   resource) plus `USE CATALOG`/`USE SCHEMA`/`SELECT` on
   `jai_ontos.demo_schema`. The `sql-warehouse` resource is attached to the app
   so `valueFrom: sql-warehouse` resolves `DATABRICKS_WAREHOUSE_ID`.
