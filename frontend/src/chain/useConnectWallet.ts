/**
 * One connect entry point for the whole app.
 *
 * "Connect" now means "open the wallet picker": the browser may have MetaMask, Rabby, Coinbase,
 * Brave, Phantom … announced over EIP-6963, plus WalletConnect for phones, and the visitor picks.
 * On a laptop with no extension at all the picker still offers the demo wallet, so every prototype
 * flow stays reachable — and the UI keeps saying which one you got.
 */
import { useEffect } from 'react';
import { useWallet } from '@/wallet/context';
import { useStore } from '@/store/useStore';

export function useConnectWallet() {
  const { status, openPicker, error } = useWallet();
  const demoConnect = useStore((s) => s.connect);
  const demoConnecting = useStore((s) => s.connecting);

  return {
    isPending: status === 'connecting' || demoConnecting,
    error,
    /** Opens the picker; the picker itself owns the demo fallback when nothing was found. */
    connectWallet: () => openPicker(),
    /** Explicitly start the demo wallet (used by the "No wallet? Use demo data" affordance). */
    connectDemo: () => void demoConnect(),
  };
}

/** Mirrors the connected account into the demo store. Mount once, inside the providers. */
export function useWalletBridge(): void {
  const { address, status } = useWallet();
  const setWallet = useStore((s) => s.setWallet);
  useEffect(() => {
    if (status === 'connecting') return;
    setWallet(status === 'connected' && address ? address : null);
  }, [address, status, setWallet]);
}

/** Disconnects both the real wallet and the demo wallet. */
export function useDisconnectWallet() {
  const { disconnect } = useWallet();
  const demoDisconnect = useStore((s) => s.disconnect);
  return () => {
    void disconnect();
    demoDisconnect();
  };
}
