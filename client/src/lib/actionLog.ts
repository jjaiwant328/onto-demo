// Client helper for the persisted action log (jai_ontos.demo_schema.jai_action_log).
// The Action Center calls logAction on Approve/Modify/Reject; the Action Log
// tracker lists and advances track_status; the print/actions route exports them.
import type { ActionItem } from './actions';

export type LogContext = {
  schema_label: string;
  domain: string;
  product: string;
};

export type LoggedAction = {
  action_id: string;
  created_at?: string;
  updated_at?: string;
  schema_label?: string;
  domain?: string;
  product?: string;
  source?: string;
  priority?: string;
  issue?: string;
  root_cause?: string;
  recommended_action?: string;
  confidence?: number;
  decision?: string;
  track_status?: string;
  decided_by?: string;
  decided_at?: string;
  ref_entity?: string;
  notes?: string;
};

// persist a decided action; returns { ok, action_id?, decided_by? }
export async function logAction(
  action: ActionItem,
  decision: 'approved' | 'modified' | 'rejected',
  ctx: LogContext
): Promise<{ ok: boolean; action_id?: string; decided_by?: string; error?: string }> {
  try {
    const resp = await fetch('/api/log-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_label: ctx.schema_label,
        domain: ctx.domain,
        product: ctx.product,
        source: action.source,
        priority: action.priority,
        issue: action.issue,
        root_cause: action.root_cause,
        recommended_action: action.recommended_action,
        confidence: action.confidence,
        decision,
        ref_entity: '',
        notes: '',
      }),
    });
    return await resp.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchActionLog(product?: string, status?: string): Promise<LoggedAction[]> {
  try {
    const qs = new URLSearchParams();
    if (product) qs.set('product', product);
    if (status) qs.set('status', status);
    const resp = await fetch(`/api/action-log${qs.toString() ? `?${qs}` : ''}`);
    const d = await resp.json();
    return Array.isArray(d?.actions) ? d.actions : [];
  } catch {
    return [];
  }
}

export async function updateActionStatus(
  action_id: string,
  track_status: 'open' | 'in_progress' | 'done'
): Promise<boolean> {
  try {
    const resp = await fetch('/api/update-action-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action_id, track_status }),
    });
    const d = await resp.json();
    return Boolean(d?.ok);
  } catch {
    return false;
  }
}
