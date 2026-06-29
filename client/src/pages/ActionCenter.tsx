// Action Center — a prescriptive "action" layer over the selected product.
//  • Exceptions (live products): real rows from the `opportunities` query mapped
//    to a queue, bucketed HIGH/MEDIUM by opportunity_usd, enriched with LLM
//    root-cause / recommended-action / confidence (deterministic fallback if LLM down).
//  • Scenario signals (hybrid): a small form → LLM-prioritized, clearly-labeled actions.
//  • Lifecycle (in-session only): Approve / Modify / Reject + a SIMULATED trail.
import { useEffect, useMemo, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
  Button,
  Input,
  Textarea,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { CheckCircle2, XCircle, Pencil, Zap, AlertTriangle, Info } from 'lucide-react';
import { useProduct } from '../lib/product';
import { useActions, buildExceptionActions, mergeLlmActions, simulatedTrail, type ActionItem, type OpportunityRow } from '../lib/actions';
import { componentsSummary } from '../lib/summary';

export function ActionCenter() {
  const { selectedProduct, components } = useProduct();
  const { queue, setQueue, addAction } = useActions();
  const live = components.live;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Action Center</h2>
        <p className="text-muted-foreground">
          Prescriptive actions for {selectedProduct.display_name} — exceptions from the live serving
          layer and scenario-driven signals. Approvals are simulated in-session (no external writes).
        </p>
      </div>

      <QueueSummary queue={queue} />

      {live ? (
        <ExceptionsPanel onSeed={setQueue} queue={queue} />
      ) : (
        <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm">
          <Info className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">
            This product is schema-derived (no live serving layer), so there are no live exceptions.
            Use the scenario signals below to generate a prioritized action plan.
          </span>
        </div>
      )}

      <ScenarioPanel onActions={(items) => items.forEach(addAction)} />

      <QueueList queue={queue} setQueue={setQueue} />
    </div>
  );
}

function QueueSummary({ queue }: { queue: ActionItem[] }) {
  const approved = queue.filter((q) => q.status === 'approved').length;
  const modified = queue.filter((q) => q.status === 'modified').length;
  const rejected = queue.filter((q) => q.status === 'rejected').length;
  const pending = queue.filter((q) => q.status === 'pending').length;
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      <Badge variant="secondary">{queue.length} in queue</Badge>
      <Badge variant="default">{approved} approved</Badge>
      <Badge variant="outline">{modified} modified</Badge>
      <Badge variant="outline">{rejected} rejected</Badge>
      <Badge variant="outline">{pending} pending</Badge>
    </div>
  );
}

