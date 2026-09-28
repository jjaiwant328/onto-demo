# Integrate real Ontos + OntoBricks apps into RT_onto_demo

## Context

Original runbook (`docs/Ontos_demo - Claude Code Runbook for RT Onto Enterprise App.md:12-13`) intended OntoBricks to own ontology design/mapping/materialization and Ontos to own governed artifacts (products, contracts, semantic models). The repo faked both as static file mirrors (`ontobricks/`, `ontos/` dirs) — nothing read at runtime, contracts/measures hardcoded in client (`client/src/lib/contract.ts:36`, `deriveComponents.ts:171,435-447`). User chose integration with the real deployed apps instead of native build. Both are Databricks Labs Apps, active, Databricks License (MCSA — internal/demo use OK).

Integration model: RT_onto_demo stays generation/UX front-end. Ontos = governance system of record (real contract validation, review workflow). OntoBricks = ontology materialization + graph query backend.

## Researched integration surfaces (verified from repo docs)

**ontos** (`github.com/databrickslabs/ontos`):
- Needs its own Lakebase instance + database `app_ontos` (GRANT CREATE TO PUBLIC), UC volume; warehouse optional. Deploy: Marketplace listing or `databricks bundle deploy` from repo. Swagger at `<app-url>/docs`.
- REST: `POST /api/data-contracts/odcs/import` (ODCS v3.1.0 YAML), `POST /api/data-products/from-contract`, `GET /api/data-products/{id}`, review-workflow endpoints (approve/certify/publish).
- Built-in "Data Contract Validation" workflow: schema drift, SLA freshness, DQ scores against UC — replaces a native validation engine entirely.
- MCP server `/api/mcp` (JSON-RPC 2.0 + SSE), ~45 tools incl. create-draft/update for products+contracts, SPARQL, UC query. Machine auth documented: API keys via `/api/mcp-tokens` (`X-API-key`). External REST SP auth **not documented** — use MCP token path for server-to-server.
- No webhooks; read governance state by polling GET endpoints / MCP search.

**ontobricks** (`github.com/databrickslabs/ontobricks`, v0.8.0):
- Needs Lakebase, warehouse, UC volume. Deploy: `make deploy` after `scripts/deploy.config.sh`. Registry in Lakebase `ontobricks_registry` tables.
- Domain = JSON payload (ontology + SQL mappings + layout). Accepts OWL/RDFS import (our `ontology/retail_traffic_labor.ttl` qualifies). No documented programmatic-authoring API — author flagship domain via OntoViz UI/LLM once, not auto-generated.
- Lifecycle DRAFT→IN-REVIEW→PUBLISHED is server-enforced, transitions UI-only. Only PUBLISHED versions queryable.
- External GraphQL: `/api/v1/graphql` (OpenAPI `/api/docs`), headers `X-Databricks-Host` + `X-Databricks-Token` (PAT). Nested depth max 5 — fits N-hop expand. Also `POST /api/v1/query` SPARQL, BFS `GET /api/v1/digitaltwin/triples/find`.
- Separate MCP app `mcp-ontobricks` (streamable-http `/mcp`): domain registry + query tools incl. `describe_entity` BFS traversal, `query_graphql`.

## Architecture decisions

1. **Deployment (operator steps, Phase 0):** Deploy `ontos` and `ontobricks` as separate Databricks Apps in `jai_classic_ws`, each with own Lakebase instance. Follow each repo's deploy docs. Flagship product scope only.
2. **Contract flow:** Convert `ontos/contracts/jai_store_traffic_labor_efficiency_contract.yaml` to ODCS v3.1.0 (ontos `GET /api/data-contracts/schema/odcs` gives exact schema). Push via `POST /api/data-contracts/odcs/import`, create product via `/api/data-products/from-contract`. Ontos Data Contract Validation workflow runs the real checks (drift/freshness/DQ) against `jai_ontos.demo_schema.jai_store_day_traffic_labor` — no native engine built.
3. **Server-to-server auth:** ontos via MCP API token (minted once by operator via `/api/mcp-tokens`, stored as App env var). ontobricks GraphQL via PAT stored as App env var. Both documented paths; PAT rotation is operator runbook item.
4. **Contract UI:** RT_onto DataContract page (`client/src/pages/DataContract.tsx:138-210`) fetches validation status through new server proxy endpoints (keeps tokens server-side, avoids CORS). `FLAGSHIP_CONTRACT` stays as offline fallback.
5. **Graph:** Author flagship domain in OntoViz (import `ontology/retail_traffic_labor.ttl`, add SQL mappings to serving views, publish through lifecycle). RT_onto server proxies GraphQL neighbor queries: new `GET /api/graph/neighbors?node=<iri>&hops=N` → ontobricks `/api/v1/graphql` nested query (depth ≤3 of max 5). TravelCanvas (`client/src/components/TravelCanvas.tsx:129-172`) expand-node calls this instead of native edges table. Native `sql/05` edges plan dropped.
6. **Measures:** Keep `ontology/semantic_measures.yaml` server-loaded + `/api/measures` endpoint (small native piece) — ontos semantic models are registry metadata, not KPI formula definitions; nothing to import from.
7. **Out of scope:** compliance DSL policies, teams/projects org modeling, SPARQL endpoints in RT_onto UI, OBX auto-generation (reverse-engineers undocumented domain JSON), SHACL headless (no API documented).

