// Semantic Explorer — lineage relationships (FK edges) + measures/KPIs + an
// entity → property drill-down, all derived for the selected product.
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
} from '@databricks/appkit-ui/react';
import { ArrowRight } from 'lucide-react';
import { useProduct } from '../lib/product';

export function SemanticExplorer() {
  const { components, selectedProduct } = useProduct();
  const { relationships, measures, mappings } = components;

  const classes = useMemo(
    () => Array.from(new Set(mappings.map((m) => m.class))),
    [mappings]
  );
  const [activeClass, setActiveClass] = useState<string>(classes[0] ?? '');
  const effectiveClass = classes.includes(activeClass) ? activeClass : (classes[0] ?? '');
  const classProps = mappings.filter((m) => m.class === effectiveClass);

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Semantic Explorer</h2>
        <p className="text-muted-foreground">
          Relationships and measures for{' '}
          <span className="font-medium">{selectedProduct.display_name}</span>.
        </p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Relationships (lineage / foreign keys)</CardTitle>
          <CardDescription>Shared-key joins inferred from the schema</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {relationships.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No foreign-key relationships inferred for this product's tables.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {relationships.map((r, i) => (
                  <div
                    key={`${r.predicate}-${i}`}
                    className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{r.from.join(' | ')}</span>
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <ArrowRight className="h-3.5 w-3.5" />
                      <em>{r.predicate}</em>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                    <span className="font-medium">{r.to}</span>
                  </div>
                ))}
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
                  {relationships.map((r, i) => (
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
                  rows={measures.filter((m) => kind === 'all' || m.type === kind)}
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
          {classes.length > 0 && (
            <Select value={effectiveClass} onValueChange={setActiveClass}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select entity" />
              </SelectTrigger>
              <SelectContent>
                {classes.map((c) => (
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
}: {
  rows: { measure: string; type: string; unit: string; formula: string; description: string }[];
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
          <TableHead>Description</TableHead>
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
            <TableCell className="text-muted-foreground text-sm">{m.description}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
