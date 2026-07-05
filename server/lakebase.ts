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
}
