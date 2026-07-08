// Control Tower Home — the decision-first landing for a supply-chain domain expert.
// One screen: a network-health score + a card per data-backed product answering
// "what needs my attention today?", each drilling into the Action Center. Plain
// language; no ontology jargon. Reads /api/control-tower-summary (live aggregates).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Skeleton,
} from '@databricks/appkit-ui/react';
import { AlertTriangle, CheckCircle2, ArrowRight, Activity, RefreshCw, ShieldAlert } from 'lucide-react';
import { useProduct } from '../lib/product';
import { fetchControlTowerSummary, refreshControlTower, humanizeMetric, type ControlTowerCard, type ControlTowerSummary } from '../lib/controlTower';
import { AskControlTower } from '../components/AskControlTower';

const SEV = {
  high: { label: 'Needs action', dot: 'bg-destructive', text: 'text-destructive', ring: 'border-destructive/40' },
  medium: { label: 'Watch', dot: 'bg-amber-500', text: 'text-amber-600', ring: 'border-amber-300' },
  ok: { label: 'Healthy', dot: 'bg-emerald-500', text: 'text-emerald-600', ring: 'border-border' },
  unknown: { label: 'No data', dot: 'bg-muted-foreground', text: 'text-muted-foreground', ring: 'border-border' },
} as const;

function fmt(n: number): string {
  return (Number(n) || 0).toLocaleString();
}

export function ControlTowerHome() {
  const navigate = useNavigate();
  const { setSelectedProduct, showActionCenter, setShowActionCenter } = useProduct();
  const [data, setData] = useState<ControlTowerSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    setLoading(true);
    void fetchControlTowerSummary().then((d) => {
      setData(d);
      setLoading(false);
    });
  };
  useEffect(load, []);

  // Refresh RECOMPUTES the pre-aggregated snapshot (the one place that scans the
  // facts), then re-reads it — mirroring what the scheduled job does in production.
  const refresh = () => {
    setRefreshing(true);
    void refreshControlTower().then(() => {
      void fetchControlTowerSummary().then((d) => {
        setData(d);
        setRefreshing(false);
      });
    });
  };

  const openProduct = (c: ControlTowerCard) => {
    setSelectedProduct(c.product_name);
    if (!showActionCenter) setShowActionCenter(true);
    navigate('/action-center');
  };

  // group cards by ontology layer (domain) for a scannable layout
  const byDomain = new Map<string, ControlTowerCard[]>();
  for (const c of data?.products ?? []) {
    const k = c.domain_label || c.domain;
    (byDomain.get(k) ?? byDomain.set(k, []).get(k)!).push(c);
  }
  const score = data?.health_score ?? 0;
  const scoreColor = score >= 80 ? 'text-emerald-600' : score >= 60 ? 'text-amber-600' : 'text-destructive';

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Control Tower</h2>
          <p className="text-muted-foreground">
            What needs attention today across the QSR supply chain.
            {data?.computed_at && <span className="text-xs"> · updated {data.computed_at}</span>}
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={refresh} disabled={loading || refreshing}>
          <RefreshCw className={`h-4 w-4 ${loading || refreshing ? 'animate-spin' : ''}`} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {/* headline row: network health + issue count */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <Activity className="h-4 w-4" /> Network health
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-10 w-24" />
            ) : (
              <>
                <div className={`text-4xl font-bold ${scoreColor}`}>{score}<span className="text-lg text-muted-foreground">/100</span></div>
                <div className="mt-2 h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div className={`h-full ${score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-amber-500' : 'bg-destructive'}`} style={{ width: `${score}%` }} />
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <ShieldAlert className="h-4 w-4" /> Areas needing action
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-10 w-16" /> : <div className="text-4xl font-bold text-foreground">{data?.high ?? 0}</div>}
            <div className="text-xs text-muted-foreground mt-1">{data?.medium ?? 0} more to watch</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" /> Areas monitored
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-10 w-16" /> : <div className="text-4xl font-bold text-foreground">{data?.products.length ?? 0}</div>}
            <div className="text-xs text-muted-foreground mt-1">supply-chain areas</div>
          </CardContent>
        </Card>
      </div>

      <AskControlTower />

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
        </div>
      ) : (
        Array.from(byDomain.entries()).map(([domainLabel, cards]) => (
          <div key={domainLabel} className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{domainLabel}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {cards.map((c) => {
                const sev = SEV[c.severity] ?? SEV.unknown;
                return (
                  <Card key={c.product_name} className={`shadow-sm border ${sev.ring} hover:shadow-md transition-shadow cursor-pointer`} onClick={() => openProduct(c)}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between gap-2">
                        <CardTitle className="text-base">{c.display_name}</CardTitle>
                        <span className="flex items-center gap-1.5 text-xs">
                          <span className={`h-2 w-2 rounded-full ${sev.dot}`} />
                          <span className={sev.text}>{sev.label}</span>
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {c.error ? (
                        <div className="text-xs text-muted-foreground">Couldn't load — {c.error}</div>
                      ) : (
                        <>
                          <div className="flex items-baseline gap-2">
                            <span className={`text-3xl font-bold ${c.headline_value > 0 ? sev.text : 'text-foreground'}`}>{fmt(c.headline_value)}</span>
                            <span className="text-sm text-muted-foreground">{humanizeMetric(c.headline_metric)}</span>
                          </div>
                          {c.critical_metric && (c.critical_value ?? 0) > 0 && (
                            <div className="flex items-center gap-1 text-xs text-destructive">
                              <AlertTriangle className="h-3 w-3" /> {fmt(c.critical_value ?? 0)} {humanizeMetric(c.critical_metric)}
                            </div>
                          )}
                          <p className="text-xs text-muted-foreground line-clamp-2">{c.business_outcome}</p>
                        </>
                      )}
                      <div className="pt-1">
                        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs px-0 text-primary" onClick={(e) => { e.stopPropagation(); openProduct(c); }}>
                          Review &amp; act <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        ))
      )}

      {!loading && (data?.products.length ?? 0) === 0 && (
        <Card className="shadow-sm">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No supply-chain data available. The Control Tower reads the QSR <code>jai_ontos.qsr_sc</code> products.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
