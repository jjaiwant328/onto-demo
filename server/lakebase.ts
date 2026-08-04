// Lakebase (Autoscaling Postgres) connection module for the app's operational
// state tables (saved_schemas / action_log / product_links). Uses the AppKit
// @databricks/lakebase driver, which returns a standard pg.Pool with automatic
// OAuth token refresh. Analytical/actual data stays on the SQL warehouse (Delta)
// — this pool is ONLY for fast operational reads/writes.
//
// Env (set in app.yaml; auto-present on the Apps runtime for the attached SP):
//   PGHOST, PGDATABASE, PGUSER, LAKEBASE_ENDPOINT, PGSSLMODE=require
import { createLakebasePool } from '@databricks/lakebase';
import type { Pool, QueryResultRow } from 'pg';

let poolPromise: Promise<Pool> | null = null;

// Whether Lakebase is configured for this deployment.
export function lakebaseConfigured(): boolean {
  return Boolean(process.env.PGHOST && process.env.LAKEBASE_ENDPOINT);
}

function makePool(): Pool {
  // createLakebasePool reads PGHOST / PGDATABASE / LAKEBASE_ENDPOINT / PGUSER
  // from the environment; ssl require + a small pool for an app-state workload.
  return createLakebasePool({
    max: 5,
    // pg pool options are passed through; keep idle low (autoscaling scales to zero)
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 30_000,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
  } as Parameters<typeof createLakebasePool>[0]);
}

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = (async () => makePool())();
  }
  return poolPromise;
}

// Run a query with cold-start tolerance: Autoscaling may take a few seconds to
// resume from suspend, and the first connection can fail with a transient
// connection error — retry a few times with backoff so the first request after
// idle succeeds.
export async function lbQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const attempts = 4;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const pool = await getPool();
      const res = await pool.query<T>(sql, params as never[]);
      return res.rows;
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      // transient cold-start / connection errors → back off and retry
      const transient =
        /ECONNREFUSED|ETIMEDOUT|Connection terminated|termina|starting up|the database system is|ENOTFOUND|EPIPE|reset by peer|timeout/i.test(
          msg
        );
      if (!transient || i === attempts - 1) break;
      // reset the pool so a fresh connection (and token) is attempted
      poolPromise = null;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Idempotent DDL — creates the 3 operational tables if absent. Runs on startup.
