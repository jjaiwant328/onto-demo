// Client helpers for the domain business/reasoning rules store (jai_business_rules).
// Rules are seeded from QSR_SC_REASONING_RULES then user-editable; they can be
// evaluated against the backing table for a live match count. Mirrors ontologyOverrides.ts.

export type BusinessRule = {
  rule_id: string;
  domain: string;
  name: string;
  if_conditions: string[];
  then_conclusion: string;
  concepts: string[];
  evidence?: string;
  eval_sql?: string;
  eval_table?: string;
  enabled?: boolean;
  origin?: 'seed' | 'user' | string;
};

// server stores JSON-encoded arrays; normalize to arrays for the UI
function parseArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [v];
    } catch {
      return [v];
    }
  }
  return [];
}

export async function fetchBusinessRules(domain: string): Promise<BusinessRule[]> {
  try {
    const r = await fetch(`/api/business-rules?domain=${encodeURIComponent(domain)}`);
    const d = await r.json();
    const rows = Array.isArray(d?.rules) ? d.rules : [];
    return rows.map((x: Record<string, unknown>) => ({
      rule_id: String(x.rule_id),
      domain: String(x.domain),
      name: String(x.name ?? ''),
      if_conditions: parseArr(x.if_conditions),
      then_conclusion: String(x.then_conclusion ?? ''),
      concepts: parseArr(x.concepts),
      evidence: x.evidence ? String(x.evidence) : undefined,
      eval_sql: x.eval_sql ? String(x.eval_sql) : undefined,
      eval_table: x.eval_table ? String(x.eval_table) : undefined,
      enabled: x.enabled !== false,
      origin: (x.origin as string) ?? 'user',
    }));
  } catch {
    return [];
  }
}

export async function saveBusinessRule(rule: Partial<BusinessRule> & { domain: string; name: string }): Promise<{ ok: boolean; rule_id?: string; error?: string }> {
  try {
    const r = await fetch('/api/business-rule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rule),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteBusinessRule(rule_id: string): Promise<boolean> {
  try {
    const r = await fetch('/api/delete-business-rule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule_id }),
    });
    return Boolean((await r.json())?.ok);
  } catch {
    return false;
  }
}

export async function evaluateBusinessRule(eval_table: string, eval_sql: string): Promise<{ ok: boolean; matches?: number; error?: string }> {
  try {
    const r = await fetch('/api/evaluate-business-rule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eval_table, eval_sql }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
