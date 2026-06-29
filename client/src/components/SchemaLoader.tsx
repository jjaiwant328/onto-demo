// SchemaLoader — upload a describe_table_extended.csv to regenerate the whole
// catalog (session-scoped), with an optional LLM-polish pass and a reset to the
// bundled default. The heuristic always runs client-side; LLM polish calls
// /api/generate-catalog and silently falls back to the heuristic on any failure.
import { useRef, useState, useEffect } from 'react';
import {
  Button,
  Badge,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Checkbox,
} from '@databricks/appkit-ui/react';
import { Upload, RotateCcw, Sparkles, Loader2 } from 'lucide-react';
import { useProduct } from '../lib/product';
import { parseDescribeCsv, buildCatalog } from '../lib/catalogGen';
import type { Catalog } from '../lib/deriveComponents';

export function SchemaLoader() {
  const { catalogSource, applyGeneratedCatalog, resetToDefault } = useProduct();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [useLlm, setUseLlm] = useState(false);
  const [llmAvailable, setLlmAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/llm-status')
      .then((r) => r.json())
      .then((d) => setLlmAvailable(Boolean(d?.available)))
      .catch(() => setLlmAvailable(false));
  }, []);

  const onPick = () => fileRef.current?.click();

  const onFile = async (file: File) => {
    setBusy(true);
    setStatus(null);
    try {
      const text = await file.text();
      const schema = parseDescribeCsv(text);
      const tableCount = Object.keys(schema).length;
      if (tableCount === 0) throw new Error('No tables parsed — is this a describe-extended CSV?');
      let catalog: Catalog = buildCatalog(schema);
      let source: 'uploaded' | 'uploaded+llm' = 'uploaded';

      if (useLlm && llmAvailable) {
        setStatus('Refining with Foundation Model…');
        try {
          const summary = schemaSummary(schema);
          const resp = await fetch('/api/generate-catalog', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ draft: catalog, summary }),
          });
          const data = await resp.json();
          if (data?.llm && data?.catalog?.domains?.length) {
            catalog = sanitizeCatalog(data.catalog, schema);
            source = 'uploaded+llm';
          }
        } catch {
          /* graceful fallback to heuristic */
        }
      }

      applyGeneratedCatalog(catalog, schema, source);
      const products = catalog.domains.reduce((n, d) => n + d.products.length, 0);
      setStatus(
        `Loaded ${tableCount} tables → ${catalog.domains.length} domains, ${products} products` +
          (source === 'uploaded+llm' ? ' (LLM-refined)' : ' (heuristic)')
      );
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Upload className="h-4 w-4" />
          Schema
          {catalogSource !== 'default' && (
            <Badge variant="secondary" className="ml-1">
              {catalogSource === 'uploaded+llm' ? 'custom+AI' : 'custom'}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-3">
          <div>
            <div className="text-sm font-semibold">Load a schema</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Upload a <code>describe_table_extended.csv</code> (catalog, schema, table, column_name,
              data_type, comment). The whole catalog regenerates from it (session-only).
            </p>
          </div>

          <label
            className={`flex items-center gap-2 text-xs ${
              llmAvailable ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'
            }`}
          >
            <Checkbox
              checked={useLlm && !!llmAvailable}
              disabled={!llmAvailable}
              onCheckedChange={(v) => setUseLlm(Boolean(v))}
            />
            <Sparkles className="h-3.5 w-3.5" />
            Refine with Foundation Model
            {llmAvailable === false && <span className="text-muted-foreground">(no endpoint)</span>}
          </label>

          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
          />

          <div className="flex gap-2">
            <Button size="sm" className="flex-1 gap-1.5" onClick={onPick} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                resetToDefault();
                setStatus('Reset to bundled default catalog');
              }}
              disabled={busy}
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
          </div>

          {status && <div className="text-xs text-muted-foreground">{status}</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function schemaSummary(schema: Record<string, { name: string; type: string }[]>): string {
  return Object.entries(schema)
    .map(([t, cols]) => `${t}: ${cols.slice(0, 12).map((c) => `${c.name}:${c.type}`).join(', ')}`)
    .join('\n')
    .slice(0, 12000);
}

// keep only domains/products that reference tables present in the schema, so the
// LLM can't introduce tables/columns that don't exist.
function sanitizeCatalog(catalog: Catalog, schema: Record<string, unknown>): Catalog {
  const has = (t: string) => Object.prototype.hasOwnProperty.call(schema, t);
  const domains = catalog.domains
    .map((d) => ({
      ...d,
      products: d.products
        .map((p) => ({
          ...p,
          fact_tables: (p.fact_tables ?? []).filter(has),
          dim_tables: (p.dim_tables ?? []).filter(has),
          kpis: Array.isArray(p.kpis) && p.kpis.length ? p.kpis : ['record_count'],
          maturity: p.maturity ?? 'incubating',
        }))
        .filter((p) => p.fact_tables.length > 0)
        .slice(0, 4),
    }))
    .filter((d) => d.products.length > 0);
  return { domains: domains.length ? domains : catalog.domains };
}
