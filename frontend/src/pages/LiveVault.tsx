/**
 * The one page where every number is real: the Poolmigo vault on the target chain, read over RPC.
 * The target chain is the wallet's chain when Poolmigo is deployed there, else the chain picked in
 * the header (src/chain/targetChain.ts).
 * Anything this page cannot get from the chain simply is not shown — there is no APR here, no USD
 * value, no rewards. Those live on the prototype pages and are tagged as demo data.
 */
import { useWallet } from '@/wallet/context';
import { Link } from 'react-router-dom';
import { DEPLOYMENTS } from '@/config/generated';
import { chainLabel, isLocalChain } from '@/chain/chains';
import { useSwitchToChain, useTargetChain } from '@/chain/useTargetChain';
import { formatAmount, formatAmountSignificant, shortHex } from '@/chain/amounts';
import { useLiveVault, useUserBasket } from '@/chain/useVault';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Stat, StatRow } from '@/components/ui/Stat';
import { Spinner } from '@/components/ui/Spinner';
import { DataLegend, LiveBadge } from '@/components/ui/DataBadge';
import { AdapterList } from '@/components/live/AdapterList';
import { LiveDepositCard } from '@/components/live/LiveDepositCard';
import { LiveRedeemCard } from '@/components/live/LiveRedeemCard';
import { LocalDevPanel } from '@/components/live/LocalDevPanel';
import { Message } from '@/components/live/Message';
import { TokenAmountList } from '@/components/live/TokenAmount';
import { cx } from '@/lib/format';

export function LiveVault() {
  const { address, chainId } = useWallet();
  const { isWrongChain: wrongChain } = useTargetChain();
  const { switchTo, switching } = useSwitchToChain();
  const vault = useLiveVault();
  const user = useUserBasket(address, vault);

  const chainName = chainLabel(vault.chainId);
  const unreachable = Boolean(vault.error) || (!vault.isLoading && vault.tokens.length === 0);
  const switchButton = (id: number) => (
    <Button key={id} size="sm" variant="secondary" loading={switching} onClick={() => void switchTo(id).catch(() => {})}>
      Switch to {chainLabel(id)}
    </Button>
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="text-xs text-ink-3 hover:text-ink-2 mr-1">← Earn</Link>
        <h1 className="display text-2xl font-semibold">{vault.name ?? 'Poolmigo vault'}</h1>
        <LiveBadge />
        <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-panel border border-line text-xs text-ink-2 num">
          {chainName}
          {vault.hasDeployment && <> · {shortHex(vault.address)}</>}
        </span>
        {vault.isLoading && <Spinner className="h-4 w-4 text-ink-3" />}
      </header>

      <p className="text-sm text-ink-2 max-w-3xl leading-relaxed">
        An in-kind basket vault: you deposit the basket tokens themselves and receive{' '}
        <span className="num">{vault.symbol ?? 'migoLP'}</span>, a fungible pro-rata claim on the whole basket. There is no USD
        valuation, no NAV and no oracle anywhere in this contract — every figure below is a token amount read from the chain.
      </p>

      {vault.hasDeployment && wrongChain && (
        <Message tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Your wallet is on {chainLabel(chainId)}. Reads below come from {chainName}; switch network to deposit or redeem.
            </span>
            {switchButton(vault.chainId)}
          </div>
        </Message>
      )}

      {!vault.hasDeployment ? (
        <Message tone="warn">
          <p>No Poolmigo deployment on {chainName} yet. Switch to a network where the vault is live:</p>
          <div className="mt-2 flex flex-wrap gap-2">{DEPLOYMENTS.map((d) => switchButton(d.chainId))}</div>
        </Message>
      ) : unreachable ? (
        <Message tone="error">
          Cannot reach the vault at {vault.address} on {chainName} ({vault.deployment?.rpcUrl}).{' '}
          {isLocalChain(vault.chainId) ? 'Start the local chain and the demo stack, then reload.' : 'The RPC did not answer; try again shortly.'}{' '}
          Everything else in the app keeps working on demo data.
        </Message>
      ) : (
        <>
          {vault.rebalancePaused && (
            <Message tone="warn">Deposits and rebalancing are paused by the vault owner. Redeem stays available.</Message>
          )}

          <StatRow cols={4}>
            <Stat
              label={`${vault.symbol ?? 'migoLP'} supply`}
              value={formatAmountSignificant(vault.totalSupply, vault.decimals)}
              sub={`${vault.tokens.length} basket tokens`}
            />
            <Stat
              label="Your share"
              value={
                vault.totalSupply === 0n || user.shares === 0n
                  ? '0%'
                  : `${((Number(user.shares) / Number(vault.totalSupply)) * 100).toFixed(2)}%`
              }
              sub={`${formatAmountSignificant(user.shares, vault.decimals)} ${vault.symbol ?? 'migoLP'}`}
            />
            <Stat
              label="Performance fee"
              value={`${(vault.performanceFeeBps / 100).toFixed(2)}%`}
              sub="on harvested fees only, in kind"
            />
            <Stat
              label="Deposits"
              value={vault.rebalancePaused ? 'Paused' : 'Open'}
              tone={vault.rebalancePaused ? 'amber' : 'up'}
              sub={`${vault.adapters.length} adapters registered`}
            />
          </StatRow>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            <div className="lg:col-span-2 space-y-6 min-w-0">
              <BasketTable vault={vault} />
              <AdapterList adapters={vault.adapters} tokens={vault.tokens} />
            </div>

            <div className="space-y-6 min-w-0">
              <Card title="Your position" action={<LiveBadge label="Live" />}>
                {user.shares === 0n ? (
                  <p className="text-sm text-ink-3">
                    {address ? 'No migoLP yet. Deposit below to mint a claim on the basket.' : 'Connect a wallet to see your position.'}
                  </p>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between gap-3 mb-2">
                      <span className="text-xs text-ink-3">{vault.symbol ?? 'migoLP'} balance</span>
                      <span className="display num text-xl font-semibold">{formatAmountSignificant(user.shares, vault.decimals)}</span>
                    </div>
                    <div className="text-xs text-ink-3 mb-1">Redeemable right now (previewRedeem)</div>
                    <TokenAmountList tokens={vault.tokens} amounts={user.owed} digits={6} />
                  </>
                )}
              </Card>

              <LiveDepositCard vault={vault} user={user} />
              <LiveRedeemCard vault={vault} user={user} />
              {/* Local-only: the target is the local stack and no wallet is on another network. */}
              {isLocalChain(vault.chainId) && !wrongChain && <LocalDevPanel vault={vault} user={user} />}
            </div>
          </div>
        </>
      )}

      <DataLegend />
    </div>
  );
}

