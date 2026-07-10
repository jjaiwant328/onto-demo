// Client helpers for the closed-loop mitigation workflow: dispatch an approved play
// to its (simulated) system of record, advance the work-order status, and — once
// resolved — the exception aggregates net it out so the KPI drops. Reversible.

export type Mitigation = {
  intervention_id: string;
  product_name: string;
  domain: string;
  action_key: string;
  action_label: string;
  target_system: string;
  work_order_id: string;
  status: 'submitted' | 'acknowledged' | 'in_progress' | 'resolved' | string;
  mitigation_predicate: string;
  effect_label: string;
  expected_delta: number;
  created_at?: string;
  resolved_at?: string;
};

export type CreateMitigationResult = {
  ok: boolean;
  intervention_id?: string;
  work_order_id?: string;
  target_system?: string;
  status?: string;
  expected_delta?: number;
  action_label?: string;
  action_key?: string;
  mitigation_predicate?: string;
  error?: string;
};

export async function createMitigation(product_name: string): Promise<CreateMitigationResult> {
  try {
    const r = await fetch('/api/mitigations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_name }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function advanceMitigation(intervention_id: string): Promise<{ ok: boolean; status?: string; error?: string }> {
  try {
    const r = await fetch('/api/mitigation-advance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervention_id }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchMitigations(): Promise<Mitigation[]> {
  try {
    const r = await fetch('/api/mitigations');
    const d = await r.json();
    return Array.isArray(d?.mitigations) ? d.mitigations : [];
  } catch {
    return [];
  }
}

export async function resetMitigations(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch('/api/mitigations-reset', { method: 'POST' });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const MITIGATION_STEPS = ['submitted', 'acknowledged', 'in_progress', 'resolved'] as const;
export const STEP_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  resolved: 'Resolved',
};
