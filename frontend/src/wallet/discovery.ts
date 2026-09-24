/**
 * EIP-6963 multi-wallet discovery.
 *
 * `mipd` (by the viem authors) dispatches `eip6963:requestProvider` and collects every
 * `eip6963:announceProvider` reply, so MetaMask, Rabby, Coinbase, Brave, Phantom … all show up
 * individually instead of fighting over a single `window.ethereum`. Wallets that announce late
 * (extension still booting) arrive through the same subscription.
 *
 * The store is created lazily: importing this module must stay safe in a node test environment.
 */
import { createStore, type Store } from 'mipd';
import type { DiscoveredProvider } from './types';

let store: Store | undefined;

function getStore(): Store | undefined {
  if (typeof window === 'undefined') return undefined;
  store ??= createStore();
  return store;
}

export function getDiscovered(): readonly DiscoveredProvider[] {
  return (getStore()?.getProviders() ?? []) as readonly DiscoveredProvider[];
}

/** Subscribe to the announcement list. Returns an unsubscribe function. */
export function subscribeDiscovered(
  listener: (providers: readonly DiscoveredProvider[]) => void,
): () => void {
  const s = getStore();
  if (!s) return () => {};
  return s.subscribe((providers) => listener(providers as readonly DiscoveredProvider[]), {
    emitImmediately: true,
  });
}

/** A pre-EIP-6963 wallet: an in-page provider that never announced itself. */
export function hasLegacyInjected(): boolean {
  return (
    typeof window !== 'undefined' &&
    'ethereum' in window &&
    (window as { ethereum?: unknown }).ethereum !== undefined
  );
}

export function getLegacyInjected(): unknown {
  return typeof window === 'undefined' ? undefined : (window as { ethereum?: unknown }).ethereum;
}
