import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { VAULT_BY_ID, TIER_CAPACITY, vaultName } from '@/demo/data/vaults';
import { fmtDate, fmtPct, fmtToken, fmtUsd, cx } from '@/lib/format';
import * as m from '@/demo/math';
import { useStore } from '@/store/useStore';
import { useMarketStatus, useVaultApr } from '@/store/selectors';
import { TokenPair } from '@/components/ui/TokenIcon';
import { ChainLogo } from '@/components/ui/ChainLogo';
import { CHAINS } from '@/demo/data/chains';
import { Stat, StatRow } from '@/components/ui/Stat';
import { PriceRange } from '@/components/vault/PriceRange';
import { AprBreakdown } from '@/components/vault/AprBreakdown';
import { NavChart } from '@/components/vault/NavChart';
import { DepositCard } from '@/components/deposit/DepositCard';
import type { Vault } from '@/lib/types';
import { CONSTANTS } from '@/demo/constants';
import { useUserDerived } from '@/store/selectors';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { BoostedApr } from '@/components/ui/BoostedApr';
import { ClaimModal } from '@/components/rewards/ClaimModal';
import { DataLegend, DemoBadge } from '@/components/ui/DataBadge';

export function VaultDetail() {
  const { id = '' } = useParams();
  const v = VAULT_BY_ID[id];
  const market = useMarketStatus();
  if (!v) {
    return (
      <div className="text-sm text-ink-3">
        Vault not found. <Link to="/" className="text-aqua">Back to markets</Link>
      </div>
    );
  }
  return <VaultView vaultId={v.id} market={market} />;
}

function VaultView({ vaultId, market }: { vaultId: string; market: 'open' | 'closed' }) {
  const v = VAULT_BY_ID[vaultId];
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { tvl, breakdown: b } = useVaultApr(v);
  const cap = TIER_CAPACITY[v.tier];
  const fill = Math.min(1, tvl / cap);
  const [aprHover, setAprHover] = useState(false);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="text-xs text-ink-3 hover:text-ink-2 mr-1">← Earn</Link>
        <TokenPair a={v.token0} b={v.token1} size={28} chain={v.chain} />
        <h1 className="display text-2xl font-semibold">{vaultName(v)}</h1>
        <span className="inline-flex items-center gap-1.5 h-7 pl-1.5 pr-2.5 rounded-full bg-panel border border-line text-xs text-ink-2">
          <ChainLogo chain={v.chain} size={16} />
          {CHAINS[v.chain].name}
        </span>
        <DemoBadge label="Demo vault" />
        <Link to="/live" className="text-xs text-up hover:underline">See the live on-chain vault →</Link>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 space-y-6 min-w-0">
        <StatRow cols={3}>
          <Stat label="TVL" value={fmtUsd(tvl)} />
          <div className="relative cursor-help" onMouseEnter={() => setAprHover(true)} onMouseLeave={() => setAprHover(false)}>
            <Stat
              label="APR"
              value={<BoostedApr value={fmtPct(b.totalApr)} />}
            />
            {aprHover && (
              <div className="absolute left-0 top-full mt-1 z-40 w-72 bg-panel-2 border border-line-2 rounded-md shadow-pop p-3 animate-fade-in">
                <AprBreakdown vault={v} compact />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <div className="text-xs text-ink-3">Capacity</div>
            <div className="display num text-xl font-semibold truncate">
              {fmtUsd(tvl)} <span className="text-ink-3 text-sm font-normal">/ {fmtUsd(cap)} · {fmtPct(fill, 0)} filled</span>
            </div>
          </div>
        </StatRow>

        <PriceRange vault={v} market={market} />
        <NavChart vault={v} />
        </div>
        <div className="lg:sticky lg:top-[72px] space-y-6">
          <YourPosition vault={v} tvl={tvl} onClaim={() => setParams({ claim: '1' })} />
          <DepositCard key={v.id} vault={v} onVaultChange={(nv) => navigate(`/vault/${nv.id}`)} showVaultLink={false} />
        </div>
      </div>
      <DataLegend />
      <ClaimModal open={params.get('claim') === '1'} onClose={() => setParams({})} />
    </div>
  );
}

function YourPosition({ vault: v, tvl, onClaim }: { vault: Vault; tvl: number; onClaim: () => void }) {
  const connected = useStore((s) => s.connected);
  const p = useStore((s) => s.user.positions[v.id]);
  const d = useUserDerived();
  if (!connected || !p) return null;
  const value = m.positionValue(p, v);
  const fees = m.feesEarned(value, v.feeApr7d, p.depositedAt, Date.now());
  const b = m.aprBreakdown(v, tvl);
  return (
    <section className="bg-panel border border-line rounded-lg p-5 max-w-[440px] mx-auto w-full">
      <h2 className="display text-sm font-semibold">Your position</h2>
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 mt-4 num">
        <Big label="Value" value={fmtUsd(value, { compact: false, cents: true })} tip={`${fmtToken(m.positionTdlp(p), 1)} ${v.receiptSymbol} · deposited ${fmtDate(p.depositedAt)}`} />
        <Big label="Your APR" value={fmtPct(b.totalApr)} tip={`${fmtPct(b.feeApr)} from fees + ${fmtPct(b.tideApr)} in PMG`} />
        <Big label="Fees earned" value={`+${fmtUsd(fees, { compact: false, cents: true })}`} tone="text-up" tip="Fees compound into your migoLP automatically. Nothing to claim." />
        <Big label="PMG rewards" value={`${fmtToken(d.pendingTide, 1)} PMG`} tone="text-tide" tip={`≈ ${fmtUsd(d.pendingTide * CONSTANTS.TIDE_PRICE, { compact: false, cents: true })} across all your vaults`} />
      </div>
      <Button block variant="tide" className="mt-5" onClick={onClaim} disabled={d.pendingTide < 0.005}>
        {d.pendingTide < 0.005 ? 'No rewards to claim yet' : `Claim ${fmtToken(d.pendingTide, 1)} PMG`}
      </Button>
    </section>
  );
}

function Big({ label, value, tone, tip }: { label: string; value: string; tone?: string; tip: string }) {
  return (
    <Tooltip content={tip} align="start" side="bottom" wide>
      <div className="cursor-help">
        <div className="text-xs text-ink-3">{label}</div>
        <div className={cx('display text-2xl font-semibold mt-1 leading-none', tone ?? 'text-ink')}>{value}</div>
      </div>
    </Tooltip>
  );
}
