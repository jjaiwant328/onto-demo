// Unified Action Inbox — ONE prioritized worklist across all supply-chain products
// (instead of a per-product queue). Each item is a product-level aggregate action,
// ranked by severity then size, with inline Approve / Modify / Reject (logged to
// jai_action_log) and a drill into that product's Action Center. Business language.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  Textarea,
  Skeleton,
} from '@databricks/appkit-ui/react';
import { CheckCircle2, XCircle, Pencil, ArrowRight, AlertTriangle, RefreshCw, Inbox } from 'lucide-react';
import { useProduct } from '../lib/product';
import { fetchActionInbox, type InboxItem } from '../lib/controlTower';
import { logAction, type LogContext } from '../lib/actionLog';
import type { ActionItem } from '../lib/actions';

function priorityVariant(p: string): 'default' | 'secondary' | 'outline' {
  return p === 'HIGH' ? 'default' : p === 'MEDIUM' ? 'secondary' : 'outline';
}

export function ActionInbox() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'high' | 'medium'>('all');

  const load = () => {
    setLoading(true);
    void fetchActionInbox().then((d) => {
      setItems(d);
      setLoading(false);
    });
  };
  useEffect(load, []);

  const shown = useMemo(() => items.filter((i) => filter === 'all' || i.severity === filter), [items, filter]);
  const high = items.filter((i) => i.severity === 'high').length;

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Inbox className="h-6 w-6" /> Action Inbox
          </h2>
          <p className="text-muted-foreground">
            Everything that needs a decision today, most urgent first — across the whole supply chain.
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {(['all', 'high', 'medium'] as const).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setFilter(f)}>
            {f === 'all' ? `All (${items.length})` : f === 'high' ? `Needs action (${high})` : `Watch (${items.length - high})`}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 w-full" />)}</div>
      ) : shown.length === 0 ? (
        <Card className="shadow-sm">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-500" />
            Nothing needs action right now. The inbox aggregates each supply-chain area's exceptions.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((it) => <InboxCard key={it.id} item={it} />)}
        </div>
      )}
    </div>
  );
}

function InboxCard({ item }: { item: InboxItem }) {
  const navigate = useNavigate();
  const { setSelectedProduct, showActionCenter, setShowActionCenter } = useProduct();
  const [status, setStatus] = useState<'pending' | 'approved' | 'modified' | 'rejected'>('pending');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.recommended_action);
  const [note, setNote] = useState<string | null>(null);

  const ctx: LogContext = { schema_label: 'QSR Supply Chain', domain: item.domain_label, product: item.product_display };
  const asAction = (recommended?: string): ActionItem => ({
    id: item.id,
    source: 'exception',
    priority: item.priority,
    issue: item.issue,
    root_cause: item.root_cause,
    recommended_action: recommended ?? item.recommended_action,
    confidence: 0.6,
    llm: false,
    status: 'pending',
  });

  const decide = async (decision: 'approved' | 'modified' | 'rejected', recommended?: string) => {
    setStatus(decision);
    setNote('Recording…');
    const r = await logAction(asAction(recommended), decision, ctx);
    setNote(r.ok ? `Logged (${decision})${r.decided_by ? ` by ${r.decided_by}` : ''}.` : `Log failed: ${r.error ?? 'unknown'}`);
  };

  const investigate = () => {
    setSelectedProduct(item.product_name);
    if (!showActionCenter) setShowActionCenter(true);
    navigate('/action-center');
  };

  const sevText = item.severity === 'high' ? 'text-destructive' : item.severity === 'medium' ? 'text-amber-600' : 'text-muted-foreground';

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            <Badge variant={priorityVariant(item.priority)}>{item.priority}</Badge>
            <Badge variant="outline" className="text-[10px]">{item.product_display}</Badge>
            <span className="text-sm text-muted-foreground">· {item.domain_label}</span>
          </CardTitle>
          {status !== 'pending' && (
            <Badge variant={status === 'rejected' ? 'outline' : 'default'} className="gap-1">
              {status === 'rejected' ? <XCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />} {status}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className={`font-medium ${sevText} flex items-center gap-1.5`}>
          {item.severity === 'high' && <AlertTriangle className="h-4 w-4" />}
          {item.issue}
        </div>
        {item.root_cause && (
          <div><span className="font-semibold text-foreground">Likely cause: </span><span className="text-muted-foreground">{item.root_cause}</span></div>
        )}
        <div>
          <span className="font-semibold text-foreground">Recommended action: </span>
          {editing ? (
            <div className="mt-1 space-y-2">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => { void decide('modified', draft); setEditing(false); }}>Save</Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <span className="text-muted-foreground">{draft}</span>
          )}
        </div>

        {!editing && status === 'pending' && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" className="gap-1.5" onClick={() => void decide('approved')}><CheckCircle2 className="h-4 w-4" /> Approve</Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Modify</Button>
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void decide('rejected')}><XCircle className="h-4 w-4" /> Reject</Button>
            <Button size="sm" variant="ghost" className="gap-1.5 ml-auto text-primary" onClick={investigate}>Investigate <ArrowRight className="h-3.5 w-3.5" /></Button>
          </div>
        )}
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  );
}
