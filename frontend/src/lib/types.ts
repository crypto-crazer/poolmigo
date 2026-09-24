import type { ChainId } from '@/demo/data/chains';

export type Tier = 'Core' | 'Turbo' | 'Degen';

export interface Vault {
  id: string;
  token0: string;
  token1: string;
  receiptSymbol: string;
  chain: ChainId;
  tier: Tier;
  tvl: number;
  feeApr7d: number;
  emissionWeight: number;
  rangeWidthPct: number;
  pricePerShare: number;
  currentPrice: number; // token0 priced in token1
  rangeCenter: number;
  timeInRange7d: number;
  lastRebalanceDaysAgo: number;
  rebalances30d: number;
  /** migoLP end value minus HODL benchmark end value (negative = benchmark ahead). */
  benchmarkLead: number;
}

export interface Position {
  staked: number; // migoLP
  unstaked: number; // migoLP
  costBasis: number; // USD paid in
  depositedAt: number;
}

export interface Lock {
  id: string;
  amount: number; // PMG
  lockedAt: number;
  unlockAt: number;
  redistributionEarned: number; // PMG
}

export type TxKind = 'deposit' | 'withdraw' | 'stake' | 'claim' | 'lock' | 'unlock';

export interface TxRecord {
  id: string;
  kind: TxKind;
  at: number;
  label: string;
}

export interface UserState {
  balances: Record<string, number>;
  positions: Record<string, Position>;
  pendingTide: number;
  pendingUpdatedAt: number;
  locks: Lock[];
  /** Deposits/withdrawals since load shift vault TVL by this much (USD). */
  tvlDelta: Record<string, number>;
  degenAcknowledged: boolean;
  history: TxRecord[];
}

export type RangeStatus = 'in' | 'out' | 'defensive';
