import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '@/store/useStore';
import { VAULT_BY_ID, TOKEN_PRICES } from '@/demo/data/vaults';
import { PROTOCOL } from '@/demo/data/protocol';
import { CONSTANTS } from '@/demo/constants';
import * as m from '@/demo/math';

const tsla = VAULT_BY_ID['tsla-usdc'];

function derived() {
  const s = useStore.getState();
  const deposits = m.totalDepositsUsd(s.user.positions, VAULT_BY_ID);
  const locked = m.lockedTide(s.user.locks) * CONSTANTS.TIDE_PRICE;
  return { s, deposits, locked };
}

describe('store — cross-page consistency after actions (checklist §7)', () => {
  beforeEach(async () => {
    useStore.getState().reset();
    await useStore.getState().connect();
  });

  it('connect loads the demo user', () => {
    const { s, deposits } = derived();
    expect(s.connected).toBe(true);
    expect(deposits).toBeCloseTo(12_398, 0);
  });

  it('deposit 5,000 USDC → balance, position and vault TVL move together', () => {
    const before = derived();
    const preview = m.zapPreview(tsla, tsla.tvl, 'USDC', 5_000, TOKEN_PRICES);
    useStore.getState().deposit({ vaultId: tsla.id, preview, stake: true, spend: [{ token: 'USDC', amount: 5_000 }] });
    const after = derived();
    expect(after.s.user.balances.USDC).toBe(20_000);
    expect(after.s.user.positions[tsla.id].staked).toBeCloseTo(9_800 + preview.tdlp, 6);
    expect(after.deposits).toBeCloseTo(before.deposits + preview.netUsd, 4);
    expect(after.s.user.tvlDelta[tsla.id]).toBeCloseTo(preview.netUsd, 6);
    const br = m.aprBreakdown(tsla, m.effectiveTvl(tsla, after.s.user.tvlDelta));
    expect(br.totalApr).toBeCloseTo(br.feeApr + br.tideApr, 12);
  });

  it('claim now pays 50%, forfeits 50% into the redistribution pool (sources still sum to pool)', () => {
    const pending = useStore.getState().user.pendingTide;
    const got = useStore.getState().claimInstant();
    const s = useStore.getState();
    expect(got).toBeCloseTo(pending * 0.5, 9);
    expect(s.user.pendingTide).toBe(0);
    expect(s.user.balances.PMG).toBeCloseTo(3_400 + got, 9);
    expect(s.forfeitsAdded).toBeCloseTo(pending * 0.5, 9);
    const forfeits = PROTOCOL.redistribution.fromForfeits + s.forfeitsAdded;
    expect(forfeits + PROTOCOL.redistribution.fromBuybacks).toBeCloseTo(48_200 + pending * 0.5, 9);
  });

  it('claim & lock locks 100% for 90 days and raises locked value', () => {
    const pending = useStore.getState().user.pendingTide;
    const before = derived();
    const lock = useStore.getState().claimLock();
    expect(lock?.amount).toBeCloseTo(pending, 9);
    expect((lock!.unlockAt - lock!.lockedAt) / 86_400_000).toBe(90);
    const after = derived();
    expect(after.locked).toBeCloseTo(before.locked + pending * CONSTANTS.TIDE_PRICE, 9);
    expect(after.s.user.pendingTide).toBe(0);
  });

  it('withdraw with staked migoLP unstakes and pays out net of the 0.1% fee; full exit removes the position', () => {
    const preview = m.withdrawPreview(tsla, 2_000, 'usdc', TOKEN_PRICES);
    useStore.getState().withdraw({ vaultId: tsla.id, preview });
    let s = useStore.getState();
    expect(s.user.positions[tsla.id].staked).toBeCloseTo(7_800, 6);
    expect(s.user.balances.USDC).toBeCloseTo(25_000 + preview.netUsd, 6);
    const all = m.withdrawPreview(tsla, 7_800, 'both', TOKEN_PRICES);
    useStore.getState().withdraw({ vaultId: tsla.id, preview: all });
    s = useStore.getState();
    expect(s.user.positions[tsla.id]).toBeUndefined();
    expect(s.user.balances.TSLAx).toBeGreaterThan(8.2);
  });

  it('portfolio total = Σ migoLP × pricePerShare; PnL = total − cost basis', () => {
    const { s, deposits } = derived();
    let sum = 0;
    for (const [id, p] of Object.entries(s.user.positions)) sum += (p.staked + p.unstaked) * VAULT_BY_ID[id].pricePerShare;
    expect(deposits).toBeCloseTo(sum, 9);
    expect(deposits - m.totalCostBasis(s.user.positions)).toBeCloseTo(412, 6);
  });

  it('reset clears everything back to disconnected defaults', () => {
    useStore.getState().reset();
    const s = useStore.getState();
    expect(s.connected).toBe(false);
    expect(Object.keys(s.user.positions)).toHaveLength(0);
    expect(s.user.locks).toHaveLength(0);
  });
});
