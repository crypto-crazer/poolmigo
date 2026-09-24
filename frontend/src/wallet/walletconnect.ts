/**
 * WalletConnect — the QR / mobile / desktop-app half of "all wallets".
 *
 * `@walletconnect/ethereum-provider` is a standalone EIP-1193 provider, so it plugs into the same
 * `createWalletClient({ transport: custom(provider) })` path as an injected wallet: no wagmi, no
 * connector abstraction.
 *
 * Two rules this file exists to enforce:
 *  1. The project id is ALWAYS user-supplied (`VITE_WALLETCONNECT_PROJECT_ID`). Nothing is
 *     hardcoded; with no id the option is simply hidden.
 *  2. The module is only ever `import()`ed — it drags in a relay client and a QR modal, and it must
 *     not cost anything to a visitor who connects with a browser extension.
 */
import type { EIP1193Provider } from 'viem';
import { DEFAULT_CHAIN_ID, SUPPORTED_CHAINS } from '@/chain/chains';

/** Empty string when unset — the picker hides WalletConnect rather than failing at click time. */
export const WALLETCONNECT_PROJECT_ID: string = (
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? ''
).trim();

export const walletConnectEnabled = WALLETCONNECT_PROJECT_ID.length > 0;

let pending: Promise<EIP1193Provider> | undefined;

/**
 * Initialise (once) and return the WalletConnect provider. `init` also restores an existing
 * session from local storage, which is how WalletConnect reconnects across a reload.
 */
export function loadWalletConnect(): Promise<EIP1193Provider> {
  if (!walletConnectEnabled) {
    return Promise.reject(
      new Error('WalletConnect is not configured: set VITE_WALLETCONNECT_PROJECT_ID in .env.local.'),
    );
  }
  pending ??= (async () => {
    const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    const provider = await EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      // The default chain is required; every other registry chain is optional, so a wallet that
      // cannot add the local node can still connect and be told to switch.
      chains: [DEFAULT_CHAIN_ID],
      optionalChains: SUPPORTED_CHAINS.map((c) => c.id).filter((id) => id !== DEFAULT_CHAIN_ID),
      rpcMap: Object.fromEntries(SUPPORTED_CHAINS.map((c) => [c.id, c.rpcUrls.default.http[0]])),
      showQrModal: true,
      metadata: {
        name: 'Poolmigo',
        description: 'In-kind, multi-pool LP auto-rebalance vault',
        url: origin,
        icons: [`${origin}/favicon.svg`],
      },
    });
    return provider as unknown as EIP1193Provider;
  })();
  return pending;
}

/** True when a WalletConnect session already exists (used for the silent reconnect on reload). */
export function walletConnectAccounts(provider: EIP1193Provider): readonly string[] {
  return (provider as unknown as { accounts?: readonly string[] }).accounts ?? [];
}

/** WalletConnect needs an explicit teardown; an injected provider does not. */
export async function closeWalletConnect(provider: EIP1193Provider): Promise<void> {
  const closable = provider as unknown as { disconnect?: () => Promise<void> };
  if (typeof closable.disconnect === 'function') await closable.disconnect();
  pending = undefined;
}
