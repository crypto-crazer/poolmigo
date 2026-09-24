import { cx } from '@/lib/format';

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  tone?: 'aqua' | 'tide';
}

export function Toggle({ checked, onChange, label, tone = 'aqua' }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150',
        checked ? (tone === 'tide' ? 'bg-tide border-tide' : 'bg-aqua border-aqua') : 'bg-line border-line-2',
      )}
    >
      <span
        className={cx(
          'inline-block h-3.5 w-3.5 rounded-full bg-deep transition-transform duration-150',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}
