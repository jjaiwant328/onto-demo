// Live validation for the flagship (live) product: queries the governed serving
// view via the analytics plugin and reports column/contract presence. Isolated in
// its own component so the warehouse hook only mounts for live products.
import { useMemo } from 'react';
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { fmtInt } from '../lib/format';

const CONTRACT_COLUMNS = [
  'store_number',
  'calendar_day',
  'total_customers',
  'total_labor_cost',
  'labor_cost_per_customer',
  'labor_hours_per_customer',
  'dual_customer_conversion_rate_pct',
];

export function LiveValidation() {
  const emptyParams = useMemo(
    () => ({ regions: sql.string(''), states: sql.string(''), stores: sql.string('') }),
    []
  );
  const { data, loading, error } = useAnalyticsQuery('kpi_summary', emptyParams);
  const rowReachable = !loading && !error && !!data && data.length > 0;
  const totalCustomers = data?.[0]?.total_customers ?? null;

  const status: 'validated' | 'incomplete' | 'no_data' | 'unknown' = loading
    ? 'unknown'
    : error
      ? 'no_data'
      : rowReachable
        ? 'validated'
        : 'incomplete';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <StatusBadge status={status} />
        {rowReachable && totalCustomers != null && (
          <span className="text-muted-foreground">{fmtInt(totalCustomers)} total customers served</span>
        )}
      </div>
      {error && (
        <div className="text-destructive bg-destructive/10 p-3 rounded-md text-sm">{error}</div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Check</TableHead>
            <TableHead className="w-16 text-right">OK</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <CheckRow label="Serving view reachable" ok={!error} />
          <CheckRow label="Returns rows" ok={rowReachable} />
          {CONTRACT_COLUMNS.map((c) => (
            <CheckRow key={c} label={`Contract column \`${c}\` present`} ok={rowReachable} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'validated')
    return (
      <Badge variant="default" className="gap-1">
        <CheckCircle2 className="h-3.5 w-3.5" /> validated
      </Badge>
    );
  if (status === 'no_data')
    return (
      <Badge variant="outline" className="gap-1 text-destructive border-destructive/40">
        <XCircle className="h-3.5 w-3.5" /> no data
      </Badge>
    );
  if (status === 'incomplete')
    return (
      <Badge variant="secondary" className="gap-1">
        <AlertTriangle className="h-3.5 w-3.5" /> incomplete
      </Badge>
    );
  return <Badge variant="outline">checking…</Badge>;
}

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <TableRow>
      <TableCell className="text-sm">{label}</TableCell>
      <TableCell className="text-right">
        {ok ? (
          <CheckCircle2 className="h-4 w-4 text-success inline" />
        ) : (
          <XCircle className="h-4 w-4 text-destructive inline" />
        )}
      </TableCell>
    </TableRow>
  );
}
