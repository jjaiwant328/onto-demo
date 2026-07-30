// Mitigation panel — the closed-loop workflow for one flagged area. Shows the issue,
// the recommended play + its (simulated) system of record, and the projected KPI
// improvement; on dispatch it opens a work order and advances a status timeline; on
// Resolved the exception aggregates net it out so the Home number drops. It also
// reveals the outbound connector payload (the real-integration seam).
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
} from '@databricks/appkit-ui/react';
import { Loader2, ArrowRight, CheckCircle2, Send, Wrench, Plug, ChevronDown } from 'lucide-react';
import {
  createMitigation,
  advanceMitigation,
  MITIGATION_STEPS,
  STEP_LABEL,
  type CreateMitigationResult,
} from '../lib/mitigation';
import type { InboxItem } from '../lib/controlTower';

function humanize(k: string): string {
  return (k || '').replace(/_/g, ' ');
}

export function MitigationPanel({
  item,
  open,
  onOpenChange,
  onResolved,
}: {
  item: InboxItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onResolved?: () => void;
}) {
  const [wo, setWo] = useState<CreateMitigationResult | null>(null);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [showConnector, setShowConnector] = useState(false);

  const before = item.headline_value;
  const slice = item.critical_value ?? 0;
  const after = Math.max(0, before - slice);
  const stepIdx = MITIGATION_STEPS.indexOf(status as (typeof MITIGATION_STEPS)[number]);
  const resolved = status === 'resolved';

  const dispatch = async () => {
    setBusy(true);
    const r = await createMitigation(item.product_name);
    setBusy(false);
    if (r.ok) {
      setWo(r);
      setStatus(r.status ?? 'submitted');
    }
  };

  const advance = async () => {
    if (!wo?.intervention_id) return;
    setBusy(true);
    const r = await advanceMitigation(wo.intervention_id);
    setBusy(false);
    if (r.ok && r.status) {
      setStatus(r.status);
      if (r.status === 'resolved') onResolved?.();
    }
  };

  const reset = () => {
    setWo(null);
    setStatus('');
    setShowConnector(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Wrench className="h-4 w-4 text-primary" /> Mitigate — {item.product_display}</DialogTitle>
          <DialogDescription>{item.issue}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* recommended play + target system */}
          <div className="rounded-md border p-3 space-y-1">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Recommended play</div>
            <div>{wo?.action_label ?? item.recommended_action}</div>
            <div className="text-xs text-muted-foreground">
              Routes to <span className="font-medium">{wo?.target_system ?? 'the system of record'}</span> (simulated).
            </div>
          </div>

          {/* projected effect */}
          <div className="flex items-center gap-3 rounded-md bg-muted/40 p-3">
            <div>
              <div className="text-xs text-muted-foreground">Now</div>
              <div className="text-2xl font-bold text-destructive">{before.toLocaleString()}</div>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-xs text-muted-foreground">After mitigation</div>
              <div className="text-2xl font-bold text-emerald-600">{after.toLocaleString()}</div>
            </div>
            <div className="ml-auto text-right text-xs text-muted-foreground">
              ≈{slice.toLocaleString()} {humanize(item.headline_metric)}<br />protected
            </div>
          </div>

          {/* dispatch / timeline */}
          {!wo ? (
            <Button className="w-full gap-1.5" disabled={busy} onClick={dispatch}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Approve &amp; dispatch
            </Button>
          ) : (
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground">
                Work order <code>{wo.work_order_id}</code> dispatched to {wo.target_system}.
              </div>
              {/* status timeline */}
              <div className="flex items-center gap-1">
                {MITIGATION_STEPS.map((s, i) => (
                  <div key={s} className="flex items-center gap-1 flex-1 last:flex-none">
                    <div className={`flex items-center gap-1 text-[11px] ${i <= stepIdx ? 'text-emerald-600 font-medium' : 'text-muted-foreground'}`}>
                      {i < stepIdx || resolved ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className={`h-2 w-2 rounded-full ${i === stepIdx ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />}
                      {STEP_LABEL[s]}
                    </div>
                    {i < MITIGATION_STEPS.length - 1 && <div className={`h-px flex-1 ${i < stepIdx ? 'bg-emerald-500' : 'bg-border'}`} />}
                  </div>
                ))}
              </div>
              {resolved ? (
                <div className="rounded-md bg-emerald-50 border border-emerald-200 p-2 text-xs text-emerald-700">
                  ✓ Resolved — {(wo.expected_delta ?? slice).toLocaleString()} {humanize(item.headline_metric)} protected. The Control Tower now reflects the drop.
                </div>
              ) : (
                <Button variant="outline" className="w-full gap-1.5" disabled={busy} onClick={advance}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} Advance work order
                </Button>
              )}
            </div>
          )}

          {/* The real integration seam */}
          <div className="rounded-md border border-dashed p-2">
            <button className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" onClick={() => setShowConnector((v) => !v)}>
              <Plug className="h-3.5 w-3.5" /> Connector <ChevronDown className={`h-3 w-3 transition-transform ${showConnector ? 'rotate-180' : ''}`} />
            </button>
            {showConnector && (
              <div className="mt-2 space-y-1.5">
                <pre className="text-[11px] bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(
                  {
                    system_of_record: wo?.target_system ?? 'ERP',
                    action: wo?.action_key ?? item.product_name,
                    work_order_id: wo?.work_order_id ?? 'WO-####',
                    product: item.product_name,
                    cleared_slice: wo?.mitigation_predicate ?? '(mitigation predicate)',
                  },
                  null,
                  2
                )}</pre>
                <p className="text-[11px] text-muted-foreground">
                  Demo stub. In production this POSTs to your ERP / CMMS API or emits a reverse-ETL / Workflows
                  event; the effect is modelled in the lakehouse via <code>jai_intervention_log</code>, which the
                  exception aggregates net out (<code>AND NOT (predicate)</code>).
                </p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
