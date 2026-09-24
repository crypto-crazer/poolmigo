import type { Vault } from '@/lib/types';
import { useVaultApr } from '@/store/selectors';
import { fmtPct, cx } from '@/lib/format';
import { InfoDot } from '@/components/ui/Tooltip';

interface Props {
  vault: Vault;
  compact?: boolean;
  className?: string;
}

/** APR breakdown — fee APR + PMG rewards APR. Rows sum by construction. */
export function AprBreakdown({ vault, compact, className }: Props) {
  const { breakdown: b } = useVaultApr(vault);
  return (
    <div className={cx('text-sm num', className)}>
      <div className="flex items-baseline justify-between">
        <span className="text-ink-2">Total APR</span>
        <span className={cx('display font-semibold', compact ? 'text-lg' : 'text-2xl')}>{fmtPct(b.totalApr)}</span>
      </div>
      <div className="my-2 border-t border-line" />
      <div className="flex items-center justify-between py-1">
        <span className="text-ink-2">Fee APR (7d avg)</span>
        <span className="font-medium text-ink">{fmtPct(b.feeApr)}</span>
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-ink-2 inline-flex items-center gap-1.5">
          PMG rewards APR
          <InfoDot tip="Paid in PMG. Claim 50% instantly or lock 90 days for the full amount." />
        </span>
        <span className="font-medium text-tide">{fmtPct(b.tideApr)}</span>
      </div>
    </div>
  );
}
