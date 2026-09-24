import { cx } from '@/lib/format';
import { formatAmount, toExactString } from '@/chain/amounts';
import type { TokenMeta } from '@/chain/useVault';

interface Props {
  token: TokenMeta;
  value: string;
  onChange: (v: string) => void;
  /** Wallet balance in base units — renders the balance line + Max. */
  balance?: bigint;
  error?: string;
  hint?: string;
  autoFocus?: boolean;
  /** Label for the balance line (default "Balance"). */
  balanceLabel?: string;
}

/** Text-mode amount field: values stay decimal strings until parseAmount turns them into base units. */
export function LiveAmountInput({ token, value, onChange, balance, error, hint, autoFocus, balanceLabel = 'Balance' }: Props) {
  return (
    <div className={cx('rounded-md bg-deep border px-3 pt-2.5 pb-2', error ? 'border-down/60' : 'border-line focus-within:border-line-2')}>
      <div className="flex items-center gap-2">
        <input
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0"
          aria-label={`${token.symbol} amount`}
          className="flex-1 min-w-0 bg-transparent display text-2xl num text-ink placeholder:text-ink-3 outline-none"
        />
        <span className="h-9 px-3 rounded-full bg-panel-2 border border-line inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap">
          {token.symbol}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-1 text-xs num">
        <span className={error ? 'text-down' : 'text-ink-3'}>{error ?? hint ?? ''}</span>
        {balance !== undefined && (
          <span className="text-ink-3 whitespace-nowrap">
            {balanceLabel} {formatAmount(balance, token.decimals, 4)}
            <button onClick={() => onChange(toExactString(balance, token.decimals))} className="ml-1.5 text-aqua font-medium hover:brightness-110">
              Max
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
