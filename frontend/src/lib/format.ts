/** Formatting helpers. Global conventions from PRD §0. */

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 });

/** `$1,234,567` below 1M, `$12.4M` at or above 1M. */
export function fmtUsd(v: number, opts: { compact?: boolean; cents?: boolean } = {}): string {
  const { compact = true, cents = false } = opts;
  const abs = Math.abs(v);
  if (compact && abs >= 1_000_000) {
    const m = v / 1_000_000;
    return `${v < 0 ? '-' : ''}$${Math.abs(m).toFixed(m >= 100 ? 0 : 1)}M`;
  }
  if (cents || abs < 1000) return usd2.format(v);
  return usd0.format(v);
}

/** Signed money, for PnL. */
export function fmtUsdSigned(v: number): string {
  const s = fmtUsd(Math.abs(v), { compact: false, cents: Math.abs(v) < 10_000 });
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : s;
}

/** APR with 1 decimal. */
export function fmtPct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtPctSigned(v: number, digits = 1): string {
  const s = fmtPct(Math.abs(v), digits);
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : s;
}

/** Token amounts: up to 4 decimals, thousands separators, trailing zeros trimmed. */
export function fmtToken(v: number, maxDecimals = 4): string {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  const decimals = abs >= 10_000 ? Math.min(maxDecimals, 0) : abs >= 100 ? Math.min(maxDecimals, 2) : maxDecimals;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 0 }).format(v);
}

/** Whole-number token counts (e.g. PMG emissions). */
export function fmtInt(v: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v);
}

/** Pool prices: adaptive significant digits so $425.80 and 0.00184 both read well. */
export function fmtPrice(v: number): string {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(v)}`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  if (abs >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(3)}`;
}

/** Quote-token price in a pair (no $ sign), adaptive precision. */
export function fmtQuote(v: number): string {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(1);
  if (abs >= 10) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(3);
  if (abs >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}

export function fmtMultiplier(v: number): string {
  return `×${(Math.floor(v * 100 + 1e-9) / 100).toFixed(2).replace(/\.?0+$/, '')}`;
}

export function fmtDate(d: Date | string | number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(d));
}

export function fmtRelativeDays(days: number): string {
  if (days < 1) return 'today';
  const d = Math.round(days);
  return `${d}d ago`;
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
