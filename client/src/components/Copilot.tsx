// Ontology Copilot — a chat panel (Sheet) that answers grounded questions about
// the selected product using its derived components (ontology classes, measures +
// formulas, relationships, KPIs); for live products the server may attach a live
// snapshot. If the response includes a structured action, an "Add to action queue"
// button pushes it into the Action Center (shared `actions` context). Gated on
// /api/llm-status — disabled with an explanation when the LLM is unavailable.
import { useEffect, useRef, useState } from 'react';
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
} from '@databricks/appkit-ui/react';
import { Sparkles, Send, Plus, Bot } from 'lucide-react';
import { useProduct } from '../lib/product';
import { useActions, type ActionItem } from '../lib/actions';
import { componentsSummary } from '../lib/summary';

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

  const send = async () => {
    const q = input.trim();
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
            {llmAvailable === false && <Badge variant="outline">unavailable</Badge>}
          </SheetTitle>
        </SheetHeader>

        <div className="text-xs text-muted-foreground border-b pb-2">
          Grounded in <span className="font-medium">{selectedProduct.display_name}</span>'s ontology,
          measures, and {components.live ? 'a live data snapshot' : 'schema-derived components'}.
        </div>

        <ScrollArea className="flex-1 -mx-2 px-2">
          <div className="space-y-3 py-3">
            {messages.length === 0 && (
              <div className="text-sm text-muted-foreground">
                Ask about this product — e.g. “Which KPI flags overstaffed stores and how is it
                computed?” or “What should we do about the worst labor-cost store?”
              </div>
            )}
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
            <div ref={scrollEnd} />
          </div>
        </ScrollArea>

        {llmAvailable === false ? (
          <div className="text-xs text-muted-foreground border-t pt-2">
            The Foundation Model endpoint isn't configured for this deployment, so the Copilot is
            disabled. The ontology, contract, and graph views still work without it.
          </div>
        ) : (
          <div className="flex gap-2 border-t pt-2">
            <Input
              placeholder="Ask about this product…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send();
              }}
              disabled={busy || llmAvailable === null}
            />
            <Button size="icon" onClick={send} disabled={busy || !input.trim()} aria-label="Send">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
