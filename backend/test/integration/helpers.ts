/**
 * Integration-test support: talk to the local anvil demo stack — the chain registry's `local`
 * entry (`shared/deployments.json` overlaid by `shared/deployment.local.json`).
 *
 * These tests mutate chain state (they send real `deployTo` / `rebalance` transactions and seed
 * mock fees), which is safe ONLY because the target is a disposable local anvil. The suite never
 * picks a chain by "first deployed" — it takes the `local` entry or nothing — and
 * `assertLocalChain` refuses anything that is not a local, testnet entry on a localhost RPC.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWalletClient, http, type WalletClient, type Account, type Chain, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createClients, defineKeeperChain, type Clients } from '../../src/chain.js';
import { parseConfig, type EnvRecord, type KeeperConfig } from '../../src/config.js';
import { createMemoryLogger, type Logger } from '../../src/logger.js';
import { buildRegistry, type RegistryChain } from '../../src/registry.js';
import { StateStore } from '../../src/state.js';
import type { Address } from '../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

export const REGISTRY_PATH = resolve(here, '../../../shared/deployments.json');
export const DEPLOYMENT_PATH = resolve(here, '../../../shared/deployment.local.json');

/**
 * Anvil account #1 (the keeper on the demo stack). This is the publicly known Anvil default key:
 * inert, LOCAL ONLY, and it must never be funded on a real network.
 */
export const ANVIL_KEY_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export interface Deployment {
  readonly vault: Address;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly usdg: Address;
  readonly weth: Address;
  readonly adapterV3: Address;
  readonly adapterV4: Address;
  readonly owner: Address;
  readonly keeper: Address;
  /** The registry entry these values come from (name, `local`, `testnet`). */
  readonly entry: RegistryChain;
}

/**
 * The registry's `local` entry, flattened. Throws when there is none: on a multi-chain registry
 * the suite must not fall back to some other deployed chain.
 */
export function readDeployment(): Deployment {
  const chains = buildRegistry({
    registryText: readFileSync(REGISTRY_PATH, 'utf8'),
    localText: existsSync(DEPLOYMENT_PATH) ? readFileSync(DEPLOYMENT_PATH, 'utf8') : undefined,
  });
  const entry = chains.find((c) => c.local === true);
  if (entry?.addresses === undefined) {
    throw new Error(
      'the chain registry has no local entry (shared/deployment.local.json missing?) — ' +
        'integration tests only ever act on the local demo stack',
    );
  }
  return { ...entry.addresses, chainId: entry.chainId, rpcUrl: entry.rpcUrl, entry };
}

/** `true` when the configured RPC answers `eth_chainId` with the expected id. */
export async function isStackReachable(): Promise<boolean> {
  let deployment: Deployment;
  try {
    deployment = readDeployment();
  } catch {
    return false;
  }
  try {
    const res = await fetch(deployment.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { result?: string };
    return Number.parseInt(json.result ?? '0', 16) === deployment.chainId;
  } catch {
    return false;
  }
}

/**
 * Guard: these tests only ever run against the registry's local overlay entry, on a chain the
 * registry marks `testnet`, over a localhost RPC. All three must hold — a mainnet chain id
 * overlaid onto localhost (e.g. an anvil fork of mainnet) is refused just like a remote RPC.
 */
export function assertLocalChain(
  deployment: Pick<Deployment, 'rpcUrl' | 'chainId'> & {
    readonly entry: Pick<RegistryChain, 'local' | 'testnet'>;
  },
): void {
  const isLocalHost = /^https?:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)[:/]/.test(
    deployment.rpcUrl,
  );
  const why = !isLocalHost
    ? 'not a localhost RPC'
    : deployment.entry.local !== true
      ? 'not the registry local entry'
      : deployment.entry.testnet !== true
        ? 'the registry does not mark this chain as a testnet'
        : null;
  if (why !== null) {
    throw new Error(
      `integration tests mutate chain state and refuse to run against ${deployment.rpcUrl} (chainId ${deployment.chainId}: ${why})`,
    );
  }
}

export interface Harness {
  readonly cfg: KeeperConfig;
  readonly clients: Clients;
  readonly logger: Logger;
  readonly records: Record<string, unknown>[];
  readonly store: StateStore;
  readonly deployment: Deployment;
}

/** Build a keeper wired to the local stack, with a throwaway state file. */
export function makeHarness(over: EnvRecord = {}): Harness {
  const deployment = readDeployment();
  assertLocalChain(deployment);

  const stateDir = mkdtempSync(join(tmpdir(), 'poolmigo-keeper-it-'));
  const cfg = parseConfig(
    {
      RPC_URL: deployment.rpcUrl,
      CHAIN_ID: String(deployment.chainId),
      VAULT_ADDRESS: deployment.vault,
      KEEPER_PRIVATE_KEY: ANVIL_KEY_1,
      STATE_FILE: join(stateDir, 'keeper-state.json'),
      LOG_LEVEL: 'debug',
      ...over,
    },
    { chain: deployment.entry },
  );
  const { logger, records } = createMemoryLogger('debug');
  return {
    cfg,
    clients: createClients(cfg),
    logger,
    records: records as Record<string, unknown>[],
    store: new StateStore(cfg.stateFile),
    deployment,
  };
}

/** A wallet client for an arbitrary local anvil account (used to seed mock fees). */
export function localWallet(
  deployment: Deployment,
  privateKey: `0x${string}`,
): WalletClient<Transport, Chain, Account> {
  const chain = defineKeeperChain(deployment.chainId, deployment.rpcUrl, deployment.entry.name);
  return createWalletClient({
    chain,
    transport: http(deployment.rpcUrl),
    account: privateKeyToAccount(privateKey),
  });
}

/** Pretty-print a log record array as the JSON lines the service would have written. */
export function renderLog(records: readonly Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}
