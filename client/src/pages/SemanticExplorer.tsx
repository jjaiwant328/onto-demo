// Semantic Explorer — lineage relationships (FK edges) + measures/KPIs + an
// entity → property drill-down, aggregated across the active SCOPE (all/domain/
// product) so it reflects the left-panel selection, not just one product.
import type React from 'react';
import { useMemo, useState } from 'react';
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  Input,
} from '@databricks/appkit-ui/react';
import { ArrowRight, Info, Search } from 'lucide-react';
import { useProduct } from '../lib/product';
import { deriveProduct } from '../lib/deriveComponents';
import { CatalogLoadingSkeleton } from '../components/LoadingSkeleton';
import { GlossaryCell } from './OntologyStudio';

export function SemanticExplorer() {
  const {
    components,
    selectedProduct,
    catalogLoading,
    rebuilding,
    scopedProducts,
    schema,
    domainScopeAll,
    productScopeAll,
    selectedDomain,
    ontologyOverrides,
    saveOntologyOverride,
    deleteOntologyOverride,
  } = useProduct();

  // aggregate relationships + measures + mappings across the SCOPED products
  // (all → every product; a domain → its products; a single product → just it).
  const { relationships, measures, mappings, scopeLabel } = useMemo(() => {
    const products = scopedProducts.length ? scopedProducts : [selectedProduct];
    const perProduct = products.map((p) => deriveProduct(p, schema));
    const relKey = (r: (typeof perProduct)[number]['relationships'][number]) =>
      `${r.from.join(',')}|${r.predicate}|${r.to}`;
    const relMap = new Map<string, (typeof perProduct)[number]['relationships'][number]>();
    const measMap = new Map<string, (typeof perProduct)[number]['measures'][number]>();
    const mapMap = new Map<string, (typeof perProduct)[number]['mappings'][number]>();
    for (const c of perProduct) {
      for (const r of c.relationships) if (!relMap.has(relKey(r))) relMap.set(relKey(r), r);
      for (const m of c.measures) if (!measMap.has(m.measure)) measMap.set(m.measure, m);
      for (const m of c.mappings) {
        const k = `${m.class}.${m.property}`;
        if (!mapMap.has(k)) mapMap.set(k, m);
      }
    }
    const label = productScopeAll
      ? domainScopeAll
        ? 'all domains'
        : (selectedDomain?.label ?? 'the selected domain')
      : selectedProduct.display_name;
    return {
      relationships: [...relMap.values()],
      measures: [...measMap.values()],
      mappings: [...mapMap.values()],
      scopeLabel: label,
    };
    // fall back to single-product components when scope is empty
  }, [scopedProducts, selectedProduct, schema, domainScopeAll, productScopeAll, selectedDomain]);

  const classes = useMemo(
    () => Array.from(new Set(mappings.map((m) => m.class))),
    [mappings]
  );
  const [activeClass, setActiveClass] = useState<string>(classes[0] ?? '');
  const effectiveClass = classes.includes(activeClass) ? activeClass : (classes[0] ?? '');

  // case-insensitive search across relationships / measures / entities / mappings
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const match = (...vals: (string | undefined)[]) =>
    !q || vals.some((v) => (v ?? '').toLowerCase().includes(q));

  const shownRelationships = useMemo(
    () => relationships.filter((r) => match(r.from.join(' '), r.predicate, r.to)),
    [relationships, q]
  );
  const shownMeasures = useMemo(
    () => measures.filter((m) => match(m.measure, m.type, m.formula)),
    [measures, q]
  );
  const shownClasses = useMemo(() => classes.filter((c) => match(c)), [classes, q]);
  const classProps = mappings
    .filter((m) => m.class === effectiveClass)
    .filter((m) => match(m.property, m.class, m.role, m.type));

  if (catalogLoading) return <CatalogLoadingSkeleton label="Generating semantics…" />;
  if (rebuilding) return <CatalogLoadingSkeleton label="Rebuilding…" />;
  // keep components referenced (single-product baseline / live flag) without warnings
  void components;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground flex items-center gap-2">
          Semantic Explorer
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="How this is populated" className="text-muted-foreground">
                  <Info className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Populated from the selected scope's components: <b>relationships</b> = shared-key / FK
                edges inferred between the products' tables; <b>measures</b> = numeric fact columns +
                declared KPIs. Aggregated (de-duped) across the scoped products.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </h2>
        <p className="text-muted-foreground">
          Relationships and measures for <span className="font-medium">{scopeLabel}</span> (
          {relationships.length} relationships · {measures.length} measures).
        </p>
        <div className="relative mt-3 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search relationships, measures, entities, columns…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {q && (
          <p className="text-xs text-muted-foreground mt-1">
            Showing {shownRelationships.length} relationship(s), {shownMeasures.length} measure(s),{' '}
            {shownClasses.length} entity(ies) matching “{search.trim()}”.
          </p>
        )}
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Relationships (lineage / foreign keys)</CardTitle>
          <CardDescription>
            Shared-key joins inferred from the schema — a read-only scoped rollup. Confirm/reject is
            curated in <span className="font-medium">Ontology Studio</span> (the single writer); this view
            reflects that status.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {shownRelationships.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {q
                ? 'No relationships match your search.'
                : "No foreign-key relationships inferred for this product's tables."}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {shownRelationships.map((r, i) => {
                  const conf = r.status === 'confirmed' ? 100 : Math.round((r.confidence ?? 0.6) * 100);
                  const statusLabel =
                    r.status === 'confirmed' ? 'Confirmed' : r.status === 'rejected' ? 'Rejected' : 'Suggested';
                  return (
                    <div
                      key={`${r.predicate}-${i}`}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                        r.status === 'rejected'
                          ? 'opacity-50 line-through bg-muted/20'
                          : r.status === 'confirmed'
                            ? 'border-emerald-400/60 bg-emerald-50/50 dark:bg-emerald-950/20'
                            : 'bg-muted/40'
                      }`}
                    >
                      <span className="font-medium">{r.from.join(' | ')}</span>
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <ArrowRight className="h-3.5 w-3.5" />
                        <em>{r.predicate}</em>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </span>
                      <span className="font-medium">{r.to}</span>
                      <Badge
                        variant={r.status === 'confirmed' ? 'default' : 'outline'}
                        className="text-[10px]"
                      >
                        {statusLabel} · {conf}%
                      </Badge>
                    </div>
                  );
                })}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>From</TableHead>
                    <TableHead>Join key</TableHead>
                    <TableHead>To</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shownRelationships.map((r, i) => (
                    <TableRow key={`${r.predicate}-${i}`}>
                      <TableCell>{r.from.join(', ')}</TableCell>
                      <TableCell className="font-medium">{r.predicate}</TableCell>
                      <TableCell>{r.to}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Measures &amp; KPIs</CardTitle>
          <CardDescription>
            Base measures from fact tables; derived = the product's headline KPIs
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="all">
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="base">Base</TabsTrigger>
              <TabsTrigger value="derived">KPIs</TabsTrigger>
            </TabsList>
            {(['all', 'base', 'derived'] as const).map((kind) => (
              <TabsContent key={kind} value={kind}>
                <MeasureTable
                  rows={shownMeasures.filter((m) => kind === 'all' || m.type === kind)}
                  renderGlossary={(m) => {
                    const gloss = ontologyOverrides.find(
                      (o) => o.kind === 'glossary' && o.ref === m.measure && o.action === 'define'
                    );
                    return (
                      <GlossaryCell
                        termType="measure"
                        name={m.measure}
                        definition={m.definition}
                        synonyms={m.synonyms}
                        hasOverride={Boolean(gloss)}
                        onSave={(def, syn) =>
                          void saveOntologyOverride({
                            product: selectedProduct.product_name,
                            kind: 'glossary',
                            ref: m.measure,
                            action: 'define',
                            value: { term_type: 'measure', definition: def, synonyms: syn },
                          })
                        }
                        onClear={() => gloss && void deleteOntologyOverride(gloss.id)}
                      />
                    );
                  }}
                />
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Entity → property drill-down</CardTitle>
            <CardDescription>Properties and physical bindings for one entity</CardDescription>
          </div>
          {shownClasses.length > 0 && (
            <Select value={effectiveClass} onValueChange={setActiveClass}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select entity" />
              </SelectTrigger>
              <SelectContent>
                {shownClasses.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardHeader>
        <CardContent>
          <div className="max-h-[420px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Property</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {classProps.map((m, i) => (
                  <TableRow key={`${m.property}-${i}`}>
                    <TableCell className="font-medium">{m.property}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{m.role}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.type}</TableCell>
                    <TableCell>
                      <code className="text-xs">{m.source}</code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MeasureTable({
  rows,
  renderGlossary,
}: {
  rows: {
    measure: string;
    type: string;
    unit: string;
    formula: string;
    description: string;
    definition?: string;
    synonyms?: string[];
  }[];
  renderGlossary?: (m: { measure: string; definition?: string; synonyms?: string[] }) => React.ReactNode;
}) {
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground py-3">No measures in this view.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Measure</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Unit</TableHead>
          <TableHead>Formula</TableHead>
          <TableHead>Glossary</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((m) => (
          <TableRow key={m.measure}>
            <TableCell className="font-medium">{m.measure}</TableCell>
            <TableCell>
              <Badge variant={m.type === 'derived' ? 'default' : 'secondary'}>
                {m.type === 'derived' ? 'kpi' : 'base'}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">{m.unit}</TableCell>
            <TableCell>
              <code className="text-xs whitespace-pre-wrap">{m.formula}</code>
            </TableCell>
            <TableCell>
              <div className="space-y-0.5">
                {m.definition && (
                  <div className="text-xs text-muted-foreground max-w-[240px] truncate">
                    {m.definition}
                    {m.synonyms?.length ? ` · ${m.synonyms.join(', ')}` : ''}
                  </div>
                )}
                {renderGlossary?.(m)}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
