# RT_onto_demo — ontos + OntoBricks companion apps setup

Operator runbook for the two companion Databricks Apps that RT_onto_demo
integrates with: **ontos** (governance system of record) and **OntoBricks**
(ontology materialization + graph query backend). Both are deployed and
running in workspace `jai_classic_ws` (org `687974281268075`, host
`https://fe-vm-jai-classic-ws.cloud.databricks.com`). This doc records what
exists, how RT_onto_demo authenticates to it, and the operator steps that
remain manual (registry init, domain authoring, token rotation).

All CLI commands below use profile `-p fe-vm-jai-classic-ws`. Older docs
reference `-p jai-classic`, but that profile points at a different host —
always use `fe-vm-jai-classic-ws`.

## 1. Overview

RT_onto_demo stays the generation/UX front-end and delegates to the
companions (full design in `docs/Integration_plan.md`):

- **ontos** — `github.com/databrickslabs/ontos`. Owns governed artifacts:
  data products, data contracts (ODCS v3.1.0 import + a built-in contract
  validation workflow: schema drift, SLA freshness, DQ scores), semantic
  models, and the review lifecycle. RT_onto's DataContract page pushes its
  ODCS contract here and displays the real validation results. Deployed
  version is a **patched SNAPSHOT of main** — the patch removes
  `temperature` from LLM calls (the `databricks-gpt-5-6-sol` endpoint
  rejects non-default temperature; upstream bug unfixed as of 2026-09-30).
  It is a custom WSFS deploy, NOT the Marketplace install (see gotcha 4).
- **OntoBricks** — `github.com/databrickslabs/ontobricks`, pinned to tag
  **v0.8.0**. Owns ontology domains: OntoViz UI for authoring/import,
  server-enforced DRAFT → IN-REVIEW → PUBLISHED lifecycle (only PUBLISHED
  versions queryable), and external GraphQL / SPARQL / digital-twin APIs
  plus a separate MCP companion app. RT_onto's TravelCanvas expand-node
  proxies GraphQL neighbor queries here.

The integration is deliberately degradable: when the env vars in section 4
are unset, every integration route falls back to its offline shape, and the
Playwright smoke tests (`tests/smoke.spec.ts`) pin that fallback behavior.

## 2. Deployed objects (current state)

| Object | Name / ID | Notes |
| --- | --- | --- |
| App `ontos` | URL `https://ontos-687974281268075.aws.databricksapps.com` | RUNNING. Swagger at `/docs`. Resources: Lakebase `projects/jai-ontos-mp` (DB `databricks_postgres`, schema `app_ontos`), warehouse `bf7ffcda00a8c351`, serving endpoint `databricks-gpt-5-6-sol`, volume `jai_ontos.ontos_mkt.ontos_demo` (WRITE_VOLUME). |
| App `jai-ontobricks` | URL `https://jai-ontobricks-687974281268075.aws.databricksapps.com` | RUNNING. Main OntoBricks app, v0.8.0. App SP client-id `731b4468-4c41-4120-a962-a66b470a220e`. |
| App `jai-mcp-ontobricks` | URL `https://jai-mcp-ontobricks-687974281268075.aws.databricksapps.com` | RUNNING. MCP companion; env `ONTOBRICKS_URL` points at the main app (needs the second deploy run, see section 8). App SP `df8daae2-6a6b-457e-96ef-d56a3ff53ffb`. |
| Lakebase project | `projects/jai-ontobricks-registry` | Branch `production`, endpoint `ep-weathered-brook-d2bijxvb.database.us-east-1.cloud.databricks.com`, CU_2. OntoBricks registry store. |
| Lakebase database | `jai_ontobricks_registry` | Resource segment `db-yt7t-u8o3wjtg48` → `projects/jai-ontobricks-registry/branches/production/databases/db-yt7t-u8o3wjtg48`. |
| UC schema | `jai_ontos.jai_ontobricks` | New schema for the OntoBricks deployment. |
| UC volume | `jai_ontos.jai_ontobricks.jai_registry` | Managed volume, registry volume (WRITE_VOLUME to both app SPs). |
| Serverless job | id `569591668099003` | `[dev jaiwant_jonathan] jai-ontobricks-graph-analytics` (DAB dev-mode prefix; the app resolves it by suffix match). |
| Service principal | `jai_rt_onto_integration` (id `72977723263196`, OAuth client_id `a1e01f11-2292-4a68-af1a-b8c6c932532f`) | Machine identity for the RT_onto server. CAN_USE on `ontos`, `jai-ontobricks`, `jai-mcp-ontobricks`; member of the `data-producers` group. |
| Workspace group | `data-producers` (id `2125585384116949`) | Matches the ontos "Data Producer" AppRole (read/write on data-products + data-contracts) — membership gives the SP REST access in ontos. |

