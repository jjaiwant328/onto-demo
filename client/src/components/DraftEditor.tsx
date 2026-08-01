// DraftEditor — a dialog to edit a use-case data-product draft's spec (title,
// summary, KPIs, tables, proposed Genie spaces, proposed metric views). Lists are
// edited as simple line-based text for a low-friction UX; the contract and data
// gaps are preserved as-is. Used from Product Drafts and the Data Products page.
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
  Label,
  Textarea,
} from '@databricks/appkit-ui/react';
import { Save, Loader2 } from 'lucide-react';
import { useProduct } from '../lib/product';
import { parseSpec, type UseCaseProductDraft, type UseCaseProductSpec } from '../lib/useCaseProduct';

const linesToArr = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const arrToLines = (a: string[] | undefined) => (a ?? []).join('\n');

export function DraftEditor({
  draft,
  open,
  onOpenChange,
}: {
  draft: UseCaseProductDraft;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { updateUseCaseDraft } = useProduct();
  const spec = parseSpec(draft);
  const [title, setTitle] = useState(spec?.title ?? draft.use_case_title);
  const [summary, setSummary] = useState(spec?.summary ?? '');
  // KPIs edited as "name — definition" per line
  const [kpis, setKpis] = useState(
    (spec?.kpis ?? []).map((k) => (k.definition ? `${k.name} — ${k.definition}` : k.name)).join('\n')
  );
  const [tables, setTables] = useState(arrToLines(spec?.tables));
  const [genie, setGenie] = useState(
    (spec?.genie_spaces ?? []).map((g) => (g.purpose ? `${g.name} — ${g.purpose}` : g.name)).join('\n')
  );
  const [metrics, setMetrics] = useState((spec?.metric_views ?? []).map((m) => m.name).join('\n'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!spec) return null;

  const save = async () => {
    setBusy(true);
    setErr(null);
    const next: UseCaseProductSpec = {
      ...spec,
      title: title.trim() || spec.title,
      summary: summary.trim(),
      kpis: linesToArr(kpis).map((line) => {
        const [name, ...rest] = line.split('—');
        return { name: name.trim(), definition: rest.join('—').trim() };
      }),
      tables: linesToArr(tables),
      genie_spaces: linesToArr(genie).map((line) => {
        const [name, ...rest] = line.split('—');
        return { name: name.trim(), purpose: rest.join('—').trim() };
      }),
      // keep existing metric-view dimensions/measures; just let the user edit names
      metric_views: linesToArr(metrics).map((name, i) => ({
        name: name.trim(),
        dimensions: spec.metric_views?.[i]?.dimensions ?? [],
        measures: spec.metric_views?.[i]?.measures ?? [],
      })),
    };
    const ok = await updateUseCaseDraft(draft.draft_id, next);
    setBusy(false);
    if (ok) onOpenChange(false);
    else setErr('Save failed — the draft store may be unavailable.');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit data product</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Summary</Label>
            <Textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">KPIs (one per line — “name — definition”)</Label>
            <Textarea rows={4} value={kpis} onChange={(e) => setKpis(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Tables (one per line)</Label>
            <Textarea rows={3} value={tables} onChange={(e) => setTables(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Proposed Genie spaces (one per line — “name — purpose”)</Label>
            <Textarea rows={2} value={genie} onChange={(e) => setGenie(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Proposed metric views (one name per line)</Label>
            <Textarea rows={2} value={metrics} onChange={(e) => setMetrics(e.target.value)} />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => void save()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save changes
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
