// PrintProduct — a print-optimized, standalone document for the selected product:
// product summary + data contract + ontology (classes/mappings/measures) + lineage.
// Zero deps: a dedicated route + @media print CSS; an "Open print dialog" button
// calls window.print() (user saves as PDF).
import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Button } from '@databricks/appkit-ui/react';
import { Printer, ArrowLeft } from 'lucide-react';
import { useProduct } from '../lib/product';
import { deriveContract } from '../lib/contract';
import { useActions } from '../lib/actions';

export function PrintProduct() {
  const { productName } = useParams();
  const navigate = useNavigate();
  const { domains, components, selectedProduct, setSelectedProduct } = useProduct();
  const { queue } = useActions();
  const approvedActions = queue.filter((a) => a.status === 'approved' || a.status === 'modified');

  // ensure the requested product is the selected one (so components match)
  useEffect(() => {
    if (productName && productName !== selectedProduct.product_name) {
      setSelectedProduct(productName);
    }
  }, [productName, selectedProduct.product_name, setSelectedProduct]);

  const product = selectedProduct;
  const domain = domains.find((d) => d.products.some((p) => p.product_name === product.product_name));
  const contract = deriveContract(product, components);
  const generated = new Date().toLocaleString();

  // auto-open the print dialog once the page has settled (only when names match)
  useEffect(() => {
    if (productName !== selectedProduct.product_name) return undefined;
    const t = setTimeout(() => window.print(), 600);
    return () => clearTimeout(t);
  }, [productName, selectedProduct.product_name]);

  return (
    <div className="print-doc">
      <style>{PRINT_CSS}</style>

      {/* screen-only toolbar */}
      <div className="no-print toolbar">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button size="sm" className="gap-1.5" onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Open print dialog (save as PDF)
        </Button>
      </div>

      <header className="doc-header">
        <div className="doc-eyebrow">RT_onto_demo · Data Product Brief</div>
        <h1>{product.display_name}</h1>
        <div className="doc-meta">
          {domain?.label ?? '—'} · {product.live ? 'Live' : 'Schema-derived'} · {product.maturity} ·
          generated {generated}
        </div>
      </header>

      {/* 1. summary */}
      <section>
        <h2>1 · Data Product</h2>
        <table className="kv">
          <tbody>
            <tr>
              <th>Domain</th>
              <td>{domain?.label ?? '—'}</td>
            </tr>
            <tr>
              <th>Status</th>
              <td>{product.live ? 'Live (governed serving views)' : 'Schema-derived (no live serving layer)'}</td>
            </tr>
            <tr>
              <th>Maturity</th>
              <td>{product.maturity}</td>
            </tr>
            <tr>
              <th>Business outcome</th>
              <td>{product.business_outcome}</td>
            </tr>
            <tr>
              <th>Fact tables</th>
              <td>{product.fact_tables.join(', ')}</td>
            </tr>
            <tr>
              <th>Dimension tables</th>
              <td>{product.dim_tables.join(', ')}</td>
            </tr>
            <tr>
              <th>KPIs</th>
              <td>{product.kpis.join(', ')}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* 2. contract */}
      <section>
        <h2>2 · Data Contract</h2>
        <table className="kv">
          <tbody>
            <tr>
              <th>Serving object</th>
              <td>{contract.serving_object}</td>
            </tr>
            <tr>
              <th>Grain</th>
              <td>{contract.grain}</td>
            </tr>
            <tr>
              <th>Freshness SLA</th>
              <td>
                {contract.freshness.sla} (basis: {contract.freshness.basis})
              </td>
            </tr>
            <tr>
              <th>Scope — included</th>
              <td>{contract.scope.included}</td>
            </tr>
            <tr>
              <th>Scope — excluded</th>
              <td>{contract.scope.excluded}</td>
            </tr>
          </tbody>
        </table>

        <h3>Schema ({contract.schema.length} columns)</h3>
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
            {contract.schema.map((c) => (
              <tr key={c.name}>
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
            {contract.quality_checks.map((q) => (
              <tr key={q.id}>
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
          {contract.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </section>

      {/* 3. ontology */}
      <section>
        <h2>3 · Ontology</h2>
        <h3>Entities ({components.classes.length})</h3>
        <table className="grid">
          <thead>
            <tr>
              <th>Entity</th>
              <th>Role</th>
              <th>Source table</th>
            </tr>
          </thead>
          <tbody>
            {components.classes.map((c) => (
              <tr key={c.class}>
                <td>{c.label}</td>
                <td>{c.role}</td>
                <td>{c.source_table}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Column mappings ({components.mappings.length})</h3>
        <table className="grid">
          <thead>
            <tr>
              <th>Entity</th>
              <th>Property</th>
              <th>Role</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {components.mappings.slice(0, 120).map((m, i) => (
              <tr key={`${m.class}-${m.property}-${i}`}>
                <td>{m.class}</td>
                <td>{m.property}</td>
                <td>{m.role}</td>
                <td>{m.type}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Measures &amp; KPIs ({components.measures.length})</h3>
        <table className="grid">
          <thead>
            <tr>
              <th>Measure</th>
              <th>Type</th>
              <th>Formula</th>
            </tr>
          </thead>
          <tbody>
            {components.measures.map((m) => (
              <tr key={m.measure}>
                <td>{m.measure}</td>
                <td>{m.type}</td>
                <td>
                  <code>{m.formula}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* 4. lineage snapshot (static node/edge list) */}
      <section>
        <h2>4 · Lineage</h2>
        <p className="muted">Source tables → serving object → product → KPIs.</p>
        <table className="grid">
          <thead>
            <tr>
              <th>From</th>
              <th>Relationship</th>
              <th>To</th>
            </tr>
          </thead>
          <tbody>
            {components.relationships.map((r, i) => (
              <tr key={`rel-${i}`}>
                <td>{r.from.join(', ')}</td>
                <td>{r.predicate}</td>
                <td>{r.to}</td>
              </tr>
            ))}
            {contract.lineage.sources.map((s, i) => (
              <tr key={`lin-${i}`}>
                <td>{s}</td>
                <td>serves</td>
                <td>{contract.lineage.serving}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* 5. approved actions (in-session, from the Action Center) */}
      {approvedActions.length > 0 && (
        <section>
          <h2>5 · Approved Actions</h2>
          <p className="muted">In-session approvals from the Action Center (simulated execution).</p>
          <table className="grid">
            <thead>
              <tr>
                <th>Priority</th>
                <th>Issue</th>
                <th>Recommended action</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {approvedActions.map((a) => (
                <tr key={a.id}>
                  <td>{a.priority}</td>
                  <td>{a.issue}</td>
                  <td>{a.recommended_action}</td>
                  <td>{a.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="doc-footer">
        RT_onto_demo · {product.display_name} · {contract.name} · generated {generated}
      </footer>
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
.print-doc h3 { font-size: 13px; margin: 14px 0 6px; color: #374151; }
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
