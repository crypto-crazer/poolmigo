import { cx, fmtToken } from '@/lib/format';

interface Props {
  value: string;
  onChange: (v: string) => void;
  token: string;
  balance?: number;
  balanceLabel?: string;
  onMax?: () => void;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
}

export function AmountInput({ value, onChange, token, balance, balanceLabel = 'Balance', onMax, error, hint, autoFocus }: Props) {
  return (
    <div>
      <div className={cx('flex items-center gap-2 bg-deep border rounded px-3 h-12', error ? 'border-down/70' : 'border-line focus-within:border-ink-3')}>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.00"
          className="flex-1 min-w-0 bg-transparent text-lg num text-ink placeholder:text-ink-3 outline-none"
        />
        <span className="text-sm text-ink-2 font-medium">{token}</span>
        {onMax && (
          <button onClick={onMax} className="h-6 px-2 rounded bg-panel-2 text-2xs font-medium text-aqua hover:brightness-110">
            Max
          </button>
        )}
      </div>
      <div className="flex justify-between mt-1.5 text-xs">
        <span className={cx(error ? 'text-down' : 'text-ink-3')}>{error ?? hint ?? ''}</span>
        {balance !== undefined && (
          <span className="text-ink-3 num">
            {balanceLabel}: <span className="text-ink-2">{fmtToken(balance)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
