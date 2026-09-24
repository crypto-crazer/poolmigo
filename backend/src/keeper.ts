/**
 * Tick orchestration and the supervision loop.
 *
 * One tick, in order:
 *   1. preflight   — chain id matches, `isKeeper(us)` is true, pause flag read
 *   2. observe     — basket, idle balances, every adapter `position()`, pinned to one block
 *   3. plan        — pure policy (see policy.ts)
 *   4. simulate    — every intended call, at head; a revert kills that action, not the tick
 *   5. execute     — only when `DRY_RUN=false`; then re-read positions and verify the delta
 *   6. rebalance   — when `REBALANCE_INTERVAL_SEC` has elapsed since the last confirmed harvest
 *   7. persist     — atomic state write
 *
 * Failures are contained per tick: the loop logs and sleeps rather than exiting, because a keeper
 * that dies on one bad RPC response stops rebalancing the vault.
 */

import {
  resolveAdapterWeights,
  type KeeperConfig,
} from './config.js';
import { assertChainId, withBackoff, type Clients } from './chain.js';
import { serializeError, type Logger } from './logger.js';
import {
  diffPositionDelta,
  isRebalanceDue,
  planDeployments,
  secondsUntilRebalance,
  type DeployPlan,
  type PolicyDecision,
  type PolicyParams,
} from './policy.js';
import { StateStore, type KeeperState, type TxRecord } from './state.js';
import type { Address } from './types.js';
import {
  decodeRebalanced,
  isKeeper,
  observe,
  readAdapterPosition,
  sendDeploy,
  sendRebalance,
  simulateDeploy,
  simulateRebalance,
} from './vault.js';

export const EXIT_OK = 0;
export const EXIT_FATAL = 1;
export const EXIT_CONFIG = 2;
export const EXIT_PREFLIGHT = 3;

export class PreflightError extends Error {
  override readonly name = 'PreflightError';
}

export type ActionOutcome = 'planned' | 'simulated' | 'sent' | 'skipped' | 'failed';

export interface DeployOutcome {
  readonly adapter: Address;
  readonly tokens: readonly Address[];
  readonly amounts: readonly bigint[];
  readonly outcome: ActionOutcome;
  readonly txHash?: string;
  readonly gasUsed?: bigint;
  readonly error?: string;
  /** Why the adapter was not funded, when `outcome === 'skipped'`. */
  readonly reason?: string;
  /** Post-condition mismatches (observed position delta != intended amounts). */
  readonly mismatches?: readonly { token: Address; expected: bigint; observed: bigint }[];
}

export interface RebalanceOutcome {
  readonly due: boolean;
  readonly outcome: ActionOutcome;
  readonly secondsUntilDue?: number;
  readonly txHash?: string;
  readonly gasUsed?: bigint;
  readonly harvested?: readonly { token: Address; amount: bigint; fee: bigint }[];
  readonly error?: string;
  readonly reason?: string;
}

export interface TickResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly blockNumber: bigint;
  readonly paused: boolean;
  readonly decision: PolicyDecision;
  readonly deploys: readonly DeployOutcome[];
  readonly rebalance: RebalanceOutcome;
}

export interface TickDeps {
  readonly cfg: KeeperConfig;
  readonly clients: Clients;
  readonly logger: Logger;
  readonly store: StateStore;
  /** Injectable clock (unix seconds) for tests. */
  readonly now?: () => number;
  /** Per-invocation override of `cfg.dryRun` (the `--execute` / `--dry-run` CLI flags). */
  readonly dryRunOverride?: boolean;
  /**
   * Whether the tick writes to `STATE_FILE`. `false` makes the tick a pure observation — used by
   * `status` (and the container HEALTHCHECK) so that inspecting the keeper cannot move its
   * scheduling state.
   */
  readonly persistState?: boolean;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Verify the keeper can act at all. Throws `PreflightError` on anything that makes the tick
 * meaningless — a wrong chain, or an address the vault does not recognise as a keeper.
 */
export async function preflight(deps: TickDeps): Promise<void> {
  const { cfg, clients, logger } = deps;
  await withBackoff(() => assertChainId(clients.publicClient, cfg.chainId), {
    maxRetries: cfg.rpcMaxRetries,
    baseMs: cfg.rpcBackoffBaseMs,
    label: 'getChainId',
    logger,
  });

  const allowed = await withBackoff(
    () => isKeeper(clients.publicClient, cfg.vaultAddress, clients.keeperAddress),
    { maxRetries: cfg.rpcMaxRetries, baseMs: cfg.rpcBackoffBaseMs, label: 'isKeeper', logger },
  );
  if (!allowed) {
    throw new PreflightError(
      `${clients.keeperAddress} is not an authorised keeper on vault ${cfg.vaultAddress} — ` +
        'the vault owner must call setKeeper(address,true). Refusing to run.',
    );
  }
  logger.info('preflight ok', {
    keeper: clients.keeperAddress,
    vault: cfg.vaultAddress,
    chainId: cfg.chainId,
    chain: cfg.chain.name,
    signer: clients.walletClient === null ? 'absent' : 'present',
  });
}

/** Run exactly one tick. Never throws for ordinary on-chain outcomes; throws on preflight failure. */
export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { cfg, clients, store } = deps;
  const persistState = deps.persistState ?? true;
  const now = deps.now ?? nowSeconds;
  const dryRun = deps.dryRunOverride ?? cfg.dryRun;
  const prev = store.read();
  const tickNumber = prev.state.tickCount + 1;
  const logger = deps.logger.child({ tick: tickNumber, dryRun });

