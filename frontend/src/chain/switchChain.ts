/**
 * Move a connected wallet to a chain: `wallet_switchEthereumChain`, and when the wallet does not
 * know the chain (always the case for the local Anvil node), `wallet_addEthereumChain` with
 * parameters built from the registry, then switch again.
 *
 * The add-chain request is sent with OUR params (`addEthereumChainParams`) rather than through
 * viem's `addChain` action, so the exact object a wallet receives is the one the unit tests pin.
 * Pure apart from the client it is handed — no React, no wallet context.
 */
import { numberToHex, type Chain, type Client, type Transport } from 'viem';
import { switchChain } from 'viem/actions';

/** EIP-3085 `wallet_addEthereumChain` parameter object. */
export interface AddEthereumChainParameter {
  chainId: `0x${string}`;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

/** viem chain → the EIP-3085 object. `blockExplorerUrls` is omitted (not empty) when unknown. */
export function addEthereumChainParams(chain: Chain): AddEthereumChainParameter {
  const explorers = chain.blockExplorers ? Object.values(chain.blockExplorers).map((e) => e.url) : [];
  return {
    chainId: numberToHex(chain.id),
    chainName: chain.name,
    nativeCurrency: { ...chain.nativeCurrency },
    rpcUrls: [...chain.rpcUrls.default.http],
    ...(explorers.length ? { blockExplorerUrls: explorers } : {}),
  };
}

/**
 * Did the wallet say "I don't know that network"? EIP-3326 says 4902; MetaMask mobile nests it
 * inside a -32603, and viem wraps whatever it got — so walk the cause chain.
 */
export function isUnknownChain(err: unknown): boolean {
  const seen = new Set<unknown>();
  let node: unknown = err;
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    const e = node as { code?: unknown; message?: unknown; cause?: unknown; data?: { originalError?: unknown } };
    if (e.code === 4902) return true;
    if (typeof e.message === 'string' && /unrecognized chain|wallet_addEthereumChain/i.test(e.message)) return true;
    node = e.cause ?? e.data?.originalError;
  }
  return false;
}

export type SwitchOutcome = 'switched' | 'added';

/**
 * Switch `client`'s wallet to `chain`, adding the chain first if the wallet does not know it.
 * Anything other than "unknown chain" — a user rejection above all — is rethrown untouched.
 */
export async function switchWalletChain(client: Client<Transport, Chain | undefined>, chain: Chain): Promise<SwitchOutcome> {
  try {
    await switchChain(client, { id: chain.id });
    return 'switched';
  } catch (err) {
    if (!isUnknownChain(err)) throw err;
  }
  await client.request(
    { method: 'wallet_addEthereumChain', params: [addEthereumChainParams(chain)] },
    { retryCount: 0 },
  );
  // Most wallets switch as part of the add; asking again is harmless and covers the ones that do not.
  await switchChain(client, { id: chain.id });
  return 'added';
}
