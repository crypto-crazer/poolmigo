/**
 * Contract layer: every read and write the keeper performs against the vault and its adapters.
 *
 * Only two state-changing entry points exist here — `deployTo` and `rebalance`, the two
 * keeper-gated functions. The owner-only surface (`addAdapter`, `setKeeper`, `setRebalancePaused`,
 * `setPerformanceFeeBps`, `setTreasury`, `emergencyUnwind`, upgrades) is deliberately absent from
 * this module and from the generated ABI selection: a keeper that cannot encode those calls cannot
 * make them by accident.
 */

import { parseEventLogs, type Hash, type TransactionReceipt } from 'viem';

import { erc20Abi, positionAdapterAbi, vaultAbi } from './abi/generated.js';
import type { Clients, KeeperPublicClient } from './chain.js';
import type { AdapterState, DeployPlan, VaultState } from './policy.js';
import type { Address } from './types.js';

export interface VaultMeta {
  readonly rebalancePaused: boolean;
  readonly performanceFeeBps: number;
  readonly treasury: Address;
}

export interface Observation {
  readonly state: VaultState;
  readonly meta: VaultMeta;
  readonly blockNumber: bigint;
}

export async function isKeeper(
  client: KeeperPublicClient,
  vault: Address,
  account: Address,
): Promise<boolean> {
  return client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'isKeeper',
    args: [account],
  });
}

export async function readVaultMeta(
  client: KeeperPublicClient,
  vault: Address,
): Promise<VaultMeta> {
  const [paused, feeBps, treasury] = await Promise.all([
    client.readContract({ address: vault, abi: vaultAbi, functionName: 'rebalancePaused' }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: 'performanceFeeBps' }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: 'treasury' }),
  ]);
  return { rebalancePaused: paused, performanceFeeBps: feeBps, treasury };
}

/** `position()` of one adapter, in that adapter's own token order. */
export async function readAdapterPosition(
  client: KeeperPublicClient,
  adapter: Address,
): Promise<AdapterState> {
  const [tokens, amounts] = await client.readContract({
    address: adapter,
    abi: positionAdapterAbi,
    functionName: 'position',
  });
  return { address: adapter, tokens: [...tokens], amounts: [...amounts] };
}

/** Human-readable venue label for logs: `dex()` / `poolId()` are bytes32 ASCII on this stack. */
export async function readAdapterLabel(
  client: KeeperPublicClient,
  adapter: Address,
): Promise<{ dex: string; poolId: string }> {
  const [dex, poolId] = await Promise.all([
    client.readContract({ address: adapter, abi: positionAdapterAbi, functionName: 'dex' }),
    client.readContract({ address: adapter, abi: positionAdapterAbi, functionName: 'poolId' }),
  ]);
  return { dex: bytes32ToLabel(dex), poolId: bytes32ToLabel(poolId) };
}

/** bytes32 -> trimmed ASCII, falling back to the raw hex when it is not printable. */
export function bytes32ToLabel(value: `0x${string}`): string {
  const bytes = value.slice(2).match(/.{2}/g) ?? [];
  const chars: string[] = [];
  for (const byte of bytes) {
    const code = Number.parseInt(byte, 16);
    if (code === 0) break;
    if (code < 0x20 || code > 0x7e) return value;
    chars.push(String.fromCharCode(code));
  }
  return chars.length > 0 ? chars.join('') : value;
}

/**
 * One consistent snapshot of everything the policy needs.
 * All reads are pinned to a single block so idle balances and positions cannot straddle a
 * state change mid-observation.
 */
export async function observe(clients: Clients, vault: Address): Promise<Observation> {
  const client = clients.publicClient;
  const blockNumber = await client.getBlockNumber();
  const at = { blockNumber } as const;

  const [tokens, adapterAddresses, paused, feeBps, treasury] = await Promise.all([
    client.readContract({ address: vault, abi: vaultAbi, functionName: 'tokens', ...at }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: 'adapters', ...at }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: 'rebalancePaused', ...at }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: 'performanceFeeBps', ...at }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: 'treasury', ...at }),
  ]);

  const [idle, adapters] = await Promise.all([
    Promise.all(
      tokens.map((token) =>
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [vault],
          ...at,
        }),
      ),
    ),
    Promise.all(
      adapterAddresses.map(async (adapter): Promise<AdapterState> => {
        const [t, a] = await client.readContract({
          address: adapter,
          abi: positionAdapterAbi,
          functionName: 'position',
          ...at,
        });
        return { address: adapter, tokens: [...t], amounts: [...a] };
      }),
    ),
  ]);

  return {
    state: { tokens: [...tokens], idle, adapters },
    meta: { rebalancePaused: paused, performanceFeeBps: feeBps, treasury },
    blockNumber,
  };
}

