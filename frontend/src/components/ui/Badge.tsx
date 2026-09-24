import type { ReactNode } from 'react';
import { cx } from '@/lib/format';
import type { RangeStatus, Tier } from '@/lib/types';

const tierStyles: Record<Tier, string> = {
  Core: 'border-aqua/60 text-aqua',
  Turbo: 'border-glass text-aqua',
  Degen: 'border-amber/60 text-amber',
};

export function TierBadge({ tier, className }: { tier: Tier; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 h-5 px-1.5 rounded border text-2xs font-medium leading-none', tierStyles[tier], className)}>
      {tier === 'Degen' && (
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
          <path d="M6 1.5 11 10.5H1L6 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M6 5v2.4M6 9v.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )}
      {tier}
    </span>
  );
}

const statusMeta: Record<RangeStatus, { label: string; dot: string; text: string }> = {
  in: { label: 'In range', dot: 'bg-aqua', text: 'text-ink-2' },
  out: { label: 'Out of range', dot: 'bg-down', text: 'text-down' },
  defensive: { label: 'Defensive', dot: 'bg-amber', text: 'text-amber' },
};

export function RangeStatusBadge({ status, className }: { status: RangeStatus; className?: string }) {
  const s = statusMeta[status];
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs', s.text, className)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', s.dot, status === 'defensive' && 'ring-2 ring-amber/25')} />
      {s.label}
    </span>
  );
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center h-5 px-1.5 rounded bg-panel-2 text-2xs text-ink-2 border border-line', className)}>{children}</span>;
}