/** Per token: idle in the vault vs working inside adapter positions. totals = idle + positions. */
function BasketTable({ vault }: { vault: ReturnType<typeof useLiveVault> }) {
  return (
    <Card
      title="Basket"
      action={<span className="text-2xs text-ink-3">totalTokens() = idle + Σ adapter position()</span>}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm num min-w-[460px]">
          <thead>
            <tr className="text-xs text-ink-3 border-b border-line">
              <th className="text-left font-medium pb-2">Token</th>
              <th className="text-right font-medium pb-2">Total</th>
              <th className="text-right font-medium pb-2">Idle</th>
              <th className="text-right font-medium pb-2">In position</th>
              <th className="w-28 pb-2" />
            </tr>
          </thead>
          <tbody>
            {vault.tokens.map((t, i) => {
              const total = vault.totals[i] ?? 0n;
              const idle = vault.idle[i] ?? 0n;
              const working = vault.inPosition[i] ?? 0n;
              const pct = total > 0n ? Number((working * 10_000n) / total) / 100 : 0;
              return (
                <tr key={t.address} className="border-b border-line last:border-0">
                  <td className="py-2.5">
                    <div className="font-medium text-ink">{t.symbol}</div>
                    <div className="text-2xs text-ink-3" title={t.address}>
                      {t.name} · {t.decimals} dp · {shortHex(t.address)}
                    </div>
                  </td>
                  <td className="py-2.5 text-right text-ink">{formatAmount(total, t.decimals, 4)}</td>
                  <td className="py-2.5 text-right text-ink-2">{formatAmount(idle, t.decimals, 4)}</td>
                  <td className="py-2.5 text-right text-ink-2">{formatAmount(working, t.decimals, 4)}</td>
                  <td className="py-2.5 pl-3">
                    <div className="h-1.5 w-full rounded-full bg-line overflow-hidden" title={`${pct.toFixed(1)}% deployed`}>
                      <div className={cx('h-full rounded-full bg-aqua')} style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                    <div className="text-2xs text-ink-3 mt-1 text-right">{pct.toFixed(1)}% deployed</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
