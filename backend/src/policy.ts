/**
 * Deployment policy — deterministic, pure, side-effect free.
 *
 * Nothing in this module touches the network, the clock, the filesystem or the config env. It maps
 * an observed vault state plus a set of parameters onto a list of intended `deployTo` calls. That
 * makes the strategy fully unit-testable and makes every on-chain action reproducible from a
 * logged state snapshot.
 *
 * ## The rule
 * Per basket token `i`:
 *   total_i        = idle_i + Σ_adapters position_i          (what the vault controls)
 *   targetIdle_i   = floor(total_i * TARGET_IDLE_BPS / 1e4)  (buffer kept liquid for redemptions)
 *   excess_i       = max(0, idle_i - targetIdle_i)
 *   tickCap_i      = floor(total_i * MAX_DEPLOY_PER_TICK_BPS / 1e4)
 *   budget_i       = min(excess_i, tickCap_i)
 *
 * `MAX_DEPLOY_PER_TICK_BPS` is measured against **total_i**, not against idle_i: total is the
 * stable denominator (it does not move as the tick deploys), so the cap behaves the same whether
 * the vault is fully idle or nearly fully deployed, and successive ticks converge geometrically on
 * the target instead of oscillating.
 *
 * `budget_i` is then split across the adapters that actually hold token `i`, proportional to their
 * configured weights. Splits round DOWN; the rounding dust simply stays idle (the vault must never
 * be asked to send more than `budget_i`). Any per-adapter amount below `MIN_DEPLOY_AMOUNT_RAW` for
 * that token is zeroed, and an adapter whose whole vector is zero is dropped from the plan.
 *
 * ## Token-order alignment (the sharp edge)
 * `PoolmigoVaultUpgradeable.deployTo(adapter, amounts)` reads `adapter.position()` and requires
 * `amounts` to be aligned to **that adapter's own token order**, which is NOT guaranteed to match
 * the vault's basket registry order. Every plan produced here carries the adapter's token vector
 * alongside the amounts, and the amounts are built by looking each adapter token up in the
 * registry — never by index.
 *
 * This is plumbing, not alpha: a conservative buffer-and-spread rule. The real allocation strategy
 * is off-chain quant work that belongs in a future replacement for this module.
 */

import type { Address } from './types.js';

export const BPS_DENOMINATOR = 10_000n;

/** One registered position as observed on-chain. */
export interface AdapterState {
  readonly address: Address;
  /** The adapter's OWN `position()` token order. Plans must align to this. */
  readonly tokens: readonly Address[];
  /** Amounts reported by `position()`, aligned to `tokens` (includes uncollected fees). */
  readonly amounts: readonly bigint[];
}

/** Everything the policy needs to know about the vault at one instant. */
export interface VaultState {
  /** Basket registry order, from `vault.tokens()`. */
  readonly tokens: readonly Address[];
  /** Vault-held (idle) ERC-20 balance per token, aligned to `tokens`. */
  readonly idle: readonly bigint[];
  readonly adapters: readonly AdapterState[];
}

export interface PolicyParams {
  readonly targetIdleBps: number;
  readonly maxDeployPerTickBps: number;
  /** Relative weight per adapter address (lowercased keys). Missing => weight 0 (never funded). */
  readonly adapterWeights: ReadonlyMap<string, bigint>;
  /** Minimum deployable amount per token, in raw units (lowercased keys). Missing => `minDeployDefault`. */
  readonly minDeployAmountRaw: ReadonlyMap<string, bigint>;
  readonly minDeployDefault: bigint;
}

/** Per-token accounting for one tick, for logging and for tests. */
export interface TokenBudget {
  readonly token: Address;
  readonly idle: bigint;
  readonly deployedInAdapters: bigint;
  readonly total: bigint;
  readonly targetIdle: bigint;
  readonly excess: bigint;
  readonly tickCap: bigint;
  /** `min(excess, tickCap)` — the amount this tick is allowed to move out of idle. */
  readonly budget: bigint;
}

