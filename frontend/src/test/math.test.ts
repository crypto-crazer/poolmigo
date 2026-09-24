import { describe, expect, it } from 'vitest';
import { CONSTANTS } from '@/demo/constants';
import { VAULTS, VAULT_BY_ID, TOKEN_PRICES } from '@/demo/data/vaults';
import { PROTOCOL } from '@/demo/data/protocol';
import { demoUserState } from '@/demo/data/demoUser';
import * as m from '@/demo/math';

const tsla = VAULT_BY_ID['tsla-usdc'];
const dog = VAULT_BY_ID['dogtsla-usdc'];

describe('anchors — MOCK-DATA-SPEC §3', () => {
  it('tsla-usdc weekly emissions = 300,000 PMG = $12,600', () => {
    expect(m.vaultWeeklyEmissions(tsla)).toBe(300_000);
    expect(m.vaultWeeklyEmissions(tsla) * CONSTANTS.TIDE_PRICE).toBeCloseTo(12_600, 6);
  });
  it('tsla-usdc staked TVL = $3.57M, base PMG APR ≈ 18.4%, total ≈ 32.6%', () => {
    expect(m.stakedTvl(tsla.tvl)).toBeCloseTo(3_570_000, 0);
    const b = m.aprBreakdown(tsla, tsla.tvl);
    expect(b.tideApr * 100).toBeCloseTo(18.4, 1);
    expect(b.totalApr * 100).toBeCloseTo(32.6, 1);
  });
  it('demo user deposits ≈ $12,398 and 36,500 PMG locked', () => {
    const u = demoUserState(0);
    expect(m.totalDepositsUsd(u.positions, VAULT_BY_ID)).toBeCloseTo(12_398, 0);
    expect(m.lockedTide(u.locks)).toBe(38_650);
  });
  it('demo Net PnL = +$412 (+3.4%)', () => {
    const u = demoUserState(0);
    const value = m.totalDepositsUsd(u.positions, VAULT_BY_ID);
    const cost = m.totalCostBasis(u.positions);
    expect(value - cost).toBeCloseTo(412, 6);
    expect(((value - cost) / cost) * 100).toBeCloseTo(3.4, 1);
  });
  it('pending 1,224 PMG ≈ $51.4; claim now 612 / lock 1,224', () => {
    const u = demoUserState(0);
    expect(u.pendingTide * CONSTANTS.TIDE_PRICE).toBeCloseTo(51.4, 1);
    const s = m.claimSplit(u.pendingTide);
    expect(s.instant).toBe(612);
    expect(s.locked).toBe(1_224);
    expect(s.forfeited).toBe(612);
  });
});

describe('APR consistency — checklist §7', () => {
  it('total APR = fee + PMG for every vault', () => {
    for (const v of VAULTS) {
      const br = m.aprBreakdown(v, v.tvl);
      expect(br.totalApr).toBeCloseTo(br.feeApr + br.tideApr, 12);
    }
  });
  it('emission weights sum to 100%', () => {
    expect(VAULTS.reduce((a, v) => a + v.emissionWeight, 0)).toBeCloseTo(1, 12);
  });
});

describe('ranges', () => {
  it('tsla-usdc in range while market open, defensive when closed', () => {
    expect(m.rangeStatus(tsla, 'open')).toBe('in');
    expect(m.rangeStatus(tsla, 'closed')).toBe('defensive');
    const open = m.rangeGeometry(tsla, 'open');
    const closed = m.rangeGeometry(tsla, 'closed');
    expect(closed.upper - closed.lower).toBeGreaterThan(open.upper - open.lower);
    expect(tsla.currentPrice).toBeGreaterThan(tsla.rangeCenter); // slightly upper half
  });
  it('dogtsla-usdc is out of range regardless of market (not Core)', () => {
    expect(m.rangeStatus(dog, 'open')).toBe('out');
    expect(m.rangeStatus(dog, 'closed')).toBe('out');
  });
  it('turbo vaults never go defensive', () => {
    expect(m.rangeStatus(VAULT_BY_ID['tsla-nvda'], 'closed')).not.toBe('defensive');
  });
});

