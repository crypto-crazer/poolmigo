import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PROTOCOL } from '@/demo/data/protocol';
import { CONSTANTS } from '@/demo/constants';
import * as m from '@/demo/math';
import { cx, fmtDate, fmtInt, fmtToken, fmtUsd } from '@/lib/format';
import { useStore } from '@/store/useStore';
import { useUserDerived } from '@/store/selectors';
import { Button } from '@/components/ui/Button';
import { LocksList } from './LocksList';

const TX_DELAY = 1500;
type Choice = 'now' | 'lock';

/** Claim pending PMG: now at 50%, or lock 90 days for 100%. */
export function ClaimModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-16 overflow-y-auto" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative w-full max-w-[440px] animate-fade-in space-y-3">
        <button onClick={onClose} className="absolute -top-8 right-0 text-xs text-ink-3 hover:text-ink" aria-label="Close">Close ✕</button>
        <Claim onDone={onClose} />
        <LocksList />
      </div>
    </div>,
    document.body,
  );
}

function Claim({ onDone }: { onDone: () => void }) {
  const d = useUserDerived();
  const claimInstant = useStore((s) => s.claimInstant);
  const claimLock = useStore((s) => s.claimLock);
  const pushToast = useStore((s) => s.pushToast);
  const [choice, setChoice] = useState<Choice>('lock');
  const [busy, setBusy] = useState(false);
  const forfeitsAdded = useStore((s) => s.forfeitsAdded);
  const pool = PROTOCOL.redistribution.fromForfeits + forfeitsAdded + PROTOCOL.redistribution.fromBuybacks;
  const split = m.claimSplit(d.pendingTide);
  const empty = d.pendingTide < 0.005;

  const submit = async () => {
    setBusy(true);
    await new Promise((r) => setTimeout(r, TX_DELAY));
    if (choice === 'now') {
      const got = claimInstant();
      pushToast({ title: 'Claim confirmed', detail: `${fmtToken(got, 1)} PMG sent to your wallet`, tone: 'up' });
    } else {
      const lock = claimLock();
      if (lock) pushToast({ title: 'Lock confirmed', detail: `${fmtToken(lock.amount, 1)} PMG unlocks ${fmtDate(lock.unlockAt)}`, tone: 'up' });
    }
    setBusy(false);
    onDone();
  };

  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="display text-sm font-semibold">Pending rewards</h2>
        <span className="text-xs text-ink-3 num">PMG ${CONSTANTS.TIDE_PRICE.toFixed(3)}</span>
      </div>
      <div className="display num text-3xl font-semibold text-tide leading-none">
        {fmtToken(d.pendingTide, 2)} <span className="text-lg">PMG</span>
        <span className="text-sm text-ink-2 font-normal ml-2">≈ {fmtUsd(d.pendingTide * CONSTANTS.TIDE_PRICE, { compact: false, cents: true })}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Option selected={choice === 'now'} onSelect={() => setChoice('now')} title="Claim now" amount={split.instant} note="50% · rest goes to lockers" />
        <Option selected={choice === 'lock'} onSelect={() => setChoice('lock')} title="Lock 90 days" amount={split.locked} note="100% + share of forfeits" good />
      </div>
      <Button block size="lg" variant="tide" onClick={submit} disabled={empty} loading={busy}>
        {busy ? 'Confirming…' : empty ? 'Nothing to claim yet' : choice === 'now' ? `Claim ${fmtToken(split.instant, 1)} PMG` : `Lock ${fmtToken(split.locked, 1)} PMG`}
      </Button>
      <div className="text-2xs text-ink-3 num">Lockers share this week's pool of {fmtInt(pool)} PMG from forfeits and buybacks.</div>
    </section>
  );
}

function Option({ selected, onSelect, title, amount, note, good }: { selected: boolean; onSelect: () => void; title: string; amount: number; note: string; good?: boolean }) {
  return (
    <button onClick={onSelect} aria-pressed={selected} className={cx('text-left rounded-md border px-3 py-2.5 transition-colors', selected ? 'border-tide bg-tide/[0.07]' : 'border-line hover:border-line-2 bg-deep')}>
      <div className="text-xs text-ink-2">{title}</div>
      <div className={cx('display num text-xl font-semibold mt-0.5', selected ? 'text-tide' : 'text-ink')}>{fmtToken(amount, 1)} <span className="text-xs font-normal">PMG</span></div>
      <div className={cx('text-2xs mt-1', good ? 'text-up' : 'text-ink-3')}>{note}</div>
    </button>
  );
}
