// Client helpers for the domain-level MONITORING JOB builder. A monitoring job
// computes AGGREGATE health per product across a whole domain on a schedule and
// stores the results in Lakebase (jai_monitor_job / jai_monitor_run) so the
// Action Center can leverage them instead of recomputing live. Aggregate-only —
// it never proposes or takes action. Graceful fallbacks mirror actionLog.ts.

export type AggregateMetric = { key: string; label?: string };
export type AggregateThreshold = { metric: string; op: '>' | '>=' | '<' | '<='; value: number };
export type AggregateSpecItem = {
  product_name: string;
  metrics: AggregateMetric[];
  threshold?: AggregateThreshold;
};
export type AggregateSpec = { aggregates: AggregateSpecItem[] };

export type MonitorJob = {
  job_id: string;
  domain: string;
  domain_label?: string;
  job_name: string;
  schedule_cron?: string;
  schedule_tz?: string;
  products_json?: string;
  aggregates_json?: string;
  summary_prompt?: string;
  enabled?: boolean;
  version?: number;
  created_by?: string;
  updated_at?: string;
  databricks_job_id?: string | null;
  job_url?: string | null;
  job_notebook_path?: string | null;
  job_deployed_at?: string | null;
};

// one row in the Jobs & schedules panel
export type MonitorJobSummary = {
  domain: string;
  domain_label?: string;
  job_name: string;
  schedule_cron?: string;
  schedule_tz?: string;
  enabled?: boolean;
  version?: number;
  databricks_job_id?: string | null;
  job_url?: string | null;
  job_notebook_path?: string | null;
  job_deployed_at?: string | null;
  last_run?: string | null;
  run_count?: number;
};

export type MonitorRun = {
  run_id: string;
  job_id: string;
  domain: string;
  run_ts: string;
  run_date: string;
  trigger: string;
  product: string;
  metrics_json?: string;
  exception_total?: number;
  status?: string;
  error?: string;
  llm_summary?: string;
};

export type MonitorPreview = {
  job_name: string;
  products: { product_name: string; display_name: string; metric_keys: string[]; sql: string | null }[];
};

export async function fetchMonitorJob(domain: string): Promise<MonitorJob | null> {
  try {
    const r = await fetch(`/api/monitor-job?domain=${encodeURIComponent(domain)}`);
    const d = await r.json();
    return d?.job ?? null;
  } catch {
    return null;
  }
}

export async function saveMonitorJob(args: {
  domain: string;
  schedule_cron: string;
  schedule_tz?: string;
  aggregates_json: unknown;
  summary_prompt?: string;
  enabled?: boolean;
}): Promise<{ ok: boolean; job_id?: string; job_name?: string; version?: number; error?: string }> {
  try {
    const r = await fetch('/api/monitor-job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function monitorChat(args: {
  domain: string;
  question: string;
  history: { role: string; content: string }[];
  currentSpec?: unknown;
}): Promise<{ answer: string; spec: AggregateSpec | null; llm?: boolean }> {
  try {
    const r = await fetch('/api/monitor-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await r.json();
  } catch (e) {
    return { answer: `Error: ${e instanceof Error ? e.message : String(e)}`, spec: null };
  }
}

export async function runMonitorJob(
  domain: string,
  trigger: 'on_demand' | 'scheduled' = 'on_demand'
): Promise<{ ok: boolean; run_id?: string; results?: Record<string, unknown>[]; error?: string }> {
  try {
    const r = await fetch('/api/monitor-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain, trigger }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchMonitorRuns(domain: string, limit = 60): Promise<MonitorRun[]> {
  try {
    const r = await fetch(`/api/monitor-runs?domain=${encodeURIComponent(domain)}&limit=${limit}`);
    const d = await r.json();
    return Array.isArray(d?.runs) ? d.runs : [];
  } catch {
    return [];
  }
}

// Deploy the saved definition as a real scheduled Databricks Job.
export async function deployMonitorJob(
  domain: string
): Promise<{ ok: boolean; databricks_job_id?: string; job_url?: string; notebook_path?: string; schedule_cron?: string; error?: string }> {
  try {
    const r = await fetch('/api/monitor-deploy-job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Every defined/provisioned monitoring job (for the Jobs & schedules panel).
export async function fetchMonitorJobs(): Promise<MonitorJobSummary[]> {
  try {
    const r = await fetch('/api/monitor-jobs');
    const d = await r.json();
    return Array.isArray(d?.jobs) ? d.jobs : [];
  } catch {
    return [];
  }
}

export async function fetchMonitorPreview(domain: string): Promise<MonitorPreview | null> {
  try {
    const r = await fetch(`/api/monitor-preview?domain=${encodeURIComponent(domain)}`);
    return await r.json();
  } catch {
    return null;
  }
}

// Cron presets surfaced in the schedule dropdown (Quartz, as Databricks expects).
export const CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Daily · 7:00 AM', value: '0 0 7 * * ?' },
  { label: 'Daily · 6:00 AM', value: '0 0 6 * * ?' },
  { label: 'Weekdays · 5:30 AM', value: '0 30 5 ? * MON-FRI' },
  { label: 'Every 6 hours', value: '0 0 */6 * * ?' },
];
