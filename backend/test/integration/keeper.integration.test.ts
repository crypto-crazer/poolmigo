/**
 * Integration tests against the LIVE local anvil demo stack — the chain registry's `local` entry
 * (`shared/deployments.json` + the `shared/deployment.local.json` overlay).
 *
 * They skip themselves when the RPC is unreachable, and refuse to run against anything that is not
 * a local chain (see `assertLocalChain`). They DO send real transactions to that local chain:
 *   a) a dry-run tick changes nothing on chain and plans what we expect;
 *   b) an executing tick performs one real `deployTo` and the adapter position grows by exactly
 *      the amounts sent;
 *   c) seeded mock fees are harvested by `rebalance()` and 10% of each token reaches the treasury.
 *
 * Test order matters within this file: (b) moves idle into adapter V3, (c) then harvests.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { erc20Abi, mockAdapterTestAbi, vaultAbi } from '../../src/abi/generated.js';
import { runTick, preflight } from '../../src/keeper.js';
import { observe, readAdapterPosition } from '../../src/vault.js';
import type { Address } from '../../src/types.js';
import {
  ANVIL_KEY_1,
  isStackReachable,
  localWallet,
  makeHarness,
  readDeployment,
  renderLog,
  type Harness,
} from './helpers.js';

const reachable = await isStackReachable();
if (!reachable) {
  // eslint-disable-next-line no-console -- visible skip reason is the point
  console.warn(
    '[integration] local anvil stack unreachable — skipping. Start it with:\n' +
      '  anvil --port 8547 --chain-id 46630   (demo stack via contracts/script/DemoLocal.s.sol)',
  );
}

const BPS = 10_000n;

/**
 * Independent restatement of the policy arithmetic, written out longhand so a bug in policy.ts
 * cannot make this assertion pass by agreeing with itself.
 */
function expectedPerAdapter(
  idle: bigint,
  inAdapters: bigint,
  targetIdleBps: bigint,
  maxPerTickBps: bigint,
  adapterCount: bigint,
): bigint {
  const total = idle + inAdapters;
  const targetIdle = (total * targetIdleBps) / BPS;
  const excess = idle > targetIdle ? idle - targetIdle : 0n;
  const cap = (total * maxPerTickBps) / BPS;
  const budget = excess < cap ? excess : cap;
  return budget / adapterCount;
}

