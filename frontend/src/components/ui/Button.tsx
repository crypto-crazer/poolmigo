import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/format';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'tide';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
  children: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'bg-aqua text-on-primary hover:bg-aqua-dim disabled:bg-line disabled:text-ink-3',
  tide: 'bg-apricot text-on-accent hover:brightness-105 disabled:bg-line disabled:text-ink-3',
  secondary: 'bg-panel text-ink border border-line-2 hover:border-ink-3 disabled:text-ink-3 disabled:hover:border-line-2',
  ghost: 'bg-transparent text-ink-2 hover:text-ink hover:bg-panel-2 disabled:text-ink-3',
  danger: 'bg-transparent text-down border border-down/40 hover:bg-down/10',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 px-5 text-md',
};

export function Button({ variant = 'primary', size = 'md', loading, block, className, children, disabled, ...rest }: Props) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors duration-150 select-none whitespace-nowrap disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        block && 'w-full',
        className,
      )}
    >
      {loading && <Spinner className="h-4 w-4" />}
      <span className={cx(loading && 'opacity-80')}>{children}</span>
    </button>
  );
}
