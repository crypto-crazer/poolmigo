import type { Tier } from '@/lib/types';
import type { Vault } from '@/lib/types';

/** Spot prices in USD — MOCK-DATA-SPEC §6. */
export const TOKEN_PRICES: Record<string, number> = {
  USDC: 1.0,
  TSLAx: 425.8,
  NVDAx: 118.4,
  HOODx: 52.1,
  SUI: 3.85,
  DOGTSLA: 0.00184,
  PMG: 0.042,
};

export const TOKEN_COLORS: Record<string, string> = {
  USDC: '#2775CA',
  TSLAx: '#E82127',
  NVDAx: '#76B900',
  HOODx: '#00C805',
  SUI: '#4DA2FF',
  DOGTSLA: '#C9A227',
  PMG: '#8B9CF7',
};

export const TIER_CAPACITY: Record<Tier, number> = {
  Core: 10_000_000,
  Turbo: 3_000_000,
  Degen: 1_000_000,
};

/** Pool price = token0 priced in token1. */
function pairPrice(token0: string, token1: string): number {
  return TOKEN_PRICES[token0] / TOKEN_PRICES[token1];
}

export const VAULTS: Vault[] = [
  {
    id: 'tsla-usdc',
    token0: 'TSLAx',
    token1: 'USDC',
    receiptSymbol: 'migoLP-TSLA',
    chain: 'robinhood',
    tier: 'Core',
    tvl: 4_200_000,
    feeApr7d: 0.142,
    emissionWeight: 0.3,
    rangeWidthPct: 0.18,
    pricePerShare: 1.0032,
    currentPrice: pairPrice('TSLAx', 'USDC'), // 425.80 — slightly above centre, in range
    rangeCenter: 420,
    timeInRange7d: 0.94,
    lastRebalanceDaysAgo: 2,
    rebalances30d: 4,
    benchmarkLead: 0.0032,
  },
  {
    id: 'nvda-usdc',
    token0: 'NVDAx',
    token1: 'USDC',
    receiptSymbol: 'migoLP-NVDA',
    chain: 'ethereum',
    tier: 'Core',
    tvl: 3_100_000,
    feeApr7d: 0.128,
    emissionWeight: 0.25,
    rangeWidthPct: 0.18,
    pricePerShare: 1.0041,
    currentPrice: pairPrice('NVDAx', 'USDC'),
    rangeCenter: 116,
    timeInRange7d: 0.97,
    lastRebalanceDaysAgo: 5,
    rebalances30d: 3,
    benchmarkLead: 0.0026,
  },
  {
    id: 'hood-usdc',
    token0: 'HOODx',
    token1: 'USDC',
    receiptSymbol: 'migoLP-HOOD',
    chain: 'robinhood',
    tier: 'Core',
    tvl: 1_800_000,
    feeApr7d: 0.195,
    emissionWeight: 0.15,
    rangeWidthPct: 0.2,
    pricePerShare: 1.0018,
    currentPrice: pairPrice('HOODx', 'USDC'),
    rangeCenter: 51,
    timeInRange7d: 0.91,
    lastRebalanceDaysAgo: 1,
    rebalances30d: 6,
    benchmarkLead: 0.0021,
  },
  {
    id: 'tsla-nvda',
    token0: 'TSLAx',
    token1: 'NVDAx',
    receiptSymbol: 'migoLP-TSLANVDA',
    chain: 'arc',
    tier: 'Turbo',
    tvl: 950_000,
    feeApr7d: 0.264,
    emissionWeight: 0.12,
    rangeWidthPct: 0.1,
    pricePerShare: 0.9987,
    currentPrice: pairPrice('TSLAx', 'NVDAx'), // ≈ 3.596
    rangeCenter: 3.55,
    timeInRange7d: 0.83,
    lastRebalanceDaysAgo: 0.4,
    rebalances30d: 11,
    benchmarkLead: -0.0041, // benchmark ahead — honest underperformance
  },
  {
    id: 'sui-tsla',
    token0: 'SUI',
    token1: 'TSLAx',
    receiptSymbol: 'migoLP-SUITSLA',
    chain: 'ethereum',
    tier: 'Turbo',
    tvl: 720_000,
    feeApr7d: 0.31,
    emissionWeight: 0.1,
    rangeWidthPct: 0.1,
    pricePerShare: 1.0105,
    currentPrice: pairPrice('SUI', 'TSLAx'), // ≈ 0.00904
    rangeCenter: 0.0089,
    timeInRange7d: 0.86,
    lastRebalanceDaysAgo: 1.2,
    rebalances30d: 9,
    benchmarkLead: 0.0038,
  },
  {
    id: 'dogtsla-usdc',
    token0: 'DOGTSLA',
    token1: 'USDC',
    receiptSymbol: 'migoLP-DOGTSLA',
    chain: 'robinhood',
    tier: 'Degen',
    tvl: 410_000,
    feeApr7d: 0.886,
    emissionWeight: 0.08,
    rangeWidthPct: 0.05,
    pricePerShare: 0.9612,
    currentPrice: pairPrice('DOGTSLA', 'USDC'), // 0.00184 — below range → out of range
    rangeCenter: 0.0021,
    timeInRange7d: 0.61,
    lastRebalanceDaysAgo: 0.1,
    rebalances30d: 27,
    benchmarkLead: -0.0188,
  },
];

export const VAULT_BY_ID: Record<string, Vault> = Object.fromEntries(VAULTS.map((v) => [v.id, v]));

export function vaultName(v: Vault): string {
  return `${v.token0} / ${v.token1}`;
}
