// Display formatters for the Business View KPIs and tables.
// NOTE: the analytics plugin returns DECIMAL/BIGINT columns as STRINGS at runtime,
// and String.toLocaleString ignores fraction-digit options — so every input is
// coerced to a number first, otherwise raw unformatted strings leak through.

function toNum(n: number | string | null | undefined): number | null {
  if (n == null) return null;
  const x = typeof n === 'string' ? Number(n) : n;
  return Number.isNaN(x) ? null : x;
}

export function fmtInt(n: number | string | null | undefined): string {
  const x = toNum(n);
  if (x == null) return '—';
  return Math.round(x).toLocaleString('en-US');
}

export function fmtUsd(n: number | string | null | undefined, digits = 3): string {
  const x = toNum(n);
  if (x == null) return '—';
  return `$${x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtUsd0(n: number | string | null | undefined): string {
  const x = toNum(n);
  if (x == null) return '—';
  return `$${Math.round(x).toLocaleString('en-US')}`;
}

export function fmtNum(n: number | string | null | undefined, digits = 3): string {
  const x = toNum(n);
  if (x == null) return '—';
  return x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(n: number | string | null | undefined, digits = 3): string {
  const x = toNum(n);
  if (x == null) return '—';
  return `${x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}
