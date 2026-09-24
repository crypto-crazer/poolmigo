/**
 * Decimal ⇄ bigint conversion for token amounts. Pure, no viem needed, fully unit-tested:
 * the basket mixes 6-decimal (mUSDG) and 18-decimal (mWETH) tokens, so every on-chain number
 * that reaches the UI goes through here rather than through `Number`.
 */

export type ParsedAmount = { ok: true; value: bigint } | { ok: false; error: string };

const NUMERIC = /^\d*(\.\d*)?$/;

/**
 * Parse a user-typed decimal string into base units.
 * Strict on purpose: more fraction digits than the token has is an error, not a silent truncation.
 */
export function parseAmount(input: string, decimals: number): ParsedAmount {
  const s = input.trim().replace(/,/g, '');
  if (s === '' || s === '.') return { ok: false, error: 'Enter an amount' };
  if (!NUMERIC.test(s)) return { ok: false, error: 'Numbers only' };
  const [intPart = '', fracPart = ''] = s.split('.');
  if (fracPart.length > decimals) return { ok: false, error: `Max ${decimals} decimals` };
  const padded = fracPart.padEnd(decimals, '0');
  const value = BigInt(`${intPart === '' ? '0' : intPart}${padded === '' ? '' : padded}`);
  return { ok: true, value };
}

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format base units for display: thousands separators, fraction TRUNCATED (never rounded up, so a
 * displayed balance is always spendable) to `maxFractionDigits`, trailing zeros trimmed.
 * A non-zero amount that truncates to nothing renders as `<0.0001` rather than `0`.
 */
export function formatAmount(value: bigint, decimals: number, maxFractionDigits = 4): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const frac = abs % base;
  const digits = Math.min(maxFractionDigits, decimals);
  const fracStr = decimals === 0 ? '' : frac.toString().padStart(decimals, '0').slice(0, digits).replace(/0+$/, '');
  if (int === 0n && fracStr === '' && abs > 0n) {
    return `${neg ? '-' : ''}<0.${'0'.repeat(Math.max(0, digits - 1))}1`;
  }
  return `${neg ? '-' : ''}${group(int.toString())}${fracStr ? `.${fracStr}` : ''}`;
}

/**
 * Adaptive precision: keeps `sig` significant digits however small the amount is.
 *
 * The first (owner-only) deposit mints a deploy-time genesis constant K (`genesisShares`, e.g.
 * 10,000e18), so migoLP supply starts at K whatever the basket tokens' decimals are and displays at
 * ≈ $1/share. Balances are then usually ≥ 1, but a small holder's slice — or a deployment with a
 * small K — can still sit far below 1e-4, where a fixed 4-decimal format would render "<0.0001".
 */
export function formatAmountSignificant(value: bigint, decimals: number, sig = 6): string {
  if (value === 0n) return '0';
  const abs = value < 0n ? -value : value;
  const base = 10n ** BigInt(decimals);
  if (abs >= base) return formatAmount(value, decimals, 4);
  let zeros = 0;
  let probe = abs * 10n;
  while (probe < base && zeros < decimals) {
    zeros++;
    probe *= 10n;
  }
  return formatAmount(value, decimals, Math.min(decimals, zeros + sig));
}

/** Exact decimal string (no truncation) — used to prefill inputs from a balance. */
export function toExactString(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = decimals === 0 ? '' : (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / base}${frac ? `.${frac}` : ''}`;
}

/** `0x1234…cdef` for addresses and other long hex. */
export function shortHex(hex: string): string {
  return hex.length <= 12 ? hex : `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/** bytes32 → its ascii content (adapter `dex()` / `poolId()` are packed ascii labels). */
export function bytes32Label(hex: string | undefined): string {
  if (!hex || !/^0x[0-9a-fA-F]{64}$/.test(hex)) return '—';
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code === 0) break;
    if (code < 32 || code > 126) return shortHex(hex); // not ascii — show the raw bytes
    out += String.fromCharCode(code);
  }
  return out === '' ? shortHex(hex) : out;
}