describe.skipIf(!reachable)('keeper against the live local stack', () => {
  const deployment = reachable ? readDeployment() : undefined;

  beforeAll(async () => {
    const h = makeHarness();
    // Fails loudly (rather than mysteriously) if the demo stack was redeployed without the keeper.
    await preflight(h);
  });

  it('a) dry run: plans the expected deployments and changes nothing on chain', async () => {
    const h: Harness = makeHarness({ DRY_RUN: 'true', REBALANCE_INTERVAL_SEC: '86400' });
    const before = await observe(h.clients, h.cfg.vaultAddress);

    const result = await runTick(h);

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.paused).toBe(false);
    expect(result.decision.plans).toHaveLength(before.state.adapters.length);
    expect(result.deploys.every((d) => d.outcome === 'simulated')).toBe(true);

    // The plan matches the longhand arithmetic, per token, per adapter.
    const adapterCount = BigInt(before.state.adapters.length);
    before.state.tokens.forEach((token, i) => {
      const idle = before.state.idle[i]!;
      const inAdapters = before.state.adapters.reduce((acc, a) => {
        const j = a.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
        return acc + (j >= 0 ? a.amounts[j]! : 0n);
      }, 0n);
      const expectedAmount = expectedPerAdapter(idle, inAdapters, 2000n, 5000n, adapterCount);

      for (const plan of result.decision.plans) {
        const j = plan.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
        expect(plan.amounts[j]).toBe(expectedAmount);
      }
    });

    // Nothing moved: idle balances and every adapter position are byte-identical.
    const after = await observe(h.clients, h.cfg.vaultAddress);
    expect(after.state.idle).toEqual(before.state.idle);
    expect(after.state.adapters.map((a) => a.amounts)).toEqual(
      before.state.adapters.map((a) => a.amounts),
    );

    // And the tick was recorded, so a restart resumes rather than repeats blindly.
    expect(h.store.read().state.tickCount).toBe(1);
    expect(h.store.read().state.lastRebalanceAt).toBeNull(); // dry run never advances the gate

    // The observation names the chain it read, by its registry name.
    const observed = h.records.find((r) => r.msg === 'observed vault');
    expect(observed).toMatchObject({
      chain: deployment!.entry.name,
      chainId: deployment!.chainId,
      vault: deployment!.vault,
    });
    expect(h.clients.chain.name).toBe(deployment!.entry.name);

    process.stdout.write(`\n--- dry-run tick log ---\n${renderLog(h.records)}\n`);
  });

  it('b) execute: one real deployTo grows the adapter position by exactly the amounts sent', async () => {
    // Weight the whole budget onto adapter V3 so exactly one transaction is sent this tick.
    const h: Harness = makeHarness({
      DRY_RUN: 'false',
      REBALANCE_INTERVAL_SEC: '86400',
      ADAPTER_WEIGHTS: `${deployment!.adapterV3}:1,${deployment!.adapterV4}:0`,
    });

    // Park the harvest gate: with a fresh state file the harvest is due immediately, and
    // `rebalance()` moves fees OUT of `position()` in the same tick — which would make the
    // read-back below measure the deploy and the harvest together.
    h.store.write({ ...h.store.read().state, lastRebalanceAt: Math.floor(Date.now() / 1000) });

    const before = await observe(h.clients, h.cfg.vaultAddress);
    const posBefore = await readAdapterPosition(h.clients.publicClient, deployment!.adapterV3);

    const result = await runTick(h);
    expect(result.rebalance.outcome).toBe('skipped'); // this tick is purely a deploy

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    const sent = result.deploys.filter((d) => d.outcome === 'sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.adapter.toLowerCase()).toBe(deployment!.adapterV3.toLowerCase());
    expect(sent[0]?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.deploys.find((d) => d.outcome === 'skipped')?.reason).toBe('zero-weight');

    const intended = sent[0]!;
    // Whole budget to one adapter (weights 1 / 0), so the longhand amount is the full budget.
    const adapterCount = 1n;
    before.state.tokens.forEach((token, i) => {
      const idle = before.state.idle[i]!;
      const inAdapters = before.state.adapters.reduce((acc, a) => {
        const j = a.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
        return acc + (j >= 0 ? a.amounts[j]! : 0n);
      }, 0n);
      const j = intended.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
      expect(intended.amounts[j]).toBe(
        expectedPerAdapter(idle, inAdapters, 2000n, 5000n, adapterCount),
      );
    });

    // Post-condition: position() grew by exactly the amounts, and idle fell by exactly the same.
    const posAfter = await readAdapterPosition(h.clients.publicClient, deployment!.adapterV3);
    expect(posAfter.tokens).toEqual(posBefore.tokens);
    posAfter.tokens.forEach((token, i) => {
      const j = intended.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
      expect(posAfter.amounts[i]! - posBefore.amounts[i]!).toBe(intended.amounts[j]);
    });
    expect(intended.mismatches).toEqual([]);

    const after = await observe(h.clients, h.cfg.vaultAddress);
    after.state.tokens.forEach((token, i) => {
      const j = intended.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
      expect(before.state.idle[i]! - after.state.idle[i]!).toBe(intended.amounts[j]);
    });

    // The vault must never be left with a standing allowance to the adapter.
    for (const token of after.state.tokens) {
      const allowance = await h.clients.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [h.cfg.vaultAddress, deployment!.adapterV3],
      });
      expect(allowance).toBe(0n);
    }

    expect(h.store.read().state.lastDeployTxs[0]?.hash).toBe(intended.txHash);

    process.stdout.write(`\n--- execute tick log ---\n${renderLog(h.records)}\n`);
  });

  it('c) rebalance: harvests seeded fees and sends exactly performanceFeeBps to the treasury', async () => {
    const wallet = localWallet(deployment!, ANVIL_KEY_1);
    const adapters: Address[] = [deployment!.adapterV3, deployment!.adapterV4];

    // Seed fresh fees on both mock adapters (`simulateFees` is permissionless on the mock).
    const seedV3 = [500_000000n, 100000000000000000n]; // 500 mUSDG, 0.1 mWETH
    const seedV4 = [250_000000n, 50000000000000000n]; // 250 mUSDG, 0.05 mWETH
    for (const [adapter, seed] of [
      [deployment!.adapterV3, seedV3],
      [deployment!.adapterV4, seedV4],
    ] as const) {
      const hash = await wallet.writeContract({
        address: adapter,
        abi: mockAdapterTestAbi,
        functionName: 'simulateFees',
        args: [seed],
      });
      await makeHarness().clients.publicClient.waitForTransactionReceipt({ hash });
    }

    // REBALANCE_INTERVAL_SEC=0 makes the harvest due on this tick; weights 0 so no deploy runs and
    // the assertion below sees only what rebalance() moved.
    const h: Harness = makeHarness({
      DRY_RUN: 'false',
      REBALANCE_INTERVAL_SEC: '0',
      TARGET_IDLE_BPS: '10000', // keep everything idle => zero deploy budget this tick
    });

    const vaultTokens = await h.clients.publicClient.readContract({
      address: h.cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'tokens',
    });
    const feeBps = await h.clients.publicClient.readContract({
      address: h.cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'performanceFeeBps',
    });
    const treasury = await h.clients.publicClient.readContract({
      address: h.cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'treasury',
    });
    expect(feeBps).toBe(1000); // 10% on the local stack

    // Everything currently harvestable across both adapters, per registry token.
    const expectedHarvest = new Map<string, bigint>(vaultTokens.map((t) => [t.toLowerCase(), 0n]));
    for (const adapter of adapters) {
      const [tokens] = await h.clients.publicClient.readContract({
        address: adapter,
        abi: mockAdapterTestAbi,
        functionName: 'position',
      });
      for (let i = 0; i < tokens.length; i += 1) {
        const harvestable = await h.clients.publicClient.readContract({
          address: adapter,
          abi: mockAdapterTestAbi,
          functionName: 'harvestable',
          args: [BigInt(i)],
        });
        const key = tokens[i]!.toLowerCase();
        expectedHarvest.set(key, (expectedHarvest.get(key) ?? 0n) + harvestable);
      }
    }
    expect([...expectedHarvest.values()].every((v) => v > 0n)).toBe(true);

    const treasuryBefore = await Promise.all(
      vaultTokens.map((token) =>
        h.clients.publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [treasury],
        }),
      ),
    );

    const result = await runTick(h);

    expect(result.ok).toBe(true);
    expect(result.decision.plans).toHaveLength(0); // TARGET_IDLE_BPS=10000 => nothing to deploy
    expect(result.rebalance.outcome).toBe('sent');
    expect(result.rebalance.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const harvested = result.rebalance.harvested!;
    expect(harvested).toHaveLength(vaultTokens.length);

    for (const entry of harvested) {
      const expectedAmount = expectedHarvest.get(entry.token.toLowerCase())!;
      expect(entry.amount).toBe(expectedAmount);
      // Fee is floor(harvested * feeBps / 10_000), charged in kind, per token.
      expect(entry.fee).toBe((expectedAmount * BigInt(feeBps)) / BPS);
    }

    // The fee really arrived at the treasury, in kind, per token.
    const treasuryAfter = await Promise.all(
      vaultTokens.map((token) =>
        h.clients.publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [treasury],
        }),
      ),
    );
    vaultTokens.forEach((token, i) => {
      const entry = harvested.find((x) => x.token.toLowerCase() === token.toLowerCase())!;
      expect(treasuryAfter[i]! - treasuryBefore[i]!).toBe(entry.fee);
    });

    // Nothing harvestable is left behind.
    for (const adapter of adapters) {
      for (let i = 0; i < vaultTokens.length; i += 1) {
        const left = await h.clients.publicClient.readContract({
          address: adapter,
          abi: mockAdapterTestAbi,
          functionName: 'harvestable',
          args: [BigInt(i)],
        });
        expect(left).toBe(0n);
      }
    }

    // A confirmed harvest advances the interval gate in the durable state.
    const state = h.store.read().state;
    expect(state.lastRebalanceAt).not.toBeNull();
    expect(state.lastRebalanceTx?.hash).toBe(result.rebalance.txHash);

    process.stdout.write(`\n--- rebalance tick log ---\n${renderLog(h.records)}\n`);
  });

  it('d) a not-yet-due harvest is skipped with an explicit reason', async () => {
    const h: Harness = makeHarness({ DRY_RUN: 'true', REBALANCE_INTERVAL_SEC: '86400' });
    h.store.write({ ...h.store.read().state, lastRebalanceAt: Math.floor(Date.now() / 1000) });

    const result = await runTick(h);
    expect(result.rebalance.due).toBe(false);
    expect(result.rebalance.reason).toBe('interval-not-elapsed');
    expect(result.rebalance.secondsUntilDue).toBeGreaterThan(86_000);
  });

  it('e) preflight rejects an address the vault does not recognise as a keeper', async () => {
    const h = makeHarness({
      // Anvil account #9 — a funded local account that was never granted the keeper role.
      KEEPER_PRIVATE_KEY: undefined,
      KEEPER_ADDRESS: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
    });
    await expect(preflight(h)).rejects.toThrow(/not an authorised keeper/);
  });
});