describe('zap / withdraw math', () => {
  it('5,000 USDC into TSLAx/USDC: half stays, ~5.87 TSLAx bought, impact ≈ 0.08%, fee ≈ $3.75', () => {
    const z = m.zapPreview(tsla, tsla.tvl, 'USDC', 5_000, TOKEN_PRICES);
    expect(z.legs[0].token).toBe('USDC');
    expect(z.legs[0].amount).toBe(2_500);
    expect(z.legs[1].token).toBe('TSLAx');
    expect(z.legs[1].amount).toBeCloseTo(5.87, 1);
    expect(z.priceImpact * 100).toBeCloseTo(0.08, 2);
    expect(z.swapFeeUsd).toBeCloseTo(3.75, 2);
    expect(z.tdlp).toBeCloseTo(z.netUsd / tsla.pricePerShare, 8);
    expect(z.netUsd).toBeLessThan(5_000);
    expect(z.netUsd).toBeGreaterThan(4_990);
  });
  it('USDC into a non-USDC pair swaps everything into two legs', () => {
    const v = VAULT_BY_ID['tsla-nvda'];
    const z = m.zapPreview(v, v.tvl, 'USDC', 1_000, TOKEN_PRICES);
    expect(z.legs.map((l) => l.token)).toEqual(['TSLAx', 'NVDAx']);
    expect(z.swappedUsd).toBe(1_000);
    expect(z.legs[0].usd).toBeCloseTo(z.legs[1].usd, 8);
  });
  it('withdraw applies 0.1% fee and values by pricePerShare', () => {
    const w = m.withdrawPreview(tsla, 2_000, 'usdc', TOKEN_PRICES);
    expect(w.grossUsd).toBeCloseTo(2_006.4, 6);
    expect(w.feeUsd).toBeCloseTo(2.0064, 6);
    expect(w.outputs[0].amount).toBeCloseTo(2_004.3936, 4);
    const both = m.withdrawPreview(tsla, 2_000, 'both', TOKEN_PRICES);
    expect(both.outputs.reduce((a, o) => a + o.usd, 0)).toBeCloseTo(w.netUsd, 8);
  });
});

describe('protocol figures — §4', () => {
  it('coverage = 8,600 / 42,000 ≈ 20.5%', () => {
    expect(PROTOCOL.weeklyEmissionsUsd).toBe(42_000);
    expect(m.buybackCoverage(PROTOCOL.buybackThisWeekUsd, PROTOCOL.weeklyEmissionsUsd) * 100).toBeCloseTo(20.5, 1);
  });
  it('redistribution sources sum to 48,200', () => {
    expect(PROTOCOL.redistribution.fromForfeits + PROTOCOL.redistribution.fromBuybacks).toBe(48_200);
  });
  it('circulating market cap ≈ $3.1M', () => {
    expect(m.circulatingMarketCap(PROTOCOL.circulatingTide) / 1e6).toBeCloseTo(3.1, 1);
  });
});

describe('chart series', () => {
  it('NAV series starts at exactly 1.0 and ends at pricePerShare / benchmark', async () => {
    const { navSeries } = await import('@/demo/series');
    const s = navSeries('tsla-usdc', 1.0032, 0.0032, 30);
    expect(s[0].tdlp).toBeCloseTo(1, 10);
    expect(s[0].hodl).toBeCloseTo(1, 10);
    expect(s[29].tdlp).toBeCloseTo(1.0032, 10);
    expect(s[29].hodl).toBeCloseTo(1.0, 10);
  });
  it('emissions series pins the final week to protocol figures', async () => {
    const { emissionsSeries } = await import('@/demo/series');
    const w = emissionsSeries(42_000, 8_600);
    expect(w).toHaveLength(8);
    expect(w[7].emissionsUsd).toBe(42_000);
    expect(w[7].buybacksUsd).toBe(8_600);
    for (let i = 1; i < 8; i++) expect(w[i].buybacksUsd).toBeGreaterThanOrEqual(w[i - 1].buybacksUsd * 0.95);
  });
});

describe('hourly price series', () => {
  it('ends exactly at the current price', async () => {
    const { priceSeriesHourly } = await import('@/demo/series');
    const s = priceSeriesHourly('tsla-usdc', 420, 425.8, 0.18);
    expect(s[s.length - 1].price).toBeCloseTo(425.8, 10);
    expect(s).toHaveLength(30 * 24 + 1);
  });
});