Resource bindings on `jai-ontobricks` (verified at deploy): `sql-warehouse`
→ `bf7ffcda00a8c351` (CAN_USE, shared jai-sql-warehouse), `volume` → the
registry volume, `postgres` → the Lakebase database above
(CAN_CONNECT_AND_CREATE). Bootstrap grants: both OntoBricks app SPs have
UC `ALL_PRIVILEGES` on catalog `jai_ontos` + schema `jai_ontos.jai_ontobricks`
and CAN_USE on the Lakebase project; the Postgres schema grants inside
`jai_ontobricks_registry` self-apply at registry Initialize (section 5).

## 3. Auth architecture (two-layer gate)

The Databricks Apps proxy (gate) on this workspace accepts **OAuth bearer
tokens only** — user-context or M2M SP. A PAT or the ontos MCP token in the
`Authorization: Bearer` header is rejected with 401 at the gate, before the
app ever sees the request (verified on both companion apps). Therefore
every machine call carries **two layers**:

1. **Gate layer:** `Authorization: Bearer <SP OAuth token>` — minted via
   OAuth client_credentials from the machine SP `jai_rt_onto_integration`:

   ```bash
   GATE_TOKEN=$(curl -s -X POST \
     "https://fe-vm-jai-classic-ws.cloud.databricks.com/oidc/v1/token" \
     -u "$SP_CLIENT_ID:$SP_SECRET" \
     -d "grant_type=client_credentials&scope=all-apis" | jq -r .access_token)
   ```

   Tokens live 1 hour (`expires_in 3600`). The RT_onto server mints and
   caches them in `server/spGateToken.ts`, re-minting at 50 minutes.

2. **App layer** (per-app header, unchanged by the gate requirement):
   - ontos: `X-API-key: <ontos MCP API token>`. On the REST `/api/*` routes
     ontos resolves the **gate identity's** Ontos role (`X-API-key` is only
     honored on `/api/mcp`), so the SP must keep its `data-producers`
     membership; the header is harmless on REST and required for MCP.
   - OntoBricks: `X-Databricks-Host: https://fe-vm-jai-classic-ws.cloud.databricks.com`
     + `X-Databricks-Token: <workspace PAT>`.

PATs work fine against workspace APIs and as the app-level
`X-Databricks-Token`; they just cannot pass the gate as `Authorization`.

## 4. Wiring RT_onto_demo

The server reads these env vars. Most are declared in `app.yaml` with empty
defaults; the two `RT_INTEGRATION_SP_*` vars are not yet declared there
(operators add them — step 3 below). Values are set at deploy time,
secrets never in the repo:

| Env var | Kind | Where to obtain the value |
| --- | --- | --- |
| `ONTOS_APP_URL` | plain | `https://ontos-687974281268075.aws.databricksapps.com` |
| `ONTOS_MCP_TOKEN` | secret | ontos MCP API token — mint at `POST <ontos-url>/api/mcp-tokens` authenticated as a workspace user (`Authorization: Bearer $(databricks auth token -p fe-vm-jai-classic-ws)`; exact payload in the ontos Swagger at `<ontos-url>/docs`). Request scopes covering `data-products` and `data-contracts` read/write. |
| `ONTOBRICKS_APP_URL` | plain | `https://jai-ontobricks-687974281268075.aws.databricksapps.com` |
| `ONTOBRICKS_TOKEN` | secret | workspace PAT — `databricks tokens create --comment "jai-ontobricks machine token for RT_onto GraphQL integration" -p fe-vm-jai-classic-ws` (record the returned `token_id` for later revocation). |
| `ONTOBRICKS_DOMAIN` | plain | Name of the published OntoBricks domain (set after section 5 step 2). |
| `RT_INTEGRATION_SP_CLIENT_ID` | plain | `a1e01f11-2292-4a68-af1a-b8c6c932532f` (the machine SP's OAuth client_id). |
| `RT_INTEGRATION_SP_SECRET` | secret | The SP's OAuth client secret — generate under workspace Settings → Identity → Service principals → `jai_rt_onto_integration` → OAuth client secrets. |
| `DATABRICKS_HOST` | runtime | Always present in the App runtime; used as the token-endpoint host. |

To set the secret-bearing values on the deployed app:

1. **Store each secret in a workspace secret scope** (values never in the
   repo): `databricks secrets put-secret <scope> <key> -p fe-vm-jai-classic-ws`.
2. **Attach each secret to the `rt-onto-demo` app as a resource** with a
   resource key (Apps UI: app detail → Resources → Add resource → Secret).
   Because resource updates go through `apps create-update`, include the
   app's FULL current `resources` array plus the new secret entries — see
   gotcha 1 before touching resources via the API.
3. **Point `app.yaml` at them** with `valueFrom` (the resource key), e.g.:

   ```yaml
   env:
     - name: ONTOS_APP_URL
       value: 'https://ontos-687974281268075.aws.databricksapps.com'
     - name: ONTOS_MCP_TOKEN
       valueFrom: ontos-mcp-token
     - name: RT_INTEGRATION_SP_CLIENT_ID
       value: 'a1e01f11-2292-4a68-af1a-b8c6c932532f'
     - name: RT_INTEGRATION_SP_SECRET
       valueFrom: rt-integration-sp-secret
   ```

   Add the two `RT_INTEGRATION_SP_*` entries (not yet declared) and switch
   the other secret-bearing entries from their empty `value: ''` defaults
   to `valueFrom`; plain values (URLs, client id, domain name) stay as
   `value`. `valueFrom` may also reference the attached `sql-warehouse`
   resource, as the existing `DATABRICKS_WAREHOUSE_ID` entry does.
4. **Redeploy** (env values resolve at deploy time) — see
   `docs/appkit_app_notes.md` for the full flow:

   ```bash
   npm install && npm run build
   databricks sync . /Workspace/Users/jaiwant.jonathan@databricks.com/rt-onto-demo \
     --exclude node_modules --exclude .venv --exclude .git \
     --exclude legacy_streamlit_app/** \
     --include 'dist/**' --include 'client/dist/**' --include 'shared/**' \
     -p fe-vm-jai-classic-ws
   databricks apps deploy rt-onto-demo \
     --source-code-path /Workspace/Users/jaiwant.jonathan@databricks.com/rt-onto-demo \
     -p fe-vm-jai-classic-ws
   ```

While the vars are unset the app runs in offline mode: `/api/contract*`
serves the bundled fallback contract, `/api/graph/neighbors` serves seeded
edges, and `/api/measures` serves the bundled measures.

## 5. Remaining operator steps

1. **OntoBricks registry Initialize (UI).** Open
   `https://jai-ontobricks-687974281268075.aws.databricksapps.com` →
   Settings → Registry → Initialize. This creates the Postgres schema
   `jai_ontobricks` in `jai_ontobricks_registry` and self-applies the SP
   schema grants. Until then, GraphQL/registry endpoints return
   `relation "jai_ontobricks.registries" does not exist` — that message
   pre-Initialize is expected. Optionally re-run, from a clone of v0.8.0:

   ```bash
   scripts/bootstrap/lakebase-perms.sh -i jai-ontobricks-registry -b production \
     -d jai_ontobricks_registry -s jai_ontobricks -c jai_ontos \
     -a jai-ontobricks -a jai-mcp-ontobricks
   ```

2. **Author the flagship domain in OntoViz (UI, one-time).** Import the
   repo's `ontology/retail_traffic_labor.ttl` (OntoBricks accepts
   OWL/RDFS import), map the classes to the serving views in
   `jai_ontos.demo_schema` (`jai_store_day_traffic_labor`,
   `jai_store_efficiency_summary`, `jai_store_efficiency_opportunities`,
   `jai_product_registry`), then publish through the server-enforced
   lifecycle DRAFT → IN-REVIEW → PUBLISHED (transitions are UI-only; only
   PUBLISHED versions are queryable). Afterwards set `ONTOBRICKS_DOMAIN`
   to the published domain name (section 4) and redeploy.
3. **ontos: verify the machine SP's role.** In the ontos UI, confirm the
   "Data Producer" AppRole still includes the `data-producers` group and
   that `jai_rt_onto_integration` is a member — the REST routes resolve
   the gate identity's role, so losing membership breaks the DataContract
   sync/validation flow.

## 6. Verification

With the env wired (section 4), first check the companions directly
(gate + app headers from section 3):

```bash
# ontos: Swagger reachable, REST routes answer with SP gate identity
curl -sf -o /dev/null -w '%{http_code}\n' "https://ontos-687974281268075.aws.databricksapps.com/docs"
curl -sf -H "Authorization: Bearer $GATE_TOKEN" \
   -H "X-API-key: $ONTOS_MCP_TOKEN" \
   "https://ontos-687974281268075.aws.databricksapps.com/api/data-products"

# OntoBricks: health + API docs
curl -sf -H "Authorization: Bearer $GATE_TOKEN" \
   -H "X-Databricks-Host: https://fe-vm-jai-classic-ws.cloud.databricks.com" \
   -H "X-Databricks-Token: $ONTOBRICKS_TOKEN" \
   "https://jai-ontobricks-687974281268075.aws.databricksapps.com/api/v1/health"
curl -sf -o /dev/null -w '%{http_code}\n' \
   -H "Authorization: Bearer $GATE_TOKEN" \
   -H "X-Databricks-Host: https://fe-vm-jai-classic-ws.cloud.databricks.com" \
   -H "X-Databricks-Token: $ONTOBRICKS_TOKEN" \
   "https://jai-ontobricks-687974281268075.aws.databricksapps.com/api/docs"
```

