import { useMarketStatus } from '@/store/selectors';
import { fmtDuration, minutesToNextTransition } from '@/lib/market';
import { Tooltip } from '@/components/ui/Tooltip';
import { cx } from '@/lib/format';

export function MarketBadge() {
  const status = useMarketStatus();
  const open = status === 'open';
  const next = fmtDuration(minutesToNextTransition());
  return (
    <Tooltip
      side="bottom"
      align="end"
      wide
      content={
        <span>
          Core vaults widen ranges while the US market is closed to protect LPs from reopening gaps.
          <span className="block mt-1 text-ink-3">
            {open ? `Closes in ${next} · 09:30–16:00 ET` : `Opens in ${next} · weekdays 09:30–16:00 ET`}
          </span>
        </span>
      }
    >
      <span className={cx('inline-flex items-center gap-2 h-8 px-2.5 rounded border text-xs cursor-help', open ? 'border-aqua/30 text-ink-2' : 'border-amber/30 text-amber')}>
        <span className={cx('h-1.5 w-1.5 rounded-full', open ? 'bg-aqua' : 'bg-amber')} />
        <span className="hidden sm:inline">{open ? 'US market open' : 'US market closed'}</span>
        <span className="sm:hidden">{open ? 'Open' : 'Closed'}</span>
      </span>
    </Tooltip>
  );
}
