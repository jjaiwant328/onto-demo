// SchemaLoader — two ways to load a schema and regenerate the whole catalog
// (session-scoped) through the SAME hybrid pipeline (heuristic + optional LLM):
//   • Upload CSV      — a describe_table_extended.csv
//   • Live connection — introspect information_schema via the attached warehouse,
//                       with catalog/schema dropdowns AND wildcard patterns.
// "Reset to default" restores the bundled catalog.
import { useRef, useState, useEffect } from 'react';
import {
  Button,
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
import { Upload, RotateCcw, Loader2, Database, Plug, Filter, Users, Trash2 } from 'lucide-react';
import { useProduct } from '../lib/product';
import { parseDescribeCsv } from '../lib/catalogGen';
import { filterBusinessSchema } from '../lib/schemaFilter';
import type { Schema } from '../lib/deriveComponents';

const NEW_CUSTOMER = '__new__';

export function SchemaLoader() {
  const {
    customers,
    customerId,
    addSchema,
    resetCustomers,
    isBundledSchema,
    removeSchema,
    removeCustomer,
  } = useProduct();
  const activeCustomer = customers.find((c) => c.id === customerId);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [filterNote, setFilterNote] = useState<string | null>(null);
  const [includeSystem, setIncludeSystem] = useState(false); // filter ON by default
  // customer assignment for the loaded schema.
  // DEFAULT to "New customer…" so an upload NEVER silently appends to a built-in
  // (Retailer/QSR) — the user must explicitly pick an existing customer to append.
  const [targetCustomer, setTargetCustomer] = useState<string>(NEW_CUSTOMER);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [schemaLabel, setSchemaLabel] = useState('');
  const [pendingFollowNew, setPendingFollowNew] = useState(false);

  // shared: filter noise schemas → assign to a customer (provider generates the catalog).
  const applySchema = async (rawSchema: Schema, label: string) => {
    if (Object.keys(rawSchema).length === 0) throw new Error('No tables found.');

    // Skill: auto-drop pipeline/test/DQ/framework schemas (unless overridden).
    const { schema, excluded, droppedSchemas } = filterBusinessSchema(rawSchema, {
      disable: includeSystem,
    });
    const tableCount = Object.keys(schema).length;
    if (excluded.length > 0) {
      const droppedTables = excluded.reduce((n, e) => n + e.tableCount, 0);
      const names = droppedSchemas.slice(0, 6).join(', ') + (droppedSchemas.length > 6 ? ', …' : '');
      setFilterNote(
        `Filtered ${excluded.length} pipeline/test/DQ schema(s) (${droppedTables} tables): ${names}`
      );
    } else {
      setFilterNote(includeSystem ? 'Filter off — all schemas included.' : 'No noise schemas detected.');
    }

    const isNew = targetCustomer === NEW_CUSTOMER;
    const custName = isNew ? newCustomerName.trim() || 'New customer' : targetCustomer;
    // default label = the detected UC schema names, so entries are distinguishable
    const ucSchemas = Array.from(new Set(Object.keys(schema).map((k) => k.split('.')[0]))).slice(0, 3);
    const entryLabel = schemaLabel.trim() || ucSchemas.join(', ') || `${label} schema`;
    const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const entry = {
      id: `sch_${entryLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${uid}`,
      label: entryLabel,
      schema,
    };
    addSchema(custName, entry, isNew);
    const custLabel = isNew ? custName : customers.find((c) => c.id === custName)?.label ?? custName;
    setStatus(
      `Added "${entryLabel}" (${tableCount} business tables) to customer "${custLabel}". The catalog will regenerate; select 2+ schemas to combine.`
    );
    setSchemaLabel('');
    setNewCustomerName('');
    // For a NEW customer, follow it so a second upload can be appended to the
    // SAME new customer (the provider makes it active). For an EXISTING customer,
    // reset back to "New customer…" so the next upload doesn't silently append.
    setPendingFollowNew(isNew);
  };

  // after creating a NEW customer, point the picker at it (provider activates it)
  useEffect(() => {
    if (pendingFollowNew) {
      setTargetCustomer(customerId);
      setPendingFollowNew(false);
    }
  }, [customerId, pendingFollowNew]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Database className="h-4 w-4" />
          Load schema
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[460px]" align="end">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Load a schema into a customer</div>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                resetCustomers();
                setStatus('Reset customers to defaults (Retailer + QSR).');
                setFilterNote(null);
                setTargetCustomer(NEW_CUSTOMER);
              }}
              disabled={busy}
              title="Clear all uploaded customers/schemas and restore Retailer + QSR"
            >
              <RotateCcw className="h-4 w-4" /> Reset customers
            </Button>
          </div>

          {/* Manage the active customer's schemas (remove appended; delete user customer) */}
          {activeCustomer && (
            <div className="rounded-md border p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" /> {activeCustomer.label} — schemas (
                  {activeCustomer.schemas.length})
                </span>
                {!activeCustomer.builtin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 text-xs text-destructive"
                    onClick={() => {
                      removeCustomer(activeCustomer.id);
                      setStatus(`Deleted customer "${activeCustomer.label}".`);
                    }}
                  >
                    <Trash2 className="h-3 w-3" /> Delete customer
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-0.5">
                {activeCustomer.schemas.map((s) => {
                  const bundled = isBundledSchema(activeCustomer.id, s.id);
                  return (
                    <div
                      key={s.id}
                      className="flex items-center justify-between text-xs rounded px-1.5 py-1 hover:bg-muted"
                    >
                      <span className="truncate">
                        {s.label}
                        {bundled && <span className="text-muted-foreground"> · bundled</span>}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                        disabled={bundled}
                        title={bundled ? 'Bundled schema — not removable' : 'Remove schema'}
                        onClick={() => {
                          removeSchema(activeCustomer.id, s.id);
                          setStatus(`Removed schema "${s.label}" from "${activeCustomer.label}".`);
                        }}
                      >
                        <Trash2
                          className={`h-3.5 w-3.5 ${bundled ? 'opacity-30' : 'text-destructive'}`}
                        />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* customer assignment */}
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" /> Assign to customer
            </Label>
            <Select value={targetCustomer} onValueChange={setTargetCustomer}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Customer" />
              </SelectTrigger>
              <SelectContent>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_CUSTOMER}>New customer…</SelectItem>
              </SelectContent>
            </Select>
            {targetCustomer === NEW_CUSTOMER && (
              <Input
                className="text-xs"
                placeholder="New customer name"
                value={newCustomerName}
                onChange={(e) => setNewCustomerName(e.target.value)}
              />
            )}
            <Input
              className="text-xs"
              placeholder="Schema label (optional, e.g. 'QSR bronze')"
              value={schemaLabel}
              onChange={(e) => setSchemaLabel(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox
              checked={includeSystem}
              onCheckedChange={(v) => setIncludeSystem(Boolean(v))}
            />
            <Filter className="h-3.5 w-3.5" />
            Include system/pipeline schemas
            <span className="text-muted-foreground">(off = auto-drop dbt/test/DQ)</span>
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

          {(status || filterNote) && (
            <div className="text-xs text-muted-foreground border-t pt-2 space-y-1">
              {status && <div>{status}</div>}
              {filterNote && (
                <div className="flex items-start gap-1.5">
                  <Filter className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>{filterNote}</span>
                </div>
              )}
            </div>
          )}
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
