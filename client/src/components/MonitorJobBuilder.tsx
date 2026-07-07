// Domain-level MONITORING JOB builder (Action Center tab). Lets the user, via an
// interactive chat, define which AGGREGATE metrics to watch across ALL products
// in a data-backed domain, name & schedule a daily batch job, run it on demand,
// and review past run outputs. Aggregate-only: it never proposes or takes action
// (that stays in the Action queue / action log). Chat scaffolding mirrors
// components/Copilot.tsx; the past-runs table mirrors ActionCenter's log tracker.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Input,
  Badge,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@databricks/appkit-ui/react';
import { Send, Bot, Sparkles, Loader2, Save, Play, CalendarClock, ShieldCheck, MessageSquare, Zap } from 'lucide-react';
import {
  fetchMonitorJob,
  saveMonitorJob,
  monitorChat,
  runMonitorJob,
  fetchMonitorRuns,
  fetchMonitorPreview,
  CRON_PRESETS,
  type AggregateSpec,
  type MonitorRun,
  type MonitorPreview,
} from '../lib/monitorJob';
import { fetchProductLinks, type ProductLink } from '../lib/productLinks';

type Msg = { role: 'user' | 'assistant'; content: string };

export function MonitorJobBuilder({ domain, domainLabel }: { domain: string; domainLabel: string }) {
  const [llmAvailable, setLlmAvailable] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [spec, setSpec] = useState<AggregateSpec | null>(null);

  const [cron, setCron] = useState('0 0 7 * * ?');
  const [preview, setPreview] = useState<MonitorPreview | null>(null);
  const [runs, setRuns] = useState<MonitorRun[]>([]);
  const [jobName, setJobName] = useState(`jai_monitor_${domain}_daily`);
  const [version, setVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  // Genie / dashboard links attached in the ontology (Ontology Studio / Further
  // analysis) — used to make each monitored exception investigable.
  const [links, setLinks] = useState<ProductLink[]>([]);
  const scrollEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/llm-status')
      .then((r) => r.json())
      .then((d) => setLlmAvailable(Boolean(d?.available)))
      .catch(() => setLlmAvailable(false));
  }, []);

  const loadRuns = useCallback(async () => setRuns(await fetchMonitorRuns(domain)), [domain]);

  // (re)load saved definition + preview + runs when the domain changes
  useEffect(() => {
    setMessages([]);
    setSpec(null);
    void (async () => {
      const [job, prev] = await Promise.all([fetchMonitorJob(domain), fetchMonitorPreview(domain)]);
      setPreview(prev);
      setJobName(prev?.job_name ?? `jai_monitor_${domain}_daily`);
      if (job) {
        setCron(job.schedule_cron ?? '0 0 7 * * ?');
        setVersion(job.version ?? null);
        if (job.aggregates_json) {
          try {
            const parsed = JSON.parse(job.aggregates_json);
            setSpec(Array.isArray(parsed?.aggregates) ? parsed : { aggregates: parsed });
          } catch {
            /* ignore malformed cache */
          }
        }
      }
    })();
    void loadRuns();
    void fetchProductLinks().then(setLinks); // all links; matched per product below
  }, [domain, loadRuns]);

  // product_name → attached links. Links are keyed by product DISPLAY name and a
  // domain label, while monitor runs carry the internal product_name — bridge via
  // the preview's product list, and fall back to any domain-scoped link.
  const linksForProduct = useCallback(
    (productName: string): ProductLink[] => {
      const disp = preview?.products.find((p) => p.product_name === productName)?.display_name;
      const byProduct = links.filter((l) => l.product && (l.product === disp || l.product === productName));
      if (byProduct.length) return byProduct;
      return links.filter((l) => l.domain && l.domain === domainLabel);
    },
    [links, preview, domainLabel]
  );

  useEffect(() => {
    scrollEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setInput('');
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setBusy(true);
    const res = await monitorChat({ domain, question, history, currentSpec: spec ?? undefined });
    setMessages((prev) => [...prev, { role: 'assistant', content: res.answer }]);
    if (res.spec?.aggregates?.length) setSpec(res.spec);
    setBusy(false);
  };

  const doSave = async () => {
    setSaving(true);
    const r = await saveMonitorJob({
      domain,
      schedule_cron: cron,
      aggregates_json: spec ?? { aggregates: [] },
      enabled: true,
    });
    setSaving(false);
    if (r.ok) {
      setVersion(r.version ?? null);
      if (r.job_name) setJobName(r.job_name);
    }
  };

  const doRun = async () => {
    setRunning(true);
    await runMonitorJob(domain, 'on_demand');
    await loadRuns();
    setRunning(false);
  };

  const suggestions = [
    `Monitor the key aggregate metrics across all ${domainLabel} products`,
    'Alert when any product has more than 5 exceptions',
    'What aggregate metrics can I watch here?',
  ];

  return (
    <div className="space-y-6">
      {/* 1. Interactive chat builder */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Build a monitoring job — {domainLabel}
          </CardTitle>
          <CardDescription>
            Define, in plain language, which <span className="font-medium">aggregate</span> metrics this
            daily job should watch across <span className="font-medium">all products</span> in the domain.
            The assistant only assembles a monitoring spec — it never proposes or takes action.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {llmAvailable === false && (
            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              The assistant is unavailable (no serving endpoint). You can still save a schedule and run the
              job on demand — it will monitor every aggregate metric each product exposes.
            </div>
          )}
          {messages.length > 0 && (
            <ScrollArea className="h-56 rounded-md border p-3">
              <div className="space-y-3">
                {messages.map((m, i) => (
                  <div key={i} className={`flex gap-2 text-sm ${m.role === 'user' ? 'justify-end' : ''}`}>
                    {m.role === 'assistant' && <Bot className="h-4 w-4 mt-0.5 text-primary shrink-0" />}
                    <div
                      className={`rounded-lg px-3 py-2 max-w-[80%] whitespace-pre-wrap ${
                        m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                <div ref={scrollEnd} />
              </div>
            </ScrollArea>
          )}
          {messages.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant="outline"
                  className="text-xs"
                  disabled={busy || llmAvailable === false}
                  onClick={() => void send(s)}
                >
                  {s}
                </Button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input
              placeholder="Describe what to monitor…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void send(input)}
              disabled={busy || llmAvailable === false}
            />
            <Button size="sm" disabled={busy || !input.trim()} onClick={() => void send(input)}>
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 2. Job card — spec preview, name, schedule, save + run now */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" /> Batch job & schedule
          </CardTitle>
          <CardDescription>
            Job name <code>{jobName}</code>
            {version != null && <span className="text-muted-foreground"> · saved v{version}</span>}. Runs the
            aggregate query below for every product daily and stores results in Lakebase
            (<code>jai_monitor_run</code>).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Schedule</span>
            <Select value={cron} onValueChange={setCron}>
              <SelectTrigger className="w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRON_PRESETS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <code className="text-[11px] text-muted-foreground">{cron}</code>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" disabled={saving} onClick={() => void doSave()}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save definition
              </Button>
              <Button size="sm" className="gap-1.5" disabled={running} onClick={() => void doRun()}>
                {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Run now
              </Button>
            </div>
          </div>

          {spec?.aggregates?.length ? (
            <div className="rounded-md border p-3 text-xs space-y-1">
              <div className="font-medium text-muted-foreground">Monitored aggregates</div>
              {spec.aggregates.map((a) => (
                <div key={a.product_name}>
                  <code>{a.product_name}</code>: {a.metrics.map((m) => m.label || m.key).join(', ')}
                  {a.threshold && (
                    <span className="text-amber-600">
                      {' '}
                      · alert if {a.threshold.metric} {a.threshold.op} {a.threshold.value}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              No custom spec yet — the job will monitor every aggregate metric each product exposes. Use the
              chat above to narrow it.
            </div>
          )}

          {/* generated aggregate SQL per product (deferred DDL: this is what the daily job runs) */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              Generated aggregate SQL (one summary row per product)
            </div>
            {(preview?.products ?? []).map((p) => (
              <div key={p.product_name} className="rounded-md bg-muted p-2">
                <div className="text-[11px] font-medium mb-1">{p.display_name}</div>
                <pre className="text-[11px] overflow-x-auto whitespace-pre-wrap">{p.sql}</pre>
              </div>
            ))}
          </div>

          <div className="flex items-start gap-1.5 rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" />
            Deferred: this defines the job <code>{jobName}</code> and stores it in Lakebase. Deploying it as a
            scheduled Databricks Job (asset bundle, daily cron, service-principal auth) is a follow-up step —
            "Run now" already computes and stores results today.
          </div>
        </CardContent>
      </Card>

      {/* 3. Past run outputs */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Run history</CardTitle>
          <CardDescription>Aggregate results per product, newest first (from {jobName}).</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <div className="text-sm text-muted-foreground">No runs yet — click "Run now" to compute today's aggregates.</div>
          ) : (
            <>
              {runs[0]?.llm_summary && (
                <div className="mb-3 flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm">
                  <Bot className="h-4 w-4 mt-0.5 text-primary shrink-0" />
                  <span>{runs[0].llm_summary}</span>
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run date</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Exceptions</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Investigate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => {
                    const rowLinks = linksForProduct(r.product);
                    const breach = r.status === 'breach' && (r.exception_total ?? 0) > 0;
                    return (
                    <TableRow key={r.run_id + r.product}>
                      <TableCell className="text-xs">{r.run_date}</TableCell>
                      <TableCell className="text-xs font-medium">{r.product}</TableCell>
                      <TableCell className="text-right text-xs">{r.exception_total ?? 0}</TableCell>
                      <TableCell>
                        <Badge
                          variant={r.status === 'breach' ? 'destructive' : r.status === 'error' ? 'outline' : 'default'}
                          className="text-[10px]"
                        >
                          {r.error ? 'error' : r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.trigger}</TableCell>
                      <TableCell>
                        {rowLinks.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {rowLinks.map((l) => (
                              <Button
                                key={l.link_id}
                                size="sm"
                                variant={breach ? 'outline' : 'ghost'}
                                className="h-7 gap-1.5 text-xs"
                                onClick={() => window.open(l.url, '_blank')}
                              >
                                {l.link_type === 'dashboard' ? <Zap className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
                                {l.link_type === 'dashboard' ? 'Dashboard' : 'Genie'}
                              </Button>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[11px] text-muted-foreground italic">
                            attach a Genie space in the ontology
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Monitoring is aggregate-only — it flags breaches but never resolves them. Use the
                linked Genie space / dashboard to investigate, then drive any action from the Actions
                tab. Links come from the ontology (attach them in Ontology Studio or Further analysis).
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
