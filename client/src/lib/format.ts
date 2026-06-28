// Display formatters for the Business View KPIs and tables.

export function fmtInt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtUsd(n: number | null | undefined, digits = 3): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtUsd0(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function fmtNum(n: number | null | undefined, digits = 3): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}
