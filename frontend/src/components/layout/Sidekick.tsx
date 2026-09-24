import { useStore } from '@/store/useStore';
import { useUserDerived } from '@/store/selectors';
import * as m from '@/demo/math';
import { fmtToken } from '@/lib/format';

/** The companion, small, with one useful line. Shown once connected. */
export function Sidekick({ onClaim }: { onClaim: () => void }) {
  const d = useUserDerived();
  const locks = useStore((s) => s.user.locks);
  const now = Date.now();
  const ready = locks.filter((l) => m.isUnlockable(l, now)).reduce((a, l) => a + l.amount + l.redistributionEarned, 0);
  let line: React.ReactNode;
  if (ready > 0) line = <>You have <button onClick={onClaim} className="text-aqua font-medium hover:underline">{fmtToken(ready, 0)} PMG ready to unlock</button>.</>;
  else if (d.pendingTide >= 1) line = <>{fmtToken(d.pendingTide, 0)} PMG is waiting for you. <button onClick={onClaim} className="text-aqua font-medium hover:underline">Claim or lock it</button>.</>;
  else if (d.hasPositions) line = <>Your vaults are rebalancing and compounding on their own. Nothing to do.</>;
  else line = <>Pick a vault below to start. Deposit one asset and the vault does the rest.</>;
  return (
    <div className="flex items-center gap-3 text-sm text-ink-2">
      <img src={`${import.meta.env.BASE_URL}brand/mascot-flat.png`} alt="" className="h-9 w-auto select-none" draggable={false} />
      <span>{line}</span>
    </div>
  );
}
