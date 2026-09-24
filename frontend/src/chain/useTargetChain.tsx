/**
 * The target chain, in React: the selected chain lives here (one piece of state, app-wide), the
 * wallet's chain comes from the wallet layer, and `resolveTargetChain` decides between them.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useWallet } from '@/wallet/context';
import { DEFAULT_CHAIN_ID } from './chains';
import { resolveTargetChain, type TargetChain } from './targetChain';

interface SelectedChain {
  selectedChainId: number;
  setSelectedChainId: (chainId: number) => void;
}

const SelectedChainContext = createContext<SelectedChain | null>(null);

/** Mount inside WalletProvider. Starts on DEFAULT_CHAIN_ID (the local stack when there is one). */
export function TargetChainProvider({ children }: { children: ReactNode }) {
  const [selectedChainId, setSelectedChainId] = useState(DEFAULT_CHAIN_ID);
  const value = useMemo(() => ({ selectedChainId, setSelectedChainId }), [selectedChainId]);
  return <SelectedChainContext.Provider value={value}>{children}</SelectedChainContext.Provider>;
}

function useSelectedChain(): SelectedChain {
  const ctx = useContext(SelectedChainContext);
  if (!ctx) throw new Error('useTargetChain must be used inside <ChainProviders>.');
  return ctx;
}

/** `{ chain, deployment, hasDeployment, isWrongChain }` for the live pages. Safe without a wallet. */
export function useTargetChain(): TargetChain & { selectedChainId: number } {
  const { address, chainId } = useWallet();
  const { selectedChainId } = useSelectedChain();
  // A wallet that is still connecting has no account yet: treat it as "no wallet".
  const walletChainId = address ? chainId : undefined;
  return useMemo(
    () => ({ ...resolveTargetChain({ walletChainId, selectedChainId }), selectedChainId }),
    [walletChainId, selectedChainId],
  );
}

/**
 * The one "go to chain X" action for the selector and the wrong-network buttons: it records the
 * choice (so read-only visitors switch what they are looking at) and, with a wallet connected,
 * asks the wallet to switch — adding the chain first when the wallet does not know it.
 */
export function useSwitchToChain() {
  const { address, switchChain, switching, error } = useWallet();
  const { setSelectedChainId } = useSelectedChain();
  const switchTo = useCallback(
    async (chainId: number) => {
      setSelectedChainId(chainId);
      if (address) await switchChain(chainId);
    },
    [address, setSelectedChainId, switchChain],
  );
  return { switchTo, switching, error };
}
