// Data Contract — the ontos-style DataContract for the selected product
// (curated for the flagship, derived for the rest), with an Export PDF action.
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@databricks/appkit-ui/react';
import { FileDown, CheckCircle2, KeyRound, Info, ShieldAlert } from 'lucide-react';
import { useProduct } from '../lib/product';
import { deriveContract, piiCandidatesForProduct } from '../lib/contract';
import { ProvenanceBadge } from '../components/ProvenanceBadge';

export function DataContract() {
  const navigate = useNavigate();
  const { selectedProduct, components, activeSourceCatalog } = useProduct();
  const contract = useMemo(
    () => deriveContract(selectedProduct, components, { sourceCatalog: activeSourceCatalog ?? undefined }),
    [selectedProduct, components, activeSourceCatalog]
  );
  // name-based candidates across all the product's tables (incl. joined dims) —
  // surfaced for confirmation, never presented as a finding
  const pii = useMemo(() => piiCandidatesForProduct(components), [components]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Data Contract</h2>
          <p className="text-muted-foreground">
            {selectedProduct.display_name} · ontos DataContract
          </p>
        </div>
        <Button
          className="gap-1.5"
          onClick={() => navigate(`/print/${selectedProduct.product_name}`)}
        >
          <FileDown className="h-4 w-4" /> Export PDF
        </Button>
      </div>

      <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm">
        <Info className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground">
          A <span className="font-medium">data contract</span> is the governance handshake for this product:
          the governed <span className="font-medium">serving object</span>, its <span className="font-medium">grain</span>,
          schema (keys + types), <span className="font-medium">quality checks</span>, freshness SLA, scope, and lineage.
          It's <span className="font-medium">derived and read-only</span> here (curated for the live flagship) — no action
          is required. <span className="font-medium">Export PDF</span> produces a shareable brief (contract + ontology +
          lineage + approved actions) to hand to data owners / consumers.
        </span>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {contract.name}
            {contract.live ? (
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3 w-3" /> live
              </Badge>
            ) : (
              <Badge variant="outline">derived</Badge>
            )}
            <Badge variant="secondary">{contract.status}</Badge>
            <ProvenanceBadge
              origin={contract.live ? 'user' : 'heuristic'}
              evidence={
                contract.live
                  ? 'hand-curated contract for the live flagship product, backed by a governed serving view'
                  : 'grain, keys and quality checks inferred from column names and types — candidates for the data owner to confirm'
              }
            />
          </CardTitle>
          <CardDescription>
            Serving object: <code className="text-xs">{contract.serving_object}</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            <span className="font-semibold text-foreground">Grain: </span>
            <span className="text-muted-foreground">{contract.grain}</span>
            {!contract.live && (
              <span className="text-muted-foreground text-xs">
                {' '}
                — asserted from key columns, not yet verified against the data
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Schema</CardTitle>
          <CardDescription>{contract.schema.length} columns</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-[460px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Column</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Nullable</TableHead>
                  <TableHead>Key</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contract.schema.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell className="font-medium flex items-center gap-1.5">
                      {c.key && <KeyRound className="h-3 w-3 text-amber-500" />}
                      {c.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.type}</TableCell>
                    <TableCell>{c.nullable ? 'yes' : 'no'}</TableCell>
                    <TableCell>{c.key ? <Badge variant="default">key</Badge> : ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Quality checks</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Rule</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contract.quality_checks.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="font-medium">{q.id}</TableCell>
                    <TableCell>
                      <code className="text-xs">{q.rule}</code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Freshness &amp; scope</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Freshness SLA</div>
              <div>{contract.freshness.sla}</div>
              <div className="text-xs text-muted-foreground">basis: {contract.freshness.basis}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Included</div>
              <div className="text-muted-foreground">{contract.scope.included}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Excluded</div>
              <div className="text-muted-foreground">{contract.scope.excluded}</div>
            </div>
            {pii.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50/60 p-2.5 dark:bg-amber-950/20">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                {/* min-w-0 lets this flex child shrink below its content width; without
                    it the long qualified column names force the card to overflow. */}
                <div className="min-w-0 flex-1 text-xs">
                  <span className="font-medium text-foreground">
                    Possible personal data in this product
                  </span>
                  <div className="mt-0.5 text-muted-foreground">
                    Flagged by column name only — <span className="font-medium">not confirmed</span>.
                    Review with the data owner and mark the real ones as PII in Ontology Studio.
                  </div>
                  {/* one column per line, each able to break mid-token, so a long
                      table.column name wraps instead of stretching the card */}
                  <ul className="mt-1.5 space-y-0.5">
                    {pii.map((c) => (
                      <li key={c} className="min-w-0">
                        <code className="text-[11px] break-all text-foreground/80">{c}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Lineage</CardTitle>
          <CardDescription>source tables → serving object</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex flex-col gap-1">
            {contract.lineage.sources.map((s) => (
              <code key={s} className="text-xs bg-muted px-1.5 py-0.5 rounded w-fit">
                {s}
              </code>
            ))}
          </div>
          <div className="text-muted-foreground">↓ serves</div>
          <code className="text-xs bg-muted px-1.5 py-0.5 rounded w-fit">
            {contract.lineage.serving}
          </code>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Assumptions</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
            {contract.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
