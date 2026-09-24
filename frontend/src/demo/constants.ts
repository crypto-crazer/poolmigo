/** Global protocol constants — see notes/frontend/MOCK-DATA-SPEC.md §1 (internal). */
export const CONSTANTS = {
  TIDE_PRICE: 0.042, // USD
  PERFORMANCE_FEE: 0.1,
  WITHDRAWAL_FEE: 0.001,
  INSTANT_CLAIM_RATIO: 0.5, // instant claim receives 50%
  LOCK_DAYS: 90,
  WEEKLY_EMISSIONS_TIDE: 1_000_000,
  /** Prototype simplification: share of vault TVL assumed staked for PMG. */
  STAKED_SHARE: 0.85,
  /** Zap swap fee (fraction of the swapped leg). */
  SWAP_FEE: 0.0015,
  /** Reset band sits this far beyond the LP range (fraction of price). */
  RESET_BAND_PCT: 0.08,
  /** Core vaults widen their range by this factor when the US market is closed. */
  DEFENSIVE_WIDEN: 1.75,
} as const;

export const DEMO_ADDRESS = '0x7a3f4c8e2b915d6a0f37c1e84b2d9a5c6e0f9d21';
