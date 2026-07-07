// Ontology Copilot — a chat panel (Sheet) that answers grounded questions about
// the selected product using its derived components (ontology classes, measures +
// formulas, relationships, KPIs); for live products the server may attach a live
// snapshot. If the response includes a structured action, an "Add to action queue"
// button pushes it into the Action Center (shared `actions` context). Gated on
// /api/llm-status — disabled with an explanation when the LLM is unavailable.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  ScrollArea,
  Input,
  Badge,
  Checkbox,
} from '@databricks/appkit-ui/react';
import { Sparkles, Send, Plus, Bot, Database } from 'lucide-react';
import { useProduct } from '../lib/product';
import { useActions, type ActionItem } from '../lib/actions';
import { componentsSummary } from '../lib/summary';
import { isDemoProduct } from '../../../shared/demoDomains';

type Msg = {
  role: 'user' | 'assistant';
  content: string;
  action?: Record<string, string>;
  added?: boolean;
};

export function Copilot() {
  const navigate = useNavigate();
  const { selectedProduct, components, isolationKey } = useProduct();
  const { addAction } = useActions();
  const dataAvailable = Boolean(selectedProduct.dataAvailable) && isDemoProduct(selectedProduct.product_name);
  // QSR control-tower products (sc_*) → Executive Copilot mode (structured answers)
  const execMode = selectedProduct.product_name.startsWith('sc_');
  const [useData, setUseData] = useState(true); // grounds on real backing data when available
  const [open, setOpen] = useState(false);
  const [llmAvailable, setLlmAvailable] = useState<boolean | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const scrollEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/llm-status')
      .then((r) => r.json())
      .then((d) => setLlmAvailable(Boolean(d?.available)))
      .catch(() => setLlmAvailable(false));
  }, []);

  useEffect(() => {
    scrollEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  // reset the conversation when the active customer/schema changes (isolation):
  // no customer's Copilot context/history leaks into another.
  useEffect(() => {
    setMessages([]);
  }, [isolationKey]);

  // context-sensitive example questions, derived deterministically from the
  // ACTIVE product's components (no extra LLM call). Recomputes on selection.
  const suggestions = useMemo(() => {
    const name = selectedProduct?.display_name ?? 'this product';
    const factShort = components.tables.find((t) => t.role === 'fact')?.label;
    const dimShort = components.tables.find((t) => t.role === 'dim')?.label;
    const anchorTable = components.tables.find((t) => t.role === 'fact') ?? components.tables[0];
    const measure = components.measures[0]?.measure ?? components.kpis[0];
    const chips: string[] = [];
    // Executive Copilot (control-tower products): lead with role-based exec prompts
    if (execMode) {
      chips.push('Summarize the top supply-chain risks right now.');
      chips.push('Which restaurants require intervention today?');
      chips.push('Which supplier disruption has the largest downstream impact?');
      chips.push('What action has the highest projected business impact?');
      return chips.slice(0, 4);
    }
    // for data-backed products, lead with data-questions against the real rows
    if (dataAvailable) {
      const dataChip: Record<string, string> = {
        dq_test_failures: 'Which DQ tests are failing and how bad?',
        table_freshness: 'Which tables are stale and by how long?',
        pipeline_health: 'Which pipelines are failing and retrying?',
        forecast_accuracy: 'Which items have the worst forecast accuracy?',
        inventory_stockout_risk: 'Which items are at stockout risk?',
        purchase_order_fulfillment: 'Which purchase orders are late?',
      };
      const q = dataChip[selectedProduct.product_name];
      if (q) chips.push(q);
      chips.push(`Summarize the exceptions in ${name}.`);
    }
    chips.push(`Summarize the ${name} data product.`);
    if (measure) chips.push(`What does ${measure} measure and how is it calculated?`);
    chips.push(`Which tables feed ${name}?`);
    if (anchorTable) chips.push(`Which columns are in ${anchorTable.label ?? anchorTable.table}?`);
    else if (dimShort) chips.push(`What are the key dimensions of ${dimShort}?`);
    else if (factShort) chips.push(`What are the key dimensions of ${factShort}?`);
    return chips.slice(0, 4);
  }, [selectedProduct, components, dataAvailable, execMode]);

  const send = async (question?: string) => {
    const q = (question ?? input).trim();
    if (!q || busy) return;
    setInput('');
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'user', content: q }]);
    setBusy(true);
    try {
      const resp = await fetch('/api/copilot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: q,
          product: selectedProduct.product_name,
          live: components.live,
          useData: dataAvailable && useData,
          execMode,
          productContext: componentsSummary(components),
          history,
        }),
      });
      const d = await resp.json();
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: d?.answer ?? 'No answer.', action: d?.action },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const addToQueue = (idx: number, action: Record<string, string>) => {
    const item: ActionItem = {
      id: `cop-${Date.now()}`,
      source: 'copilot',
      priority: (['HIGH', 'MEDIUM', 'LOW'].includes(String(action.priority)) ? action.priority : 'MEDIUM') as ActionItem['priority'],
      issue: String(action.issue ?? 'Copilot action'),
      root_cause: String(action.root_cause ?? ''),
      recommended_action: String(action.recommended_action ?? ''),
      confidence: typeof action.confidence === 'number' ? action.confidence : 0.5,
      llm: true, // Copilot recommendations come from the model
      status: 'pending',
    };
    addAction(item);
    setMessages((m) => m.map((msg, i) => (i === idx ? { ...msg, added: true } : msg)));
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Sparkles className="h-4 w-4" /> Copilot
      </Button>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px] flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4" /> Ontology Copilot
            {dataAvailable && (
              <Badge variant="default" className="gap-1">
                <Database className="h-3 w-3" /> Data Avlbl
              </Badge>
            )}
            {llmAvailable === false && <Badge variant="outline">unavailable</Badge>}
          </SheetTitle>
        </SheetHeader>

        {/* input + suggestion chips pinned at the TOP of the panel body */}
        {llmAvailable === false ? (
          <div className="text-xs text-muted-foreground border-b pb-2">
            The Foundation Model endpoint isn't configured for this deployment, so the Copilot is
            disabled. The ontology, contract, and graph views still work without it.
          </div>
        ) : (
          <div className="space-y-2 border-b pb-3">
            <div className="flex gap-2">
              <Input
                placeholder="Ask about this product…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') send();
                }}
                disabled={busy || llmAvailable === null}
              />
              <Button size="icon" onClick={() => send()} disabled={busy || !input.trim()} aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            </div>
            {dataAvailable && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Checkbox checked={useData} onCheckedChange={(v) => setUseData(Boolean(v))} />
                Use Data Avlbl (ground answers on the real backing data)
              </label>
            )}
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy}
                  onClick={() => send(s)}
                  className="rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors text-left"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="text-xs text-muted-foreground pt-2">
          Grounded in <span className="font-medium">{selectedProduct.display_name}</span>'s ontology,
          measures, and {components.live ? 'a live data snapshot' : 'schema-derived components'}.
        </div>

        {/* bounded, scrollable conversation (min-h-0 lets the flex child shrink so
            the ScrollArea actually scrolls instead of growing the panel) */}
        <ScrollArea className="flex-1 min-h-0 max-h-[calc(100vh-16rem)] -mx-2 px-2">
          <div className="space-y-3 py-3">
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
                <div
                  className={`inline-block rounded-lg px-3 py-2 text-sm max-w-[90%] text-left ${
                    m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                  }`}
                >
                  <div className="whitespace-pre-wrap">{m.content}</div>
                  {m.action && (
                    <div className="mt-2 border-t pt-2">
                      <div className="text-xs font-medium">Proposed action: {m.action.issue}</div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-1 gap-1.5"
                        disabled={m.added}
                        onClick={() => {
                          addToQueue(i, m.action!);
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {m.added ? 'Added to queue' : 'Add to action queue'}
                      </Button>
                      {m.added && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="mt-1 ml-1"
                          onClick={() => {
                            setOpen(false);
                            navigate('/action-center');
                          }}
                        >
                          View
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="text-sm text-muted-foreground">Thinking…</div>}
            {messages.length === 0 && !busy && (
              <div className="text-sm text-muted-foreground">
                Ask about this product using the box above, or tap a suggestion.
              </div>
            )}
            <div ref={scrollEnd} />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
