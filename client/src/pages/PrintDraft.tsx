// PrintDraft — a print-optimized, standalone brief for a use-case data-product
// draft: summary + KPIs + tables + proposed Genie spaces + proposed metric views.
// Same pattern as PrintProduct (dedicated route + @media print CSS + auto print).
import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Button } from '@databricks/appkit-ui/react';
import { Printer, ArrowLeft } from 'lucide-react';
import { useProduct } from '../lib/product';
import { parseSpec } from '../lib/useCaseProduct';

export function PrintDraft() {
  const { draftId } = useParams();
  const navigate = useNavigate();
  const { useCaseDrafts } = useProduct();
  const draft = useCaseDrafts.find((d) => d.draft_id === draftId);
  const spec = draft ? parseSpec(draft) : null;
  const generated = new Date().toLocaleString();

  useEffect(() => {
    if (!spec) return;
    const t = setTimeout(() => window.print(), 600);
    return () => clearTimeout(t);
  }, [spec]);

  if (!draft || !spec) {
    return (
      <div className="print-doc">
        <div className="no-print toolbar">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void navigate(-1)}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </div>
        <p>Draft not found. Open it from the Product Drafts tab and export from there.</p>
        <style>{PRINT_CSS}</style>
      </div>
    );
  }

  return (
    <div className="print-doc">
      <style>{PRINT_CSS}</style>

      <div className="no-print toolbar">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void navigate(-1)}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button size="sm" className="gap-1.5" onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Open print dialog (save as PDF)
        </Button>
      </div>

      <header className="doc-header">
        <div className="doc-eyebrow">Ontology-demo · Use-Case Data Product Brief</div>
        <h1>{draft.use_case_title}</h1>
        <div className="doc-meta">
          {draft.domain_name} · status: {draft.status} · {draft.llm_used ? 'LLM-authored' : 'heuristic'} ·
          generated {generated}
        </div>
      </header>

      <section>
        <h2>1 · Summary</h2>
        <p>{spec.summary || '—'}</p>
        <table className="kv">
          <tbody>
            <tr>
              <th>Source products</th>
              <td>{(spec.products ?? []).join(', ') || '—'}</td>
            </tr>
            <tr>
              <th>Status</th>
              <td>{draft.status}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>2 · KPIs ({spec.kpis.length})</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>KPI</th>
              <th>Definition</th>
            </tr>
          </thead>
          <tbody>
            {spec.kpis.map((k, i) => (
              <tr key={`${k.name}-${i}`}>
                <td>{k.name}</td>
                <td>{k.definition || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>3 · Tables ({spec.tables.length})</h2>
        <ul>
          {spec.tables.map((t, i) => (
            <li key={`${t}-${i}`}>
              <code>{t}</code>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>4 · Proposed Genie spaces ({spec.genie_spaces.length})</h2>
        <p className="muted">Proposed — not yet created in the workspace.</p>
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            {spec.genie_spaces.map((g, i) => (
              <tr key={`${g.name}-${i}`}>
                <td>
                  <code>{g.name}</code>
                </td>
                <td>{g.purpose || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>5 · Proposed metric views ({spec.metric_views.length})</h2>
        <p className="muted">Proposed — not yet created in the workspace.</p>
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Dimensions</th>
              <th>Measures</th>
            </tr>
          </thead>
          <tbody>
            {spec.metric_views.map((m, i) => (
              <tr key={`${m.name}-${i}`}>
                <td>
                  <code>{m.name}</code>
                </td>
                <td>{(m.dimensions ?? []).join(', ') || '—'}</td>
                <td>{(m.measures ?? []).join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {spec.contract && (
        <section>
          <h2>6 · Data Contract</h2>
          <table className="kv">
            <tbody>
              <tr>
                <th>Serving object</th>
                <td>
                  {spec.contract.serving_object} <span className="muted">(proposed)</span>
                </td>
              </tr>
              <tr>
                <th>Grain</th>
                <td>{spec.contract.grain}</td>
              </tr>
              <tr>
                <th>Freshness SLA</th>
                <td>
                  {spec.contract.freshness?.sla} (basis: {spec.contract.freshness?.basis})
                </td>
              </tr>
              <tr>
                <th>Scope — included</th>
                <td>{spec.contract.scope?.included}</td>
              </tr>
              <tr>
                <th>Scope — excluded</th>
                <td>{spec.contract.scope?.excluded}</td>
              </tr>
              <tr>
                <th>Lineage</th>
                <td>
                  {(spec.contract.lineage?.sources ?? []).join(', ') || '—'} →{' '}
                  {spec.contract.lineage?.serving}
                </td>
              </tr>
            </tbody>
          </table>

          <h3>Schema ({spec.contract.schema?.length ?? 0} columns)</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>Key</th>
              </tr>
            </thead>
            <tbody>
              {(spec.contract.schema ?? []).map((c, i) => (
                <tr key={`${c.name}-${i}`}>
                  <td>{c.name}</td>
                  <td>{c.type}</td>
                  <td>{c.nullable ? 'yes' : 'no'}</td>
                  <td>{c.key ? 'key' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Quality checks</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>ID</th>
                <th>Rule</th>
              </tr>
            </thead>
            <tbody>
              {(spec.contract.quality_checks ?? []).map((q, i) => (
                <tr key={`${q.id}-${i}`}>
                  <td>{q.id}</td>
                  <td>
                    <code>{q.rule}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Assumptions</h3>
          <ul>
            {(spec.contract.assumptions ?? []).map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="doc-footer">
        Ontology-demo · use-case data product · {draft.use_case_title} · generated {generated}
      </div>
    </div>
  );
}

const PRINT_CSS = `
.print-doc { max-width: 880px; margin: 0 auto; padding: 24px; color: #111827; background: #fff;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
.print-doc .toolbar { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 16px; }
.print-doc .doc-header { border-bottom: 3px solid #111827; padding-bottom: 12px; margin-bottom: 20px; }
.print-doc .doc-eyebrow { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; }
.print-doc h1 { font-size: 26px; margin: 4px 0; }
.print-doc .doc-meta { font-size: 12px; color: #6b7280; }
.print-doc section { margin: 18px 0; page-break-inside: avoid; }
.print-doc h2 { font-size: 16px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; margin: 18px 0 10px; }
.print-doc table { width: 100%; border-collapse: collapse; font-size: 11px; margin: 6px 0; }
.print-doc table.kv th { text-align: left; width: 160px; vertical-align: top; color: #6b7280; font-weight: 600; padding: 3px 8px 3px 0; }
.print-doc table.kv td { padding: 3px 0; }
.print-doc table.grid th { text-align: left; background: #f3f4f6; border: 1px solid #e5e7eb; padding: 4px 6px; }
.print-doc table.grid td { border: 1px solid #e5e7eb; padding: 3px 6px; vertical-align: top; }
.print-doc code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.print-doc ul { margin: 6px 0; padding-left: 18px; font-size: 11px; }
.print-doc .muted { color: #6b7280; font-size: 11px; }
.print-doc .doc-footer { margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 8px; font-size: 10px; color: #9ca3af; }
@media print {
  .no-print { display: none !important; }
  .print-doc { padding: 0; max-width: none; }
  @page { margin: 16mm; }
}
`;
