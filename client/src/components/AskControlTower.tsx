// Ask the Control Tower — a natural-language ask-bar for the domain expert. Gives a
// fast, grounded answer over the LIVE aggregate signals (cached server-side), with
// role prompts (CEO/COO/CSCO) and a deep-link into the Genie space for open-ended
// data exploration on the warehouse.
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Button, Input, Badge } from '@databricks/appkit-ui/react';
import { Sparkles, Send, Loader2, MessageSquare, ExternalLink } from 'lucide-react';
import { askControlTower, fetchControlTowerConfig } from '../lib/controlTower';

const ROLES: { role: string; label: string; prompts: string[] }[] = [
  { role: 'CEO', label: 'CEO', prompts: ['Summarize today’s biggest supply-chain risks.', 'Where are the largest opportunities to cut waste and protect service?'] },
  { role: 'COO', label: 'COO', prompts: ['Which restaurants need intervention today?', 'What are the top operational risks right now?'] },
  { role: 'CSCO', label: 'Chief Supply Chain Officer', prompts: ['Which supplier disruptions have the largest downstream impact?', 'Which distribution centers are capacity constrained?'] },
];

export function AskControlTower() {
  const [role, setRole] = useState<string>('CSCO');
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [genieUrl, setGenieUrl] = useState('');
  const [llm, setLlm] = useState(true);

  useEffect(() => {
    void fetchControlTowerConfig().then((c) => {
      setGenieUrl(c.genie_url);
      setLlm(c.llm);
    });
  }, []);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setAnswer(null);
    setNote(null);
    const r = await askControlTower(text, ROLES.find((x) => x.role === role)?.label);
    setBusy(false);
    if (r.answer) setAnswer(r.answer);
    else setNote(r.reason === 'no serving endpoint configured' ? 'The assistant needs the Foundation Model endpoint (not configured here). Use "Explore in Genie" for a live answer.' : 'No answer returned.');
  };

  const rolePrompts = ROLES.find((x) => x.role === role)?.prompts ?? [];

  return (
    <Card className="shadow-sm border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" /> Ask the Control Tower
        </CardTitle>
        <CardDescription>
          A grounded answer over today&rsquo;s live signals. Pick a lens, ask in plain English, or explore deeper in Genie.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {ROLES.map((r) => (
            <Button key={r.role} size="sm" variant={role === r.role ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setRole(r.role)}>
              {r.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {rolePrompts.map((p) => (
            <Button key={p} size="sm" variant="ghost" className="h-auto py-1 text-xs text-primary" disabled={busy || !llm} onClick={() => { setQ(p); void ask(p); }}>
              {p}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Ask about today’s supply chain…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void ask(q)}
            disabled={busy || !llm}
          />
          <Button size="sm" className="gap-1.5" disabled={busy || !q.trim() || !llm} onClick={() => void ask(q)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
          {genieUrl && (
            <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={() => window.open(q.trim() ? `${genieUrl}?q=${encodeURIComponent(q)}` : genieUrl, '_blank')}>
              <MessageSquare className="h-3.5 w-3.5" /> Explore in Genie <ExternalLink className="h-3 w-3" />
            </Button>
          )}
        </div>
        {answer && (
          <div className="rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap">
            <Badge variant="secondary" className="gap-1 text-[10px] mb-1"><Sparkles className="h-3 w-3" /> Grounded in live signals</Badge>
            <div>{answer}</div>
          </div>
        )}
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  );
}
