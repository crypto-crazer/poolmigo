/**
 * Which chain the live pages read from and write to — as a pure function, so the rule is testable
 * without a wallet or React:
 *
 *   wallet connected AND on a chain Poolmigo is deployed on  → that chain;
 *   otherwise                                                 → the app's selected chain
 *                                                               (header selector; default chain).
 *
 * So a visitor with no wallet still gets the default deployment, a wallet on a deployed chain is
 * followed automatically, and a wallet parked on a chain without a deployment is told to switch.
 */
import type { Chain } from 'viem';
import { DEFAULT_CHAIN_ID, chainEntry, chainFor, deploymentForChain, type ChainDeployment } from './chains';

export interface TargetChain {
  /** Always a registry chain. */
  chain: Chain;
  deployment: ChainDeployment | undefined;
  hasDeployment: boolean;
  /** A wallet is connected and it is NOT on `chain` — writes are blocked until it switches. */
  isWrongChain: boolean;
}

export function resolveTargetChain({
  walletChainId,
  selectedChainId,
}: {
  /** The wallet's chain; undefined when no wallet is connected. */
  walletChainId: number | undefined;
  selectedChainId: number | undefined;
}): TargetChain {
  const id =
    walletChainId !== undefined && deploymentForChain(walletChainId)
      ? walletChainId
      : chainEntry(selectedChainId)
        ? (selectedChainId as number)
        : DEFAULT_CHAIN_ID;
  const chain = chainFor(id);
  if (!chain) throw new Error(`default chain ${id} is not in the registry — run pnpm sync:shared`);
  const deployment = deploymentForChain(id);
  return {
    chain,
    deployment,
    hasDeployment: deployment !== undefined,
    isWrongChain: walletChainId !== undefined && walletChainId !== id,
  };
}
