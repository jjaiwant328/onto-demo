// Action layer — types, a deterministic fallback action-builder (from opportunities
// rows), and an in-session action queue (React context). NO external writes:
// approve/modify/reject only mutate session state and render a SIMULATED trail.
import { createContext, useContext } from 'react';

export type ActionStatus = 'pending' | 'approved' | 'modified' | 'rejected';
export type ActionPriority = 'HIGH' | 'MEDIUM' | 'LOW';
export type ActionSource = 'exception' | 'scenario' | 'copilot';

export type ActionItem = {
  id: string;
  source: ActionSource;
  priority: ActionPriority;
  issue: string;
  root_cause: string;
  recommended_action: string;
  confidence: number; // 0..1
  store?: number | string;
  opportunity_usd?: number;
  lcpc_gap?: number;
  status: ActionStatus;
  // provenance of the RECOMMENDATION (root cause + recommended action):
  //   true  → LLM-generated guidance
  //   false → deterministic/heuristic (no model)
  // The issue, priority and $ opportunity are always data-derived.
  llm?: boolean;
  // simulated execution trail shown after approval
  trail?: string[];
};

// Row shape from the `opportunities` analytics query (subset we use).
export type OpportunityRow = {
  opportunity_rank?: number;
  store_number?: number;
  store_name?: string;
  region_name?: string;
  labor_cost_per_customer?: number;
  benchmark_lcpc?: number;
  lcpc_gap?: number;
  opportunity_usd?: number;
  opportunity_flag?: string;
};

function priorityForUsd(usd: number): ActionPriority {
  if (usd >= 8000) return 'HIGH';
  if (usd >= 3000) return 'MEDIUM';
  return 'LOW';
}

// The analytics plugin returns DECIMAL/BIGINT columns as STRINGS at runtime, so
// coerce defensively before any arithmetic / toFixed.
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

// Deterministic exceptions from opportunities rows (the LLM-down fallback, and the
// base set the LLM enriches). Maps `over_cost_vs_peers` rows to queue items.
export function buildExceptionActions(rows: OpportunityRow[]): ActionItem[] {
  return rows
    .filter((r) => String(r.opportunity_flag ?? '').toLowerCase().includes('over_cost'))
    .map((r) => {
      const usd = Math.max(0, num(r.opportunity_usd));
      const lcpc = num(r.labor_cost_per_customer);
      const bench = num(r.benchmark_lcpc);
      const pctOver = bench > 0 ? Math.round(((lcpc - bench) / bench) * 100) : 0;
      const store = r.store_number ?? '?';
      return {
        id: `exc-${store}`,
        source: 'exception' as const,
        priority: priorityForUsd(usd),
        issue: `Store ${store}${r.store_name ? ` (${r.store_name})` : ''} labor $/customer ${pctOver}% over peer benchmark`,
        root_cause: 'Labor hours not scaled to customer traffic for this store-day grain (heuristic).',
        recommended_action: `Right-size scheduled labor toward the ${bench > 0 ? `$${bench.toFixed(3)}` : 'peer'} benchmark; review staffing on low-traffic dayparts.`,
        confidence: 0.6,
        store,
        opportunity_usd: usd,
        lcpc_gap: num(r.lcpc_gap),
        llm: false, // heuristic base; flipped to true once the LLM enriches it
        status: 'pending' as const,
      };
    })
    .sort((a, b) => (b.opportunity_usd ?? 0) - (a.opportunity_usd ?? 0));
}

// Merge LLM enrichment (root_cause/recommended_action/confidence/priority) onto the
// deterministic base by store id; keep deterministic items the model didn't return.
export function mergeLlmActions(base: ActionItem[], llm: Partial<ActionItem>[]): ActionItem[] {
  const byStore = new Map<string, Partial<ActionItem>>();
  for (const a of llm) if (a.store != null) byStore.set(String(a.store), a);
  return base.map((b) => {
    const e = byStore.get(String(b.store));
    if (!e) return b;
    return {
      ...b,
      llm: true, // this item's root cause / recommended action came from the model
      priority: (e.priority as ActionPriority) ?? b.priority,
      issue: e.issue ?? b.issue,
      root_cause: e.root_cause ?? b.root_cause,
      recommended_action: e.recommended_action ?? b.recommended_action,
      confidence: typeof e.confidence === 'number' ? e.confidence : b.confidence,
    };
  });
}

// Simulated, in-session execution trail (no external writes).
export function simulatedTrail(a: ActionItem): string[] {
  if (a.source === 'scenario') {
    return ['✓ staffing plan adjusted for scenario', '✓ ops dashboard flag set', '✓ notification queued (simulated)'];
  }
  if (a.source === 'copilot') {
    return ['✓ action recorded', '✓ owner notified (simulated)'];
  }
  // exception / data-backed. Store-specific for the retail flagship; generic for
  // aggregate (store-less) exceptions so we never render "store undefined".
  const hasStore = a.store != null && a.store !== '?' && a.store !== '';
  if (hasStore) {
    return [`✓ labor target updated for store ${a.store}`, `✓ store ${a.store} notified`, '✓ tracking ticket opened (simulated)'];
  }
  return [
    '✓ recommendation approved and routed to the data owner',
    '✓ tracking ticket opened (simulated)',
    '✓ decision logged to the action log',
  ];
}

// ---- in-session queue context (Copilot can push into it too) ----
export type ActionsContextValue = {
  queue: ActionItem[];
  setQueue: React.Dispatch<React.SetStateAction<ActionItem[]>>;
  addAction: (a: ActionItem) => void;
};

export const ActionsContext = createContext<ActionsContextValue | null>(null);

export function useActions(): ActionsContextValue {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('useActions must be used within ActionsProvider');
  return ctx;
}
