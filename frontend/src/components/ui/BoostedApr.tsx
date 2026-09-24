import { cx } from '@/lib/format';

/** APR that includes PMG rewards — rendered as a charged, gradient number. */
export function BoostedApr({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1', className)}>
      <svg viewBox="0 0 12 16" className="h-[0.8em] w-auto text-apricot shrink-0" fill="currentColor" aria-hidden>
        <path d="M7.5 0 1 9.5h4.2L4 16l7-9.5H6.8L7.5 0Z" />
      </svg>
      <span className="text-aqua">{value}</span>
    </span>
  );
}