/** One intended `deployTo` call. */
export interface DeployPlan {
  readonly adapter: Address;
  /** The adapter's `position()` token order — echoed so the caller can assert alignment. */
  readonly tokens: readonly Address[];
  /** Amounts to send, aligned to `tokens`. */
  readonly amounts: readonly bigint[];
}

/** An adapter that the policy considered but deliberately did not fund. */
export interface SkippedAdapter {
  readonly adapter: Address;
  readonly reason:
    | 'zero-weight'
    | 'nothing-to-deploy'
    | 'below-min-amount'
    | 'no-registry-tokens';
}

export interface PolicyDecision {
  readonly budgets: readonly TokenBudget[];
  readonly plans: readonly DeployPlan[];
  readonly skipped: readonly SkippedAdapter[];
}

function key(address: Address): string {
  return address.toLowerCase();
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Per-token budget table. Exported separately so it can be logged and asserted on its own.
 * @throws if `state.idle` is not aligned to `state.tokens`, or an adapter vector is ragged.
 */
export function computeTokenBudgets(state: VaultState, params: PolicyParams): TokenBudget[] {
  if (state.idle.length !== state.tokens.length) {
    throw new Error(
      `idle/tokens length mismatch: ${state.idle.length} vs ${state.tokens.length}`,
    );
  }
  assertBps(params.targetIdleBps, 'targetIdleBps');
  assertBps(params.maxDeployPerTickBps, 'maxDeployPerTickBps');

  const targetBps = BigInt(params.targetIdleBps);
  const capBps = BigInt(params.maxDeployPerTickBps);

  const deployedByToken = new Map<string, bigint>();
  for (const adapter of state.adapters) {
    if (adapter.tokens.length !== adapter.amounts.length) {
      throw new Error(
        `adapter ${adapter.address} position() is ragged: ${adapter.tokens.length} tokens vs ${adapter.amounts.length} amounts`,
      );
    }
    adapter.tokens.forEach((token, i) => {
      const amount = adapter.amounts[i] ?? 0n;
      deployedByToken.set(key(token), (deployedByToken.get(key(token)) ?? 0n) + amount);
    });
  }

  return state.tokens.map((token, i) => {
    const idle = state.idle[i] ?? 0n;
    const deployedInAdapters = deployedByToken.get(key(token)) ?? 0n;
    const total = idle + deployedInAdapters;
    const targetIdle = (total * targetBps) / BPS_DENOMINATOR;
    const excess = idle > targetIdle ? idle - targetIdle : 0n;
    const tickCap = (total * capBps) / BPS_DENOMINATOR;
    return {
      token,
      idle,
      deployedInAdapters,
      total,
      targetIdle,
      excess,
      tickCap,
      budget: min(excess, tickCap),
    };
  });
}

/**
 * Turn an observed state into the set of `deployTo` calls to make this tick.
 *
 * Invariants (covered by unit tests):
 *  - `amounts[j]` is always the amount of `plan.tokens[j]`, the adapter's own order.
 *  - Σ over plans of the amount of token i never exceeds `budget_i` (so never exceeds idle_i).
 *  - No plan is emitted with an all-zero amount vector.
 */
export function planDeployments(state: VaultState, params: PolicyParams): PolicyDecision {
  const budgets = computeTokenBudgets(state, params);
  const budgetByToken = new Map(budgets.map((b) => [key(b.token), b.budget]));
  const registry = new Set(state.tokens.map(key));

  const plans: DeployPlan[] = [];
  const skipped: SkippedAdapter[] = [];

  const weightOf = (adapter: AdapterState): bigint =>
    params.adapterWeights.get(key(adapter.address)) ?? 0n;

  // Per token: which adapters can receive it, and what is the weight denominator for that token.
  // Only adapters that actually report the token participate in its split — otherwise a budget
  // slice would be assigned to an adapter that cannot hold it and would be silently lost.
  const weightSumByToken = new Map<string, bigint>();
  for (const adapter of state.adapters) {
    const weight = weightOf(adapter);
    if (weight <= 0n) continue;
    for (const token of new Set(adapter.tokens.map(key))) {
      if (!registry.has(token)) continue;
      weightSumByToken.set(token, (weightSumByToken.get(token) ?? 0n) + weight);
    }
  }

  for (const adapter of state.adapters) {
    const weight = weightOf(adapter);
    if (weight <= 0n) {
      skipped.push({ adapter: adapter.address, reason: 'zero-weight' });
      continue;
    }
    if (!adapter.tokens.some((t) => registry.has(key(t)))) {
      skipped.push({ adapter: adapter.address, reason: 'no-registry-tokens' });
      continue;
    }

    const seen = new Set<string>();
    let anyPositive = false;
    let anyZeroedByMin = false;

    const amounts = adapter.tokens.map((token) => {
      const k = key(token);
      // A token listed twice by one adapter would otherwise be funded twice out of one budget.
      if (!registry.has(k) || seen.has(k)) return 0n;
      seen.add(k);

      const budget = budgetByToken.get(k) ?? 0n;
      const weightSum = weightSumByToken.get(k) ?? 0n;
      if (budget === 0n || weightSum === 0n) return 0n;

      const share = (budget * weight) / weightSum; // floor; dust stays idle
      const floorAmount = params.minDeployAmountRaw.get(k) ?? params.minDeployDefault;
      if (share < floorAmount) {
        if (share > 0n) anyZeroedByMin = true;
        return 0n;
      }
      anyPositive = true;
      return share;
    });

    if (!anyPositive) {
      skipped.push({
        adapter: adapter.address,
        reason: anyZeroedByMin ? 'below-min-amount' : 'nothing-to-deploy',
      });
      continue;
    }
    plans.push({ adapter: adapter.address, tokens: adapter.tokens, amounts });
  }

  return { budgets, plans, skipped };
}

/** Interval gate for the harvest tick. `lastAtSec === null` means "never run" => due immediately. */
export function isRebalanceDue(
  nowSec: number,
  lastAtSec: number | null,
  intervalSec: number,
): boolean {
  if (lastAtSec === null) return true;
  // A clock that jumped backwards (or a state file from the future) must not wedge the loop shut.
  if (lastAtSec > nowSec) return true;
  return nowSec - lastAtSec >= intervalSec;
}

/** Seconds until the next harvest is due; 0 when it is due now. */
export function secondsUntilRebalance(
  nowSec: number,
  lastAtSec: number | null,
  intervalSec: number,
): number {
  if (isRebalanceDue(nowSec, lastAtSec, intervalSec)) return 0;
  return Math.max(0, (lastAtSec as number) + intervalSec - nowSec);
}

/**
 * Compare an intended deployment against the adapter position observed after the transaction.
 * Returns the per-token discrepancy (`observed - expected`) for every token that did not move by
 * exactly the intended amount. An empty array means the post-condition held.
 *
 * Real venue adapters legitimately deploy less than offered (ratio adjustment, slippage), so this
 * is reported as a WARN by the caller rather than treated as a failure.
 */
export function diffPositionDelta(
  plan: DeployPlan,
  before: readonly bigint[],
  after: readonly bigint[],
): { token: Address; expected: bigint; observed: bigint; delta: bigint }[] {
  const out: { token: Address; expected: bigint; observed: bigint; delta: bigint }[] = [];
  plan.tokens.forEach((token, i) => {
    const expected = plan.amounts[i] ?? 0n;
    const observed = (after[i] ?? 0n) - (before[i] ?? 0n);
    if (observed !== expected) out.push({ token, expected, observed, delta: observed - expected });
  });
  return out;
}

function assertBps(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${name} must be an integer in [0, 10000], got ${value}`);
  }
}
