import { TOKEN_COLORS } from '@/demo/data/vaults';
import type { ChainId } from '@/demo/data/chains';
import { ChainLogo } from './ChainLogo';
import { cx } from '@/lib/format';

export function TokenIcon({ symbol, size = 22, className }: { symbol: string; size?: number; className?: string }) {
  const color = TOKEN_COLORS[symbol] ?? '#8F8981';
  const letter = symbol.replace(/x$/, '').slice(0, 1);
  return (
    <span
      className={cx('inline-flex items-center justify-center rounded-full font-display font-semibold text-white shrink-0', className)}
      style={{ width: size, height: size, background: color, fontSize: size * 0.48, boxShadow: '0 0 0 2px rgb(var(--c-panel))' }}
      title={symbol}
    >
      {letter}
    </span>
  );
}

export function TokenPair({ a, b, size = 22, chain }: { a: string; b: string; size?: number; chain?: ChainId }) {
  return (
    <span className="relative inline-flex items-center shrink-0" style={{ width: size * 1.7, height: size }}>
      <TokenIcon symbol={a} size={size} className="relative z-10" />
      <TokenIcon symbol={b} size={size} className="-ml-2" />
      {chain && (
        <ChainLogo
          chain={chain}
          size={Math.round(size * 0.6)}
          className="absolute -bottom-1 -right-1 z-20 ring-2 ring-panel"
        />
      )}
    </span>
  );
}