  if (prev.recovered !== null) logger.warn('state recovered', { detail: prev.recovered });

  const backoff = {
    maxRetries: cfg.rpcMaxRetries,
    baseMs: cfg.rpcBackoffBaseMs,
    logger,
  };

  const observation = await withBackoff(() => observe(clients, cfg.vaultAddress), {
    ...backoff,
    label: 'observe',
  });
  const { state, meta, blockNumber } = observation;

  logger.info('observed vault', {
    chain: cfg.chain.name,
    chainId: cfg.chainId,
    vault: cfg.vaultAddress,
    block: blockNumber,
    paused: meta.rebalancePaused,
    performanceFeeBps: meta.performanceFeeBps,
    treasury: meta.treasury,
    tokens: state.tokens,
    idle: state.idle,
    adapters: state.adapters.map((a) => ({
      address: a.address,
      tokens: a.tokens,
      amounts: a.amounts,
    })),
  });

  if (meta.rebalancePaused) {
    // Both keeper entry points revert while paused; there is nothing to simulate.
    logger.warn('rebalancePaused is true — skipping deploy and harvest for this tick', {
      reason: 'vault-paused',
    });
    const result: TickResult = {
      ok: true,
      dryRun,
      blockNumber,
      paused: true,
      decision: { budgets: [], plans: [], skipped: [] },
      deploys: [],
      rebalance: { due: false, outcome: 'skipped', reason: 'vault-paused' },
    };
    if (persistState) persist(store, now(), result, []);
    return result;
  }

  const params = buildPolicyParams(cfg, state.adapters.map((a) => a.address));
  const decision = planDeployments(state, params);

  logger.info('policy decision', {
    budgets: decision.budgets.map((b) => ({
      token: b.token,
      idle: b.idle,
      inAdapters: b.deployedInAdapters,
      total: b.total,
      targetIdle: b.targetIdle,
      excess: b.excess,
      tickCap: b.tickCap,
      budget: b.budget,
    })),
    plans: decision.plans.map(describePlan),
    skipped: decision.skipped,
  });

  const deploys: DeployOutcome[] = decision.skipped.map(
    (s): DeployOutcome => ({
      adapter: s.adapter,
      tokens: [],
      amounts: [],
      outcome: 'skipped',
      reason: s.reason,
    }),
  );
  const txs: TxRecord[] = [];

  for (const plan of decision.plans) {
    deploys.push(await runDeploy({ cfg, clients, logger, dryRun, plan, backoff }, txs, now));
  }

  // The harvest tx is recorded separately (`lastRebalanceTx`), not in `txs`, because only a
  // confirmed harvest may advance the interval gate.
  const rebalance = await runRebalanceIfDue(
    { cfg, clients, logger, dryRun, backoff },
    prev.state,
    now,
  );

  const ok =
    deploys.every((d) => d.outcome !== 'failed') && rebalance.outcome !== 'failed';

  const result: TickResult = {
    ok,
    dryRun,
    blockNumber,
    paused: false,
    decision,
    deploys,
    rebalance,
  };

  if (persistState) persistFull(store, now(), result, txs, rebalance);
  logger.info('tick complete', {
    ok,
    deployed: deploys.filter((d) => d.outcome === 'sent').length,
    simulated: deploys.filter((d) => d.outcome === 'simulated').length,
    failed: deploys.filter((d) => d.outcome === 'failed').length,
    rebalance: rebalance.outcome,
  });
  return result;
}

interface DeployCtx {
  cfg: KeeperConfig;
  clients: Clients;
  logger: Logger;
  dryRun: boolean;
  plan: DeployPlan;
  backoff: { maxRetries: number; baseMs: number; logger: Logger };
}

