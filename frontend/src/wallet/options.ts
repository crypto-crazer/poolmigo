/**
 * Turning what the browser announced into the list the picker renders.
 *
 * Pure functions, no `window`, no providers — this is the part of the wallet layer that is worth
 * unit-testing, and the part that decides what a returning visitor silently reconnects to.
 */
import {
  LEGACY_INJECTED_ID,
  WALLETCONNECT_ID,
  type DiscoveredProvider,
  type WalletOption,
} from './types';

export interface BuildOptionsArgs {
  /** EIP-6963 announcements, in arrival order. */
  detected: readonly DiscoveredProvider[];
  /** A legacy `window.ethereum` exists (only used when nothing announced itself). */
  hasLegacyInjected: boolean;
  /** VITE_WALLETCONNECT_PROJECT_ID is set — without it the option is hidden, never faked. */
  walletConnectEnabled: boolean;
}

/**
 * Injected wallets first (alphabetically, so the list does not reshuffle between announcements),
 * WalletConnect last. The legacy `window.ethereum` entry only appears when EIP-6963 found nothing:
 * every modern wallet announces itself, and offering both would list the same wallet twice.
 */
export function buildWalletOptions({
  detected,
  hasLegacyInjected,
  walletConnectEnabled,
}: BuildOptionsArgs): WalletOption[] {
  const seen = new Set<string>();
  const injected: WalletOption[] = [];
  for (const d of detected) {
    const rdns = d.info?.rdns;
    if (!rdns || seen.has(rdns)) continue;
    seen.add(rdns);
    injected.push({ id: rdns, kind: 'injected', name: d.info.name, icon: d.info.icon });
  }
  injected.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  if (injected.length === 0 && hasLegacyInjected) {
    injected.push({ id: LEGACY_INJECTED_ID, kind: 'injected', name: 'Browser wallet' });
  }

  return walletConnectEnabled
    ? [...injected, { id: WALLETCONNECT_ID, kind: 'walletconnect', name: 'WalletConnect' }]
    : injected;
}

/**
 * The option to silently reconnect to on reload, or undefined when there is nothing to resume.
 * WalletConnect resumes from its own session store, so it does not need to be in `options` yet —
 * but it does need the project id, which `options` already encodes.
 */
export function resolveReconnect(
  options: readonly WalletOption[],
  lastId: string | null | undefined,
): WalletOption | undefined {
  if (!lastId) return undefined;
  return options.find((o) => o.id === lastId);
}

/** Find the announced provider behind an option id. */
export function findDiscovered(
  detected: readonly DiscoveredProvider[],
  id: string,
): DiscoveredProvider | undefined {
  return detected.find((d) => d.info?.rdns === id);
}
