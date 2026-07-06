// Ontology Studio — the semantic adapter: entities/classes derived from the
// selected product's tables, with column mappings (role badges) and validation.
// Validation queries the warehouse only for `live` products; others are clearly
// labelled schema-derived (no live serving layer).
import { useEffect, useMemo, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
  Button,
  Switch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Input,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Label,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@databricks/appkit-ui/react';
import { CheckCircle2, XCircle, AlertTriangle, Info, Check, X, Trash2, BookText, Sparkles, Loader2, ShieldCheck, FileCode, Link2, ExternalLink, Plus } from 'lucide-react';
import { useProduct } from '../lib/product';
import { LiveValidation } from './LiveValidation';
import { CatalogLoadingSkeleton } from '../components/LoadingSkeleton';
import { generateServingView } from '../lib/servingView';
import { deriveContract } from '../lib/contract';
import {
  suggestRelationships,
  validateOntology,
  verifyViewSql,
  type SuggestedRelationship,
  type ValidationResult,
} from '../lib/ontologyOverrides';
import { fetchProductLinks, attachLink, deleteLink, type ProductLink } from '../lib/productLinks';

// compact relative time ("3m ago", "2h ago", "5d ago")
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Inline business-glossary editor for an entity or measure. Saves a
// kind='glossary' override; shows a "glossary" indicator when set.
export function GlossaryCell({
  termType,
  name,
  definition,
  synonyms,
  hasOverride,
  onSave,
  onClear,
}: {
  termType: 'entity' | 'measure';
  name: string;
  definition?: string;
  synonyms?: string[];
  hasOverride: boolean;
  onSave: (def: string, syn: string[]) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [def, setDef] = useState(definition ?? '');
  const [syn, setSyn] = useState((synonyms ?? []).join(', '));
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setDef(definition ?? '');
          setSyn((synonyms ?? []).join(', '));
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1 text-xs ${hasOverride ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          title={hasOverride ? 'Edit glossary' : 'Add definition / synonyms'}
        >
          <BookText className="h-3.5 w-3.5" />
          {hasOverride ? 'glossary' : 'define'}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3 space-y-2" align="start">
        <div className="text-xs font-medium">
          Glossary — {termType}: <span className="text-muted-foreground">{name}</span>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Definition</Label>
          <Input className="text-xs" value={def} onChange={(e) => setDef(e.target.value)} placeholder="Business definition" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Synonyms (comma-separated)</Label>
          <Input className="text-xs" value={syn} onChange={(e) => setSyn(e.target.value)} placeholder="e.g. store, location, site" />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              onSave(
                def.trim(),
                syn.split(',').map((s) => s.trim()).filter(Boolean)
              );
              setOpen(false);
            }}
          >
            Save
          </Button>
          {hasOverride && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function OntologyStudio() {
  const {
    components,
    selectedProduct,
    catalogLoading,
    rebuilding,
    activeSourceCatalog,
    saveOntologyOverride,
    deleteOntologyOverride,
    ontologyOverrides,
    getScopeCache,
    setScopeCache,
    scopedDomains,
    selectedSchemaIds,
    schemaEntries,
  } = useProduct();
  const { classes, mappings, relationships, live } = components;

  // context for attaching product links (step 6): the schema label + the domain
  // that contains the selected product.
  const schemaLabel =
    selectedSchemaIds.length === 1
      ? (schemaEntries.find((s) => s.id === selectedSchemaIds[0])?.label ?? '1 schema')
      : `${selectedSchemaIds.length} schemas combined`;
  const selectedDomain = useMemo(
    () =>
      scopedDomains.find((d) =>
        d.products.some((p) => p.product_name === selectedProduct?.product_name)
      ),
    [scopedDomains, selectedProduct]
  );

  // quick lookup: is there an override for a given ref (by key)?
  const overrideFor = (kind: string, ref: string, action: string) =>
    ontologyOverrides.find((o) => o.kind === kind && o.ref === ref && o.action === action);

  // B) LLM-suggested relationships (accept/reject)
  const [suggestions, setSuggestions] = useState<SuggestedRelationship[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  // C) validate-against-data result (cached per scope)
  const [validation, setValidation] = useState<ValidationResult | null>(
    () => getScopeCache<ValidationResult>('validation') ?? null
  );
  const [validating, setValidating] = useState(false);
  // serving-view SQL live verification (EXPLAIN dry-run against the warehouse)
  const [viewCheck, setViewCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  // dismissible "How this works" stepper
  const [showSteps, setShowSteps] = useState(() => {
    try {
      return localStorage.getItem('rt_onto_hide_steps') !== '1';
    } catch {
      return true;
    }
  });
  const dismissSteps = () => {
    setShowSteps(false);
    try {
      localStorage.setItem('rt_onto_hide_steps', '1');
    } catch {
      /* ignore */
    }
  };

  const roles = useMemo<string[]>(
    () => Array.from(new Set(mappings.map((m) => m.role as string))).sort(),
    [mappings]
  );
  const [activeRoles, setActiveRoles] = useState<string[]>(roles);
  // keep filter valid when the product (and thus role set) changes
  const effectiveRoles = activeRoles.filter((r) => roles.includes(r));
  const shownRoles = effectiveRoles.length ? effectiveRoles : roles;
  const filteredMappings = mappings.filter((m) => shownRoles.includes(m.role));

  // tables + columns of the current product (for suggest/validate payloads)
  const productTables = components.tables.map((t) => ({
    table: t.table,
    columns: t.columns.map((c) => c.name),
  }));
  const singleTable = productTables.length < 2; // no cross-table joins to suggest

  // persisted per-product suggest status (item 1)
  const suggestStatus = (() => {
    const ov = ontologyOverrides.find(
      (o) => o.kind === 'suggest_status' && o.ref === selectedProduct.product_name
    );
    if (!ov?.value) return null;
    try {
      return JSON.parse(ov.value) as { state?: string; count?: number; last_run_at?: string };
    } catch {
      return null;
    }
  })();
  const suggestStatusLabel = (() => {
    if (!suggestStatus?.last_run_at) return 'Not run yet';
    const when = relativeTime(suggestStatus.last_run_at);
    return suggestStatus.state === 'found'
      ? `Ran ${when} — ${suggestStatus.count ?? 0} found`
      : `Ran ${when} — none found`;
  })();
  const runSuggest = async () => {
    setSuggesting(true);
    setSuggestNote(null);
    const s = await suggestRelationships({
      product: selectedProduct.product_name,
      tables: productTables,
    });
    // hide ones the user already rejected or already added
    const rejected = new Set(
      ontologyOverrides
        .filter((o) => o.kind === 'relationship' && o.action === 'reject')
        .map((o) => o.ref)
    );
    const filtered = s.filter((x) => !rejected.has(`${x.from}|${x.predicate}|${x.to}`));
    setSuggestions(filtered);
    setSuggestNote(
      filtered.length
        ? null
        : 'No new joins — the detected joins look complete (or add related tables / Validate against data).'
    );
    // persist per-product suggest status (item 1)
    void saveOntologyOverride({
      product: selectedProduct.product_name,
      kind: 'suggest_status',
      ref: selectedProduct.product_name,
      action: 'define',
      value: {
        state: filtered.length ? 'found' : 'none',
        count: filtered.length,
        last_run_at: new Date().toISOString(),
      },
    });
    setSuggesting(false);
  };
  const runValidate = async () => {
    setValidating(true);
    // catalog-qualify the product's fact/dim tables + FK relationships
    const tables = components.tables.map((t) => ({
      table: t.table,
      keys: t.columns.filter((c) => c.role === 'key').map((c) => c.name),
    }));
    const relationships = components.relationships
      .filter((r) => r.status !== 'rejected')
      .map((r) => {
        const fromT = components.tables.find((t) => t.table.endsWith(r.from[0]) || t.label === r.from[0]);
        const toT = components.tables.find((t) => t.table.endsWith(r.to) || t.label === r.to);
        // fromColumn/toColumn default to predicate (same-named heuristic FK);
        // accepted LLM suggestions carry differently-named keys.
        return fromT && toT
          ? {
              from: fromT.table,
              to: toT.table,
              column: r.predicate,
              fromColumn: r.fromColumn ?? r.predicate,
              toColumn: r.toColumn ?? r.predicate,
            }
          : null;
      })
      .filter(
        (x): x is { from: string; to: string; column: string; fromColumn: string; toColumn: string } =>
          x != null
      );
    const v = await validateOntology({ product: selectedProduct.product_name, tables, relationships });
    setValidation(v);
    if (v) setScopeCache('validation', v);
    setValidating(false);
  };

  // C) generate serving view + contract (deferred DDL; preview + copy + export)
  const served = useMemo(
    () => generateServingView(selectedProduct, components),
    [selectedProduct, components]
  );
  const contract = useMemo(
    () => deriveContract(selectedProduct, components, { servingObject: served.name }),
    [selectedProduct, components, served.name]
  );
  const runVerifyView = async () => {
    setVerifying(true);
    setViewCheck(await verifyViewSql(served.sql));
    setVerifying(false);
  };

  if (catalogLoading) return <CatalogLoadingSkeleton label="Generating ontology…" />;
  if (rebuilding) return <CatalogLoadingSkeleton label="Rebuilding…" />;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Ontology Studio</h2>
        <p className="text-muted-foreground">
          The semantic adapter for <span className="font-medium">{selectedProduct.display_name}</span>:
          entities derived from the product's tables, mapped onto physical columns.
        </p>
      </div>

      {/* "How this works" stepper (dismissible) */}
      {showSteps && (
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="font-medium text-foreground">How this works:</span>
              {[
                'Review derived ontology',
                'Suggest relationships',
                'Confirm / Reject',
                'Validate against data',
                'Generate serving view + contract',
                'Attach Genie / Dashboard',
              ].map((step, i) => (
                <span key={step} className="flex items-center gap-2 text-muted-foreground">
                  <Badge variant="secondary" className="text-[10px]">
                    {i + 1}
                  </Badge>
                  {step}
                  {i < 5 && <span className="text-muted-foreground/50">→</span>}
                </span>
              ))}
            </div>
            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={dismissSteps} aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Classes / entities</CardTitle>
          <CardDescription>One per source table ({classes.length})</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entity</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Grain</TableHead>
                <TableHead>Source table</TableHead>
                <TableHead>Glossary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {classes.map((c) => {
                const gloss = overrideFor('glossary', c.class, 'define');
                return (
                  <TableRow key={c.class}>
                    <TableCell className="font-medium">{c.label}</TableCell>
                    <TableCell>
                      <Badge variant={c.role === 'fact' ? 'default' : 'secondary'}>{c.role}</Badge>
                    </TableCell>
                    <TableCell>{c.grain}</TableCell>
                    <TableCell>
                      <code className="text-xs">{c.source_table}</code>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-0.5">
                        {c.definition && (
                          <div className="text-xs text-muted-foreground max-w-[280px] truncate">
                            {c.definition}
                            {c.synonyms?.length ? ` · ${c.synonyms.join(', ')}` : ''}
                          </div>
                        )}
                        <GlossaryCell
                          termType="entity"
                          name={c.label}
                          definition={c.definition}
                          synonyms={c.synonyms}
                          hasOverride={Boolean(gloss)}
                          onSave={(def, syn) =>
                            void saveOntologyOverride({
                              product: selectedProduct.product_name,
                              kind: 'glossary',
                              ref: c.class,
                              action: 'define',
                              value: { term_type: 'entity', definition: def, synonyms: syn },
                            })
                          }
                          onClear={() => gloss && void deleteOntologyOverride(gloss.id)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Business → physical mapping</CardTitle>
            <CardDescription>
              How entity properties bind to physical columns ({mappings.length})
            </CardDescription>
          </div>
          {roles.length > 0 && (
            <ToggleGroup
              type="multiple"
              value={shownRoles}
              onValueChange={(v) => setActiveRoles(v.length ? v : roles)}
              variant="outline"
              size="sm"
            >
              {roles.map((r) => (
                <ToggleGroupItem key={r} value={r} aria-label={r}>
                  {r}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        </CardHeader>
        <CardContent>
          <div className="max-h-[480px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Entity</TableHead>
                  <TableHead>Property</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>PII</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMappings.map((m, i) => {
                  const ref = `${m.class}.${m.column}`;
                  const roleOv = overrideFor('mapping', ref, 'set_role');
                  const piiOv = overrideFor('mapping', ref, 'set_pii');
                  return (
                    <TableRow key={`${m.class}-${m.property}-${i}`}>
                      <TableCell className="font-medium">{m.class}</TableCell>
                      <TableCell>{m.property}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Select
                            value={m.role}
                            onValueChange={(v) =>
                              void saveOntologyOverride({
                                product: selectedProduct.product_name,
                                kind: 'mapping',
                                ref,
                                action: 'set_role',
                                value: { role: v },
                              })
                            }
                          >
                            <SelectTrigger className="h-7 w-28 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="key">key</SelectItem>
                              <SelectItem value="measure">measure</SelectItem>
                              <SelectItem value="attribute">attribute</SelectItem>
                            </SelectContent>
                          </Select>
                          {m.origin === 'user' && (
                            <Badge variant="outline" className="text-[10px]">
                              edited
                            </Badge>
                          )}
                          {roleOv && (
                            <button
                              type="button"
                              className="text-[10px] text-muted-foreground hover:text-destructive"
                              title="Clear role override"
                              onClick={() => void deleteOntologyOverride(roleOv.id)}
                            >
                              clear
                            </button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Switch
                            checked={Boolean(m.pii)}
                            onCheckedChange={(v) =>
                              void saveOntologyOverride({
                                product: selectedProduct.product_name,
                                kind: 'mapping',
                                ref,
                                action: 'set_pii',
                                value: { pii: Boolean(v) },
                              })
                            }
                            aria-label="PII"
                          />
                          {piiOv && (
                            <button
                              type="button"
                              className="text-[10px] text-muted-foreground hover:text-destructive"
                              title="Clear PII override"
                              onClick={() => void deleteOntologyOverride(piiOv.id)}
                            >
                              clear
                            </button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{m.type}</TableCell>
                      <TableCell>
                        <code className="text-xs">{m.source}</code>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Relationships — origin + confidence, with confirm/reject/delete */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Relationships (inferred lineage / FKs)</CardTitle>
          <CardDescription>
            Confirm trusted edges, reject spurious ones, or delete an FK. Confirmed edges become
            user-trusted; rejected edges are hidden downstream.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {relationships.length === 0 ? (
            <p className="text-sm text-muted-foreground">No relationships inferred.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>From → To</TableHead>
                  <TableHead>Origin</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead className="text-right">Curate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {relationships.map((r, i) => {
                  const ref = `${r.from.join(',')}>${r.to}:${r.predicate}`;
                  const confirmOv = overrideFor('edge_status', ref, 'confirm');
                  const rejectOv = overrideFor('edge_status', ref, 'reject');
                  return (
                    <TableRow key={`${ref}-${i}`}>
                      <TableCell className="font-medium">
                        {r.from.join(', ')} <span className="text-muted-foreground">·{r.predicate}·</span> {r.to}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.origin === 'user' ? 'default' : 'outline'} className="text-[10px]">
                          {r.origin ?? 'heuristic'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {r.status === 'confirmed'
                            ? '100% (confirmed)'
                            : `${Math.round((r.confidence ?? 0.6) * 100)}%`}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            size="sm"
                            variant={r.status === 'confirmed' ? 'default' : 'ghost'}
                            className="h-7 px-2"
                            title="Confirm (trusted)"
                            onClick={() =>
                              confirmOv
                                ? void deleteOntologyOverride(confirmOv.id)
                                : void saveOntologyOverride({
                                    product: selectedProduct.product_name,
                                    kind: 'edge_status',
                                    ref,
                                    action: 'confirm',
                                    value: { predicate: r.predicate },
                                  })
                            }
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant={r.status === 'rejected' ? 'default' : 'ghost'}
                            className="h-7 px-2"
                            title="Reject (hide)"
                            onClick={() =>
                              rejectOv
                                ? void deleteOntologyOverride(rejectOv.id)
                                : void saveOntologyOverride({
                                    product: selectedProduct.product_name,
                                    kind: 'edge_status',
                                    ref,
                                    action: 'reject',
                                    value: { predicate: r.predicate },
                                  })
                            }
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-destructive"
                            title="Delete this FK/relationship"
                            onClick={() =>
                              void saveOntologyOverride({
                                product: selectedProduct.product_name,
                                kind: 'relationship',
                                ref,
                                action: 'delete',
                                value: { predicate: r.predicate },
                              })
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* B) LLM-suggested relationships (accept/reject) */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Suggested relationships
              <Badge variant="outline" className="text-[10px] font-normal">
                {suggestStatusLabel}
              </Badge>
            </CardTitle>
            <CardDescription>
              LLM-proposed joins the shared-key heuristic missed (semantic name matches). Confirm to
              add to the ontology; reject to hide.
            </CardDescription>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 shrink-0"
                    disabled={suggesting || singleTable}
                    onClick={runSuggest}
                  >
                    {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    Suggest relationships
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {singleTable
                  ? 'Only one table — no cross-table joins to suggest.'
                  : 'Runs an LLM to propose joins the auto-detector missed — best for products spanning multiple tables.'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </CardHeader>
        <CardContent className="space-y-2">
          {suggestNote && <p className="text-sm text-muted-foreground">{suggestNote}</p>}
          {suggestions.length === 0 && !suggestNote && (
            <p className="text-sm text-muted-foreground">
              Click "Suggest relationships" to ask the model for candidate joins.
            </p>
          )}
          {suggestions.map((s, i) => {
            const ref = `${s.from}|${s.predicate}|${s.to}`;
            return (
              <div
                key={`${ref}-${i}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm bg-muted/20"
              >
                <span className="font-medium">{s.from}</span>
                <span className="text-muted-foreground text-xs">·{s.predicate}·</span>
                <span className="font-medium">{s.to}</span>
                <Badge variant="outline" className="text-[10px]">
                  llm-suggested · {Math.round((s.confidence ?? 0.4) * 100)}%
                </Badge>
                {s.rationale && <span className="text-xs text-muted-foreground">{s.rationale}</span>}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-emerald-600"
                    title="Confirm — add to ontology"
                    onClick={() => {
                      void saveOntologyOverride({
                        product: selectedProduct.product_name,
                        kind: 'relationship',
                        ref,
                        action: 'add',
                        value: {
                          from: s.from,
                          to: s.to,
                          predicate: s.predicate,
                          column: s.column,
                          toColumn: s.toColumn,
                        },
                      });
                      setSuggestions((prev) => prev.filter((x) => `${x.from}|${x.predicate}|${x.to}` !== ref));
                    }}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-destructive"
                    title="Reject — don't show again"
                    onClick={() => {
                      void saveOntologyOverride({
                        product: selectedProduct.product_name,
                        kind: 'relationship',
                        ref,
                        action: 'reject',
                        value: { predicate: s.predicate },
                      });
                      setSuggestions((prev) => prev.filter((x) => `${x.from}|${x.predicate}|${x.to}` !== ref));
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* C) Validate ontology against live data */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" /> Validate against data
            </CardTitle>
            <CardDescription>
              Runs warehouse checks on the product's real tables: row counts, key null/distinct %, and
              FK join hit-rate. Inaccessible catalogs are marked "no access".
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" className="gap-1.5 shrink-0" disabled={validating} onClick={runValidate}>
            {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Validate against data
          </Button>
        </CardHeader>
        {validation && (
          <CardContent className="space-y-3">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Tables</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Table</TableHead>
                    <TableHead>Rows</TableHead>
                    <TableHead>Key null% / distinct%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {validation.tables.map((t) => (
                    <TableRow key={t.table}>
                      <TableCell className="font-medium"><code className="text-xs">{t.table}</code></TableCell>
                      <TableCell>
                        {t.error ? (
                          <Badge variant="outline" className="text-[10px]">{t.error}</Badge>
                        ) : (
                          (t.row_count ?? 0).toLocaleString()
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {(t.keys ?? []).map((k) =>
                          k.error ? `${k.column}: —` : `${k.column}: ${k.null_pct}% / ${k.distinct_pct}%`
                        ).join(' · ') || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {validation.relationships.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Foreign-key hit-rate</div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>From → To</TableHead>
                      <TableHead>Column</TableHead>
                      <TableHead>Hit-rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {validation.relationships.map((r, i) => {
                      const low = typeof r.hit_rate === 'number' && r.hit_rate < 50;
                      return (
                        <TableRow key={`${r.from}-${r.to}-${i}`}>
                          <TableCell className="text-xs">
                            <code>{r.from}</code> → <code>{r.to}</code>
                          </TableCell>
                          <TableCell className="text-xs">
                            {r.from_column && r.to_column && r.from_column !== r.to_column ? (
                              <code>
                                {r.from_column} = {r.to_column}
                              </code>
                            ) : (
                              r.from_column ?? r.column
                            )}
                          </TableCell>
                          <TableCell>
                            {r.error ? (
                              <Badge variant="outline" className="text-[10px]">{r.error}</Badge>
                            ) : r.hit_rate == null ? (
                              '—'
                            ) : (
                              <Badge variant={low ? 'outline' : 'default'} className={low ? 'text-amber-600' : ''}>
                                {r.hit_rate}%{low ? ' — low match, likely not a real FK' : ''}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* item 3 — Generate serving view + contract (deferred DDL; preview/copy) */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <FileCode className="h-4 w-4 text-primary" /> Serving view + contract
            </CardTitle>
            <CardDescription>
              A conformed <code>CREATE VIEW</code> from the fact table + confirmed relationships, plus
              the derived data contract. Executing the DDL is deferred (needs a one-time CREATE grant):
              preview, verify, and copy here; it is also in the exported brief.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={verifying}
              title="Dry-run the view's SELECT (EXPLAIN) against the warehouse — no view is created"
              onClick={() => void runVerifyView()}
            >
              {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              Verify
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => void navigator.clipboard?.writeText(served.sql)}
            >
              Copy SQL
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="text-xs text-muted-foreground">
            Target: <code>{served.name}</code> · {served.note}
          </div>
          {viewCheck && (
            <div
              className={`flex items-start gap-1.5 rounded-md p-2 text-xs ${
                viewCheck.ok ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'
              }`}
            >
              {viewCheck.ok ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>Verified — the SELECT resolves against the live warehouse; this DDL will run.</span>
                </>
              ) : (
                <>
                  <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>Won't run: {viewCheck.error}</span>
                </>
              )}
            </div>
          )}
          <pre className="text-xs bg-muted rounded-md p-3 overflow-x-auto whitespace-pre">{served.sql}</pre>
          <div className="text-xs text-muted-foreground">
            Contract serving object: <code>{contract.serving_object}</code> · grain: {contract.grain}
          </div>
        </CardContent>
      </Card>

      {/* item 6 — Attach Genie / Dashboard (surfaces in the ontology map) */}
      {selectedProduct && (
        <AttachLinksCard
          product={selectedProduct.display_name}
          productName={selectedProduct.product_name}
          domainName={selectedDomain?.name ?? ''}
          domainLabel={selectedDomain?.label ?? selectedDomain?.name ?? ''}
          schemaLabel={schemaLabel}
        />
      )}

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Validation status</CardTitle>
          <CardDescription>
            {live
              ? 'Live check against the governed serving view'
              : 'Schema-derived product — no live serving layer'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {live ? (
            // Keyed so the hook-bearing live component remounts per live product.
            <LiveValidation key={selectedProduct.product_name} />
          ) : (
            <SchemaDerivedNotice
              tableCount={classes.length}
              columnCount={mappings.length}
              sourceCatalog={activeSourceCatalog}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SchemaDerivedNotice({
  tableCount,
  columnCount,
  sourceCatalog,
}: {
  tableCount: number;
  columnCount: number;
  sourceCatalog?: string | null;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm">
        <Info className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground">
          This product's components are <span className="font-medium">schema-derived</span> from{' '}
          {sourceCatalog ? (
            <>
              the live <code>{sourceCatalog}</code> catalog
            </>
          ) : (
            'the source catalog'
          )}{' '}
          (no governed serving layer yet). The mappings above reflect the real source tables; build
          the serving views + contract to make it live.
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Check</TableHead>
            <TableHead className="w-16 text-right">OK</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <CheckRow label={`Source tables resolved (${tableCount})`} ok={tableCount > 0} />
          <CheckRow label={`Columns resolved from schema (${columnCount})`} ok={columnCount > 0} />
          <CheckRow
            label="Governed serving view present"
            ok={false}
            warn
            tooltip="A governed serving view is a stable, contract-backed view (e.g. jai_ontos.demo_schema.jai_<product>_serving) that conforms the raw source tables into the product's business shape. This product is still schema-derived straight from source tables — no serving view exists yet, so downstream consumers are reading raw tables that can change. Generate + run the serving view (above) to clear this warning."
          />
        </TableBody>
      </Table>
    </div>
  );
}

function CheckRow({
  label,
  ok,
  warn,
  tooltip,
}: {
  label: string;
  ok: boolean;
  warn?: boolean;
  tooltip?: string;
}) {
  return (
    <TableRow>
      <TableCell className="text-sm">
        {tooltip ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 cursor-help border-b border-dotted border-muted-foreground/40">
                  {label}
                  <Info className="h-3 w-3 text-muted-foreground" />
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-xs">{tooltip}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          label
        )}
      </TableCell>
      <TableCell className="text-right">
        {ok ? (
          <CheckCircle2 className="h-4 w-4 text-success inline" />
        ) : warn ? (
          <AlertTriangle className="h-4 w-4 text-amber-500 inline" />
        ) : (
          <XCircle className="h-4 w-4 text-destructive inline" />
        )}
      </TableCell>
    </TableRow>
  );
}

// Prebuilt sample dashboards/Genie spaces we can offer as a one-click attach for
// a given domain. Matched by domain name; the URL points at a real workspace
// artifact so it renders in the ontology map once attached.
const SAMPLE_LINKS: {
  match: (domainName: string) => boolean;
  link_type: 'genie' | 'dashboard';
  url: string;
  label: string;
}[] = [
  {
    match: (d) => d === 'demand_forecasting_planning',
    link_type: 'dashboard',
    url: 'https://fe-vm-jai-classic-ws.cloud.databricks.com/dashboardsv3/01f1780f38a51b0ead8949891f7172e3/published',
    label: 'Demand Forecasting & Planning (sample AI/BI dashboard)',
  },
];

// Step 6 — attach a Genie Space or AI/BI dashboard to the selected product. The
// attached links surface as first-class nodes in the ontology / enterprise map.
function AttachLinksCard({
  product,
  productName,
  domainName,
  domainLabel,
  schemaLabel,
}: {
  product: string;
  productName: string;
  domainName: string;
  domainLabel: string;
  schemaLabel: string;
}) {
  const { refreshGraphLinks } = useProduct();
  const [links, setLinks] = useState<ProductLink[]>([]);
  const [kind, setKind] = useState<'genie' | 'dashboard'>('dashboard');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchProductLinks(product).then((l) => {
      if (!cancelled) setLinks(l);
    });
    return () => {
      cancelled = true;
    };
  }, [product]);

  const reload = async () => {
    setLinks(await fetchProductLinks(product));
    // keep the enterprise/ontology graph overlay in sync with the new link set
    void refreshGraphLinks();
  };
  const doAttach = async (linkType: 'genie' | 'dashboard', u: string, lbl?: string) => {
    if (!u.trim()) return;
    setBusy(true);
    const r = await attachLink({
      schema_label: schemaLabel,
      domain: domainName,
      product,
      link_type: linkType,
      url: u.trim(),
      label: lbl?.trim() || (linkType === 'genie' ? 'Genie Space' : 'Dashboard'),
    });
    setBusy(false);
    if (r.ok) {
      setUrl('');
      setLabel('');
      await reload();
    }
  };
  const doDelete = async (id: string) => {
    setBusy(true);
    await deleteLink(id);
    setBusy(false);
    await reload();
  };

  const sample = SAMPLE_LINKS.find((s) => s.match(domainName));
  const sampleAttached = sample ? links.some((l) => l.url === sample.url) : false;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" /> Attach Genie / Dashboard
        </CardTitle>
        <CardDescription>
          Link a Genie Space or AI/BI dashboard to <span className="font-medium">{product}</span>. Attached
          links appear as nodes on the ontology map so consumers can jump straight to analysis.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* suggested prebuilt dashboard for this domain */}
        {sample && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm">
            <Sparkles className="h-4 w-4 text-primary shrink-0" />
            <span className="font-medium">Suggested for {domainLabel || domainName}:</span>
            <span className="text-muted-foreground">{sample.label}</span>
            {sampleAttached ? (
              <Badge variant="outline" className="ml-auto text-[10px] text-success">
                <Check className="h-3 w-3 mr-1" /> attached
              </Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto gap-1.5"
                disabled={busy}
                onClick={() => void doAttach(sample.link_type, sample.url, sample.label)}
              >
                <Plus className="h-3.5 w-3.5" /> Attach sample
              </Button>
            )}
          </div>
        )}

        {/* currently attached links */}
        {links.length > 0 && (
          <div className="space-y-1.5">
            {links.map((l) => (
              <div
                key={l.link_id}
                className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
              >
                <Badge variant="secondary" className="text-[10px] shrink-0">
                  {l.link_type === 'genie' ? 'Genie' : 'Dashboard'}
                </Badge>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-primary hover:underline inline-flex items-center gap-1"
                >
                  {l.label || l.url}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
                <Button
                  size="icon"
                  variant="ghost"
                  className="ml-auto h-7 w-7 text-destructive shrink-0"
                  disabled={busy}
                  title="Detach"
                  onClick={() => void doDelete(l.link_id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* manual attach form */}
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            value={kind}
            onValueChange={(v) => v && setKind(v as 'genie' | 'dashboard')}
            className="shrink-0"
          >
            <ToggleGroupItem value="dashboard" className="text-xs">
              Dashboard
            </ToggleGroupItem>
            <ToggleGroupItem value="genie" className="text-xs">
              Genie
            </ToggleGroupItem>
          </ToggleGroup>
          <Input
            className="flex-1 min-w-[200px] text-xs"
            placeholder={`Paste ${kind === 'genie' ? 'Genie Space' : 'dashboard'} URL`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Input
            className="w-40 text-xs"
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button
            size="sm"
            disabled={busy || !url.trim()}
            onClick={() => void doAttach(kind, url, label)}
          >
            Attach
          </Button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Persisted to <code>product_links</code> for <code>{productName}</code>; overlaid on the graph in
          Graph Explorer.
        </div>
      </CardContent>
    </Card>
  );
}
