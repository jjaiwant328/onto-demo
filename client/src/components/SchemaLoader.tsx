// SchemaLoader — two ways to load a schema and regenerate the whole catalog
// (session-scoped) through the SAME hybrid pipeline (heuristic + optional LLM):
//   • Upload CSV      — a describe_table_extended.csv
//   • Live connection — introspect information_schema via the attached warehouse,
//                       with catalog/schema dropdowns AND wildcard patterns.
// "Reset to default" restores the bundled catalog.
import { useRef, useState, useEffect } from 'react';
import {
  Button,
  Badge,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Checkbox,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Input,
  Label,
} from '@databricks/appkit-ui/react';
import { Upload, RotateCcw, Sparkles, Loader2, Database, Plug } from 'lucide-react';
import { useProduct } from '../lib/product';
import { parseDescribeCsv, buildCatalog } from '../lib/catalogGen';
import type { Catalog, Schema } from '../lib/deriveComponents';

export function SchemaLoader() {
  const { catalogSource, applyGeneratedCatalog, resetToDefault } = useProduct();
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

  // shared: run a schema map through heuristic + optional LLM, then apply
  const applySchema = async (schema: Schema, label: string) => {
    const tableCount = Object.keys(schema).length;
    if (tableCount === 0) throw new Error('No tables found.');
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
      `${label}: ${tableCount} tables → ${catalog.domains.length} domains, ${products} products` +
        (source === 'uploaded+llm' ? ' (LLM-refined)' : ' (heuristic)')
    );
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Database className="h-4 w-4" />
          Schema
          {catalogSource !== 'default' && (
            <Badge variant="secondary" className="ml-1">
              {catalogSource === 'uploaded+llm' ? 'custom+AI' : 'custom'}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px]" align="end">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Load a schema</div>
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
              <RotateCcw className="h-4 w-4" /> Reset
            </Button>
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

          <Tabs defaultValue="upload">
            <TabsList className="w-full">
              <TabsTrigger value="upload" className="flex-1 gap-1.5">
                <Upload className="h-3.5 w-3.5" /> Upload CSV
              </TabsTrigger>
              <TabsTrigger value="live" className="flex-1 gap-1.5">
                <Plug className="h-3.5 w-3.5" /> Live connection
              </TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="mt-3">
              <UploadTab
                busy={busy}
                setBusy={setBusy}
                setStatus={setStatus}
                onSchema={(s) => applySchema(s, 'Uploaded')}
              />
            </TabsContent>

            <TabsContent value="live" className="mt-3">
              <LiveTab
                busy={busy}
                setBusy={setBusy}
                setStatus={setStatus}
                onSchema={(s) => applySchema(s, 'Live')}
              />
            </TabsContent>
          </Tabs>

          {status && <div className="text-xs text-muted-foreground border-t pt-2">{status}</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------- Upload CSV tab ----------
function UploadTab({
  busy,
  setBusy,
  setStatus,
  onSchema,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  setStatus: (s: string | null) => void;
  onSchema: (schema: Schema) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const onFile = async (file: File) => {
    setBusy(true);
    setStatus(null);
    try {
      const text = await file.text();
      const schema = parseDescribeCsv(text);
      await onSchema(schema);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Upload a <code>describe_table_extended.csv</code> (catalog, schema, table, column_name,
        data_type, comment). Generate one with <code>scripts/generate_schema_csv.py</code>.
      </p>
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
      <Button
        size="sm"
        className="w-full gap-1.5"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        Upload CSV
      </Button>
    </div>
  );
}

// ---------- Live connection tab ----------
function LiveTab({
  busy,
  setBusy,
  setStatus,
  onSchema,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  setStatus: (s: string | null) => void;
  onSchema: (schema: Schema) => Promise<void>;
}) {
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [catalog, setCatalog] = useState('');
  const [catalogPat, setCatalogPat] = useState('');
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState('');
  const [schemaPat, setSchemaPat] = useState('');
  const [tablePat, setTablePat] = useState('*');

  useEffect(() => {
    fetch('/api/catalogs')
      .then((r) => r.json())
      .then((d) => setCatalogs(Array.isArray(d?.catalogs) ? d.catalogs : []))
      .catch(() => setCatalogs([]));
  }, []);

  useEffect(() => {
    if (!catalog) {
      setSchemas([]);
      return;
    }
    fetch(`/api/schemas?catalog=${encodeURIComponent(catalog)}`)
      .then((r) => r.json())
      .then((d) => setSchemas(Array.isArray(d?.schemas) ? d.schemas : []))
      .catch(() => setSchemas([]));
  }, [catalog]);

  const run = async () => {
    const cat = catalogPat.trim() || catalog;
    if (!cat) {
      setStatus('Pick a catalog or enter a catalog pattern.');
      return;
    }
    setBusy(true);
    setStatus('Introspecting information_schema…');
    try {
      const resp = await fetch('/api/introspect-schema', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          catalog: cat,
          schema: schemaPat.trim() || schema || '*',
          table: tablePat.trim() || '*',
        }),
      });
      const data = await resp.json();
      const schemaMap = (data?.schema ?? {}) as Schema;
      const tableCount = Object.keys(schemaMap).length;
      if (tableCount === 0) {
        const warn = (data?.warnings ?? []).join(' ') || data?.error || 'No tables matched.';
        setStatus(`No tables loaded — ${warn}`);
        return;
      }
      await onSchema(schemaMap);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-muted-foreground">
        Introspect a live catalog via the attached warehouse. Pick a catalog/schema, or use a
        wildcard pattern (<code>*</code> or <code>%</code>). Patterns override the dropdown.
      </p>

      <div className="space-y-1">
        <Label className="text-xs">Catalog</Label>
        <Select value={catalog} onValueChange={setCatalog}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={catalogs.length ? 'Select catalog' : 'Loading…'} />
          </SelectTrigger>
          <SelectContent>
            {catalogs.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="text-xs"
          placeholder="…or catalog pattern e.g. jai_*"
          value={catalogPat}
          onChange={(e) => setCatalogPat(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Schema</Label>
        <Select value={schema} onValueChange={setSchema}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={schemas.length ? 'Select schema' : 'pick a catalog first'} />
          </SelectTrigger>
          <SelectContent>
            {schemas.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="text-xs"
          placeholder="…or schema pattern e.g. * or demo_*"
          value={schemaPat}
          onChange={(e) => setSchemaPat(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Table pattern</Label>
        <Input
          className="text-xs"
          placeholder="* (all) or dim_*"
          value={tablePat}
          onChange={(e) => setTablePat(e.target.value)}
        />
      </div>

      <Button size="sm" className="w-full gap-1.5" onClick={run} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
        Introspect &amp; generate
      </Button>
    </div>
  );
}

function schemaSummary(schema: Record<string, { name: string; type: string }[]>): string {
  return Object.entries(schema)
    .map(([t, cols]) => `${t}: ${cols.slice(0, 12).map((c) => `${c.name}:${c.type}`).join(', ')}`)
    .join('\n')
    .slice(0, 12000);
}

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