## File changes

New:
- `server/ontosClient.ts` — ontos REST + MCP-token client (push contract/product, fetch validation state)
- `server/ontobricksClient.ts` — GraphQL neighbor query proxy
- `shared/ontosTypes.ts` — ODCS contract, validation-result, graph-neighbor types
- `ontology/odcs/jai_store_traffic_labor_efficiency_contract.odcs.yaml` — ODCS v3.1.0 conversion of existing contract YAML
- `docs/ontos_ontobricks_setup.md` — operator runbook: deploy both apps, mint MCP token, create PAT, author+publish flagship domain, env vars
- `tests/ontosClient.test.ts`, `tests/ontobricksClient.test.ts` — mocked-fetch unit tests

Modified:
- `server/server.ts` — new endpoints: `/api/contract` (proxy ontos validation state), `/api/contract/sync` (push ODCS + create product), `/api/graph/neighbors` (proxy GraphQL), `/api/measures` (YAML-driven)
- `client/src/pages/DataContract.tsx` — real validation badges from API, "Sync to Ontos" + "Run validation" buttons
- `client/src/components/TravelCanvas.tsx` — expand-node via `/api/graph/neighbors`
- `client/src/lib/deriveComponents.ts` — measures from `/api/measures` (bundled JSON fallback)
- `app.yaml` — env vars: `ONTOS_APP_URL`, `ONTOS_MCP_TOKEN`, `ONTOBRICKS_APP_URL`, `ONTOBRICKS_TOKEN`
- `CLAUDE.md` — record companion apps + env vars

## Phases (CLAUDE.md: single use case first)

1. **Deploy companion apps (operator):** ontos + Lakebase `app_ontos`, ontobricks + Lakebase registry; mint MCP token + PAT; record URLs/tokens as app secrets.
2. **Contract integration:** ODCS conversion → sync push → DataContract page shows ontos validation results. End state: `jai_store_traffic_labor_efficiency` product + contract live in ontos, validation workflow run, pass/fail visible in RT_onto.
3. **Graph integration:** author + publish flagship domain in OntoViz; `/api/graph/neighbors` proxy; TravelCanvas expand-node serves live materialized-graph data.
4. **Measures (native small):** `/api/measures` + deriveComponents rewire.
5. **Later:** MCP wiring for Copilot (ontos + mcp-ontobricks), multi-product sync from generated catalog, compliance policies.

## Verification

- Unit: clients mocked-fetch (token headers, error humanization); ODCS YAML validates against `GET /api/data-contracts/schema/odcs`; graph-neighbor mapping from GraphQL response to `UnifiedNode/UnifiedEdge` shapes (`graphData.ts:202-235`).
- E2E manual: after Phase 2, open ontos `<url>/docs`, confirm product + contract exist; trigger validation workflow; RT_onto DataContract shows same results. After Phase 3, expand node in TravelCanvas returns published-domain neighbors.
- Playwright: extend `tests/smoke.spec.ts` — DataContract page renders validation badges; Graph Explorer loads with live neighbor expand (stubbed if companion apps down — offline fallback paths must hold).
- `npm test` (vitest + smoke) green.

## Risks / tradeoffs

- Two more Lakebase instances + two more Apps: ops cost. Traded for real validation workflow, review lifecycle, standards (ODCS, R2RML, SPARQL) instead of re-implementing.
- ontos external REST SP auth undocumented — MCP token is the documented machine path; if it proves insufficient for REST calls, fall back to UI-driven import (manual) + GET-only polling.
- ontobricks domain JSON undocumented — avoid auto-generation; flagship authored in UI once. Multi-product auto-authoring blocked until upstream documents an API.
- Both apps actively developed, docs on `development` branch — pin deployed versions in setup runbook.
- PAT for ontobricks GraphQL: rotation = manual runbook step.
- Databricks License (not OSS) — internal/demo use consistent with this workspace.
