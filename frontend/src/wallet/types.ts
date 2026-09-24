/**
 * Wallet layer types.
 *
 * A `WalletOption` is one entry in the picker. It is deliberately provider-free: the pure
 * option-building logic (src/wallet/options.ts) is testable in node, while the provider objects
 * live in the discovery/connection modules that need a browser.
 */

/** 'injected' = an in-page EIP-1193 provider (EIP-6963 or legacy). 'walletconnect' = QR / mobile. */
export type WalletKind = 'injected' | 'walletconnect';

export interface WalletOption {
  /** Stable id used for reconnect persistence: the EIP-6963 rdns, or one of the ids below. */
  id: string;
  kind: WalletKind;
  name: string;
  /** `data:image/…` URI straight from EIP-6963 `info.icon`. Absent for the two synthetic entries. */
  icon?: string;
}

/** Synthetic id for a `window.ethereum` that never announced itself over EIP-6963. */
export const LEGACY_INJECTED_ID = 'injected.legacy';
/** Synthetic id for the WalletConnect entry. */
export const WALLETCONNECT_ID = 'walletconnect';

/** The shape mipd hands us, narrowed to what this app reads. */
export interface DiscoveredProvider {
  info: { uuid: string; name: string; rdns: string; icon: string };
  provider: unknown;
}

export type WalletStatus = 'disconnected' | 'connecting' | 'connected';
