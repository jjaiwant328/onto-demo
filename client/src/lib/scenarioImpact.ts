// Client helpers for the Scenario & Impact Explorer — what-if scenarios (from the
// injected jai_scenario catalog) and blast-radius impact traces over the spine.

export type Scenario = {
  scenario_id: string;
  scenario_type: string;
  scope_kind?: string;
  scope_value?: string;
  start_date?: string;
  end_date?: string;
  effect?: string;
  magnitude?: number | string;
  description?: string;
};

export type PlaybookEntry = { root_cause: string; recommended_action: string; source: 'db' | 'guidance' };

export type ScenarioImpact = {
  scenario: Scenario;
  impact_label: string;
  impact: Record<string, unknown>;
  product: { product_name: string; display_name: string } | null;
  playbook: PlaybookEntry[];
  rule: { id: string; name: string; if_conditions: string[]; then_conclusion: string } | null;
  error?: string;
};

export type ImpactEntity = { id: string; name: string };
export type ImpactRow = { name: string; restaurants: number; at_risk_positions: number };
export type ImpactTrace = { rows: ImpactRow[]; total_restaurants: number; total_positions: number; error?: string };

export async function fetchScenarios(): Promise<Scenario[]> {
  try {
    const r = await fetch('/api/scenarios');
    const d = await r.json();
    return Array.isArray(d?.scenarios) ? d.scenarios : [];
  } catch {
    return [];
  }
}

export async function fetchScenarioImpact(scenario_id: string): Promise<ScenarioImpact | null> {
  try {
    const r = await fetch('/api/scenario-impact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario_id }),
    });
    return await r.json();
  } catch (e) {
    return { scenario: { scenario_id, scenario_type: '' }, impact_label: '', impact: {}, product: null, playbook: [], rule: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchImpactEntities(type: 'supplier' | 'dc' | 'ingredient'): Promise<ImpactEntity[]> {
  try {
    const r = await fetch(`/api/impact-entities?type=${type}`);
    const d = await r.json();
    return Array.isArray(d?.entities) ? d.entities : [];
  } catch {
    return [];
  }
}

export async function fetchImpactTrace(entity_type: string, id: string): Promise<ImpactTrace> {
  try {
    const r = await fetch('/api/impact-trace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entity_type, id }),
    });
    return await r.json();
  } catch (e) {
    return { rows: [], total_restaurants: 0, total_positions: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