// Exceptions: load opportunities (no filters), build deterministic actions, enrich via LLM.
function ExceptionsPanel({
  onSeed,
  queue,
}: {
  onSeed: React.Dispatch<React.SetStateAction<ActionItem[]>>;
  queue: ActionItem[];
}) {
  const { selectedProduct, components } = useProduct();
  const params = useMemo(
    () => ({ regions: sql.string(''), states: sql.string(''), stores: sql.string('') }),
    []
  );
  const opp = useAnalyticsQuery('opportunities', params);
  const [enriching, setEnriching] = useState(false);
  const [llmNote, setLlmNote] = useState<string | null>(null);
  const seeded = useMemo(() => queue.some((q) => q.source === 'exception'), [queue]);

  useEffect(() => {
    if (!opp.data || seeded) return;
    const rows = opp.data as unknown as OpportunityRow[];
    const base = buildExceptionActions(rows);
    if (base.length === 0) return;
    // seed deterministic actions immediately (works even if LLM is down)
    onSeed((prev) => [...base, ...prev.filter((p) => p.source !== 'exception')]);
    // then enrich with the LLM (best-effort)
    setEnriching(true);
    fetch('/api/recommend-actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'exceptions',
        product: selectedProduct.product_name,
        componentsSummary: componentsSummary(components),
        opportunities: rows.slice(0, 25),
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d?.llm && Array.isArray(d.actions) && d.actions.length) {
          onSeed((prev) => {
            const merged = mergeLlmActions(
              prev.filter((p) => p.source === 'exception'),
              d.actions
            );
            const others = prev.filter((p) => p.source !== 'exception');
            return [...merged, ...others];
          });
          setLlmNote('LLM-enriched root cause + recommended action');
        } else {
          setLlmNote('Heuristic actions (LLM unavailable — showing deterministic fallback)');
        }
      })
      .catch(() => setLlmNote('Heuristic actions (LLM unavailable — showing deterministic fallback)'))
      .finally(() => setEnriching(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opp.data, seeded]);

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> Exceptions
          {enriching && <Badge variant="outline">enriching…</Badge>}
        </CardTitle>
        <CardDescription>
          Stores over their peer labor benchmark (jai_store_efficiency_opportunities)
          {llmNote ? ` · ${llmNote}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {opp.loading && <Skeleton className="h-20 w-full" />}
        {opp.error && (
          <div className="text-destructive bg-destructive/10 p-3 rounded-md text-sm">{opp.error}</div>
        )}
        {opp.data && (
          <p className="text-sm text-muted-foreground">
            {(opp.data as unknown as OpportunityRow[]).filter((r) =>
              (r.opportunity_flag ?? '').includes('over_cost')
            ).length}{' '}
            exception(s) loaded into the queue below.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const SCENARIO_FIELDS = [
  { key: 'weather', label: 'Weather / temperature', placeholder: 'e.g. 95°F heat wave' },
  { key: 'holiday', label: 'Holiday', placeholder: 'e.g. July 4th' },
  { key: 'promotion', label: 'Promotion', placeholder: 'e.g. fountain drink BOGO' },
] as const;

function ScenarioPanel({ onActions }: { onActions: (items: ActionItem[]) => void }) {
  const { selectedProduct, components } = useProduct();
  const [signals, setSignals] = useState<Record<string, string>>({});
  const [dayType, setDayType] = useState('weekday');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const resp = await fetch('/api/recommend-actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'scenario',
          product: selectedProduct.product_name,
          componentsSummary: componentsSummary(components),
          signals: { ...signals, day_type: dayType },
        }),
      });
      const d = await resp.json();
      if (d?.llm && Array.isArray(d.actions) && d.actions.length) {
        const items: ActionItem[] = d.actions.map((a: Record<string, unknown>, i: number) => ({
          id: `scn-${Date.now()}-${i}`,
          source: 'scenario',
          priority: (['HIGH', 'MEDIUM', 'LOW'].includes(String(a.priority)) ? a.priority : 'MEDIUM') as ActionItem['priority'],
          issue: String(a.issue ?? 'Scenario action'),
          root_cause: String(a.root_cause ?? ''),
          recommended_action: String(a.recommended_action ?? ''),
          confidence: typeof a.confidence === 'number' ? a.confidence : 0.5,
          status: 'pending',
        }));
        onActions(items);
        setNote(`Added ${items.length} scenario-driven action(s)`);
      } else {
        setNote(d?.reason === 'no serving endpoint configured'
          ? 'Scenario actions need the Foundation Model endpoint (not configured here).'
          : 'No scenario actions returned.');
      }
    } catch (err) {
      setNote(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-violet-500" /> Scenario signals
          <Badge variant="secondary">Scenario-driven</Badge>
        </CardTitle>
        <CardDescription>
          Enter operating signals → a prioritized action plan grounded in this product's measures.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {SCENARIO_FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs">{f.label}</Label>
              <Input
                placeholder={f.placeholder}
                value={signals[f.key] ?? ''}
                onChange={(e) => setSignals((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            </div>
          ))}
          <div className="space-y-1">
            <Label className="text-xs">Day type</Label>
            <Select value={dayType} onValueChange={setDayType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weekday">Weekday</SelectItem>
                <SelectItem value="weekend">Weekend</SelectItem>
                <SelectItem value="holiday">Holiday</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button size="sm" className="gap-1.5" onClick={run} disabled={busy}>
          <Zap className="h-4 w-4" /> {busy ? 'Generating…' : 'Generate scenario actions'}
        </Button>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  );
}

function QueueList({
  queue,
  setQueue,
}: {
  queue: ActionItem[];
  setQueue: React.Dispatch<React.SetStateAction<ActionItem[]>>;
}) {
  if (queue.length === 0) {
    return (
      <Card className="shadow-sm">
        <CardContent className="py-6 text-sm text-muted-foreground">
          No actions in the queue yet. Live exceptions seed automatically (flagship); scenario signals
          and the Copilot add more.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {queue.map((a) => (
        <ActionCard key={a.id} action={a} setQueue={setQueue} />
      ))}
    </div>
  );
}

function priorityVariant(p: string): 'default' | 'secondary' | 'outline' {
  if (p === 'HIGH') return 'default';
  if (p === 'MEDIUM') return 'secondary';
  return 'outline';
}

function ActionCard({
  action,
  setQueue,
}: {
  action: ActionItem;
  setQueue: React.Dispatch<React.SetStateAction<ActionItem[]>>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(action.recommended_action);

  const update = (patch: Partial<ActionItem>) =>
    setQueue((prev) => prev.map((q) => (q.id === action.id ? { ...q, ...patch } : q)));

  const approve = () => update({ status: 'approved', trail: simulatedTrail(action) });
  const reject = () => update({ status: 'rejected', trail: undefined });
  const saveEdit = () => {
    update({ status: 'modified', recommended_action: draft });
    setEditing(false);
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Badge variant={priorityVariant(action.priority)}>{action.priority}</Badge>
            {action.source === 'scenario' && <Badge variant="secondary">Scenario</Badge>}
            {action.source === 'copilot' && <Badge variant="secondary">Copilot</Badge>}
            <span>{action.issue}</span>
          </CardTitle>
          <StatusBadge status={action.status} />
        </div>
        <CardDescription>
          confidence {Math.round((action.confidence ?? 0) * 100)}%
          {action.opportunity_usd ? ` · opportunity $${Math.round(action.opportunity_usd).toLocaleString()}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div>
          <span className="font-semibold text-foreground">Root cause: </span>
          <span className="text-muted-foreground">{action.root_cause}</span>
        </div>
        <div>
          <span className="font-semibold text-foreground">Recommended action: </span>
          {editing ? (
            <div className="mt-1 space-y-2">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} />
              <div className="flex gap-2">
                <Button size="sm" onClick={saveEdit}>
                  Save
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <span className="text-muted-foreground">{action.recommended_action}</span>
          )}
        </div>

        {action.trail && action.status === 'approved' && (
          <div className="rounded-md bg-success/10 border border-success/30 p-2 text-xs space-y-0.5">
            {action.trail.map((t, i) => (
              <div key={i} className="text-success-foreground/90">
                {t}
              </div>
            ))}
            <div className="text-muted-foreground italic">(simulated — no external writes)</div>
          </div>
        )}

        {!editing && action.status !== 'approved' && (
          <div className="flex gap-2 pt-1">
            <Button size="sm" className="gap-1.5" onClick={approve}>
              <CheckCircle2 className="h-4 w-4" /> Approve
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Modify
            </Button>
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={reject}>
              <XCircle className="h-4 w-4" /> Reject
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: ActionItem['status'] }) {
  if (status === 'approved')
    return (
      <Badge variant="default" className="gap-1">
        <CheckCircle2 className="h-3 w-3" /> approved
      </Badge>
    );
  if (status === 'modified')
    return (
      <Badge variant="secondary" className="gap-1">
        <Pencil className="h-3 w-3" /> modified
      </Badge>
    );
  if (status === 'rejected')
    return (
      <Badge variant="outline" className="gap-1 text-destructive border-destructive/40">
        <XCircle className="h-3 w-3" /> rejected
      </Badge>
    );
  return <Badge variant="outline">pending</Badge>;
}
