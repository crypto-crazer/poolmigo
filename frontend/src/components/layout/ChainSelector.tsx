/**
 * Header network selector: every registry chain (SUPPORTED_CHAINS), the target chain ticked.
 * Picking one records it as the selected chain and, with a wallet connected, asks the wallet to
 * switch (adding the chain first if the wallet does not know it). Chains without a deployment are
 * listed — you can go there — but marked so nobody expects a vault.
 */
import { useEffect, useRef, useState } from 'react';
import { SUPPORTED_CHAINS, chainShortLabel, hasDeployment, isLocalChain } from '@/chain/chains';
import { useSwitchToChain, useTargetChain } from '@/chain/useTargetChain';
import { Spinner } from '@/components/ui/Spinner';
import { cx } from '@/lib/format';

export function ChainSelector() {
  const { chain, hasDeployment: deployed, isWrongChain } = useTargetChain();
  const { switchTo, switching } = useSwitchToChain();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const warn = isWrongChain || !deployed;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Network: ${chain.name}`}
        title={isWrongChain ? 'Your wallet is on another network' : !deployed ? 'No Poolmigo deployment on this network' : chain.name}
        className={cx(
          'h-9 px-2.5 rounded-md border bg-panel text-xs text-ink inline-flex items-center gap-2 max-w-[12rem]',
          warn ? 'border-amber/60 hover:border-amber' : 'border-line hover:border-line-2',
        )}
      >
        {switching ? (
          <Spinner className="h-3 w-3 text-ink-3" />
        ) : (
          <span className={cx('h-2 w-2 rounded-full shrink-0', warn ? 'bg-amber' : 'bg-up')} aria-hidden />
        )}
        <span className="truncate">{chainShortLabel(chain.id)}</span>
        {isLocalChain(chain.id) && <span className="text-2xs text-ink-3">local</span>}
        <svg viewBox="0 0 12 12" className="h-3 w-3 text-ink-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Networks"
          className="absolute right-0 top-full mt-2 w-72 bg-panel-2 border border-line-2 rounded-md shadow-pop p-1 animate-fade-in z-40"
        >
          {SUPPORTED_CHAINS.map((c) => {
            const current = c.id === chain.id;
            const live = hasDeployment(c.id);
            return (
              <li key={c.id} role="option" aria-selected={current}>
                <button
                  type="button"
                  disabled={switching}
                  onClick={() => {
                    setOpen(false);
                    void switchTo(c.id).catch(() => {});
                  }}
                  className={cx(
                    'w-full rounded px-2.5 py-2 text-left text-xs flex items-center gap-2 hover:bg-panel disabled:cursor-not-allowed',
                    current ? 'text-ink' : 'text-ink-2',
                  )}
                >
                  <span className={cx('h-2 w-2 rounded-full shrink-0', live ? 'bg-up' : 'bg-line-2')} aria-hidden />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{c.name}</span>
                    <span className="block text-2xs text-ink-3 num">
                      chain id {c.id}
                      {c.testnet ? ' · testnet' : ''}
                      {live ? '' : ' · no deployment'}
                    </span>
                  </span>
                  {current && <span className="text-aqua" aria-hidden>✓</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
