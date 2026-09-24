/**
 * viem wiring: the chain definition, the public/wallet clients, and the retry policy.
 *
 * Retries are split deliberately:
 *  - transport level (`http({ retryCount })`) absorbs single flaky requests;
 *  - `withBackoff` wraps whole logical operations (a multicall batch, a receipt wait) and backs off
 *    exponentially with jitter.
 * A contract revert is NOT retried: it is a deterministic answer from the chain, and hammering it
 * only burns gas and rate limit. `isRetryable` encodes that split.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  BaseError,
  ContractFunctionRevertedError,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { KeeperConfig } from './config.js';
import type { Logger } from './logger.js';
import { serializeError } from './logger.js';

/**
 * The viem chain for the configured id. The name comes from the chain registry
 * (`shared/deployments.json`, via `cfg.chain.name`); a chain the registry does not list — an
 * env-only config — gets a generic `Chain <id>`. Native currency is ETH on every EVM chain Poolmigo
 * targets today (Robinhood Chain is an Arbitrum Orbit chain).
 */
export function defineKeeperChain(chainId: number, rpcUrl: string, name?: string): Chain {
  return defineChain({
    id: chainId,
    name: name ?? `Chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export type KeeperPublicClient = PublicClient<Transport, Chain>;
export type KeeperWalletClient = WalletClient<Transport, Chain, Account>;

export interface Clients {
  readonly chain: Chain;
  readonly publicClient: KeeperPublicClient;
  /** `null` when no signer is configured — reads and simulations still work. */
  readonly walletClient: KeeperWalletClient | null;
  readonly account: Account | null;
  /** The address the keeper acts as: the signer's, or `KEEPER_ADDRESS` in signer-less dry-run. */
  readonly keeperAddress: `0x${string}`;
}

export function createClients(cfg: KeeperConfig): Clients {
  const chain = defineKeeperChain(cfg.chainId, cfg.rpcUrl, cfg.chain.name);
  const transport = http(cfg.rpcUrl, {
    retryCount: 2,
    retryDelay: cfg.rpcBackoffBaseMs,
    timeout: 20_000,
  });

  const publicClient = createPublicClient({ chain, transport }) as KeeperPublicClient;

  if (cfg.keeperPrivateKey === null) {
    if (cfg.keeperAddress === null) {
      throw new Error('no keeper identity configured'); // parseConfig already rejects this
    }
    return {
      chain,
      publicClient,
      walletClient: null,
      account: null,
      keeperAddress: cfg.keeperAddress,
    };
  }
  const account = privateKeyToAccount(cfg.keeperPrivateKey);
  if (cfg.keeperAddress !== null && cfg.keeperAddress.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `KEEPER_ADDRESS (${cfg.keeperAddress}) does not match the configured signer (${account.address})`,
    );
  }
  const walletClient = createWalletClient({ chain, transport, account }) as KeeperWalletClient;
  return { chain, publicClient, walletClient, account, keeperAddress: account.address };
}

/** Assert the RPC actually serves the chain we were configured for — a wrong RPC is a silent disaster. */
export async function assertChainId(client: KeeperPublicClient, expected: number): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== expected) {
    throw new Error(`RPC reports chainId ${actual} but CHAIN_ID is ${expected} — refusing to act`);
  }
}

/**
 * True when an error is worth retrying: transport/network/timeout failures.
 * Contract reverts, and anything that decodes to one, are terminal for this tick.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert !== null) return false;
    const name = err.name;
    if (
      name === 'HttpRequestError' ||
      name === 'TimeoutError' ||
      name === 'RpcRequestError' ||
      name === 'InternalRpcError' ||
      name === 'LimitExceededRpcError' ||
      name === 'WaitForTransactionReceiptTimeoutError'
    ) {
      return true;
    }
    // `execution reverted` surfaced without a decoded custom error is still terminal.
    return !/revert/i.test(err.shortMessage ?? err.message);
  }
  if (err instanceof Error) {
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i.test(
      err.message,
    );
  }
  return false;
}

export interface BackoffOptions {
  readonly maxRetries: number;
  readonly baseMs: number;
  readonly label: string;
  readonly logger: Logger;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Run `fn`, retrying retryable failures with exponential backoff + full jitter. */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxRetries || !isRetryable(err)) throw err;
      const ceiling = opts.baseMs * 2 ** attempt;
      const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
      attempt += 1;
      opts.logger.warn('rpc call failed, backing off', {
        op: opts.label,
        attempt,
        maxRetries: opts.maxRetries,
        delayMs: delay,
        ...serializeError(err),
      });
      await sleep(delay);
    }
  }
}
