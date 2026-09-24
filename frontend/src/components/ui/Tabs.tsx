import { cx } from '@/lib/format';

interface Props<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  size?: 'sm' | 'md';
  className?: string;
}

/** Segmented control — used for Deposit/Withdraw, 30D/7D, asset chips. */
export function Segmented<T extends string>({ value, onChange, options, size = 'md', className }: Props<T>) {
  return (
    <div className={cx('inline-flex rounded border border-line bg-deep p-0.5 gap-0.5', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded transition-colors font-medium whitespace-nowrap disabled:opacity-40',
            size === 'sm' ? 'h-6 px-2 text-xs' : 'h-8 px-3 text-sm',
            value === o.value ? 'bg-panel-2 text-ink' : 'text-ink-3 hover:text-ink-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function UnderlineTabs<T extends string>({ value, onChange, options, className }: Props<T>) {
  return (
    <div className={cx('flex border-b border-line', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-11 px-4 text-sm font-medium -mb-px border-b-2 transition-colors',
            value === o.value ? 'border-aqua text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
