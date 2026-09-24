import { CHAINS, type ChainId } from '@/demo/data/chains';
import { cx } from '@/lib/format';

/** Simplified chain marks for the prototype (not official brand assets). */
export function ChainLogo({ chain, size = 16, className }: { chain: ChainId; size?: number; className?: string }) {
  const c = CHAINS[chain];
  return (
    <span
      className={cx('inline-flex items-center justify-center rounded-[28%] shrink-0', className)}
      style={{ width: size, height: size, background: c.color }}
      title={c.name}
      aria-label={c.name}
    >
      {chain === 'ethereum' && (
        <svg viewBox="0 0 16 16" width={size * 0.7} height={size * 0.7} fill="none" aria-hidden>
          <path d="M8 1.5v4.9l4 1.8L8 1.5Z" fill="#fff" fillOpacity=".6" />
          <path d="M8 1.5 4 8.2l4-1.8V1.5Z" fill="#fff" />
          <path d="M8 11.2v3.3l4-5.6-4 2.3Z" fill="#fff" fillOpacity=".6" />
          <path d="M8 14.5v-3.3L4 8.9l4 5.6Z" fill="#fff" />
          <path d="m8 10.4 4-2.2-4-1.8v4Z" fill="#fff" fillOpacity=".2" />
          <path d="m4 8.2 4 2.2v-4L4 8.2Z" fill="#fff" fillOpacity=".6" />
        </svg>
      )}
      {chain === 'robinhood' && (
        <svg viewBox="0 0 16 16" width={size * 0.7} height={size * 0.7} fill="none" aria-hidden>
          <path d="M11.5 2.5c-3 .2-5.2 2-6.4 4.6C4.4 8.6 4 10.4 4 13.5c1-2.4 2-4 3.4-5.1-.4 1.6-.3 3 .2 4.3 1.4-1.8 2.3-3.9 2.6-6.4.8-1.1 1.3-2.4 1.3-3.8Z" fill="#1A1613" />
        </svg>
      )}
      {chain === 'arc' && (
        <svg viewBox="0 0 16 16" width={size * 0.7} height={size * 0.7} fill="none" aria-hidden>
          <path d="M3 11.5a5.5 5.5 0 0 1 10 0" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="8" cy="12" r="1.2" fill="#fff" />
        </svg>
      )}
    </span>
  );
}
