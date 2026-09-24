import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@/wallet/context';
import { useStore } from '@/store/useStore';
import { Button } from '@/components/ui/Button';
import { CONSTANTS, DEMO_ADDRESS } from '@/demo/constants';
import { cx, fmtToken, fmtUsd, shortAddress } from '@/lib/format';
import { TokenIcon } from '@/components/ui/TokenIcon';
import { TOKEN_PRICES } from '@/demo/data/vaults';
import { DemoBadge } from '@/components/ui/DataBadge';
import { useConnectWallet, useDisconnectWallet } from '@/chain/useConnectWallet';
import { chainLabel } from '@/chain/chains';
import { useSwitchToChain, useTargetChain } from '@/chain/useTargetChain';
import { useLiveVault, useUserBasket } from '@/chain/useVault';
import { formatAmount, formatAmountSignificant } from '@/chain/amounts';

export function WalletButton() {
  const connected = useStore((s) => s.connected);
  const storeAddress = useStore((s) => s.address);
  const demoWallet = useStore((s) => s.demoWallet);
  const balances = useStore((s) => s.user.balances);
  const { address, chainId, walletName } = useWallet();
  const { chain: target, isWrongChain: wrongChain } = useTargetChain();
  const { switchTo, switching } = useSwitchToChain();
  const { connectWallet, isPending } = useConnectWallet();
  const disconnectAll = useDisconnectWallet();
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

  if (!connected) {
    return (
      <Button size="sm" onClick={connectWallet} loading={isPending}>
        {isPending ? 'Connecting' : 'Connect wallet'}
      </Button>
    );
  }

  const shown = storeAddress ?? DEMO_ADDRESS;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={cx(
          'h-9 px-3 rounded-md border bg-panel text-xs num text-ink inline-flex items-center gap-2',
          wrongChain ? 'border-amber/60 hover:border-amber' : 'border-line-2 hover:border-ink-3',
        )}
      >
        <span className={cx('h-4 w-4 rounded-full', address ? 'bg-gradient-to-br from-glass to-apricot' : 'bg-line-2')} />
        {shortAddress(shown)}
        {wrongChain && <span className="text-amber">!</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-panel-2 border border-line-2 rounded-md shadow-pop p-3 animate-fade-in z-40">
          <div className="text-2xs text-ink-3 mb-2 num break-all">{shown}</div>

          {address ? (
            <div className="mb-3 rounded border border-line bg-panel px-2.5 py-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-ink-3">Wallet</span>
                <span className="text-ink">{walletName ?? 'Browser wallet'}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs mt-1">
                <span className="text-ink-3">Network</span>
                <span className={cx('num', wrongChain ? 'text-amber' : 'text-ink')}>{chainLabel(chainId)}</span>
              </div>
              {wrongChain && (
                <Button size="sm" block className="mt-2" loading={switching} onClick={() => void switchTo(target.id).catch(() => {})}>
                  Switch to {target.name}
                </Button>
              )}
            </div>
          ) : (
            <div className="mb-3 rounded border border-amber/40 bg-amber/10 px-2.5 py-2 text-2xs text-amber leading-snug">
              Demo wallet — no chain connection. Connect a browser wallet to use the live vault.
            </div>
          )}

          {address && <LiveBalances account={address} />}

          <div className="mt-3 pt-2 border-t border-line">
            <div className="flex items-center justify-between mb-1">
              <span className="text-2xs text-ink-3">Prototype balances</span>
              <DemoBadge />
            </div>
            <div className="divide-y divide-line text-sm">
              <Row token="PMG" amount={balances.PMG ?? 0} usd={(balances.PMG ?? 0) * CONSTANTS.TIDE_PRICE} tide />
              <Row token="USDC" amount={balances.USDC ?? 0} usd={balances.USDC ?? 0} />
              <Row token="TSLAx" amount={balances.TSLAx ?? 0} usd={(balances.TSLAx ?? 0) * TOKEN_PRICES.TSLAx} />
            </div>
          </div>

          <Button variant="secondary" size="sm" block className="mt-3" onClick={() => { disconnectAll(); setOpen(false); }}>
            {demoWallet && !address ? 'Leave demo wallet' : 'Disconnect'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Real balances of the deployed vault's basket + migoLP. */
function LiveBalances({ account }: { account: `0x${string}` }) {
  const vault = useLiveVault();
  const user = useUserBasket(account, vault);
  if (!vault.hasDeployment || vault.error || vault.tokens.length === 0) return null;
  return (
    <div>
      <div className="text-2xs text-ink-3 mb-1">Live vault balances</div>
      <div className="divide-y divide-line text-sm">
        <div className="flex items-center justify-between py-2">
          <span className="text-ink-2">{vault.symbol ?? 'migoLP'}</span>
          <span className="num font-medium">{formatAmountSignificant(user.shares, vault.decimals)}</span>
        </div>
        {vault.tokens.map((t, i) => (
          <div key={t.address} className="flex items-center justify-between py-2">
            <span className="text-ink-2">{t.symbol}</span>
            <span className="num font-medium">{formatAmount(user.balances[i] ?? 0n, t.decimals, 4)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ token, amount, usd, tide }: { token: string; amount: number; usd: number; tide?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="inline-flex items-center gap-2 text-ink-2">
        <TokenIcon symbol={token} size={18} />
        {token}
      </span>
      <span className="text-right">
        <span className={tide ? 'text-tide num font-medium' : 'num font-medium'}>{fmtToken(amount)}</span>
        <span className="block text-2xs text-ink-3 num">{fmtUsd(usd, { compact: false, cents: true })}</span>
      </span>
    </div>
  );
}
