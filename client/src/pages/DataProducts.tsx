// Data Products — the domain → data-product catalog (6 domains × 4 products).
// Shows all domains, the selected domain's products, and the selected product's
// detail (outcome, source tables, KPIs). Selecting a product derives its
// components at runtime from the real schema.
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
} from '@databricks/appkit-ui/react';
import { CheckCircle2 } from 'lucide-react';
import { useProduct } from '../lib/product';

function maturityVariant(m: string): 'default' | 'secondary' | 'outline' {
  const s = (m || '').toLowerCase();
  if (s === 'ga') return 'default';
  if (s === 'beta') return 'secondary';
  return 'outline';
}

export function DataProducts() {
  const { domains, selectedDomain, setSelectedDomain, selectedProduct, setSelectedProduct } =
    useProduct();

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Data Products</h2>
        <p className="text-muted-foreground">
          A domain → data-product catalog. {domains.length} domains ·{' '}
          {domains.reduce((n, d) => n + d.products.length, 0)} products. Selecting a product derives
          its ontology, lineage, and KPIs at runtime from the live schema. One product
          (<span className="font-medium">Store Traffic &amp; Labor Efficiency</span>) is fully live
          on governed serving views.
        </p>
      </div>

      {/* domains */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {domains.map((d) => {
          const active = d.name === selectedDomain.name;
          const liveCount = d.products.filter((p) => p.live).length;
          return (
            <button key={d.name} onClick={() => setSelectedDomain(d.name)} className="text-left">
              <Card
                className={`shadow-sm h-full transition-colors ${
                  active ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/40'
                }`}
              >
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center justify-between">
                    {d.label}
                    {liveCount > 0 && (
                      <Badge variant="default" className="gap-1">
                        <CheckCircle2 className="h-3 w-3" /> live
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription>{d.description}</CardDescription>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  {d.products.length} products
                </CardContent>
              </Card>
            </button>
          );
        })}
      </div>

      {/* products in selected domain */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>{selectedDomain.label} — products</CardTitle>
          <CardDescription>{selectedDomain.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Maturity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source tables</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {selectedDomain.products.map((p) => {
                const active = p.product_name === selectedProduct.product_name;
                return (
                  <TableRow
                    key={p.product_name}
                    className={`cursor-pointer ${active ? 'bg-muted/60' : ''}`}
                    onClick={() => setSelectedProduct(p.product_name)}
                  >
                    <TableCell className="font-medium">{p.display_name}</TableCell>
                    <TableCell>
                      <Badge variant={maturityVariant(p.maturity)}>{p.maturity}</Badge>
                    </TableCell>
                    <TableCell>
                      {p.live ? (
                        <Badge variant="default" className="gap-1">
                          <CheckCircle2 className="h-3 w-3" /> live
                        </Badge>
                      ) : (
                        <Badge variant="outline">schema-derived</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {p.fact_tables.length + p.dim_tables.length} tables
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* selected product detail */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Selected: {selectedProduct.display_name}
            {selectedProduct.live ? (
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3 w-3" /> live
              </Badge>
            ) : (
              <Badge variant="outline">schema-derived</Badge>
            )}
          </CardTitle>
          <CardDescription>{selectedDomain.label}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <span className="font-semibold text-foreground">Business outcome: </span>
            <span className="text-muted-foreground">{selectedProduct.business_outcome}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Fact tables
              </div>
              <div className="flex flex-col gap-1">
                {selectedProduct.fact_tables.map((t) => (
                  <code key={t} className="text-xs bg-muted px-1.5 py-0.5 rounded w-fit">
                    {t}
                  </code>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Dimension tables
              </div>
              <div className="flex flex-col gap-1">
                {selectedProduct.dim_tables.map((t) => (
                  <code key={t} className="text-xs bg-muted px-1.5 py-0.5 rounded w-fit">
                    {t}
                  </code>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">KPIs</div>
            <div className="flex flex-wrap gap-1.5">
              {selectedProduct.kpis.map((k) => (
                <Badge key={k} variant="secondary">
                  {k}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
