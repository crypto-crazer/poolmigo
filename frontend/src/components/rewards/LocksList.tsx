import { useState } from 'react';
import * as m from '@/demo/math';
import { cx, fmtDate, fmtToken } from '@/lib/format';
import { useStore } from '@/store/useStore';
import { Button } from '@/components/ui/Button';

/** Every lock as its own row with a countdown to unlock. Lives inside the claim modal. */
export function LocksList() {
  const locks = useStore((s) => s.user.locks);
  const unlock = useStore((s) => s.unlock);
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.now();
  if (locks.length === 0) return null;
  const total = m.lockedTide(locks);

  const doUnlock = async (id: string, amount: number) => {
    setBusy(id);
    await new Promise((r) => setTimeout(r, 1500));
    unlock(id);
    setBusy(null);
    pushToast({ title: 'Unlock confirmed', detail: `${fmtToken(amount, 1)} PMG returned to your wallet`, tone: 'up' });
  };

  return (
    <section className="bg-panel border border-line rounded-lg p-4">
      <div className="flex items-center justify-between">
        <h2 className="display text-sm font-semibold">Locked PMG</h2>
        <span className="text-xs num text-tide">{fmtToken(total, 0)} PMG</span>
      </div>
      <ul className="divide-y divide-line mt-1">
        {[...locks].sort((a, b) => a.unlockAt - b.unlockAt).map((l) => {
          const ready = m.isUnlockable(l, now);
          const left = m.lockDaysLeft(l, now);
          return (
            <li key={l.id} className="py-3 text-sm num">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink font-medium">
                  {fmtToken(l.amount, 1)} PMG
                  {l.redistributionEarned > 0 && <span className="text-2xs text-up ml-2">+{fmtToken(l.redistributionEarned, 1)} earned</span>}
                </span>
                {ready ? (
                  <Button size="sm" variant="tide" onClick={() => doUnlock(l.id, l.amount)} loading={busy === l.id}>Unlock</Button>
                ) : (
                  <span className="text-xs text-ink-3">{left}d left</span>
                )}
              </div>
              <div className="mt-2 h-1 rounded-full bg-line overflow-hidden">
                <div className={cx('h-full rounded-full', ready ? 'bg-up' : 'bg-tide')} style={{ width: `${m.lockProgress(l, now) * 100}%` }} />
              </div>
              <div className="mt-1.5 flex justify-between text-2xs text-ink-3">
                <span>Locked {fmtDate(l.lockedAt)}</span>
                <span className={ready ? 'text-up' : ''}>{ready ? 'Ready to unlock' : `Unlocks ${fmtDate(l.unlockAt)}`}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
