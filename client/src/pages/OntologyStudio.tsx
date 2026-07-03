// Ontology Studio — the semantic adapter: entities/classes derived from the
// selected product's tables, with column mappings (role badges) and validation.
// Validation queries the warehouse only for `live` products; others are clearly
// labelled schema-derived (no live serving layer).
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
  ToggleGroup,
  ToggleGroupItem,
} from '@databricks/appkit-ui/react';
import { CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react';
import { useProduct } from '../lib/product';
import { LiveValidation } from './LiveValidation';
import { CatalogLoadingSkeleton } from '../components/LoadingSkeleton';

const ROLE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  key: 'default',
  attribute: 'secondary',
  measure: 'outline',
};

export function OntologyStudio() {
  const { components, selectedProduct, catalogLoading, rebuilding, activeSourceCatalog } = useProduct();
  const { classes, mappings, live } = components;

  const roles = useMemo<string[]>(
    () => Array.from(new Set(mappings.map((m) => m.role as string))).sort(),
    [mappings]
  );
  const [activeRoles, setActiveRoles] = useState<string[]>(roles);
  // keep filter valid when the product (and thus role set) changes
  const effectiveRoles = activeRoles.filter((r) => roles.includes(r));
  const shownRoles = effectiveRoles.length ? effectiveRoles : roles;
  const filteredMappings = mappings.filter((m) => shownRoles.includes(m.role));

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
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {classes.map((c) => (
                <TableRow key={c.class}>
                  <TableCell className="font-medium">{c.label}</TableCell>
                  <TableCell>
                    <Badge variant={c.role === 'fact' ? 'default' : 'secondary'}>{c.role}</Badge>
                  </TableCell>
                  <TableCell>{c.grain}</TableCell>
                  <TableCell>
                    <code className="text-xs">{c.source_table}</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{c.comment}</TableCell>
                </TableRow>
              ))}
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
                  <TableHead>Type</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMappings.map((m, i) => (
                  <TableRow key={`${m.class}-${m.property}-${i}`}>
                    <TableCell className="font-medium">{m.class}</TableCell>
                    <TableCell>{m.property}</TableCell>
                    <TableCell>
                      <Badge variant={ROLE_VARIANT[m.role] ?? 'outline'}>{m.role}</Badge>
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
          <CheckRow label="Governed serving view present" ok={false} warn />
        </TableBody>
      </Table>
    </div>
  );
}

function CheckRow({ label, ok, warn }: { label: string; ok: boolean; warn?: boolean }) {
  return (
    <TableRow>
      <TableCell className="text-sm">{label}</TableCell>
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
