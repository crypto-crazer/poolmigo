/**
 * The read side: one viem client per chain, pointed at that chain's RPC from the registry.
 *
 * Reads deliberately do NOT go through the wallet. The live vault must render for a visitor with
 * no extension installed, or with a wallet parked on another network — only writes need a
 * connection. Every read names its chain explicitly; the live pages pass the target chain
 * (src/chain/targetChain.ts), never a module-level constant.
 *
 * `createClient` + standalone actions from `viem/actions`, NOT `createPublicClient`: the latter
 * attaches every public action there is (simulateCalls, the watchers, the filters, multicall …)
 * and none of it tree-shakes. We use two actions; we ship two actions.
 */
import { createClient, http, type Abi, type Address, type Chain, type Client, type ContractFunctionName, type Transport } from 'viem';
import { readContract, waitForTransactionReceipt } from 'viem/actions';
import { chainFor } from './chains';

const clients = new Map<number, Client<Transport, Chain>>();

/**
 * The (cached) read client for a registry chain. `batch: true` collapses the ~40 calls a page
 * render issues into a handful of JSON-RPC batch requests — transport-level batching needs no
 * Multicall3 deployment, which not every target chain carries.
 */
export function publicClientFor(chainId: number): Client<Transport, Chain> {
  let client = clients.get(chainId);
  if (!client) {
    const chain = chainFor(chainId);
    if (!chain) throw new Error(`Chain ${chainId} is not in the registry (shared/deployments.json).`);
    client = createClient({ chain, transport: http(chain.rpcUrls.default.http[0], { batch: true }) });
    clients.set(chainId, client);
  }
  return client;
}

export interface ContractCall {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

export type ReadResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: Error };

/**
 * Stable cache key for a batch of calls. Everything that changes the answer — address, function,
 * arguments — is in the string, and `String()` keeps bigint args from blowing up JSON.stringify.
 * Two components asking for the same reads therefore share one request.
 */
export function callsKey(calls: readonly ContractCall[]): string {
  return calls
    .map((c) => `${c.address}.${c.functionName}(${(c.args ?? []).map(String).join(',')})`)
    .join('|');
}

/**
 * Per-call failure tolerance, the way `useReadContracts({ allowFailure: true })` had it: a single
 * reverting call (an adapter that cannot report, a mock-only getter on a real adapter) is DATA,
 * not an error. Only a batch in which nothing at all succeeded is treated as an error, because
 * that means the node is unreachable or the contract is not deployed — which is what the UI's
 * "cannot reach the vault" state is for.
 */
export async function readMany(chainId: number, calls: readonly ContractCall[]): Promise<ReadResult[]> {
  if (calls.length === 0) return [];
  const client = publicClientFor(chainId);
  const results = await Promise.all(
    calls.map(async (call): Promise<ReadResult> => {
      try {
        const result = await readContract(client, {
          address: call.address,
          abi: call.abi as Abi,
          functionName: call.functionName as ContractFunctionName<Abi>,
          args: call.args as never,
        });
        return { status: 'success', result };
      } catch (error) {
        return { status: 'failure', error: error as Error };
      }
    }),
  );
  const firstFailure = results.find((r) => r.status === 'failure');
  if (firstFailure?.status === 'failure' && results.every((r) => r.status === 'failure')) {
    throw firstFailure.error;
  }
  return results;
}

/** Wait for a transaction sent through the wallet to land on `chainId` (read over its RPC). */
export function waitForReceipt(chainId: number, hash: `0x${string}`) {
  return waitForTransactionReceipt(publicClientFor(chainId), { hash });
}
