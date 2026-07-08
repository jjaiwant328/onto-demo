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
};

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
    };
  } catch {
    return { products: [], health_score: 0, issues_total: 0, high: 0, medium: 0 };
  }
}

// humanize a metric key (at_risk_items → "at risk items") for plain-language labels
export function humanizeMetric(key: string): string {
  return (key || '').replace(/_/g, ' ').replace(/\bpct\b/, '%').trim();
}