`/api/v1/health` should return
`{"status":"healthy","version":"0.8.0",...}`. Then in the RT_onto app:

- **DataContract page:** after "Sync to Ontos" and "Run validation", the
  page shows the real ontos validation results (badges), not the offline
  fallback.
- **TravelCanvas:** after the domain is published (section 5 step 2),
  expanding a node returns live materialized-graph neighbors via
  `/api/graph/neighbors`.

Offline fallback: with the env unset, the same pages must degrade
gracefully to their offline shapes — `tests/smoke.spec.ts` pins this
("Data Contract page shows ontos validation offline", "Graph Explorer page
loads and travels a node offline").

## 7. Token rotation + expiry

| Credential | Used as | Expires | Rotation |
| --- | --- | --- | --- |
| ontos MCP API token | `X-API-key` to ontos | ~90 days (current one 2026-12-29) | Mint a fresh token at `POST /api/mcp-tokens`, update the secret scope value, redeploy, revoke the old token by id in the ontos UI/API. |
| Workspace PAT | `X-Databricks-Token` to OntoBricks | ~90 days (current one ~2026-12-30, `token_id` on record) | `databricks tokens create` a new one, update the secret scope value, redeploy, revoke the old: `databricks tokens delete <token_id>`. Manual step — no automation. |
| SP OAuth secret | mints the 1h gate tokens | current secret 2028-09-29 | Generate a new OAuth client secret on the SP (workspace settings), update the secret scope value, redeploy, delete the old secret on the SP. |
| SP gate tokens | `Authorization: Bearer` at the gate | 1 hour | Automatic — the server re-mints at 50 min (`server/spGateToken.ts`); nothing to rotate manually. |

## 8. Operational gotchas (learned the hard way)

1. **Never PATCH an app without its full `resources` array.** The Apps API
   replaces on omit — a `PATCH /api/2.0/apps/<name>` body that only carries
   `user_api_scopes` silently nulls `resources`, and the app crashes on the
   next deploy/start (e.g. missing `DATABRICKS_WAREHOUSE_ID`). The safe
   path is `databricks apps create-update <name> --json
   '{"update_mask":"<field>","app":{...}}'` with a scoped mask AND the full
   resources array included when touching `resources`. Resource JSON
   shapes: `sql_warehouse:{id,permission}`,
   `serving_endpoint:{name,permission}`,
   `postgres:{branch,database,permission:"CAN_CONNECT_AND_CREATE"}`,
   `uc_securable:{securable_full_name,securable_type:"VOLUME",permission}`.
2. **`apps stop` + `apps start` drops the active deployment.** After any
   stop, redeploy from source before expecting the app to serve.
3. **`user_api_scopes` changes require users to sign out and back in** to
   the app (re-consent). Current ontos scopes:
   `sql`, `catalog.catalogs`, `catalog.schemas`, `catalog.tables`,
   `catalog.connections`, `files`.
4. **ontos is a patched custom deploy, not the Marketplace install** (the
   Marketplace version was deleted 2026-09-28 and cannot be redeployed or
   source-updated). Patched source lives in WSFS at
   `/Users/jaiwant.jonathan@databricks.com/ontos-patched`. Redeploy:

   ```bash
   databricks apps deploy ontos \
     --source-code-path "/Workspace/Users/jaiwant.jonathan@databricks.com/ontos-patched/" \
     -p fe-vm-jai-classic-ws
   ```

   The `/Workspace` prefix and trailing slash are required. If the app's
   SP ever changes, the Lakebase app-schema reset recipe is in the project
   memory (`ontos-app-replacement`).
5. **OntoBricks first-deploy race:** the initial `scripts/deploy.sh` run
   deploys the MCP companion before the main app's URL is known, so a
   second idempotent deploy run is needed to embed `ONTOBRICKS_URL` into
   `jai-mcp-ontobricks`. Deploy from a clone of tag `v0.8.0` with
   `scripts/deploy.config.sh` patched in the clone (never in this repo).
6. **CLI profile:** use `-p fe-vm-jai-classic-ws` for everything in this
   workspace; the `jai-classic` profile referenced by older docs points at
   the wrong host.
