import { cx } from '@/lib/format';
import { formatAmount } from '@/chain/amounts';
import type { TokenMeta } from '@/chain/useVault';

/** One `1,234.5678 mUSDG` line. Every live amount on screen goes through formatAmount. */
export function TokenAmount({
  value,
  token,
  digits = 4,
  className,
  showSymbol = true,
}: {
  value: bigint;
  token: TokenMeta;
  digits?: number;
  className?: string;
  showSymbol?: boolean;
}) {
  return (
    <span className={cx('num whitespace-nowrap', className)}>
      {formatAmount(value, token.decimals, digits)}
      {showSymbol && <span className="text-ink-3"> {token.symbol}</span>}
    </span>
  );
}

/** A labelled list of per-token amounts (basket totals, redeem previews, …). */
export function TokenAmountList({
  tokens,
  amounts,
  digits = 4,
  emptyLabel = '—',
  className,
}: {
  tokens: readonly TokenMeta[];
  amounts: readonly bigint[];
  digits?: number;
  emptyLabel?: string;
  className?: string;
}) {
  if (tokens.length === 0) return <div className="text-sm text-ink-3">{emptyLabel}</div>;
  return (
    <div className={cx('divide-y divide-line', className)}>
      {tokens.map((t, i) => (
        <div key={t.address} className="flex items-center justify-between gap-3 py-2 text-sm">
          <span className="text-ink-2">{t.symbol}</span>
          <TokenAmount value={amounts[i] ?? 0n} token={t} digits={digits} showSymbol={false} className="text-ink font-medium" />
        </div>
      ))}
    </div>
  );
}
