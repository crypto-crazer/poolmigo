/**
 * Pure derivation rules — MOCK-DATA-SPEC §3. Every page computes from these;
 * no component hard-codes a derived number.
 */
import { CONSTANTS } from './constants';
import type { Lock, Position, RangeStatus, Vault } from '@/lib/types';
import type { MarketStatus } from '@/lib/market';

// ───────────────────────── Emissions & APR ─────────────────────────

export function vaultWeeklyEmissions(v: Vault): number {
  return CONSTANTS.WEEKLY_EMISSIONS_TIDE * v.emissionWeight;
}

export function effectiveTvl(v: Vault, tvlDelta: Record<string, number> = {}): number {
  return v.tvl + (tvlDelta[v.id] ?? 0);
}

export function stakedTvl(tvl: number): number {
  return tvl * CONSTANTS.STAKED_SHARE;
}

/** base PMG APR = weekly emissions × price × 52 / staked TVL */
export function baseTideApr(v: Vault, tvl: number = v.tvl): number {
  const s = stakedTvl(tvl);
  if (s <= 0) return 0;
  return (vaultWeeklyEmissions(v) * CONSTANTS.TIDE_PRICE * 52) / s;
}

export interface AprBreakdown {
  feeApr: number;
  tideApr: number;
  totalApr: number; // fee + PMG — the same for every depositor
}

export function aprBreakdown(v: Vault, tvl: number): AprBreakdown {
  const tide = baseTideApr(v, tvl);
  return { feeApr: v.feeApr7d, tideApr: tide, totalApr: v.feeApr7d + tide };
}

// ───────────────────────── Ranges ─────────────────────────

export interface RangeGeometry {
  lower: number;
  upper: number;
  resetLower: number;
  resetUpper: number;
  widthPct: number;
  defensive: boolean;
}

export function isDefensive(v: Vault, market: MarketStatus): boolean {
  return v.tier === 'Core' && market === 'closed';
}

export function rangeGeometry(v: Vault, market: MarketStatus): RangeGeometry {
  const defensive = isDefensive(v, market);
  const widthPct = defensive ? v.rangeWidthPct * CONSTANTS.DEFENSIVE_WIDEN : v.rangeWidthPct;
  const lower = v.rangeCenter * (1 - widthPct);
  const upper = v.rangeCenter * (1 + widthPct);
  const band = v.rangeCenter * CONSTANTS.RESET_BAND_PCT;
  return { lower, upper, resetLower: lower - band, resetUpper: upper + band, widthPct, defensive };
}

export function rangeStatus(v: Vault, market: MarketStatus): RangeStatus {
  const g = rangeGeometry(v, market);
  if (g.defensive) return 'defensive';
  return v.currentPrice >= g.lower && v.currentPrice <= g.upper ? 'in' : 'out';
}

// ───────────────────────── Positions ─────────────────────────

export function positionTdlp(p: Position | undefined): number {
  return p ? p.staked + p.unstaked : 0;
}

export function positionValue(p: Position | undefined, v: Vault): number {
  return positionTdlp(p) * v.pricePerShare;
}

export function totalDepositsUsd(positions: Record<string, Position>, vaults: Record<string, Vault>): number {
  let t = 0;
  for (const [id, p] of Object.entries(positions)) {
    const v = vaults[id];
    if (v) t += positionValue(p, v);
  }
  return t;
}

export function totalCostBasis(positions: Record<string, Position>): number {
  return Object.values(positions).reduce((a, p) => a + p.costBasis, 0);
}

export function lockedTide(locks: Lock[]): number {
  return locks.reduce((a, l) => a + l.amount, 0);
}

export function lockedUsd(locks: Lock[]): number {
  return lockedTide(locks) * CONSTANTS.TIDE_PRICE;
}

/** Fees earned so far by a position: value × fee APR × time held. */
export function feesEarned(valueUsd: number, feeApr: number, depositedAt: number, now: number): number {
  const days = Math.max(0, (now - depositedAt) / 86_400_000);
  return (valueUsd * feeApr * days) / 365;
}

/** 7-day earnings estimate for a position. */
export function earnings7d(valueUsd: number, yourApr: number): number {
  return (valueUsd * yourApr * 7) / 365;
}

/** PMG accrued per second across positions (rewards only, not fees). */
export function pendingAccrualPerSecond(positions: Record<string, Position>, vaults: Record<string, Vault>, tvlDelta: Record<string, number>): number {
  let usdPerYear = 0;
  for (const [id, p] of Object.entries(positions)) {
    const v = vaults[id];
    if (!v) continue;
    usdPerYear += positionValue(p, v) * baseTideApr(v, effectiveTvl(v, tvlDelta));
  }
  return usdPerYear / CONSTANTS.TIDE_PRICE / (365 * 86_400);
}

// ───────────────────────── Deposit / Withdraw ─────────────────────────

export type DepositMode = 'single' | 'dual';

export interface ZapPreview {
  mode: DepositMode;
  inputToken: string;
  inputAmount: number;
  inputUsd: number;
  /** legs after swap: what actually enters the LP */
  legs: Array<{ token: string; amount: number; usd: number }>;
  swappedUsd: number;
  swapToken: string | null;
  swapPrice: number | null; // USD per unit of the token bought
  priceImpact: number; // fraction
  swapFeeUsd: number;
  netUsd: number;
  tdlp: number;
  pricePerShare: number;
}

/**
 * Price impact model: swapped notional over ~75% of pool TVL (the working
 * liquidity), capped. 2,500 into a $4.2M pool ≈ 0.08%.
 */
export function priceImpact(swapUsd: number, tvl: number): number {
  if (swapUsd <= 0 || tvl <= 0) return 0;
  return Math.min(swapUsd / (tvl * 0.75), 0.15);
}

