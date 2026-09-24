import { cx } from '@/lib/format';
import { Tooltip } from './Tooltip';

/**
 * Provenance tags. Every number on screen is one of two things and the UI has to say which:
 *  - <DemoBadge/>  — invented figure from src/demo (no chain can produce it: APR, USD, PMG, locks)
 *  - <LiveBadge/>  — read from the deployed vault over RPC
 * See notes/frontend/INTEGRATION.md (internal) for the full mapping.
 */
export function DemoBadge({ className, label = 'Demo data' }: { className?: string; label?: string }) {
  return (
    <Tooltip content="Prototype figure — invented, not read from any chain." wide>
      <span
        className={cx(
          'inline-flex items-center gap-1 h-5 px-1.5 rounded border border-amber/45 bg-amber/10 text-2xs font-medium leading-none text-amber whitespace-nowrap cursor-help',
          className,
        )}
      >
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" aria-hidden>
          <circle cx="6" cy="6" r="4.75" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2 1.6" />
        </svg>
        {label}
      </span>
    </Tooltip>
  );
}

export function LiveBadge({ className, label = 'Live on-chain' }: { className?: string; label?: string }) {
  return (
    <Tooltip content="Read from the deployed Poolmigo vault over RPC." wide>
      <span
        className={cx(
          'inline-flex items-center gap-1.5 h-5 px-1.5 rounded border border-up/45 bg-up/10 text-2xs font-medium leading-none text-up whitespace-nowrap cursor-help',
          className,
        )}
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-up opacity-60 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-up" />
        </span>
        {label}
      </span>
    </Tooltip>
  );
}

/** One-line legend for pages that mix both kinds of number. */
export function DataLegend({ className }: { className?: string }) {
  return (
    <p className={cx('flex flex-wrap items-center gap-2 text-2xs text-ink-3', className)}>
      <LiveBadge label="Live" /> read from the deployed vault ·
      <DemoBadge label="Demo" /> prototype figure, not from any chain
    </p>
  );
}
