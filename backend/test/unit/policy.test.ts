import { describe, expect, it } from 'vitest';

import {
  computeTokenBudgets,
  diffPositionDelta,
  isRebalanceDue,
  planDeployments,
  secondsUntilRebalance,
  type AdapterState,
  type PolicyParams,
  type VaultState,
} from '../../src/policy.js';
import type { Address } from '../../src/types.js';

/** Deterministic fake addresses: `addr('a')` -> 0xaaaa…aa. */
function addr(seed: string): Address {
  return `0x${seed.repeat(40).slice(0, 40)}` as Address;
}

const USDG = addr('a'); // 6-decimal token in the local basket
const WETH = addr('b'); // 18-decimal token
const ADAPTER_V3 = addr('1');
const ADAPTER_V4 = addr('2');

function params(over: Partial<PolicyParams> = {}): PolicyParams {
  return {
    targetIdleBps: 2000,
    maxDeployPerTickBps: 5000,
    adapterWeights: new Map([
      [ADAPTER_V3.toLowerCase(), 1n],
      [ADAPTER_V4.toLowerCase(), 1n],
    ]),
    minDeployAmountRaw: new Map(),
    minDeployDefault: 0n,
    ...over,
  };
}

function adapter(address: Address, tokens: Address[], amounts: bigint[]): AdapterState {
  return { address, tokens, amounts };
}

describe('computeTokenBudgets', () => {
  it('keeps TARGET_IDLE_BPS of the TOTAL (idle + adapters) idle, not of idle alone', () => {
    const state: VaultState = {
      tokens: [USDG],
      idle: [400n],
      adapters: [adapter(ADAPTER_V3, [USDG], [600n])],
    };
    const [usdg] = computeTokenBudgets(state, params({ maxDeployPerTickBps: 10_000 }));
    expect(usdg).toMatchObject({
      idle: 400n,
      deployedInAdapters: 600n,
      total: 1000n,
      targetIdle: 200n, // 20% of 1000
      excess: 200n,
      budget: 200n,
    });
  });

  it('reports zero excess when idle is already at or below target', () => {
    const state: VaultState = {
      tokens: [USDG],
      idle: [100n],
      adapters: [adapter(ADAPTER_V3, [USDG], [900n])],
    };
    const [usdg] = computeTokenBudgets(state, params());
    expect(usdg?.targetIdle).toBe(200n);
    expect(usdg?.excess).toBe(0n);
    expect(usdg?.budget).toBe(0n);
  });

  it('caps the tick at MAX_DEPLOY_PER_TICK_BPS of the total', () => {
    // Fully idle vault: excess is 80% of total, but the cap allows only 50% this tick.
    const state: VaultState = { tokens: [USDG], idle: [1000n], adapters: [] };
    const [usdg] = computeTokenBudgets(state, params({ maxDeployPerTickBps: 5000 }));
    expect(usdg?.excess).toBe(800n);
    expect(usdg?.tickCap).toBe(500n);
    expect(usdg?.budget).toBe(500n);
  });

  it('converges on the target over successive capped ticks instead of oscillating', () => {
    let idle = 1000n;
    let deployed = 0n;
    for (let i = 0; i < 6; i += 1) {
      const [b] = computeTokenBudgets(
        { tokens: [USDG], idle: [idle], adapters: [adapter(ADAPTER_V3, [USDG], [deployed])] },
        params(),
      );
      idle -= b!.budget;
      deployed += b!.budget;
    }
    expect(idle + deployed).toBe(1000n); // conserved
    expect(idle).toBe(200n); // exactly the 20% target
  });

  it('treats a token with zero total as having no budget', () => {
    const state: VaultState = { tokens: [USDG], idle: [0n], adapters: [] };
    expect(computeTokenBudgets(state, params())[0]?.budget).toBe(0n);
  });

  it('rejects a ragged adapter position() vector', () => {
    const state: VaultState = {
      tokens: [USDG],
      idle: [1n],
      adapters: [{ address: ADAPTER_V3, tokens: [USDG, WETH], amounts: [1n] }],
    };
    expect(() => computeTokenBudgets(state, params())).toThrow(/ragged/);
  });

  it('rejects an out-of-range bps parameter', () => {
    const state: VaultState = { tokens: [USDG], idle: [1n], adapters: [] };
    expect(() => computeTokenBudgets(state, params({ targetIdleBps: 10_001 }))).toThrow(
      /targetIdleBps/,
    );
  });
});

