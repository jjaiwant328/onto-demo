// PrintActions — a print-optimized handoff document listing the logged/approved
// actions grouped by domain → product (issue → root cause → recommended action →
// priority → track status), for handing to another team. Reuses the @media-print
// pattern; auto-opens the print dialog. Standalone route: /print/actions.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@databricks/appkit-ui/react';
import { Printer, ArrowLeft } from 'lucide-react';
import { fetchActionLog, type LoggedAction } from '../lib/actionLog';

export function PrintActions() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<LoggedAction[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const data = await fetchActionLog();
      // handoff doc = approved + modified (decisions to act on), newest first
      setRows(data.filter((r) => r.decision === 'approved' || r.decision === 'modified'));
      setLoaded(true);
    })();
  }, []);

  // group by domain → product
  const groups = useMemo(() => {
    const byDomain = new Map<string, Map<string, LoggedAction[]>>();
    for (const r of rows) {
      const dom = r.domain || '—';
      const prod = r.product || '—';
      if (!byDomain.has(dom)) byDomain.set(dom, new Map());
      const byProd = byDomain.get(dom)!;
      if (!byProd.has(prod)) byProd.set(prod, []);
      byProd.get(prod)!.push(r);
    }
    return byDomain;
  }, [rows]);

  const generated = new Date().toLocaleString();

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => window.print(), 600);
    return () => clearTimeout(t);
  }, [loaded]);

  return (
    <div className="print-doc">
      <style>{PRINT_CSS}</style>

      <div className="no-print toolbar">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button size="sm" className="gap-1.5" onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Open print dialog (save as PDF)
        </Button>
      </div>

      <header className="doc-header">
        <div className="doc-eyebrow">Ontology-demo · Action Handoff</div>
        <h1>Approved actions for handoff</h1>
        <div className="doc-meta">
          {rows.length} action(s) · generated {generated}
        </div>
      </header>

      {loaded && rows.length === 0 && (
        <p className="muted">No approved/modified actions in the log yet.</p>
      )}

      {[...groups.entries()].map(([domain, byProd]) => (
        <section key={domain}>
          <h2>{domain}</h2>
          {[...byProd.entries()].map(([product, items]) => (
            <div key={product}>
              <h3>{product}</h3>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Priority</th>
                    <th>Issue</th>
                    <th>Root cause</th>
                    <th>Recommended action</th>
                    <th>Decision</th>
                    <th>Status</th>
                    <th>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.action_id}>
                      <td>{r.priority}</td>
                      <td>{r.issue}</td>
                      <td>{r.root_cause}</td>
                      <td>{r.recommended_action}</td>
                      <td>{r.decision}</td>
                      <td>{r.track_status}</td>
                      <td>{r.decided_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}

      <footer className="doc-footer">
        Ontology-demo · Action handoff · generated {generated}
      </footer>
    </div>
  );
}

const PRINT_CSS = `
.print-doc { max-width: 980px; margin: 0 auto; padding: 24px; color: #111827; background: #fff;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
.print-doc .toolbar { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 16px; }
.print-doc .doc-header { border-bottom: 3px solid #111827; padding-bottom: 12px; margin-bottom: 20px; }
.print-doc .doc-eyebrow { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; }
.print-doc h1 { font-size: 26px; margin: 4px 0; }
.print-doc .doc-meta { font-size: 12px; color: #6b7280; }
.print-doc section { margin: 18px 0; page-break-inside: avoid; }
.print-doc h2 { font-size: 16px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; margin: 18px 0 10px; }
.print-doc h3 { font-size: 13px; margin: 14px 0 6px; color: #374151; }
.print-doc table { width: 100%; border-collapse: collapse; font-size: 11px; margin: 6px 0; }
.print-doc table.grid th { text-align: left; background: #f3f4f6; border: 1px solid #e5e7eb; padding: 4px 6px; }
.print-doc table.grid td { border: 1px solid #e5e7eb; padding: 3px 6px; vertical-align: top; }
.print-doc .muted { color: #6b7280; font-size: 12px; }
.print-doc .doc-footer { margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 8px; font-size: 10px; color: #9ca3af; }
@media print {
  .no-print { display: none !important; }
  .print-doc { padding: 0; max-width: none; }
  @page { margin: 16mm; }
}
`;
