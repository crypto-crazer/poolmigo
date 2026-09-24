import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { VAULTS, vaultName } from '@/demo/data/vaults';
import { CHAINS } from '@/demo/data/chains';
import * as m from '@/demo/math';
import { cx, fmtPct, fmtUsd } from '@/lib/format';
import type { Vault } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { TokenPair } from '@/components/ui/TokenIcon';

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (v: Vault) => void;
  selectedId: string;
}

/** Uniswap-style token select, for vaults. */
export function VaultSelect({ open, onClose, onSelect, selectedId }: Props) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const tvlDelta = useStore((s) => s.user.tvlDelta);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setTimeout(() => input.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const rows = useMemo(
    () =>
      VAULTS.map((v) => ({ v, tvl: m.effectiveTvl(v, tvlDelta) }))
        .filter(({ v }) => `${vaultName(v)} ${CHAINS[v.chain].name}`.toLowerCase().replace(/\s/g, '').includes(q.toLowerCase().replace(/\s/g, '')))
        .sort((a, b) => b.tvl - a.tvl),
    [q, tvlDelta],
  );

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start md:items-center justify-center p-4" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative w-full max-w-md bg-panel border border-line rounded-lg shadow-pop animate-fade-in overflow-hidden">
        <div className="px-4 pt-4 pb-3 border-b border-line">
          <div className="flex items-center justify-between mb-3">
            <h2 className="display text-md font-semibold">Select a vault</h2>
            <button onClick={onClose} className="text-ink-3 hover:text-ink text-sm" aria-label="Close">✕</button>
          </div>
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pairs"
            className="w-full h-10 px-3 rounded bg-deep border border-line focus:border-ink-3 outline-none text-sm placeholder:text-ink-3"
          />
        </div>
        <ul className="max-h-[420px] overflow-y-auto py-1">
          {rows.map(({ v, tvl }) => {
            const apr = m.aprBreakdown(v, tvl).totalApr;
            const selected = v.id === selectedId;
            return (
              <li key={v.id}>
                <button
                  onClick={() => { onSelect(v); onClose(); }}
                  className={cx('w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-panel-2 transition-colors', selected && 'bg-panel-2/70', v.tier === 'Degen' && 'bg-amber/[0.04]')}
                >
                  <TokenPair a={v.token0} b={v.token1} size={26} chain={v.chain} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink">{vaultName(v)}</div>
                    <div className="text-xs text-ink-3 num">{CHAINS[v.chain].name} · {fmtUsd(tvl)} TVL{v.tier === 'Degen' ? ' · High risk' : ''}</div>
                  </div>
                  <div className="display num text-md font-semibold text-ink">{fmtPct(apr)}</div>
                </button>
              </li>
            );
          })}
          {rows.length === 0 && <li className="px-4 py-8 text-center text-sm text-ink-3">No vaults match.</li>}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
