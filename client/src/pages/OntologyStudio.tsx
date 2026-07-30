// Ontology Studio — the semantic adapter: entities/classes derived from the
// selected product's tables, with column mappings (role badges) and validation.
// Validation queries the warehouse only for `live` products; others are clearly
// labelled schema-derived (no live serving layer).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  checkServingView,
  type SuggestedRelationship,
  type ValidationResult,
} from '../lib/ontologyOverrides';
import { fetchProductLinks, attachLink, deleteLink, type ProductLink } from '../lib/productLinks';
import { artifactDownloadUrl, type StoredArtifact } from '../lib/ontologyArtifact';
import {
  fetchBusinessRules,
  saveBusinessRule,
  deleteBusinessRule,
  evaluateBusinessRule,
  type BusinessRule,
} from '../lib/businessRules';

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
    activeSchemaLabel,
    artifact,
    artifactStale,
    regenerateArtifact,
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
  // in-flight accept + feedback: which suggestion is saving, an inline result
  // message, and the relRef of the just-added edge to highlight in the table.
  const [acceptingRef, setAcceptingRef] = useState<string | null>(null);
  const [acceptResult, setAcceptResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [highlightRelRef, setHighlightRelRef] = useState<string | null>(null);
  // ref to the just-added Relationships row, so we can scroll it into view
  const highlightRowRef = useRef<HTMLTableRowElement | null>(null);
  // clear the "just added" row highlight a few seconds after it appears
  useEffect(() => {
    if (!highlightRelRef) return;
    // scroll the newly-added row into view so the user sees where it landed
    highlightRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setHighlightRelRef(null), 6000);
    return () => clearTimeout(t);
  }, [highlightRelRef]);
  // C) validate-against-data result (cached per scope)
  const [validation, setValidation] = useState<ValidationResult | null>(
    () => getScopeCache<ValidationResult>('validation') ?? null
  );
  const [validating, setValidating] = useState(false);
  // serving-view SQL live verification (EXPLAIN dry-run against the warehouse)
  const [viewCheck, setViewCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  // when the governed view already exists we collapse the DDL card (item 4); this
  // lets the user expand it on demand to re-copy / re-verify.
  const [showServingDdl, setShowServingDdl] = useState(false);
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
    // hide ones the user already rejected or already accepted (added) — both
    // are persisted as relationship overrides keyed by `${from}|${predicate}|${to}`,
    // so an accepted suggestion never re-surfaces on the next Suggest run.
    const excluded = new Set(
      ontologyOverrides
        .filter((o) => o.kind === 'relationship' && (o.action === 'reject' || o.action === 'add'))
        .map((o) => o.ref)
    );
    // also exclude anything already present as a confirmed/derived relationship
    for (const r of relationships) excluded.add(`${r.from[0]}|${r.predicate}|${r.to}`);
    const filtered = s.filter((x) => !excluded.has(`${x.from}|${x.predicate}|${x.to}`));
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

  // Governed serving-view presence — ONE stable check per serving object, lifted
  // out of SchemaDerivedNotice (whose internal check re-ran on every render because
  // it depended on an inline callback prop → the flicker loop). Results flow down.
  const servingObject = contract.serving_object;
  const [servingPresent, setServingPresent] = useState<boolean | null>(null);
  const [servingChecking, setServingChecking] = useState(false);
  const recheckServing = useCallback(async () => {
    if (!servingObject) {
      setServingPresent(null);
      return;
    }
    setServingChecking(true);
    const r = await checkServingView(servingObject);
    setServingChecking(false);
    setServingPresent(r.present);
  }, [servingObject]);
  useEffect(() => {
    void recheckServing();
  }, [recheckServing]);
  // feed the flag into the artifact, but only when presence actually flips — the
  // ref guard means a changing regenerateArtifact identity never re-triggers it.
  const lastServingFed = useRef<boolean | null>(null);
  useEffect(() => {
    if (servingPresent === null || lastServingFed.current === servingPresent) return;
    lastServingFed.current = servingPresent;
    void regenerateArtifact({ servingViewPresent: servingPresent });
  }, [servingPresent, regenerateArtifact]);

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

      <ReasoningRulesCard domainName={selectedDomain?.name ?? ''} />

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
              value={activeRoles}
              onValueChange={(v) => setActiveRoles(v)}
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
                {[...relationships]
                  // surface user-added / confirmed edges at the top so an accepted
                  // suggestion is immediately visible (they render newest-relevant first).
                  .sort((a, b) => (b.origin === 'user' ? 1 : 0) - (a.origin === 'user' ? 1 : 0))
                  .map((r, i) => {
                  const ref = `${r.from.join(',')}>${r.to}:${r.predicate}`;
                  const confirmOv = overrideFor('edge_status', ref, 'confirm');
                  const rejectOv = overrideFor('edge_status', ref, 'reject');
                  const justAdded = ref === highlightRelRef;
                  return (
                    <TableRow
                      key={`${ref}-${i}`}
                      ref={justAdded ? highlightRowRef : undefined}
                      className={
                        justAdded ? 'bg-emerald-50 ring-1 ring-emerald-300 transition-colors' : undefined
                      }
                    >
                      <TableCell className="font-medium">
                        {justAdded && (
                          <Badge className="mr-1.5 bg-emerald-600 text-[10px]">just added</Badge>
                        )}
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
          {acceptResult && (
            <div
              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                acceptResult.ok
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-destructive/40 bg-destructive/10 text-destructive'
              }`}
            >
              {acceptResult.ok ? (
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              )}
              <span>{acceptResult.msg}</span>
            </div>
          )}
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
                    title="Confirm — add to the Relationships table below"
                    disabled={acceptingRef === ref}
                    onClick={() => {
                      void (async () => {
                        setAcceptingRef(ref);
                        setAcceptResult(null);
                        const r = await saveOntologyOverride({
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
                        setAcceptingRef(null);
                        if (r.ok) {
                          // only remove on success; surface WHERE it landed and
                          // highlight the new row in the Relationships table.
                          setSuggestions((prev) =>
                            prev.filter((x) => `${x.from}|${x.predicate}|${x.to}` !== ref)
                          );
                          const relRefAdded = `${s.from}>${s.to}:${s.predicate}`;
                          setHighlightRelRef(relRefAdded);
                          setAcceptResult({
                            ok: true,
                            msg: `Added "${s.from} ·${s.predicate}· ${s.to}" to the Relationships table below (origin: user, confirmed).`,
                          });
                        } else {
                          // keep the suggestion so the user can retry
                          setAcceptResult({
                            ok: false,
                            msg: `Couldn't add relationship: ${r.error ?? 'save failed'}. It was not added — try again.`,
                          });
                        }
                      })();
                    }}
                  >
                    {acceptingRef === ref ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
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

      {/* item 3 — Generate serving view + contract (deferred DDL; preview/copy).
          Collapses to a compact confirmation once the governed view exists (item 4). */}
      {(() => {
        const collapsed = servingPresent === true && !showServingDdl;
        return (
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <FileCode className="h-4 w-4 text-primary" /> Serving view + contract
              {servingPresent === true && (
                <Badge variant="default" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" /> view exists
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {collapsed ? (
                <>
                  The governed view <code>{served.name}</code> already exists in the warehouse — no
                  action needed. Expand to re-copy or re-verify the DDL after confirming new relationships.
                </>
              ) : (
                <>
                  A conformed <code>CREATE VIEW</code> from the fact table + confirmed relationships, plus
                  the derived data contract. Executing the DDL is deferred (needs a one-time CREATE grant):
                  preview, verify, and copy here; it is also in the exported brief.
                </>
              )}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {servingPresent === true && (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5"
                onClick={() => setShowServingDdl((v) => !v)}
              >
                {collapsed ? 'Show DDL' : 'Hide DDL'}
              </Button>
            )}
            {!collapsed && (
              <>
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
              </>
            )}
          </div>
        </CardHeader>
        {!collapsed && (
        <CardContent className="space-y-2">
          <div className="flex items-start gap-1.5 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" />
            <span>
              This preview <span className="font-medium">regenerates live</span> as you confirm relationships above —
              it currently joins <span className="font-medium">{served.joins}</span> confirmed relationship
              {served.joins === 1 ? '' : 's'}. Re-run the DDL after confirming changes to update the governed view.
            </span>
          </div>
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
        )}
      </Card>
        );
      })()}

      {/* ontology artifact (OWL/TTL + JSON-LD) — the file that drives the Ontology Explorer */}
      <OntologyArtifactCard
        artifact={artifact}
        stale={artifactStale}
        onRegenerate={regenerateArtifact}
        schemaLabel={activeSchemaLabel}
        productName={selectedProduct.product_name}
      />

      {/* item 6 — Attach Genie / Dashboard (surfaces in the ontology map) */}
      {selectedProduct && (
        <AttachLinksCard
          product={selectedProduct.display_name}
          productName={selectedProduct.product_name}
          domainName={selectedDomain?.name ?? ''}
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
              servingObject={contract.serving_object}
              present={servingPresent}
              checking={servingChecking}
              onRecheck={() => void recheckServing()}
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
  servingObject,
  present,
  checking,
  onRecheck,
}: {
  tableCount: number;
  columnCount: number;
  sourceCatalog?: string | null;
  servingObject?: string;
  // presence is checked once by the parent (stable) and passed in — this keeps
  // the notice a pure view and avoids the render/check flicker loop.
  present: boolean | null;
  checking: boolean;
  onRecheck: () => void;
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
            label={`Governed serving view present${checking ? ' (checking…)' : ''}`}
            ok={present === true}
            warn={present !== true}
            tooltip={`Checks the warehouse for ${servingObject ?? 'the serving object'}. Green once the view exists (create it from the serving-view card above, then Recheck). A permission error reads as "cannot verify", not absent.`}
          />
        </TableBody>
      </Table>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" disabled={checking || !servingObject} onClick={onRecheck}>
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          Recheck serving view
        </Button>
        {present === true && <span className="text-xs text-success">Present in the warehouse.</span>}
        {present === false && <span className="text-xs text-muted-foreground">Not found (or no access) — create it, then Recheck.</span>}
      </div>
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
  {
    // QSR Supply Chain Control Tower domains → the Executive Command Center dashboard
    match: (d) => d.startsWith('qsr_') && d !== 'qsr_demo',
    link_type: 'dashboard',
    url: 'https://fe-vm-jai-classic-ws.cloud.databricks.com/dashboardsv3/01f179a5593014b99153f9403cd82bf3/published',
    label: 'Executive Command Center (QSR Supply Chain)',
  },
  {
    // store-level operations — most relevant to the Restaurant Operations layer
    match: (d) => d === 'qsr_restaurant_operations' || d === 'qsr_demand_inventory_waste',
    link_type: 'dashboard',
    url: 'https://fe-vm-jai-classic-ws.cloud.databricks.com/dashboardsv3/01f179a92a0315c9b0d51c0d224bb24c/published',
    label: 'Operations Center — store-level risk & actions',
  },
  {
    // event → reasoning → recommendation → outcome timeline (all control-tower domains)
    match: (d) => d.startsWith('qsr_') && d !== 'qsr_demo',
    link_type: 'dashboard',
    url: 'https://fe-vm-jai-classic-ws.cloud.databricks.com/dashboardsv3/01f179a92a8611349e20a8175975d141/published',
    label: 'Executive Decision Timeline',
  },
];

// Business/reasoning rules for the selected domain — persisted in Lakebase
// (jai_business_rules), editable, and optionally evaluatable against the backing
// data for a live match count. Rules feed the ontology artifact.
const EMPTY_RULE = { name: '', if_conditions: '', then_conclusion: '', concepts: '', evidence: '', eval_table: '', eval_sql: '' };
function ReasoningRulesCard({ domainName }: { domainName: string }) {
  const { regenerateArtifact } = useProduct();
  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // rule_id | 'new' | null
  const [form, setForm] = useState({ ...EMPTY_RULE });
  const [busy, setBusy] = useState(false);
  const [evalRes, setEvalRes] = useState<Record<string, string>>({});

  const reload = async () => {
    const rs = await fetchBusinessRules(domainName);
    setRules(rs);
    // feed rules into the ontology artifact (TTL annotations)
    void regenerateArtifact({
      rules: rs.map((r) => ({ id: r.rule_id, name: r.name, if_conditions: r.if_conditions, then_conclusion: r.then_conclusion, concepts: r.concepts, evidence: r.evidence })),
    });
  };
  useEffect(() => {
    let cancelled = false;
    void fetchBusinessRules(domainName).then((rs) => {
      if (!cancelled) setRules(rs);
    });
    return () => {
      cancelled = true;
    };
  }, [domainName]);

  if (!domainName) return null;

  const startEdit = (r?: BusinessRule) => {
    setEditing(r?.rule_id ?? 'new');
    setForm(
      r
        ? {
            name: r.name,
            if_conditions: r.if_conditions.join('; '),
            then_conclusion: r.then_conclusion,
            concepts: r.concepts.join(', '),
            evidence: r.evidence ?? '',
            eval_table: r.eval_table ?? '',
            eval_sql: r.eval_sql ?? '',
          }
        : { ...EMPTY_RULE }
    );
  };
  const save = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    await saveBusinessRule({
      rule_id: editing && editing !== 'new' ? editing : undefined,
      domain: domainName,
      name: form.name.trim(),
      if_conditions: form.if_conditions.split(';').map((s) => s.trim()).filter(Boolean),
      then_conclusion: form.then_conclusion.trim(),
      concepts: form.concepts.split(',').map((s) => s.trim()).filter(Boolean),
      evidence: form.evidence.trim(),
      eval_table: form.eval_table.trim() || undefined,
      eval_sql: form.eval_sql.trim() || undefined,
    });
    setBusy(false);
    setEditing(null);
    await reload();
  };
  const remove = async (id: string) => {
    setBusy(true);
    await deleteBusinessRule(id);
    setBusy(false);
    await reload();
  };
  const evaluate = async (r: BusinessRule) => {
    if (!r.eval_table || !r.eval_sql) return;
    setEvalRes((p) => ({ ...p, [r.rule_id]: '…' }));
    const res = await evaluateBusinessRule(r.eval_table, r.eval_sql);
    setEvalRes((p) => ({ ...p, [r.rule_id]: res.ok ? `${res.matches} rows match now` : `error: ${res.error ?? ''}` }));
  };

  return (
    <Card className="shadow-sm border-primary/30">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Business rules
            <Badge variant="secondary">{rules.length}</Badge>
          </CardTitle>
          <CardDescription>
            Captured business rules over this domain's ontology concepts (IF → THEN), persisted so they
            apply consistently. Optionally evaluate a rule against the live data for a current match count.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={() => startEdit()}>
          <Plus className="h-3.5 w-3.5" /> Add rule
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {editing === 'new' && (
          <RuleEditor form={form} setForm={setForm} busy={busy} onSave={save} onCancel={() => setEditing(null)} />
        )}
        {rules.length === 0 && editing !== 'new' && (
          <div className="text-sm text-muted-foreground">No rules for this domain yet — add one.</div>
        )}
        {rules.map((r) =>
          editing === r.rule_id ? (
            <RuleEditor key={r.rule_id} form={form} setForm={setForm} busy={busy} onSave={save} onCancel={() => setEditing(null)} />
          ) : (
            <div key={r.rule_id} className="rounded-md border p-3 text-sm space-y-1.5">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">{r.origin === 'seed' ? 'seed' : 'custom'}</Badge>
                <span className="font-medium">{r.name}</span>
                <div className="ml-auto flex items-center gap-1">
                  {r.eval_table && r.eval_sql && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void evaluate(r)}>
                      Evaluate
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit" onClick={() => startEdit(r)}>
                    <BookText className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Delete" disabled={busy} onClick={() => void remove(r.rule_id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="text-xs">
                <span className="text-muted-foreground">IF </span>
                {r.if_conditions.join(' AND ')}
                <span className="text-muted-foreground"> → THEN </span>
                <span className="font-medium">{r.then_conclusion}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {r.concepts.map((c) => (
                  <Badge key={c} variant="secondary" className="text-[10px]">{c}</Badge>
                ))}
                {evalRes[r.rule_id] && (
                  <Badge variant="outline" className="text-[10px] text-primary">{evalRes[r.rule_id]}</Badge>
                )}
              </div>
              {r.evidence && (
                <div className="text-[11px] text-muted-foreground">Signal: <code>{r.evidence}</code></div>
              )}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

function RuleEditor({
  form,
  setForm,
  busy,
  onSave,
  onCancel,
}: {
  form: typeof EMPTY_RULE;
  setForm: (f: typeof EMPTY_RULE) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (k: keyof typeof EMPTY_RULE) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="rounded-md border border-primary/40 p-3 space-y-2 bg-muted/20">
      <Input className="text-xs" placeholder="Rule name" value={form.name} onChange={set('name')} />
      <Input className="text-xs" placeholder="IF conditions (semicolon-separated)" value={form.if_conditions} onChange={set('if_conditions')} />
      <Input className="text-xs" placeholder="THEN conclusion" value={form.then_conclusion} onChange={set('then_conclusion')} />
      <Input className="text-xs" placeholder="Ontology concepts (comma-separated)" value={form.concepts} onChange={set('concepts')} />
      <Input className="text-xs" placeholder="Evidence / signal (optional)" value={form.evidence} onChange={set('evidence')} />
      <div className="flex gap-2">
        <Input className="text-xs" placeholder="Eval table (e.g. jai_ontos.qsr_sc.jai_inventory_event)" value={form.eval_table} onChange={set('eval_table')} />
        <Input className="text-xs" placeholder="Eval WHERE predicate (optional)" value={form.eval_sql} onChange={set('eval_sql')} />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={busy || !form.name.trim()} onClick={onSave}>Save rule</Button>
      </div>
    </div>
  );
}

// The generated ontology artifact (OWL/TTL + JSON-LD). This IS the file that
// drives the Ontology Explorer (Graph Explorer tab 2 reads its graph); it
// regenerates as curation / links / rules change, and is downloadable.
function OntologyArtifactCard({
  artifact,
  stale,
  onRegenerate,
  schemaLabel,
  productName,
}: {
  artifact: StoredArtifact | null;
  stale: boolean;
  onRegenerate: () => Promise<void>;
  schemaLabel: string;
  productName: string;
}) {
  const [busy, setBusy] = useState(false);
  const regen = async () => {
    setBusy(true);
    await onRegenerate();
    setBusy(false);
  };
  return (
    <Card className="shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <FileCode className="h-4 w-4 text-primary" /> Ontology artifact (OWL/TTL + JSON-LD)
          </CardTitle>
          <CardDescription>
            A portable OWL ontology generated from this product's curated ontology — classes, datatype
            properties, confirmed relationships, rules, and attached links. The Ontology Explorer is
            rendered from this artifact; it refreshes as you curate, attach links, or edit rules.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => void regen()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {artifact ? 'Regenerate' : 'Generate'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {artifact ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary" className="text-[10px]">{artifact.class_count ?? 0} classes</Badge>
              <Badge variant="secondary" className="text-[10px]">{artifact.objprop_count ?? 0} object properties</Badge>
              <span>IRI <code>{artifact.iri}</code></span>
              <span>· generated {artifact.generated_at}</span>
              {stale && (
                <Badge variant="outline" className="text-[10px] text-amber-600">
                  <AlertTriangle className="h-3 w-3 mr-1" /> stale — regenerate to refresh
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <a
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                href={artifactDownloadUrl(schemaLabel, productName, 'ttl')}
              >
                <ExternalLink className="h-3 w-3" /> Download .ttl
              </a>
              <a
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                href={artifactDownloadUrl(schemaLabel, productName, 'jsonld')}
              >
                <ExternalLink className="h-3 w-3" /> Download .jsonld
              </a>
              {artifact.volume_path && (
                <span className="text-[11px] text-muted-foreground">· mirrored to <code>{artifact.volume_path}</code></span>
              )}
            </div>
          </>
        ) : (
          <div className="text-sm text-muted-foreground">
            No artifact generated yet — click Generate to emit the OWL/TTL file and drive the Ontology
            Explorer from it.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Step 6 — attach a Genie Space or AI/BI dashboard to the selected product. The
// attached links surface as first-class nodes in the ontology / enterprise map.
function AttachLinksCard({
  product,
  productName,
  domainName,
  schemaLabel,
}: {
  product: string;
  productName: string;
  domainName: string;
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

  const samples = SAMPLE_LINKS.filter((s) => s.match(domainName));

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
        {/* suggested prebuilt dashboards/spaces for this domain */}
        {samples.map((sample) => {
          const attached = links.some((l) => l.url === sample.url);
          return (
            <div
              key={sample.url}
              className="flex flex-wrap items-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm"
            >
              <Sparkles className="h-4 w-4 text-primary shrink-0" />
              <Badge variant="secondary" className="text-[10px] shrink-0">
                {sample.link_type === 'genie' ? 'Genie' : 'Dashboard'}
              </Badge>
              <span className="text-muted-foreground">{sample.label}</span>
              {attached ? (
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
                  <Plus className="h-3.5 w-3.5" /> Attach
                </Button>
              )}
            </div>
          );
        })}

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
