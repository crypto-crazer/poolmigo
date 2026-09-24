/**
 * In-kind redemption. `redeem(shares, receiver)` burns migoLP and sends a pro-rata slice of EVERY
 * basket token — it reads no adapter reports and works even while rebalancing is paused, so there
 * is no state in which a holder cannot get out.
 */
import { useState } from 'react';
import { parseEventLogs } from 'viem';
import { vaultAbi } from '@/config/generated';
import { useWallet } from '@/wallet/context';
import { waitForReceipt } from '@/chain/client';
import { chainLabel } from '@/chain/chains';
import { useSwitchToChain } from '@/chain/useTargetChain';
import { formatAmount, formatAmountSignificant, parseAmount, toExactString } from '@/chain/amounts';
import { describeChainError } from '@/chain/errors';
import { usePreviewRedeem, type LiveVault, type UserBasket } from '@/chain/useVault';
import { Button } from '@/components/ui/Button';
import { useConnectWallet } from '@/chain/useConnectWallet';
import { useStore } from '@/store/useStore';
import { Message } from './Message';
import { TokenAmountList } from './TokenAmount';

export function LiveRedeemCard({ vault, user }: { vault: LiveVault; user: UserBasket }) {
  const { address, chainId, write } = useWallet();
  const { connectWallet, isPending: connecting } = useConnectWallet();
  const { switchTo, switching } = useSwitchToChain();
  const pushToast = useStore((s) => s.pushToast);

  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [received, setReceived] = useState<bigint[] | null>(null);

  const parsed = value.trim() === '' ? null : parseAmount(value, vault.decimals);
  const shares = parsed && parsed.ok ? parsed.value : 0n;
  const parseError = parsed && !parsed.ok ? parsed.error : undefined;
  const tooMany = shares > user.shares;

  const preview = usePreviewRedeem(vault, shares, shares > 0n && !tooMany);
  const errCtx = {
    shareDecimals: vault.decimals,
    tokenDecimals: Object.fromEntries(vault.tokens.map((t) => [t.address, t.decimals])),
    tokenSymbols: Object.fromEntries(vault.tokens.map((t) => [t.address, t.symbol])),
  };

  const wrongChain = Boolean(address) && chainId !== vault.chainId;

  const submit = async () => {
    if (!address || shares === 0n) return;
    setError(null);
    setReceived(null);
    setBusy(true);
    try {
      const hash = await write({
        chainId: vault.chainId,
        address: vault.address,
        abi: vaultAbi,
        functionName: 'redeem',
        args: [shares, address],
      });
      const receipt = await waitForReceipt(vault.chainId, hash);
      const events = parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: 'Redeemed' });
      const amounts = (events[0]?.args as { amounts?: readonly bigint[] } | undefined)?.amounts;
      setReceived(amounts ? [...amounts] : null);
      setValue('');
      vault.refetch();
      user.refetch();
      pushToast({
        title: 'Redeem confirmed',
        detail: `Burned ${formatAmountSignificant(shares, vault.decimals)} ${vault.symbol ?? 'migoLP'} on ${chainLabel(vault.chainId)}`,
        tone: 'up',
      });
    } catch (err) {
      setError(describeChainError(err, errCtx));
    } finally {
      setBusy(false);
    }
  };

  let cta: { label: string; disabled: boolean; onClick: () => void } = { label: 'Redeem', disabled: true, onClick: () => {} };
  if (!address) cta = { label: 'Connect wallet', disabled: false, onClick: connectWallet };
  else if (wrongChain) {
    cta = { label: `Switch to ${chainLabel(vault.chainId)}`, disabled: false, onClick: () => void switchTo(vault.chainId).catch(() => {}) };
  }
  else if (user.shares === 0n) cta = { label: 'No migoLP to redeem', disabled: true, onClick: () => {} };
  else if (parseError) cta = { label: 'Fix the amount', disabled: true, onClick: () => {} };
  else if (shares === 0n) cta = { label: 'Enter an amount', disabled: true, onClick: () => {} };
  else if (tooMany) cta = { label: `Max ${formatAmountSignificant(user.shares, vault.decimals)}`, disabled: true, onClick: () => {} };
  else cta = { label: 'Redeem in kind', disabled: false, onClick: () => void submit() };

  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="display text-sm font-semibold">Redeem</h3>
        <span className="text-2xs text-ink-3">Always available · never blocked by a position</span>
      </div>

      <div className="rounded-md bg-deep border border-line px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <input
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => { setValue(e.target.value); setReceived(null); }}
            placeholder="0"
            aria-label="migoLP amount to redeem"
            className="flex-1 min-w-0 bg-transparent display text-2xl num text-ink placeholder:text-ink-3 outline-none"
          />
          <span className="h-9 px-3 rounded-full bg-panel-2 border border-line inline-flex items-center text-sm font-medium whitespace-nowrap">
            {vault.symbol ?? 'migoLP'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-1 text-xs num">
          <span className={parseError || tooMany ? 'text-down' : 'text-ink-3'}>{parseError ?? (tooMany ? 'More than you hold' : '')}</span>
          <span className="text-ink-3 whitespace-nowrap">
            Balance {formatAmountSignificant(user.shares, vault.decimals)}
            <button
              onClick={() => setValue(toExactString(user.shares, vault.decimals))}
              className="ml-1.5 text-aqua font-medium hover:brightness-110"
            >
              Max
            </button>
          </span>
        </div>
      </div>

      <div className="rounded-md bg-deep border border-line px-3 py-2">
        <div className="text-xs text-ink-3 mb-1">You receive</div>
        <TokenAmountList tokens={vault.tokens} amounts={preview.owed ?? vault.tokens.map(() => 0n)} digits={6} />
      </div>

      {preview.error && <Message tone="warn">{describeChainError(preview.error, errCtx)}</Message>}
      {error && <Message tone="error">{error}</Message>}
      {received && (
        <Message tone="ok">
          Redeemed.{' '}
          {vault.tokens.map((t, i) => `${formatAmount(received[i] ?? 0n, t.decimals, 6)} ${t.symbol}`).join(' + ')} sent to your wallet.
        </Message>
      )}

      <Button block size="lg" variant="secondary" onClick={cta.onClick} disabled={cta.disabled || busy} loading={busy || connecting || (wrongChain && switching)}>
        {busy ? 'Redeeming…' : cta.label}
      </Button>

      <p className="text-2xs text-ink-3 leading-relaxed">
        Each adapter delivers <span className="num">floor(sharesBps / 10,000)</span> of what it holds straight to your wallet; the
        vault sends your exact slice of its idle balances. The bps flooring leaves up to ~1bp of the adapter-held slice behind — a
        documented dust convention, the vault never over-delivers.
      </p>
    </section>
  );
}