export async function ensureLakebaseTables(): Promise<void> {
  await lbQuery(`CREATE TABLE IF NOT EXISTS saved_schemas (
    schema_id text PRIMARY KEY,
    customer text,
    schema_name text,
    source text,
    catalog_ref text,
    table_count int,
    created_by text,
    created_at timestamptz,
    volume_path text,
    schema_json text,
    catalog_json text
  )`);
  await lbQuery(`CREATE TABLE IF NOT EXISTS action_log (
    action_id text PRIMARY KEY,
    created_at timestamptz,
    updated_at timestamptz,
    schema_label text,
    domain text,
    product text,
    source text,
    priority text,
    issue text,
    root_cause text,
    recommended_action text,
    confidence double precision,
    decision text,
    track_status text,
    decided_by text,
    decided_at timestamptz,
    ref_entity text,
    notes text
  )`);
  await lbQuery(`CREATE TABLE IF NOT EXISTS product_links (
    link_id text PRIMARY KEY,
    schema_label text,
    domain text,
    product text,
    link_type text,
    url text,
    label text,
    created_by text,
    created_at timestamptz
  )`);
  // user curation of the auto-derived ontology, layered over heuristic/LLM
  // components per schema. kind ∈ entity|relationship|mapping|edge_status;
  // action ∈ rename|merge|set_role|set_pii|delete|confirm|reject; value = JSON.
  await lbQuery(`CREATE TABLE IF NOT EXISTS ontology_overrides (
    id text PRIMARY KEY,
    schema_label text,
    product text,
    kind text,
    ref text,
    action text,
    value text,
    created_by text,
    created_at timestamptz
  )`);
  // LLM-refined catalog cache keyed by scope signature (sorted schema-id list),
  // so the "AI refining labels" polish runs ONCE per scope and every later
  // reload — including combined/built-in scopes — loads instantly.
  await lbQuery(`CREATE TABLE IF NOT EXISTS catalog_cache (
    sig text PRIMARY KEY,
    catalog_json text,
    created_at timestamptz
  )`);
  // Domain-level monitoring-job DEFINITION — one active, revisable row per
  // domain. Captures the aggregate spec the user assembles via the chat builder,
  // the schedule, and the job name shown to the user. Keyed by domain so a new
  // domain onboards with zero DDL (shared table, WHERE domain = $1).
  await lbQuery(`CREATE TABLE IF NOT EXISTS jai_monitor_job (
    job_id text PRIMARY KEY,
    domain text UNIQUE NOT NULL,
    domain_label text,
    job_name text,
    schedule_cron text,
    schedule_tz text DEFAULT 'America/New_York',
    products_json text,
    aggregates_json text,
    summary_prompt text,
    enabled boolean DEFAULT true,
    version int DEFAULT 1,
    created_by text,
    created_at timestamptz,
    updated_at timestamptz
  )`);
  // Databricks Job provisioning details for a deployed monitoring definition
  // (populated when the user clicks "Deploy scheduled job"). Nullable — a job may
  // be defined/run on-demand without being deployed as a real scheduled Job.
  await lbQuery(`ALTER TABLE jai_monitor_job ADD COLUMN IF NOT EXISTS databricks_job_id text`);
  await lbQuery(`ALTER TABLE jai_monitor_job ADD COLUMN IF NOT EXISTS job_url text`);
  await lbQuery(`ALTER TABLE jai_monitor_job ADD COLUMN IF NOT EXISTS job_deployed_at timestamptz`);
  await lbQuery(`ALTER TABLE jai_monitor_job ADD COLUMN IF NOT EXISTS job_notebook_path text`);
  // (The Control Tower snapshot lives in a Delta table
  // jai_ontos.demo_schema.jai_control_tower_snapshot — written by BOTH the app's
  // on-demand refresh and the scheduled Databricks Job, read by the app — so a
  // notebook-based job can maintain exactly what the app serves.)
  // LLM response cache — keyed by a hash of the exact prompt (+ max tokens), so any
  // change to the inputs (which are embedded in the prompt) misses and re-runs,
  // while unchanged inputs reuse the stored answer (no tokens). Long-term (survives
  // restarts) and shared across sessions/users.
  await lbQuery(`CREATE TABLE IF NOT EXISTS jai_llm_cache (
    cache_key text PRIMARY KEY,
    label text,
    response text,
    created_at timestamptz,
    last_hit_at timestamptz,
    hits int DEFAULT 0
  )`);
  // Monitoring-job RUN OUTPUT — daily AGGREGATE results, one row per
  // (domain, product, day). Never stores row-level detail or actions; this is
  // physically separate from action_log (no decision/recommendation columns).
  await lbQuery(`CREATE TABLE IF NOT EXISTS jai_monitor_run (
    run_id text PRIMARY KEY,
    job_id text NOT NULL,
    domain text NOT NULL,
    run_ts timestamptz NOT NULL,
    run_date date NOT NULL,
    trigger text,
    product text NOT NULL,
    metrics_json text,
    exception_total bigint,
    status text,
    error text,
    llm_summary text,
    created_at timestamptz
  )`);
  await lbQuery(
    `CREATE INDEX IF NOT EXISTS idx_monitor_run_domain_date ON jai_monitor_run (domain, run_date DESC)`
  );
  // one row per (job, product, day) — re-runs upsert in place (idempotent)
  await lbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_monitor_run_day ON jai_monitor_run (job_id, product, run_date)`
  );
  // Generated ontology artifact per product (OWL/TTL + JSON-LD + cytoscape graph).
  // Canonical source the Ontology Explorer reads; also mirrored to a UC Volume.
  await lbQuery(`CREATE TABLE IF NOT EXISTS jai_ontology_artifact (
    artifact_id text PRIMARY KEY,
    schema_label text,
    product text,
    product_label text,
    iri text,
    ttl text,
    jsonld text,
    graph_json text,
    model_json text,
    volume_path text,
    class_count int,
    objprop_count int,
    generated_by text,
    generated_at timestamptz
  )`);
  // Domain-level business/reasoning rules (seeded from QSR_SC_REASONING_RULES,
  // then user-editable). Captures rules so they can be applied consistently.
  await lbQuery(`CREATE TABLE IF NOT EXISTS jai_business_rules (
    rule_id text PRIMARY KEY,
    domain text NOT NULL,
    name text,
    if_conditions text,
    then_conclusion text,
    concepts text,
    evidence text,
    eval_sql text,
    eval_table text,
    enabled boolean DEFAULT true,
    origin text,
    created_by text,
    created_at timestamptz,
    updated_at timestamptz
  )`);
  // Generated domain analysis (ROI-ranked use cases + data-gap analysis) per
  // schema+domain. LLM-authored (grounded in the domain's products/DDL) with a
  // deterministic fallback; canonical source the Domain Analysis tab reads.
  await lbQuery(`CREATE TABLE IF NOT EXISTS jai_domain_analysis (
    analysis_id text PRIMARY KEY,
    schema_label text,
    domain_name text,
    domain_label text,
    signature text,
    analysis_json text,
    llm_used boolean,
    generated_by text,
    generated_at timestamptz
  )`);
  // Use-case data-product DRAFTS: a use case from the Domain Analysis described
  // as a data product (KPIs, tables, proposed genie spaces + metric views). Lives
  // in a staging tab; only status='completed' drafts surface in Data Products.
  await lbQuery(`CREATE TABLE IF NOT EXISTS jai_use_case_product (
    draft_id text PRIMARY KEY,
    schema_label text,
    domain_name text,
    use_case_title text,
    spec_json text,
    llm_used boolean,
    status text DEFAULT 'draft',
    created_by text,
    created_at timestamptz,
    updated_at timestamptz
  )`);
}