export interface SimulatedCall {
  /** Gas the node estimates for the call. `null` if the estimate itself could not be obtained. */
  readonly gas: bigint | null;
}

/** `estimateContractGas`, but a failure degrades to `null` rather than failing the action. */
async function estimateOrNull(fn: () => Promise<bigint>): Promise<bigint | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * `simulateContract` for one intended `deployTo`. Throws (with the decoded custom error) if the
 * call would revert — the keeper never sends a transaction it has not simulated at head.
 */
export async function simulateDeploy(
  clients: Clients,
  vault: Address,
  plan: DeployPlan,
): Promise<SimulatedCall> {
  const account = clients.keeperAddress;
  const { request } = await clients.publicClient.simulateContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'deployTo',
    args: [plan.adapter, plan.amounts as readonly bigint[]],
    account,
  });
  // `simulateContract` does not populate `request.gas`; estimate separately so the dry-run log
  // tells an operator what the call would actually cost.
  const gas =
    request.gas ??
    (await estimateOrNull(() =>
      clients.publicClient.estimateContractGas({
        address: vault,
        abi: vaultAbi,
        functionName: 'deployTo',
        args: [plan.adapter, plan.amounts as readonly bigint[]],
        account,
      }),
    ));
  return { gas };
}

export async function simulateRebalance(clients: Clients, vault: Address): Promise<SimulatedCall> {
  const account = clients.keeperAddress;
  const { request } = await clients.publicClient.simulateContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'rebalance',
    account,
  });
  const gas =
    request.gas ??
    (await estimateOrNull(() =>
      clients.publicClient.estimateContractGas({
        address: vault,
        abi: vaultAbi,
        functionName: 'rebalance',
        account,
      }),
    ));
  return { gas };
}

export interface SentTx {
  readonly hash: Hash;
  readonly receipt: TransactionReceipt;
}

/** Simulate, send, and wait for the receipt. Reverts as `status: 'reverted'` are raised. */
export async function sendDeploy(
  clients: Clients,
  vault: Address,
  plan: DeployPlan,
  opts: { confirmations: number; timeoutSec: number },
): Promise<SentTx> {
  const wallet = requireWallet(clients);
  const account = wallet.account;
  const { request } = await clients.publicClient.simulateContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'deployTo',
    args: [plan.adapter, plan.amounts as readonly bigint[]],
    account,
  });
  const hash = await wallet.writeContract(request);
  return { hash, receipt: await waitFor(clients.publicClient, hash, opts) };
}

export async function sendRebalance(
  clients: Clients,
  vault: Address,
  opts: { confirmations: number; timeoutSec: number },
): Promise<SentTx> {
  const wallet = requireWallet(clients);
  const account = wallet.account;
  const { request } = await clients.publicClient.simulateContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'rebalance',
    account,
  });
  const hash = await wallet.writeContract(request);
  return { hash, receipt: await waitFor(clients.publicClient, hash, opts) };
}

async function waitFor(
  client: KeeperPublicClient,
  hash: Hash,
  opts: { confirmations: number; timeoutSec: number },
): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: opts.confirmations,
    timeout: opts.timeoutSec * 1000,
  });
  if (receipt.status !== 'success') {
    throw new Error(`transaction ${hash} reverted on-chain (block ${receipt.blockNumber})`);
  }
  return receipt;
}

/** Decode the `Rebalanced(keeper, tokens, harvested, fees)` event from a rebalance receipt. */
export function decodeRebalanced(
  receipt: TransactionReceipt,
): { tokens: readonly Address[]; harvested: readonly bigint[]; fees: readonly bigint[] } | null {
  const events = parseEventLogs({ abi: vaultAbi, eventName: 'Rebalanced', logs: receipt.logs });
  const first = events[0];
  if (first === undefined) return null;
  const args = first.args as {
    tokens: readonly Address[];
    harvested: readonly bigint[];
    fees: readonly bigint[];
  };
  return { tokens: args.tokens, harvested: args.harvested, fees: args.fees };
}

function requireWallet(clients: Clients) {
  if (clients.walletClient === null) {
    throw new Error('no wallet client — cannot send transactions without a configured signer');
  }
  return clients.walletClient;
}
