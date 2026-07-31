// Data Product Drafts — the STAGING area for use cases described as data products
// (from the Domain Analysis "Describe" action). Each draft shows its proposed
// KPIs, tables, Genie spaces, and metric views. Drafts stay here until marked
// "completed", at which point they also surface in the Data Products view. Kept
// deliberately separate so in-progress drafts never pollute the real catalog.
import { useState } from 'react';
import type React from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
  Button,
} from '@databricks/appkit-ui/react';
import { Package, Check, Undo2, Trash2, Sparkles, Database, MessageSquare, Gauge } from 'lucide-react';
import { useProduct } from '../lib/product';
import { parseSpec } from '../lib/useCaseProduct';

export function DataProductDrafts() {
  const { useCaseDrafts, setUseCaseDraftStatus, removeUseCaseDraft, domainAnalysisLabel } = useProduct();
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggle = async (draftId: string, completed: boolean) => {
    setBusyId(draftId);
    await setUseCaseDraftStatus(draftId, completed ? 'completed' : 'draft');
    setBusyId(null);
  };
  const remove = async (draftId: string) => {
    setBusyId(draftId);
    await removeUseCaseDraft(draftId);
    setBusyId(null);
  };

  return (
    <div className="space-y-4">
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-primary" /> Data Product Drafts — {domainAnalysisLabel}
          </CardTitle>
          <CardDescription>
            Use cases described as data products (KPIs, tables, proposed Genie spaces, and metric
            views). Drafts stay here until you mark them <span className="font-medium">completed</span>{' '}
            — completed drafts also appear in the Data Products view.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {useCaseDrafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No drafts yet. In <span className="font-medium">Domain Analysis</span>, click{' '}
              <span className="font-medium">Describe</span> on a use case to draft it as a data product.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {useCaseDrafts.filter((d) => d.status === 'completed').length} completed ·{' '}
              {useCaseDrafts.filter((d) => d.status !== 'completed').length} in draft
            </p>
          )}
        </CardContent>
      </Card>

      {useCaseDrafts.map((d) => {
        const spec = parseSpec(d);
        const completed = d.status === 'completed';
        return (
          <Card key={d.draft_id} className={`shadow-sm ${completed ? 'border-emerald-300' : ''}`}>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  {d.use_case_title}
                  <Badge variant={completed ? 'default' : 'outline'} className="text-[10px]">
                    {completed ? 'completed' : 'draft'}
                  </Badge>
                  {!d.llm_used && (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      heuristic
                    </Badge>
                  )}
                </CardTitle>
                {spec?.summary && <CardDescription>{spec.summary}</CardDescription>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="sm"
                  variant={completed ? 'outline' : 'default'}
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={busyId === d.draft_id}
                  onClick={() => void toggle(d.draft_id, !completed)}
                >
                  {completed ? <Undo2 className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                  {completed ? 'Revert to draft' : 'Mark completed'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  title="Delete draft"
                  disabled={busyId === d.draft_id}
                  onClick={() => void remove(d.draft_id)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </CardHeader>
            {spec && (
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Section icon={<Gauge className="h-3.5 w-3.5" />} title={`KPIs (${spec.kpis.length})`}>
                  {spec.kpis.length === 0 ? (
                    <Empty />
                  ) : (
                    <ul className="space-y-1">
                      {spec.kpis.map((k, i) => (
                        <li key={`${k.name}-${i}`} className="text-xs">
                          <span className="font-medium">{k.name}</span>
                          {k.definition && <span className="text-muted-foreground"> — {k.definition}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section icon={<Database className="h-3.5 w-3.5" />} title={`Tables (${spec.tables.length})`}>
                  {spec.tables.length === 0 ? (
                    <Empty />
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {spec.tables.map((t, i) => (
                        <Badge key={`${t}-${i}`} variant="secondary" className="text-[10px] font-normal">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </Section>
                <Section
                  icon={<MessageSquare className="h-3.5 w-3.5" />}
                  title={`Genie spaces (${spec.genie_spaces.length})`}
                >
                  {spec.genie_spaces.length === 0 ? (
                    <Empty />
                  ) : (
                    <ul className="space-y-1">
                      {spec.genie_spaces.map((g, i) => (
                        <li key={`${g.name}-${i}`} className="text-xs">
                          <span className="font-mono">{g.name}</span>
                          {g.purpose && <span className="text-muted-foreground"> — {g.purpose}</span>}{' '}
                          <span className="text-[10px] text-muted-foreground">(proposed)</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                  title={`Metric views (${spec.metric_views.length})`}
                >
                  {spec.metric_views.length === 0 ? (
                    <Empty />
                  ) : (
                    <ul className="space-y-1.5">
                      {spec.metric_views.map((m, i) => (
                        <li key={`${m.name}-${i}`} className="text-xs">
                          <div className="font-mono">
                            {m.name} <span className="text-[10px] text-muted-foreground">(proposed)</span>
                          </div>
                          <div className="text-muted-foreground">
                            dims: {(m.dimensions ?? []).join(', ') || '—'} · measures:{' '}
                            {(m.measures ?? []).join(', ') || '—'}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="text-xs text-muted-foreground">None proposed.</p>;
}
