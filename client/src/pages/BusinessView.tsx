// Business View — KPI cards, daily trend, region/state/store filters, store
// diagnostics, and ranked efficiency opportunities. All derived KPIs are
// recomputed from base sums in SQL (see config/queries/*.sql), never averaged.
import { useMemo, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Checkbox,
  ScrollArea,
  ToggleGroup,
  ToggleGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Skeleton,
  LineChart,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { ChevronDown, Users, DollarSign, Clock, Repeat, Info } from 'lucide-react';
import { fmtUsd, fmtNum, fmtPct } from '../lib/format';
import { useProduct } from '../lib/product';

// Business View dispatcher: live products keep the warehouse-backed dashboard;
// non-live (schema-derived) products show derived KPI definitions + fact-table
// column shapes with a clear "no live serving layer" notice (no fake data).
export function BusinessView() {
  const { components, selectedProduct } = useProduct();
  if (components.live) return <LiveBusinessView key={selectedProduct.product_name} />;
  return <SchemaDerivedBusinessView key={selectedProduct.product_name} />;
}

const TREND_METRICS = [
  { key: 'total_customers', label: 'Total customers' },
  { key: 'labor_cost_per_customer', label: 'Labor $ / customer' },
  { key: 'labor_hours_per_customer', label: 'Labor hrs / customer' },
  { key: 'dual_customer_conversion_rate_pct', label: 'Dual conversion %' },
] as const;

type MetricKey = (typeof TREND_METRICS)[number]['key'];

function LiveBusinessView() {
  const noParams = useMemo(() => ({}) as Record<string, never>, []);
  const { data: filterData } = useAnalyticsQuery('filter_options', noParams);

  const regions = useMemo(
    () => (filterData ?? []).filter((f) => f.kind === 'region'),
    [filterData]
  );
  const states = useMemo(() => (filterData ?? []).filter((f) => f.kind === 'state'), [filterData]);
  const stores = useMemo(() => (filterData ?? []).filter((f) => f.kind === 'store'), [filterData]);

  const [selRegions, setSelRegions] = useState<string[]>([]);
  const [selStates, setSelStates] = useState<string[]>([]);
  const [selStores, setSelStores] = useState<string[]>([]);
  const [metric, setMetric] = useState<MetricKey>('labor_cost_per_customer');

  const params = useMemo(
    () => ({
      regions: sql.string(selRegions.join(',')),
      states: sql.string(selStates.join(',')),
      stores: sql.string(selStores.join(',')),
    }),
    [selRegions, selStates, selStores]
  );

  const kpi = useAnalyticsQuery('kpi_summary', params);
  const trend = useAnalyticsQuery('daily_trend', params);
  const diag = useAnalyticsQuery('store_diagnostics', params);
  const opp = useAnalyticsQuery('opportunities', params);

  const k = kpi.data?.[0];
  const totalOpp = (opp.data ?? []).reduce((s, r) => s + Math.max(0, r.opportunity_usd ?? 0), 0);
  const metricLabel = TREND_METRICS.find((m) => m.key === metric)?.label ?? metric;

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Business View</h2>
        <p className="text-muted-foreground">
          Store traffic &amp; labor efficiency. Derived KPIs are recomputed from base sums in the
          governed serving layer.
        </p>
      </div>

      {/* Filters */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-start gap-6">
          <FilterBlock label="Region">
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              value={selRegions}
              onValueChange={setSelRegions}
            >
              {regions.map((r) => (
                <ToggleGroupItem key={r.value} value={r.value}>
                  {r.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FilterBlock>

          <FilterBlock label="State">
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              value={selStates}
              onValueChange={setSelStates}
            >
              {states.map((s) => (
                <ToggleGroupItem key={s.value} value={s.value}>
                  {s.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FilterBlock>

          <FilterBlock label="Store">
            <MultiSelect
              options={stores}
              selected={selStores}
              onChange={setSelStores}
              placeholder="All stores"
            />
          </FilterBlock>

          {(selRegions.length || selStates.length || selStores.length) > 0 && (
            <div className="self-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelRegions([]);
                  setSelStates([]);
                  setSelStores([]);
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={<Users className="h-4 w-4" />}
          label="Total customers"
          value={k ? fmtNum(k.total_customers) : null}
          loading={kpi.loading}
        />
        <KpiCard
          icon={<DollarSign className="h-4 w-4" />}
          label="Labor $ / customer"
          value={k ? fmtUsd(k.labor_cost_per_customer) : null}
          loading={kpi.loading}
        />
        <KpiCard
          icon={<Clock className="h-4 w-4" />}
          label="Labor hrs / customer"
          value={k ? fmtNum(k.labor_hours_per_customer) : null}
          loading={kpi.loading}
        />
        <KpiCard
          icon={<Repeat className="h-4 w-4" />}
          label="Dual conversion"
          value={k ? fmtPct(k.dual_customer_conversion_rate_pct, 3) : null}
          loading={kpi.loading}
        />
      </div>

      {/* Trend */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Daily trend</CardTitle>
            <CardDescription>{metricLabel} by calendar day</CardDescription>
          </div>
          <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TREND_METRICS.map((m) => (
                <SelectItem key={m.key} value={m.key}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {trend.error && (
            <div className="text-destructive bg-destructive/10 p-3 rounded-md text-sm">
              {trend.error}
            </div>
          )}
          {trend.data && (
            <LineChart
              data={trend.data}
              xKey="calendar_day"
              yKey={metric}
              height={300}
              showLegend={false}
            />
          )}
        </CardContent>
      </Card>

      {/* Store diagnostics */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Store diagnostics</CardTitle>
          <CardDescription>
            Per-store rollup (jai_store_efficiency_summary), sorted by labor $/customer
          </CardDescription>
        </CardHeader>
        <CardContent>
          {diag.loading && <Skeleton className="h-40 w-full" />}
          {diag.error && (
            <div className="text-destructive bg-destructive/10 p-3 rounded-md text-sm">
              {diag.error}
            </div>
          )}
          {diag.data && (
            <ScrollArea className="max-h-[420px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Store</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Customers</TableHead>
                    <TableHead className="text-right">Labor $/cust</TableHead>
                    <TableHead className="text-right">Labor hrs/cust</TableHead>
                    <TableHead className="text-right">Dual conv %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diag.data.map((r) => (
                    <TableRow key={r.store_number}>
                      <TableCell className="font-medium">
                        {r.store_number} — {r.store_name}
                      </TableCell>
                      <TableCell>{r.region_name}</TableCell>
                      <TableCell>{r.state_code}</TableCell>
                      <TableCell className="text-right">{fmtNum(r.total_customers)}</TableCell>
                      <TableCell className="text-right">
                        {fmtUsd(r.labor_cost_per_customer)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtNum(r.labor_hours_per_customer)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtPct(r.dual_customer_conversion_rate_pct, 3)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Opportunities */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Efficiency opportunity rankings</CardTitle>
            <CardDescription>
              Stores above the benchmark labor cost per customer (jai_store_efficiency_opportunities)
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Identified opportunity
            </div>
            <div className="text-xl font-bold text-foreground">{fmtUsd(totalOpp)}</div>
          </div>
        </CardHeader>
        <CardContent>
          {opp.loading && <Skeleton className="h-40 w-full" />}
          {opp.error && (
            <div className="text-destructive bg-destructive/10 p-3 rounded-md text-sm">
              {opp.error}
            </div>
          )}
          {opp.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead className="text-right">Labor $/cust</TableHead>
                  <TableHead className="text-right">Benchmark</TableHead>
                  <TableHead className="text-right">Gap</TableHead>
                  <TableHead className="text-right">Opportunity $</TableHead>
                  <TableHead>Flag</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {opp.data.map((r) => (
                  <TableRow key={r.store_number}>
                    <TableCell>{r.opportunity_rank}</TableCell>
                    <TableCell className="font-medium">
                      {r.store_number} — {r.store_name}
                    </TableCell>
                    <TableCell>{r.region_name}</TableCell>
                    <TableCell className="text-right">{fmtUsd(r.labor_cost_per_customer)}</TableCell>
                    <TableCell className="text-right">{fmtUsd(r.benchmark_lcpc)}</TableCell>
                    <TableCell className="text-right">{fmtUsd(r.lcpc_gap)}</TableCell>
                    <TableCell className="text-right">{fmtUsd(r.opportunity_usd)}</TableCell>
                    <TableCell>
                      <Badge variant={r.opportunity_flag === 'opportunity' ? 'default' : 'outline'}>
                        {r.opportunity_flag}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Non-live products: no warehouse query, no fabricated data. Show the derived
// KPI definitions and the real fact-table column shapes, with a clear notice.
function SchemaDerivedBusinessView() {
  const { components, selectedProduct } = useProduct();
  const factTables = components.tables.filter((t) => t.role === 'fact');

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Business View</h2>
        <p className="text-muted-foreground">{selectedProduct.display_name}</p>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-amber-300/50 bg-amber-50/60 dark:bg-amber-950/20 p-3 text-sm">
        <Info className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
        <span className="text-muted-foreground">
          <span className="font-medium text-foreground">Schema-derived preview</span> — no live
          serving layer for this product yet. The KPI definitions and fact-table shapes below are
          derived from the live <code>fc_entdata_gold</code> schema; build the serving views to light
          up live metrics, charts, and filters (as on the flagship product).
        </span>
      </div>

      {/* headline KPI definitions (no values — no fabricated data) */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-2">Headline KPIs (definitions)</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {components.kpis.map((k) => (
            <Card key={k} className="shadow-sm">
              <CardContent className="pt-6">
                <div className="text-muted-foreground text-xs uppercase tracking-wide">KPI</div>
                <div className="text-lg font-bold text-foreground mt-1 break-words">{k}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  Awaiting serving layer — no value computed.
                </div>
              </CardContent>
            </Card>
          ))}
          {components.kpis.length === 0 && (
            <p className="text-sm text-muted-foreground">No KPIs defined for this product.</p>
          )}
        </div>
      </div>

      {/* fact-table column shapes */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Fact-table column shapes</h3>
        {factTables.map((t) => (
          <Card key={t.table} className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-base">{t.label}</CardTitle>
              <CardDescription>
                <code className="text-xs">{t.table}</code> · {t.columns.length} columns
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="max-h-72">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Column</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Role</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {t.columns.map((c) => (
                      <TableRow key={c.name}>
                        <TableCell className="font-medium">{c.name}</TableCell>
                        <TableCell className="text-muted-foreground">{c.type}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{c.role}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        ))}
        {factTables.length === 0 && (
          <p className="text-sm text-muted-foreground">No fact tables defined for this product.</p>
        )}
      </div>
    </div>
  );
}

function FilterBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  loading: boolean;
}) {
  return (
    <Card className="shadow-sm">
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          {icon}
          {label}
        </div>
        {loading ? (
          <Skeleton className="h-8 w-24 mt-2" />
        ) : (
          <div className="text-3xl font-bold text-foreground mt-1">{value ?? '—'}</div>
        )}
      </CardContent>
    </Card>
  );
}

function MultiSelect({
  options,
  selected,
  onChange,
  placeholder,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const text =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-64 justify-between font-normal">
          <span className="truncate">{text}</span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <ScrollArea className="max-h-72">
          <div className="p-1">
            {options.map((o) => (
              <label
                key={o.value}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer"
              >
                <Checkbox
                  checked={selected.includes(o.value)}
                  onCheckedChange={() => toggle(o.value)}
                />
                <span className="truncate">{o.label}</span>
              </label>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