async function runDeploy(
  ctx: DeployCtx,
  txs: TxRecord[],
  now: () => number,
): Promise<DeployOutcome> {
  const { cfg, clients, logger, dryRun, plan } = ctx;
  const described = describePlan(plan);

  try {
    const sim = await withBackoff(() => simulateDeploy(clients, cfg.vaultAddress, plan), {
      ...ctx.backoff,
      label: 'simulate deployTo',
    });
    logger.info('simulated deployTo', { ...described, gasEstimate: sim.gas });

    if (dryRun) {
      logger.info('DRY RUN — not sending deployTo', described);
      return { adapter: plan.adapter, tokens: plan.tokens, amounts: plan.amounts, outcome: 'simulated' };
    }
    if (clients.walletClient === null) {
      logger.error('execute requested but no signer is configured', described);
      return {
        adapter: plan.adapter,
        tokens: plan.tokens,
        amounts: plan.amounts,
        outcome: 'failed',
        error: 'no signer configured',
      };
    }

    // Snapshot immediately before sending so the post-condition diff is tight.
    const before = await readAdapterPosition(clients.publicClient, plan.adapter);
    const sent = await sendDeploy(clients, cfg.vaultAddress, plan, {
      confirmations: cfg.confirmations,
      timeoutSec: cfg.txTimeoutSec,
    });
    txs.push({ hash: sent.hash, at: now(), adapter: plan.adapter });
    logger.info('deployTo confirmed', {
      ...described,
      txHash: sent.hash,
      block: sent.receipt.blockNumber,
      gasUsed: sent.receipt.gasUsed,
    });

    const after = await readAdapterPosition(clients.publicClient, plan.adapter);
    const mismatches = diffPositionDelta(plan, before.amounts, after.amounts);
    if (mismatches.length > 0) {
      // Not fatal: a real venue adapter may deploy less than offered (ratio adjustment), and fee
      // accrual between the two reads moves `position()` on its own. Surfaced loudly regardless.
      logger.warn('post-condition mismatch after deployTo', {
        ...described,
        txHash: sent.hash,
        mismatches: mismatches.map((m) => ({
          token: m.token,
          expected: m.expected,
          observed: m.observed,
          delta: m.delta,
        })),
      });
    } else {
      logger.info('post-condition verified', { ...described, txHash: sent.hash });
    }

    return {
      adapter: plan.adapter,
      tokens: plan.tokens,
      amounts: plan.amounts,
      outcome: 'sent',
      txHash: sent.hash,
      gasUsed: sent.receipt.gasUsed,
      mismatches: mismatches.map((m) => ({
        token: m.token,
        expected: m.expected,
        observed: m.observed,
      })),
    };
  } catch (err) {
    logger.error('deployTo failed', { ...described, ...serializeError(err) });
    return {
      adapter: plan.adapter,
      tokens: plan.tokens,
      amounts: plan.amounts,
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runRebalanceIfDue(
  ctx: {
    cfg: KeeperConfig;
    clients: Clients;
    logger: Logger;
    dryRun: boolean;
    backoff: { maxRetries: number; baseMs: number; logger: Logger };
  },
  prev: KeeperState,
  now: () => number,
): Promise<RebalanceOutcome> {
  const { cfg, clients, logger, dryRun } = ctx;
  const due = isRebalanceDue(now(), prev.lastRebalanceAt, cfg.rebalanceIntervalSec);
  if (!due) {
    const wait = secondsUntilRebalance(now(), prev.lastRebalanceAt, cfg.rebalanceIntervalSec);
    logger.debug('harvest not due', { secondsUntilDue: wait });
    return { due: false, outcome: 'skipped', secondsUntilDue: wait, reason: 'interval-not-elapsed' };
  }

  try {
    const sim = await withBackoff(() => simulateRebalance(clients, cfg.vaultAddress), {
      ...ctx.backoff,
      label: 'simulate rebalance',
    });
    logger.info('simulated rebalance', { gasEstimate: sim.gas });

    if (dryRun) {
      logger.info('DRY RUN — not sending rebalance');
      return { due: true, outcome: 'simulated' };
    }
    if (clients.walletClient === null) {
      return { due: true, outcome: 'failed', error: 'no signer configured' };
    }

    const sent = await sendRebalance(clients, cfg.vaultAddress, {
      confirmations: cfg.confirmations,
      timeoutSec: cfg.txTimeoutSec,
    });
    const decoded = decodeRebalanced(sent.receipt);
    const harvested = decoded?.tokens.map((token, i) => ({
      token,
      amount: decoded.harvested[i] ?? 0n,
      fee: decoded.fees[i] ?? 0n,
    }));

    logger.info('rebalance confirmed', {
      txHash: sent.hash,
      block: sent.receipt.blockNumber,
      gasUsed: sent.receipt.gasUsed,
      harvested,
    });
    return {
      due: true,
      outcome: 'sent',
      txHash: sent.hash,
      gasUsed: sent.receipt.gasUsed,
      ...(harvested !== undefined ? { harvested } : {}),
    };
  } catch (err) {
    logger.error('rebalance failed', serializeError(err));
    return {
      due: true,
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function describePlan(plan: DeployPlan): Record<string, unknown> {
  return {
    adapter: plan.adapter,
    // tokens/amounts are index-aligned to the ADAPTER's position() order, not the vault registry.
    amountsByToken: plan.tokens.map((token, i) => ({ token, amount: plan.amounts[i] ?? 0n })),
  };
}

export function buildPolicyParams(
  cfg: KeeperConfig,
  adapters: readonly Address[],
): PolicyParams {
  return {
    targetIdleBps: cfg.targetIdleBps,
    maxDeployPerTickBps: cfg.maxDeployPerTickBps,
    adapterWeights: resolveAdapterWeights(cfg.adapterWeights, adapters),
    minDeployAmountRaw: cfg.minDeploy.byToken,
    minDeployDefault: cfg.minDeploy.fallback,
  };
}

function persist(
  store: StateStore,
  at: number,
  result: TickResult,
  txs: readonly TxRecord[],
): void {
  store.update((prev) => ({
    ...prev,
    lastTickAt: at,
    lastSuccessfulTickAt: result.ok ? at : prev.lastSuccessfulTickAt,
    lastDeployTxs: txs.length > 0 ? [...txs] : prev.lastDeployTxs,
    tickCount: prev.tickCount + 1,
  }));
}

function persistFull(
  store: StateStore,
  at: number,
  result: TickResult,
  txs: readonly TxRecord[],
  rebalance: RebalanceOutcome,
): void {
  store.update((prev) => ({
    ...prev,
    lastTickAt: at,
    lastSuccessfulTickAt: result.ok ? at : prev.lastSuccessfulTickAt,
    // Only a CONFIRMED harvest advances the interval gate; a dry run or a failure must not.
    lastRebalanceAt: rebalance.outcome === 'sent' ? at : prev.lastRebalanceAt,
    lastRebalanceTx:
      rebalance.outcome === 'sent' && rebalance.txHash !== undefined
        ? { hash: rebalance.txHash, at }
        : prev.lastRebalanceTx,
    lastDeployTxs: txs.length > 0 ? [...txs] : prev.lastDeployTxs,
    tickCount: prev.tickCount + 1,
    lastError: result.ok
      ? null
      : {
          at,
          message:
            result.deploys.find((d) => d.outcome === 'failed')?.error ??
            rebalance.error ??
            'unknown tick failure',
        },
  }));
}

/* ------------------------------------------ the loop ------------------------------------------ */

export interface LoopHandle {
  /** Resolves once the loop has stopped. */
  readonly done: Promise<void>;
  stop(reason: string): void;
}

/**
 * Interval loop with graceful shutdown. An in-flight tick is always allowed to finish — killing a
 * process between `writeContract` and the receipt is how you lose track of a sent transaction.
 */
export function runLoop(deps: TickDeps): LoopHandle {
  const { cfg, logger } = deps;
  let stopped = false;
  let wake: (() => void) | null = null;

  const stop = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    logger.info('shutdown requested — finishing in-flight work', { reason });
    wake?.();
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((res) => {
      const timer = setTimeout(() => {
        wake = null;
        res();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        res();
      };
    });

  const done = (async () => {
    try {
      await preflight(deps);
    } catch (err) {
      logger.error('preflight failed — not starting the loop', serializeError(err));
      throw err;
    }

    let consecutiveFailures = 0;
    while (!stopped) {
      const started = Date.now();
      try {
        const result = await runTick(deps);
        consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
      } catch (err) {
        // A tick must never take the loop down: log, count, and carry on.
        consecutiveFailures += 1;
        logger.error('tick threw', { consecutiveFailures, ...serializeError(err) });
        deps.store.update((prev) => ({
          ...prev,
          lastTickAt: Math.floor(started / 1000),
          tickCount: prev.tickCount + 1,
          lastError: {
            at: Math.floor(Date.now() / 1000),
            message: err instanceof Error ? err.message : String(err),
          },
        }));
      }
      if (stopped) break;

      // Back the whole loop off after repeated failures so a dead RPC is not hammered every tick.
      const penalty = Math.min(consecutiveFailures, 5);
      const delayMs = cfg.tickIntervalSec * 1000 * (penalty > 0 ? 2 ** (penalty - 1) : 1);
      logger.debug('sleeping until next tick', { delayMs, consecutiveFailures });
      await sleep(delayMs);
    }
    logger.info('loop stopped');
  })();

  return { done, stop };
}