/** Single-sided zap: the vault swaps into a 50/50 split and mints migoLP. */
export function zapPreview(
  v: Vault,
  tvl: number,
  inputToken: string,
  inputAmount: number,
  prices: Record<string, number>,
): ZapPreview {
  const px = prices[inputToken] ?? 0;
  const inputUsd = inputAmount * px;
  const inPair = inputToken === v.token0 || inputToken === v.token1;
  // Tokens in the pair: swap half. Outside token (e.g. USDC into TSLAx/NVDAx): swap all, half each.
  const swapUsdGross = inPair ? inputUsd / 2 : inputUsd;
  const impact = priceImpact(swapUsdGross, tvl);
  const swapFeeUsd = swapUsdGross * CONSTANTS.SWAP_FEE;
  const swapUsdNet = swapUsdGross * (1 - impact) - swapFeeUsd;

  const legs: ZapPreview['legs'] = [];
  let swapToken: string | null = null;
  if (inPair) {
    const other = inputToken === v.token0 ? v.token1 : v.token0;
    swapToken = other;
    legs.push({ token: inputToken, amount: inputAmount / 2, usd: inputUsd / 2 });
    legs.push({ token: other, amount: swapUsdNet / prices[other], usd: swapUsdNet });
  } else {
    const half = swapUsdNet / 2;
    legs.push({ token: v.token0, amount: half / prices[v.token0], usd: half });
    legs.push({ token: v.token1, amount: half / prices[v.token1], usd: half });
  }
  const netUsd = legs.reduce((a, l) => a + l.usd, 0);
  return {
    mode: 'single',
    inputToken,
    inputAmount,
    inputUsd,
    legs,
    swappedUsd: swapUsdGross,
    swapToken,
    swapPrice: swapToken ? prices[swapToken] * (1 + impact) : null,
    priceImpact: impact,
    swapFeeUsd,
    netUsd,
    tdlp: netUsd / v.pricePerShare,
    pricePerShare: v.pricePerShare,
  };
}

/** Dual-sided deposit: no swap, both legs enter as-is. */
export function dualPreview(v: Vault, amount0: number, amount1: number, prices: Record<string, number>): ZapPreview {
  const usd0 = amount0 * prices[v.token0];
  const usd1 = amount1 * prices[v.token1];
  const netUsd = usd0 + usd1;
  return {
    mode: 'dual',
    inputToken: `${v.token0} + ${v.token1}`,
    inputAmount: amount0 + amount1,
    inputUsd: netUsd,
    legs: [
      { token: v.token0, amount: amount0, usd: usd0 },
      { token: v.token1, amount: amount1, usd: usd1 },
    ],
    swappedUsd: 0,
    swapToken: null,
    swapPrice: null,
    priceImpact: 0,
    swapFeeUsd: 0,
    netUsd,
    tdlp: netUsd / v.pricePerShare,
    pricePerShare: v.pricePerShare,
  };
}

export type WithdrawMode = 'usdc' | 'both';

export interface WithdrawPreview {
  tdlp: number;
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
  outputs: Array<{ token: string; amount: number; usd: number }>;
}

export function withdrawPreview(v: Vault, tdlp: number, mode: WithdrawMode, prices: Record<string, number>): WithdrawPreview {
  const grossUsd = tdlp * v.pricePerShare;
  const feeUsd = grossUsd * CONSTANTS.WITHDRAWAL_FEE;
  const netUsd = grossUsd - feeUsd;
  const outputs: WithdrawPreview['outputs'] =
    mode === 'usdc'
      ? [{ token: 'USDC', amount: netUsd / prices.USDC, usd: netUsd }]
      : [
          { token: v.token0, amount: netUsd / 2 / prices[v.token0], usd: netUsd / 2 },
          { token: v.token1, amount: netUsd / 2 / prices[v.token1], usd: netUsd / 2 },
        ];
  return { tdlp, grossUsd, feeUsd, netUsd, outputs };
}

// ───────────────────────── Claims & locks ─────────────────────────

export interface ClaimSplit {
  instant: number; // pending × 50%
  forfeited: number; // goes to lockers
  locked: number; // pending × 100%
}

export function claimSplit(pending: number): ClaimSplit {
  const instant = pending * CONSTANTS.INSTANT_CLAIM_RATIO;
  return { instant, forfeited: pending - instant, locked: pending };
}

export function lockProgress(l: Lock, now: number): number {
  const total = l.unlockAt - l.lockedAt;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - l.lockedAt) / total));
}

export function lockDaysLeft(l: Lock, now: number): number {
  return Math.max(0, Math.ceil((l.unlockAt - now) / 86_400_000));
}

export function isUnlockable(l: Lock, now: number): boolean {
  return now >= l.unlockAt;
}

// ───────────────────────── Protocol ─────────────────────────

/** buyback coverage = weekly buybacks ÷ weekly emissions value */
export function buybackCoverage(buybackUsd: number, emissionsUsd: number): number {
  return emissionsUsd > 0 ? buybackUsd / emissionsUsd : 0;
}

export function circulatingMarketCap(circulating: number): number {
  return circulating * CONSTANTS.TIDE_PRICE;
}

export function dailyFees(vaults: Vault[], tvlDelta: Record<string, number> = {}): number {
  return vaults.reduce((a, v) => a + (effectiveTvl(v, tvlDelta) * v.feeApr7d) / 365, 0);
}

export function totalTvl(vaults: Vault[], tvlDelta: Record<string, number> = {}): number {
  return vaults.reduce((a, v) => a + effectiveTvl(v, tvlDelta), 0);
}
