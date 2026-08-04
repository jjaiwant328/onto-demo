// Client helper for the Control Tower Home — a cross-product "what needs
// attention today" summary over the QSR supply-chain products.

export type ControlTowerCard = {
  product_name: string;
  display_name: string;
  business_outcome?: string;
  domain: string;
  domain_label: string;
  headline_metric: string;
  headline_value: number;
  critical_metric?: string | null;
  critical_value?: number;
  kpis: Record<string, unknown>;
  severity: 'high' | 'medium' | 'ok' | 'unknown';
  error?: string;
};

export type ControlTowerSummary = {
  products: ControlTowerCard[];
  health_score: number;
  issues_total: number;
  high: number;
  medium: number;
  computed_at?: string | null;
};

// force a snapshot recompute (Refresh button); returns how many products refreshed
export async function refreshControlTower(): Promise<{ ok: boolean; refreshed?: number; error?: string }> {
  try {
    const r = await fetch('/api/control-tower-refresh', { method: 'POST' });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchControlTowerSummary(domain?: string): Promise<ControlTowerSummary> {
  try {
    const qs = domain ? `?domain=${encodeURIComponent(domain)}` : '';
    const r = await fetch(`/api/control-tower-summary${qs}`);
    const d = await r.json();
    return {
      products: Array.isArray(d?.products) ? d.products : [],
      health_score: Number(d?.health_score ?? 0),
      issues_total: Number(d?.issues_total ?? 0),
      high: Number(d?.high ?? 0),
      medium: Number(d?.medium ?? 0),
      computed_at: d?.computed_at ?? null,
    };
  } catch {
    return { products: [], health_score: 0, issues_total: 0, high: 0, medium: 0, computed_at: null };
  }
}

// humanize a metric key (at_risk_items → "at risk items") for plain-language labels
export function humanizeMetric(key: string): string {
  return (key || '').replace(/_/g, ' ').replace(/\bpct\b/, '%').trim();
}

export type InboxItem = {
  id: string;
  product_name: string;
  product_display: string;
  domain: string;
  domain_label: string;
  severity: 'high' | 'medium' | 'ok';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  headline_metric: string;
  headline_value: number;
  critical_metric?: string | null;
  critical_value?: number;
  issue: string;
  root_cause: string;
  recommended_action: string;
  kpis: Record<string, unknown>;
};

export async function fetchActionInbox(): Promise<InboxItem[]> {
  try {
    const r = await fetch('/api/action-inbox');
    const d = await r.json();
    return Array.isArray(d?.items) ? d.items : [];
  } catch {
    return [];
  }
}

export async function askControlTower(
  question: string,
  role?: string
): Promise<{ answer: string | null; llm: boolean; reason?: string }> {
  try {
    const r = await fetch('/api/control-tower-ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, role }),
    });
    return await r.json();
  } catch (e) {
    return { answer: null, llm: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export type CtRefreshJob = { databricks_job_id: string; job_url: string; schedule_cron: string; job_deployed_at?: string };
export type ControlTowerConfig = { genie_url: string; llm: boolean; refresh_job: CtRefreshJob | null };

export async function fetchControlTowerConfig(): Promise<ControlTowerConfig> {
  try {
    const r = await fetch('/api/control-tower-config');
    const d = await r.json();
    return { genie_url: String(d?.genie_url ?? ''), llm: Boolean(d?.llm), refresh_job: d?.refresh_job ?? null };
  } catch {
    return { genie_url: '', llm: false, refresh_job: null };
  }
}

// Provision (or update) the scheduled Databricks Job that keeps the snapshot fresh.
export async function deployControlTowerRefreshJob(
  cron?: string
): Promise<{ ok: boolean; databricks_job_id?: string; job_url?: string; schedule_cron?: string; error?: string }> {
  try {
    const r = await fetch('/api/control-tower-deploy-job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cron ? { cron } : {}),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// map a quartz cron to a friendly label (best-effort)
export function cronLabel(cron?: string): string {
  const map: Record<string, string> = {
    '0 0 6 * * ?': 'daily · 6:00 AM',
    '0 0 7 * * ?': 'daily · 7:00 AM',
    '0 0 */6 * * ?': 'every 6 hours',
  };
  return cron ? (map[cron] ?? cron) : '';
}
