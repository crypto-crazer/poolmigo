/**
 * Chain definitions, built from the registry (shared/deployments.json → src/config/generated.ts).
 * Nothing here names a chain: adding one is a registry entry + `pnpm sync:shared`.
 *
 * Two lists, two meanings:
 *  - `CHAINS` / `SUPPORTED_CHAINS` — every chain the app knows and will offer to switch to;
 *  - `DEPLOYMENTS` — the subset Poolmigo is actually deployed on, with addresses.
 *
 * Imports are relative (not `@/`) on purpose: `scripts/e2e-local.ts` runs this module under tsx,
 * which does not see the Vite alias.
 */
import { defineChain, type Chain } from 'viem';
import { CHAINS, DEPLOYMENTS, type ChainDeployment, type ChainEntry, type ChainMeta } from '../config/generated';

export type { ChainDeployment, ChainEntry, ChainMeta };

const nativeCurrency = { name: 'Ether', symbol: 'ETH', decimals: 18 } as const;

/** Registry metadata → a viem chain (ETH-native: every target is an EVM L1/L2 paying gas in ETH). */
export function toViemChain(meta: ChainMeta): Chain {
  return defineChain({
    id: meta.chainId,
    name: meta.name,
    nativeCurrency,
    rpcUrls: { default: { http: [meta.rpcUrl] } },
    ...(meta.explorerUrl ? { blockExplorers: { default: { name: 'Explorer', url: meta.explorerUrl } } } : {}),
    testnet: meta.testnet,
  });
}

/** Every registry chain as a viem chain, ascending chain id. */
export const SUPPORTED_CHAINS: readonly Chain[] = CHAINS.map(toViemChain);

/** The viem chain for an id, or undefined when the wallet is on something the registry lacks. */
export function chainFor(chainId: number | undefined): Chain | undefined {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId);
}

/** The registry entry (status, local flag) for an id. */
export function chainEntry(chainId: number | undefined): ChainEntry | undefined {
  return CHAINS.find((c) => c.chainId === chainId);
}

/** Addresses for a chain Poolmigo is deployed on; undefined for planned or unknown chains. */
export function deploymentForChain(chainId: number | undefined): ChainDeployment | undefined {
  return DEPLOYMENTS.find((d) => d.chainId === chainId);
}

export function hasDeployment(chainId: number | undefined): boolean {
  return deploymentForChain(chainId) !== undefined;
}

/**
 * Local-only conveniences (mint mock tokens, the RPC strip) are gated on this: true only for the
 * demo stack overlaid from shared/deployment.local.json, where `MockToken.mint` is public.
 */
export function isLocalChain(chainId: number | undefined): boolean {
  return deploymentForChain(chainId)?.local === true;
}

export function chainLabel(chainId: number | undefined): string {
  const entry = chainEntry(chainId);
  if (entry) return entry.name;
  return chainId === undefined ? 'Unknown network' : `Chain ${chainId}`;
}

/** "Robinhood Chain (local demo stack)" → "Robinhood Chain": for tight spots that tag `local` separately. */
export function chainShortLabel(chainId: number | undefined): string {
  return chainLabel(chainId).replace(/\s*\([^)]*\)\s*$/, '');
}

/**
 * Default-chain preference, as a pure function of the registry so it is testable with any shape:
 *  - deployment chain: the `local` entry, else the first deployed chain, else none;
 *  - app chain: the deployment chain, else the first registry chain (read-only "no deployment").
 */
export function defaultChainIds(chains: readonly ChainEntry[]): { chainId: number; deploymentChainId: number | undefined } {
  const deployed = chains.filter((c) => c.status === 'deployed');
  const deploymentChainId = (deployed.find((c) => c.local) ?? deployed[0])?.chainId;
  const chainId = deploymentChainId ?? chains[0]?.chainId;
  if (chainId === undefined) throw new Error('chain registry is empty — run pnpm sync:shared');
  return { chainId, deploymentChainId };
}

const defaults = defaultChainIds(CHAINS);

/** The chain the app shows before any wallet or selection says otherwise. */
export const DEFAULT_CHAIN_ID: number = defaults.chainId;

/** The default chain that HAS a deployment (undefined only if the registry has none at all). */
export const DEFAULT_DEPLOYMENT_CHAIN_ID: number | undefined = defaults.deploymentChainId;
