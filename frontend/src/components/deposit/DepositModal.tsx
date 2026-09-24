import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Vault } from '@/lib/types';
import { DepositCard } from './DepositCard';

/** The home deposit card, as an overlay. */
export function DepositModal({ vault, onClose }: { vault: Vault | null; onClose: () => void }) {
  const [current, setCurrent] = useState<Vault | null>(vault);
  useEffect(() => setCurrent(vault), [vault]);
  useEffect(() => {
    if (!vault) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vault, onClose]);
  if (!vault || !current) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-16 overflow-y-auto" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative w-full max-w-[440px] animate-fade-in">
        <button onClick={onClose} className="absolute -top-8 right-0 text-xs text-ink-3 hover:text-ink" aria-label="Close">Close ✕</button>
        <DepositCard key={current.id} vault={current} onVaultChange={setCurrent} />
      </div>
    </div>,
    document.body,
  );
}