describe('planDeployments — weights and splitting', () => {
  const baseState: VaultState = {
    tokens: [USDG, WETH],
    idle: [1000n, 2000n],
    adapters: [adapter(ADAPTER_V3, [USDG, WETH], [0n, 0n]), adapter(ADAPTER_V4, [USDG, WETH], [0n, 0n])],
  };

  it('splits the budget equally by default', () => {
    const { budgets, plans } = planDeployments(baseState, params());
    expect(budgets.map((b) => b.budget)).toEqual([500n, 1000n]); // 50% tick cap
    expect(plans).toHaveLength(2);
    expect(plans[0]?.amounts).toEqual([250n, 500n]);
    expect(plans[1]?.amounts).toEqual([250n, 500n]);
  });

  it('honours unequal weights', () => {
    const { plans } = planDeployments(
      baseState,
      params({
        adapterWeights: new Map([
          [ADAPTER_V3.toLowerCase(), 3n],
          [ADAPTER_V4.toLowerCase(), 1n],
        ]),
      }),
    );
    expect(plans[0]?.amounts).toEqual([375n, 750n]); // 3/4 of 500 / 1000
    expect(plans[1]?.amounts).toEqual([125n, 250n]); // 1/4
  });

  it('skips a zero-weight adapter and gives it no budget share', () => {
    const { plans, skipped } = planDeployments(
      baseState,
      params({
        adapterWeights: new Map([
          [ADAPTER_V3.toLowerCase(), 1n],
          [ADAPTER_V4.toLowerCase(), 0n],
        ]),
      }),
    );
    expect(skipped).toEqual([{ adapter: ADAPTER_V4, reason: 'zero-weight' }]);
    // The whole budget goes to the only weighted adapter — it is not silently halved.
    expect(plans).toHaveLength(1);
    expect(plans[0]?.amounts).toEqual([500n, 1000n]);
  });

  it('never deploys more than the per-token budget (rounding dust stays idle)', () => {
    const state: VaultState = {
      tokens: [USDG],
      idle: [1000n],
      adapters: [
        adapter(ADAPTER_V3, [USDG], [0n]),
        adapter(ADAPTER_V4, [USDG], [0n]),
        adapter(addr('3'), [USDG], [0n]),
      ],
    };
    const { budgets, plans } = planDeployments(
      state,
      params({
        maxDeployPerTickBps: 10_000,
        adapterWeights: new Map([
          [ADAPTER_V3.toLowerCase(), 1n],
          [ADAPTER_V4.toLowerCase(), 1n],
          [addr('3').toLowerCase(), 1n],
        ]),
      }),
    );
    const budget = budgets[0]!.budget; // 1000 - floor(1000*0.2) = 800
    const sent = plans.reduce((acc, p) => acc + (p.amounts[0] ?? 0n), 0n);
    expect(budget).toBe(800n);
    expect(plans.map((p) => p.amounts[0])).toEqual([266n, 266n, 266n]); // floor(800/3)
    expect(sent).toBe(798n); // 2 raw units of dust stay idle rather than overdrawing the budget
    expect(sent).toBeLessThanOrEqual(budget);
  });

  it('never emits an all-zero amount vector', () => {
    const state: VaultState = {
      tokens: [USDG],
      idle: [0n],
      adapters: [adapter(ADAPTER_V3, [USDG], [1000n])],
    };
    const { plans, skipped } = planDeployments(state, params());
    expect(plans).toHaveLength(0);
    expect(skipped).toEqual([{ adapter: ADAPTER_V3, reason: 'nothing-to-deploy' }]);
  });
});

