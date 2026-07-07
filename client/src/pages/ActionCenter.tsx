// Action Center — a prescriptive "action" layer over the selected product.
//  • Exceptions (live products): real rows from the `opportunities` query mapped
//    to a queue, bucketed HIGH/MEDIUM by opportunity_usd, enriched with LLM
//    root-cause / recommended-action / confidence (deterministic fallback if LLM down).
//  • Scenario signals (hybrid): a small form → LLM-prioritized, clearly-labeled actions.
//  • Lifecycle (in-session only): Approve / Modify / Reject + a SIMULATED trail.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
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
  Checkbox,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { CheckCircle2, XCircle, Pencil, Zap, AlertTriangle, Info, Database, Loader2, FileDown, MessageSquare, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import { useProduct } from '../lib/product';
import { fetchProductLinks, attachLink, deleteLink, type ProductLink } from '../lib/productLinks';
import { useActions, buildExceptionActions, mergeLlmActions, simulatedTrail, type ActionItem, type OpportunityRow } from '../lib/actions';
import { componentsSummary } from '../lib/summary';
import {
  logAction,
  fetchActionLog,
  type LogContext,
  type LoggedAction,
} from '../lib/actionLog';
import { MonitorJobBuilder } from '../components/MonitorJobBuilder';

export function ActionCenter() {
  const navigate = useNavigate();
  const {
    selectedProduct,
    selectedDomain,
    components,
    isolationKey,
    domainScope,
    productScope,
    schemaEntries,
    selectedSchemaIds,
  } = useProduct();
  const { queue, setQueue, addAction } = useActions();
  const live = components.live;
  const dataAvailable = Boolean(selectedProduct.dataAvailable);

  const schemaLabel =
    selectedSchemaIds.length === 1
      ? (schemaEntries.find((s) => s.id === selectedSchemaIds[0])?.label ?? '1 schema')
      : `${selectedSchemaIds.length} schemas`;
  const logCtx: LogContext = {
    schema_label: schemaLabel,
    domain: selectedDomain?.label ?? '',
    product: selectedProduct.display_name,
  };

  // Attached Genie / dashboard links for this product — lifted here so both the
  // Further-analysis panel AND each action card ("Review before approving") share
  // one source of truth and stay in sync after an attach/remove.
  const [productLinks, setProductLinks] = useState<ProductLink[]>([]);
  const reloadLinks = React.useCallback(async () => {
    setProductLinks(await fetchProductLinks(selectedProduct.display_name));
  }, [selectedProduct.display_name]);
  useEffect(() => {
    void reloadLinks();
  }, [reloadLinks]);

  // Reset the Action Center whenever the SCOPE (schema/domain/product) changes so
  // no previous product's generated actions/analysis linger. Keyed like the
  // isolation reset, but also on domain/product scope. Remount panels via the key.
  const scopeSig = `${isolationKey}|${domainScope}|${productScope}|${selectedProduct.product_name}`;
  useEffect(() => {
    setQueue([]);
  }, [scopeSig, setQueue]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground flex items-center gap-2">
            Action Center
            {dataAvailable && (
              <Badge variant="default" className="gap-1">
                <Database className="h-3 w-3" /> Data Avlbl
              </Badge>
            )}
          </h2>
          <p className="text-muted-foreground">
            Prescriptive actions for {selectedProduct.display_name} — exceptions from the live serving
            layer and scenario-driven signals. Approve/Modify/Reject are recorded to the action log.
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={() => navigate('/print/actions')}>
          <FileDown className="h-4 w-4" /> Export actions
        </Button>
      </div>

      <Tabs defaultValue="actions">
        <TabsList>
          <TabsTrigger value="actions">Actions</TabsTrigger>
          <TabsTrigger value="log">Action Log</TabsTrigger>
          {dataAvailable && <TabsTrigger value="monitor">Monitoring Job</TabsTrigger>}
        </TabsList>

        <TabsContent value="actions" className="space-y-6 mt-4">
          <QueueSummary queue={queue} />

          {dataAvailable && (
            <FurtherAnalysisPanel
              key={`fa-${scopeSig}`}
              product={selectedProduct.display_name}
              schemaLabel={schemaLabel}
              domain={selectedDomain?.label ?? ''}
              backingTables={selectedProduct.fact_tables ?? []}
              links={productLinks}
              onChanged={reloadLinks}
            />
          )}

          {dataAvailable ? (
            <DataExceptionsPanel key={scopeSig} onSeed={setQueue} queue={queue} />
          ) : live ? (
            <ExceptionsPanel key={scopeSig} onSeed={setQueue} queue={queue} />
          ) : (
            <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm">
              <Info className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">
                This product is schema-derived (no live serving layer), so there are no live
                exceptions. Use the scenario signals below to generate a prioritized action plan.
              </span>
            </div>
          )}

          <ScenarioPanel onActions={(items) => items.forEach(addAction)} />

          <QueueList queue={queue} setQueue={setQueue} logCtx={logCtx} reviewLinks={productLinks} />
        </TabsContent>

        <TabsContent value="log" className="mt-4">
          <ActionLogTracker product={selectedProduct.display_name} />
        </TabsContent>

        {dataAvailable && (
          <TabsContent value="monitor" className="mt-4">
            <MonitorJobBuilder
              key={`monitor-${selectedDomain?.name ?? ''}`}
              domain={selectedDomain?.name ?? ''}
              domainLabel={selectedDomain?.label ?? ''}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// Action Log tracker — lists persisted decisions (deduped by product+issue), each
// row expandable to the full issue / root cause / recommended action detail.
function ActionLogTracker({ product }: { product: string }) {
  const [rows, setRows] = useState<LoggedAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [scopeToProduct, setScopeToProduct] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    const data = await fetchActionLog(scopeToProduct ? product : undefined);
    setRows(data);
    setLoading(false);
  }, [product, scopeToProduct]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Action log</CardTitle>
            <CardDescription>Persisted decisions from jai_action_log — one row per issue (re-deciding updates it), newest first. Click an issue for detail.</CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <Checkbox checked={scopeToProduct} onCheckedChange={(v) => setScopeToProduct(Boolean(v))} />
              This product only
            </label>
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No logged actions yet. Approve/Modify/Reject an action to record it here.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Issue</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Decided</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const open = expandedId === r.action_id;
                return (
                <React.Fragment key={r.action_id}>
                <TableRow className="cursor-pointer" onClick={() => setExpandedId(open ? null : r.action_id)}>
                  <TableCell className="max-w-[320px]">
                    <div className="font-medium flex items-center gap-1">
                      {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      <span className={open ? '' : 'truncate'}>{r.issue}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.source ? <Badge variant="outline" className="text-[10px]">{r.source}</Badge> : null}
                  </TableCell>
                  <TableCell className="text-xs">{r.product}</TableCell>
                  <TableCell>
                    <Badge variant={r.decision === 'rejected' ? 'outline' : r.decision === 'modified' ? 'secondary' : 'default'}>{r.decision}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.decided_by}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.decided_at ?? r.created_at}</TableCell>
                </TableRow>
                {open && (
                  <TableRow>
                    <TableCell colSpan={6} className="bg-muted/30">
                      <div className="space-y-1.5 py-1 text-sm">
                        {r.priority && (
                          <div><span className="font-semibold">Priority: </span><Badge variant={priorityVariant(r.priority)} className="text-[10px]">{r.priority}</Badge>
                          {typeof r.confidence === 'number' && <span className="ml-2 text-xs text-muted-foreground">confidence {Math.round((r.confidence ?? 0) * 100)}%</span>}</div>
                        )}
                        <div><span className="font-semibold">Issue: </span><span className="text-muted-foreground">{r.issue}</span></div>
                        <div><span className="font-semibold">Root cause: </span><span className="text-muted-foreground">{r.root_cause || '—'}</span></div>
                        <div><span className="font-semibold">Recommended action: </span><span className="text-muted-foreground">{r.recommended_action || '—'}</span></div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// Data-backed exceptions: for a "Data Avlbl" product, a "Use Data Avlbl" toggle
// runs the product's exception SQL against the backing schema (server-side) and
// LLM-enriches each real row into a prioritized action.
type PlaybookEntry = { root_cause: string; recommended_action: string; source: 'db' | 'guidance' };
type DataExResult = {
  actions: Record<string, unknown>[];
  stats: Record<string, unknown> | null;
  rows: Record<string, unknown>[];
  llm?: boolean;
  note?: string;
  sql?: { aggregate?: string; rows?: string };
  full_count?: number;
  playbook?: PlaybookEntry[];
};

function DataExceptionsPanel({
  onSeed,
}: {
  onSeed: React.Dispatch<React.SetStateAction<ActionItem[]>>;
  queue: ActionItem[];
}) {
  const { selectedProduct, getScopeCache, setScopeCache } = useProduct();
  const [useData, setUseData] = useState(true);
  const [loading, setLoading] = useState(false);
  const [showRows, setShowRows] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [allRows, setAllRows] = useState<Record<string, unknown>[] | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  // rehydrate from the per-scope cache so results survive tab navigation
  const [result, setResult] = useState<DataExResult | null>(
    () => getScopeCache<DataExResult>('dataExceptions') ?? null
  );
  const loadAllRows = async () => {
    setLoadingRows(true);
    try {
      const r = await fetch('/api/exception-rows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product: selectedProduct.product_name, limit: 1000 }),
      });
      const d = await r.json();
      setAllRows(Array.isArray(d?.rows) ? d.rows : []);
      setShowRows(true);
    } finally {
      setLoadingRows(false);
    }
  };

  const generate = async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/data-exceptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product: selectedProduct.product_name }),
      });
      const d = (await resp.json()) as {
        actions?: Record<string, unknown>[];
        rows?: Record<string, unknown>[];
        stats?: Record<string, unknown> | null;
        llm?: boolean;
        reason?: string;
        sql?: { aggregate?: string; rows?: string };
        full_count?: number;
        playbook?: PlaybookEntry[];
      };
      const actions = d.actions ?? [];
      const items: ActionItem[] = actions.map((a, i) => ({
        id: `dx-${selectedProduct.product_name}-${i}-${Date.now()}`,
        source: 'exception',
        priority: (['HIGH', 'MEDIUM', 'LOW'].includes(String(a.priority))
          ? a.priority
          : 'MEDIUM') as ActionItem['priority'],
        issue: String(a.issue ?? 'Data exception'),
        root_cause: String(a.root_cause ?? ''),
        recommended_action: String(a.recommended_action ?? ''),
        confidence: typeof a.confidence === 'number' ? a.confidence : 0.6,
        llm: Boolean(d.llm), // recommendation is LLM-summarized when the model ran
        status: 'pending',
      }));
      onSeed((prev) => [...items, ...prev.filter((p) => p.source !== 'exception')]);
      const res: DataExResult = {
        actions,
        stats: d.stats ?? null,
        rows: d.rows ?? [],
        llm: d.llm,
        sql: d.sql,
        full_count: d.full_count,
        playbook: d.playbook,
        note: actions.length
          ? `${actions.length} aggregate action(s) from the backing data${d.llm ? ' (LLM-summarized)' : ''}.`
          : `No exceptions returned${d.reason ? ` — ${d.reason}` : ''}.`,
      };
      setResult(res);
      setScopeCache('dataExceptions', res); // persist for this scope
    } catch (err) {
      setResult({ actions: [], stats: null, rows: [], note: `Error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setLoading(false);
    }
  };

  const stats = result?.stats ?? null;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Database className="h-4 w-4" /> Data-backed exceptions (aggregated)
        </CardTitle>
        <CardDescription>
          Summarizes {selectedProduct.display_name}'s exception rule over the backing schema into a
          handful of high-level actions (row detail on expand).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox checked={useData} onCheckedChange={(v) => setUseData(Boolean(v))} />
            Use Data Avlbl
          </label>
          <Button size="sm" className="gap-1.5" disabled={loading || !useData} onClick={generate}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            Generate from data
          </Button>
          {result && <Badge variant="secondary">{result.actions.length} aggregate action(s)</Badge>}
          {result?.note && <span className="text-xs text-muted-foreground">{result.note}</span>}
        </div>

        {stats && (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary" className="text-[10px]">Data-derived</Badge>
              <span className="text-[11px] text-muted-foreground">real SQL aggregates over the backing table</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(stats).map(([k, v]) => (
                <Badge key={k} variant="outline" className="font-normal">
                  {k.replace(/_/g, ' ')}: <span className="font-medium ml-1">{String(v)}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* exact query behind the numbers (drill-through) */}
        {result?.sql && (
          <div>
            <Button size="sm" variant="ghost" className="text-xs gap-1.5" onClick={() => setShowSql((s) => !s)}>
              <Database className="h-3.5 w-3.5" /> {showSql ? 'Hide' : 'Show'} supporting query
            </Button>
            {showSql && (
              <div className="mt-1 space-y-1">
                <div className="text-[11px] text-muted-foreground">Aggregate (the stat numbers):</div>
                <pre className="text-[11px] bg-muted rounded-md p-2 overflow-x-auto whitespace-pre-wrap">{result.sql.aggregate}</pre>
                <div className="text-[11px] text-muted-foreground">Exception rows:</div>
                <pre className="text-[11px] bg-muted rounded-md p-2 overflow-x-auto whitespace-pre-wrap">{result.sql.rows}</pre>
              </div>
            )}
          </div>
        )}

        {/* prescriptive playbook — honest DB-backed vs guidance (renders even w/o LLM) */}
        {result?.playbook && result.playbook.length > 0 && (
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium">Playbook — root cause → action</span>
              <Badge variant="secondary" className="text-[10px]">AI guidance</Badge>
            </div>
            {result.playbook.map((p, i) => (
              <div key={i} className="text-xs space-y-0.5">
                <div>
                  <Badge variant="outline" className={`text-[9px] mr-1 ${p.source === 'db' ? 'text-success' : 'text-muted-foreground'}`}>
                    {p.source === 'db' ? 'DB-backed' : 'Guidance'}
                  </Badge>
                  <span className="text-muted-foreground">Why: </span>{p.root_cause}
                </div>
                <div className="pl-1"><span className="text-muted-foreground">Do: </span><span className="font-medium">{p.recommended_action}</span></div>
              </div>
            ))}
            <div className="text-[10px] text-muted-foreground">
              Root cause / recommended action are AI + curated guidance; the counts above are data-derived. Open the attached Genie space (Further analysis panel) to drill deeper.
            </div>
          </div>
        )}

        {result && result.rows.length > 0 && (
          <div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" className="text-xs" onClick={() => setShowRows((s) => !s)}>
                {showRows ? 'Hide' : 'Show'} rows ({(allRows ?? result.rows).length}
                {result.full_count != null && result.full_count > (allRows ?? result.rows).length ? ` of ${result.full_count}` : ''})
              </Button>
              {result.full_count != null && !allRows && result.full_count > result.rows.length && (
                <Button size="sm" variant="ghost" className="text-xs gap-1.5" disabled={loadingRows} onClick={() => void loadAllRows()}>
                  {loadingRows ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Load all {result.full_count} exception rows
                </Button>
              )}
            </div>
            {showRows && (allRows ?? result.rows).length > 0 && (
              <div className="mt-2 max-h-96 overflow-auto rounded-md border">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="bg-muted/50">
                      {Object.keys((allRows ?? result.rows)[0]).map((c) => (
                        <th key={c} className="text-left px-2 py-1 font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(allRows ?? result.rows).map((r, i) => (
                      <tr key={i} className="border-t">
                        {Object.values(r).map((v, j) => (
                          <td key={j} className="px-2 py-1 whitespace-nowrap">
                            {String(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Further analysis — pivots to deeper tooling. If a Genie/dashboard link is
// attached → Open in Genie / Open dashboard (new window). Else → guidance +
// Attach Genie Space (paste URL).
function FurtherAnalysisPanel({
  product,
  schemaLabel,
  domain,
  backingTables,
  links,
  onChanged,
}: {
  product: string;
  schemaLabel: string;
  domain: string;
  backingTables: string[];
  links: ProductLink[];
  onChanged: () => void | Promise<void>;
}) {
  const [showAttach, setShowAttach] = useState(false);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const attach = async () => {
    if (!url.trim()) return;
    const r = await attachLink({
      schema_label: schemaLabel,
      domain,
      product,
      link_type: 'genie',
      url: url.trim(),
      label: label.trim() || 'Genie Space',
    });
    if (r.ok) {
      setUrl('');
      setLabel('');
      setShowAttach(false);
      setNote('Genie Space attached.');
      void onChanged();
    } else {
      setNote(`Attach failed: ${r.error ?? 'unknown'}`);
    }
  };

  const remove = async (id: string) => {
    if (await deleteLink(id)) void onChanged();
  };

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4" /> Further analysis
        </CardTitle>
        <CardDescription>Explore this product interactively in Genie or an AI/BI dashboard.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {links.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {links.map((l) => (
              <div key={l.link_id} className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => window.open(l.url, '_blank')}
                >
                  {l.link_type === 'dashboard' ? <Zap className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
                  {l.link_type === 'dashboard' ? 'Open dashboard' : 'Open in Genie'}
                  {l.label ? ` · ${l.label}` : ''}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => remove(l.link_id)} title="Remove link">
                  <XCircle className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" className="text-xs" onClick={() => setShowAttach((s) => !s)}>
              + Attach another
            </Button>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm">
            <Info className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">
              Build a Genie Space on{' '}
              {backingTables.length ? (
                <code>{backingTables.join(', ')}</code>
              ) : (
                <code>the backing table(s)</code>
              )}{' '}
              to explore this further, then attach it here.
              <Button size="sm" variant="outline" className="ml-2 gap-1.5" onClick={() => setShowAttach(true)}>
                <MessageSquare className="h-3.5 w-3.5" /> Attach Genie Space
              </Button>
            </span>
          </div>
        )}

        {showAttach && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[220px] space-y-1">
              <Label className="text-xs">Genie Space URL</Label>
              <Input placeholder="https://…/genie/rooms/…" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="min-w-[140px] space-y-1">
              <Label className="text-xs">Label (optional)</Label>
              <Input placeholder="e.g. DQ Genie" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <Button size="sm" onClick={attach} disabled={!url.trim()}>
              Attach
            </Button>
          </div>
        )}
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </CardContent>
    </Card>
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
          llm: true, // scenario actions are LLM-prioritized
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
  logCtx,
  reviewLinks,
}: {
  queue: ActionItem[];
  setQueue: React.Dispatch<React.SetStateAction<ActionItem[]>>;
  logCtx: LogContext;
  reviewLinks: ProductLink[];
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
        <ActionCard key={a.id} action={a} setQueue={setQueue} logCtx={logCtx} reviewLinks={reviewLinks} />
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
  logCtx,
  reviewLinks,
}: {
  action: ActionItem;
  setQueue: React.Dispatch<React.SetStateAction<ActionItem[]>>;
  logCtx: LogContext;
  reviewLinks: ProductLink[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(action.recommended_action);
  const [logNote, setLogNote] = useState<string | null>(null);
  // single most-relevant investigation link: prefer the Genie space (works for any
  // exception), else the first dashboard.
  const primaryLink = reviewLinks.find((l) => l.link_type === 'genie') ?? reviewLinks[0];

  const update = (patch: Partial<ActionItem>) =>
    setQueue((prev) => prev.map((q) => (q.id === action.id ? { ...q, ...patch } : q)));

  // persist the decision to jai_action_log (best-effort; UI still updates in-session)
  const persist = async (decision: 'approved' | 'modified' | 'rejected', override?: ActionItem) => {
    setLogNote('Recording…');
    const r = await logAction(override ?? action, decision, logCtx);
    setLogNote(r.ok ? `Recorded to action log${r.decided_by ? ` (as ${r.decided_by})` : ''}.` : `Log failed: ${r.error ?? 'unknown'}`);
  };

  const approve = () => {
    update({ status: 'approved', trail: simulatedTrail(action) });
    void persist('approved');
  };
  const reject = () => {
    update({ status: 'rejected', trail: undefined });
    void persist('rejected');
  };
  const saveEdit = () => {
    update({ status: 'modified', recommended_action: draft });
    void persist('modified', { ...action, recommended_action: draft });
    setEditing(false);
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            <Badge variant={priorityVariant(action.priority)}>{action.priority}</Badge>
            {action.source === 'exception' && (
              <Badge variant="default" className="gap-1">
                <Database className="h-3 w-3" /> Data exception
              </Badge>
            )}
            {action.source === 'scenario' && (
              <Badge variant="secondary" className="gap-1">
                <Zap className="h-3 w-3" /> Scenario
              </Badge>
            )}
            {action.source === 'copilot' && <Badge variant="secondary">Copilot</Badge>}
            {action.llm ? (
              <Badge variant="outline" className="gap-1 text-[10px] font-normal">
                <Sparkles className="h-3 w-3" /> AI (LLM) recommendation
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1 text-[10px] font-normal">
                <Database className="h-3 w-3" /> Data-derived (heuristic)
              </Badge>
            )}
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

        {/* honest provenance split: the numbers are data, the prose is guidance */}
        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            Issue, priority{action.opportunity_usd ? ' and $ opportunity' : ''} are{' '}
            <span className="font-medium">data-derived</span>; root cause and recommended action are{' '}
            <span className="font-medium">{action.llm ? 'AI (LLM) guidance' : 'heuristic guidance (no model)'}</span> —
            review before approving.
          </span>
        </div>

        {/* one most-relevant investigation link (the product's Genie space is the
            general-purpose tool for any exception; else a dashboard) — the full set
            lives once at the top of the page (Further analysis). */}
        {primaryLink && action.status !== 'approved' && (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <span className="text-[11px] text-muted-foreground">Review before approving:</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              onClick={() => window.open(primaryLink.url, '_blank')}
            >
              {primaryLink.link_type === 'dashboard' ? <Zap className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
              {primaryLink.link_type === 'dashboard' ? 'Open dashboard' : 'Open in Genie'}
              {primaryLink.label ? ` · ${primaryLink.label}` : ''}
            </Button>
          </div>
        )}

        {action.trail && action.status === 'approved' && (
          <div className="rounded-md bg-success/10 border border-success/30 p-2 text-xs space-y-0.5">
            {action.trail.map((t, i) => (
              <div key={i} className="text-success font-medium">
                {t}
              </div>
            ))}
            <div className="text-muted-foreground italic">(execution simulated — decision persisted to the action log)</div>
          </div>
        )}

        {logNote && <div className="text-xs text-muted-foreground">{logNote}</div>}

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
