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
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@databricks/appkit-ui/react';
import { CheckCircle2, FileText, FileDown, Layers, Database, MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useEffect, useMemo, useState } from 'react';
import { useProduct } from '../lib/product';
import { CatalogLoadingSkeleton } from '../components/LoadingSkeleton';
import { fetchProductLinks, type ProductLink } from '../lib/productLinks';

function maturityVariant(m: string): 'default' | 'secondary' | 'outline' {
  const s = (m || '').toLowerCase();
  if (s === 'ga') return 'default';
  if (s === 'beta') return 'secondary';
  return 'outline';
}

export function DataProducts() {
  const navigate = useNavigate();
  const {
    scopedDomains,
    selectedProduct,
    setSelectedDomain,
    setSelectedProduct,
    syncScopeFromSections,
    schemaEntries,
    combined,
    conformance,
    selectedSchemaIds,
    catalogLoading,
    rebuilding,
  } = useProduct();
  const schemaLabel =
    selectedSchemaIds.length === 1
      ? (schemaEntries.find((s) => s.id === selectedSchemaIds[0])?.label ?? '1 schema')
      : `${selectedSchemaIds.length} schemas combined`;

  // Domains shown = the scoped domains (All → every domain). Row clicks below set
  // a local focus for the detail card. When the "Selections update scope" toggle
  // is ON, they ALSO update the left-panel Scope; OFF (default) = view-only.
  const domains = scopedDomains;
  const [focusDomainName, setFocusDomainName] = useState<string | null>(null);
  const [focusProductName, setFocusProductName] = useState<string | null>(null);

  const pickDomain = (name: string) => {
    setFocusDomainName(name);
    setFocusProductName(null);
    if (syncScopeFromSections) setSelectedDomain(name);
  };
  const pickProduct = (name: string) => {
    setFocusProductName(name);
    if (syncScopeFromSections) setSelectedProduct(name);
  };

  const focusDomain = useMemo(
    () => domains.find((d) => d.name === focusDomainName) ?? domains[0],
    [domains, focusDomainName]
  );
  const focusProduct = useMemo(() => {
    const inDomain = focusDomain?.products ?? [];
    return (
      inDomain.find((p) => p.product_name === focusProductName) ??
      inDomain.find((p) => p.product_name === selectedProduct?.product_name) ??
      inDomain[0] ??
      selectedProduct
    );
  }, [focusDomain, focusProductName, selectedProduct]);

  const totalProducts = domains.reduce((n, d) => n + d.products.length, 0);

  // product links (Genie Space / dashboard) keyed by product display_name.
  // Loaded from Delta so they persist across reloads.
  const [linksByProduct, setLinksByProduct] = useState<Map<string, ProductLink[]>>(new Map());
  useEffect(() => {
    void (async () => {
      const all = await fetchProductLinks();
      const map = new Map<string, ProductLink[]>();
      for (const l of all) {
        const key = l.product ?? '';
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(l);
      }
      setLinksByProduct(map);
    })();
  }, []);

  if (catalogLoading) return <CatalogLoadingSkeleton />;
  if (rebuilding) return <CatalogLoadingSkeleton label="Rebuilding…" />;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Data Products</h2>
        <p className="text-muted-foreground">
          Schema <span className="font-medium">{schemaLabel}</span> · {domains.length} domains ·{' '}
          {totalProducts} products. Selecting a product below previews its ontology, lineage, and KPIs
          (view-only — the left panel controls scope).
        </p>
        {combined && conformance && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/20 p-2 text-sm">
            <Layers className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">Combined {selectedSchemaIds.length} schemas</span> ·{' '}
              {conformance.count} conformed shared dimension
              {conformance.count === 1 ? '' : 's'}
              {conformance.sharedNames.length
                ? ` (${conformance.sharedNames.slice(0, 6).join(', ')}${conformance.sharedNames.length > 6 ? ', …' : ''})`
                : ''}
              . Conformed dims link products from different source schemas.
            </span>
          </div>
        )}
      </div>

      {/* domains */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {domains.map((d) => {
          const active = d.name === focusDomain?.name;
          const liveCount = d.products.filter((p) => p.live).length;
          return (
            <button key={d.name} onClick={() => pickDomain(d.name)} className="text-left">
              <Card
                className={`shadow-sm h-full transition-colors ${
                  active ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/40'
                }`}
              >
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center justify-between gap-2">
                    <span className="truncate">{d.label}</span>
                    {d.dataAvailable ? (
                      <Badge variant="default" className="gap-1 shrink-0">
                        <Database className="h-3 w-3" /> Data Avlbl
                      </Badge>
                    ) : (
                      liveCount > 0 && (
                        <Badge variant="default" className="gap-1 shrink-0">
                          <CheckCircle2 className="h-3 w-3" /> live
                        </Badge>
                      )
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

      {/* products in the focused domain */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>{focusDomain?.label} — products</CardTitle>
          <CardDescription>{focusDomain?.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Maturity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source tables</TableHead>
                <TableHead>Genie Space</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(focusDomain?.products ?? []).map((p) => {
                const active = p.product_name === focusProduct?.product_name;
                return (
                  <TableRow
                    key={p.product_name}
                    className={`cursor-pointer ${active ? 'bg-muted/60' : ''}`}
                    onClick={() => pickProduct(p.product_name)}
                  >
                    <TableCell className="font-medium">{p.display_name}</TableCell>
                    <TableCell>
                      <Badge variant={maturityVariant(p.maturity)}>{p.maturity}</Badge>
                    </TableCell>
                    <TableCell>
                      {p.dataAvailable ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="default"
                                className="gap-1 cursor-pointer hover:opacity-90"
                                role="button"
                                tabIndex={0}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedProduct(p.product_name);
                                  navigate('/action-center');
                                }}
                              >
                                <Database className="h-3 w-3" /> Data Avlbl
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              Backed by live data — open in Action Center
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : p.live ? (
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
                    <TableCell>
                      {(() => {
                        const genie = (linksByProduct.get(p.display_name) ?? []).find(
                          (l) => l.link_type === 'genie' || l.link_type === 'dashboard'
                        );
                        if (genie) {
                          return (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    className="text-primary hover:opacity-80"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      window.open(genie.url, '_blank');
                                    }}
                                    aria-label="Open Genie Space"
                                  >
                                    <MessageSquare className="h-4 w-4" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Open {genie.label || 'Genie Space'} in a new window
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          );
                        }
                        if (p.dataAvailable) {
                          return (
                            <button
                              type="button"
                              className="text-xs text-muted-foreground hover:text-foreground underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedProduct(p.product_name);
                                navigate('/action-center');
                              }}
                            >
                              Attach
                            </button>
                          );
                        }
                        return <span className="text-xs text-muted-foreground">—</span>;
                      })()}
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
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                Preview: {focusProduct?.display_name}
                {focusProduct?.live ? (
                  <Badge variant="default" className="gap-1">
                    <CheckCircle2 className="h-3 w-3" /> live
                  </Badge>
                ) : (
                  <Badge variant="outline">schema-derived</Badge>
                )}
              </CardTitle>
              <CardDescription>{focusDomain?.label}</CardDescription>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate('/data-contract')}>
                <FileText className="h-4 w-4" /> Data Contract
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => focusProduct && navigate(`/print/${focusProduct.product_name}`)}
              >
                <FileDown className="h-4 w-4" /> Export PDF
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <span className="font-semibold text-foreground">Business outcome: </span>
            <span className="text-muted-foreground">{focusProduct?.business_outcome}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Fact tables
              </div>
              <div className="flex flex-col gap-1">
                {(focusProduct?.fact_tables ?? []).map((t) => (
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
                {(focusProduct?.dim_tables ?? []).map((t) => (
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
              {(focusProduct?.kpis ?? []).map((k) => (
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