describe('planDeployments — MIN_DEPLOY_AMOUNT_RAW', () => {
  const state: VaultState = {
    tokens: [USDG, WETH],
    idle: [1000n, 2000n],
    adapters: [adapter(ADAPTER_V3, [USDG, WETH], [0n, 0n])],
  };

  it('zeroes a per-adapter amount below the token floor but keeps the rest', () => {
    const { plans } = planDeployments(
      state,
      params({ minDeployAmountRaw: new Map([[USDG.toLowerCase(), 10_000n]]) }),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.amounts).toEqual([0n, 1000n]); // USDG share of 500 < 10000 floor
  });

  it('skips the adapter entirely when every amount is below its floor', () => {
    const { plans, skipped } = planDeployments(
      state,
      params({ minDeployDefault: 10_000n }),
    );
    expect(plans).toHaveLength(0);
    expect(skipped).toEqual([{ adapter: ADAPTER_V3, reason: 'below-min-amount' }]);
  });

  it('applies per-token floors independently of the default', () => {
    const { plans } = planDeployments(
      state,
      params({
        minDeployDefault: 10_000n,
        minDeployAmountRaw: new Map([[WETH.toLowerCase(), 1n]]),
      }),
    );
    expect(plans[0]?.amounts).toEqual([0n, 1000n]);
  });
});

describe('planDeployments — adapter token-order alignment', () => {
  it('aligns amounts to the ADAPTER position() order, not the vault registry order', () => {
    // Vault registry is [USDG, WETH]; this adapter reports [WETH, USDG].
    const state: VaultState = {
      tokens: [USDG, WETH],
      idle: [1000n, 2000n],
      adapters: [adapter(ADAPTER_V3, [WETH, USDG], [0n, 0n])],
    };
    const { budgets, plans } = planDeployments(state, params());
    expect(budgets.map((b) => [b.token, b.budget])).toEqual([
      [USDG, 500n],
      [WETH, 1000n],
    ]);

    const plan = plans[0]!;
    expect(plan.tokens).toEqual([WETH, USDG]);
    // WETH budget first, USDG second — a registry-ordered vector would send 500 WETH and 1000 USDG.
    expect(plan.amounts).toEqual([1000n, 500n]);
    // Restated as a map, to make the intent unmistakable:
    expect(Object.fromEntries(plan.tokens.map((t, i) => [t, plan.amounts[i]]))).toEqual({
      [USDG]: 500n,
      [WETH]: 1000n,
    });
  });

  it('handles two adapters with different token orders in the same tick', () => {
    const state: VaultState = {
      tokens: [USDG, WETH],
      idle: [1000n, 2000n],
      adapters: [
        adapter(ADAPTER_V3, [USDG, WETH], [0n, 0n]),
        adapter(ADAPTER_V4, [WETH, USDG], [0n, 0n]),
      ],
    };
    const { plans } = planDeployments(state, params());
    expect(plans[0]?.tokens).toEqual([USDG, WETH]);
    expect(plans[0]?.amounts).toEqual([250n, 500n]);
    expect(plans[1]?.tokens).toEqual([WETH, USDG]);
    expect(plans[1]?.amounts).toEqual([500n, 250n]);
  });

  it('only splits a token among adapters that actually hold it', () => {
    // ADAPTER_V4 is a single-token position; the WETH budget must go entirely to ADAPTER_V3.
    const state: VaultState = {
      tokens: [USDG, WETH],
      idle: [1000n, 2000n],
      adapters: [
        adapter(ADAPTER_V3, [USDG, WETH], [0n, 0n]),
        adapter(ADAPTER_V4, [USDG], [0n]),
      ],
    };
    const { plans } = planDeployments(state, params());
    expect(plans[0]?.amounts).toEqual([250n, 1000n]); // half the USDG, all the WETH
    expect(plans[1]?.amounts).toEqual([250n]);
  });

  it('sends nothing for an adapter token that is not in the vault registry', () => {
    const rogue = addr('9');
    const state: VaultState = {
      tokens: [USDG],
      idle: [1000n],
      adapters: [adapter(ADAPTER_V3, [USDG, rogue], [0n, 0n])],
    };
    const { plans } = planDeployments(state, params());
    expect(plans[0]?.tokens).toEqual([USDG, rogue]);
    expect(plans[0]?.amounts).toEqual([500n, 0n]);
  });

  it('funds a duplicated adapter token only once', () => {
    const state: VaultState = {
      tokens: [USDG],
      idle: [1000n],
      adapters: [adapter(ADAPTER_V3, [USDG, USDG], [0n, 0n])],
    };
    const { plans } = planDeployments(state, params());
    expect(plans[0]?.amounts).toEqual([500n, 0n]);
  });

  it('skips an adapter that shares no token with the registry', () => {
    const state: VaultState = {
      tokens: [USDG],
      idle: [1000n],
      adapters: [adapter(ADAPTER_V3, [addr('9')], [0n])],
    };
    const { plans, skipped } = planDeployments(state, params());
    expect(plans).toHaveLength(0);
    expect(skipped).toEqual([{ adapter: ADAPTER_V3, reason: 'no-registry-tokens' }]);
  });

  it('matches addresses case-insensitively', () => {
    const state: VaultState = {
      tokens: [USDG.toUpperCase().replace('0X', '0x') as Address],
      idle: [1000n],
      adapters: [adapter(ADAPTER_V3, [USDG], [0n])],
    };
    const { plans } = planDeployments(state, params());
    expect(plans[0]?.amounts).toEqual([500n]);
  });
});

describe('planDeployments — reproduces the live local stack', () => {
  // Numbers read from the running anvil demo stack on 2026-09-22.
  const state: VaultState = {
    tokens: [USDG, WETH],
    idle: [25_000_000000n, 2_500000000000000000n],
    adapters: [
      adapter(ADAPTER_V3, [USDG, WETH], [50_250_000000n, 5_050000000000000000n]),
      adapter(ADAPTER_V4, [USDG, WETH], [25_100_000000n, 2_520000000000000000n]),
    ],
  };

  it('computes the expected budgets and equal split', () => {
    const { budgets, plans } = planDeployments(state, params());
    expect(budgets[0]).toMatchObject({
      total: 100_350_000000n,
      targetIdle: 20_070_000000n,
      excess: 4_930_000000n,
      budget: 4_930_000000n, // well under the 50% tick cap
    });
    expect(budgets[1]).toMatchObject({
      total: 10_070000000000000000n,
      targetIdle: 2_014000000000000000n,
      excess: 486000000000000000n,
      budget: 486000000000000000n,
    });
    expect(plans[0]?.amounts).toEqual([2_465_000000n, 243000000000000000n]);
    expect(plans[1]?.amounts).toEqual([2_465_000000n, 243000000000000000n]);
  });
});

describe('isRebalanceDue / secondsUntilRebalance', () => {
  it('is due when it has never run', () => {
    expect(isRebalanceDue(1000, null, 3600)).toBe(true);
    expect(secondsUntilRebalance(1000, null, 3600)).toBe(0);
  });

  it('is not due before the interval elapses', () => {
    expect(isRebalanceDue(1000, 900, 3600)).toBe(false);
    expect(secondsUntilRebalance(1000, 900, 3600)).toBe(3500);
  });

  it('is due exactly at the interval boundary', () => {
    expect(isRebalanceDue(4500, 900, 3600)).toBe(true);
    expect(secondsUntilRebalance(4500, 900, 3600)).toBe(0);
  });

  it('is always due with a zero interval', () => {
    expect(isRebalanceDue(1000, 1000, 0)).toBe(true);
  });

  it('does not wedge shut when the recorded timestamp is in the future', () => {
    // Clock skew or a state file copied from another host must not disable harvesting forever.
    expect(isRebalanceDue(1000, 99_999, 3600)).toBe(true);
  });
});

describe('diffPositionDelta', () => {
  const plan = { adapter: ADAPTER_V3, tokens: [USDG, WETH], amounts: [100n, 200n] };

  it('reports nothing when the position moved by exactly the intended amounts', () => {
    expect(diffPositionDelta(plan, [10n, 20n], [110n, 220n])).toEqual([]);
  });

  it('reports the shortfall when the adapter took less than offered', () => {
    expect(diffPositionDelta(plan, [10n, 20n], [110n, 200n])).toEqual([
      { token: WETH, expected: 200n, observed: 180n, delta: -20n },
    ]);
  });

  it('reports a surplus (e.g. fees accrued between the two reads)', () => {
    expect(diffPositionDelta(plan, [10n, 20n], [115n, 220n])).toEqual([
      { token: USDG, expected: 100n, observed: 105n, delta: 5n },
    ]);
  });
});
