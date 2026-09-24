import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WalletProvider } from '@/wallet/WalletProvider';
import { TargetChainProvider } from './useTargetChain';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Contract reads are cheap and the local chain moves only when we move it.
      staleTime: 2_000,
      retry: 1,
    },
  },
});

/**
 * Three providers, no wallet framework: React Query caches/polls the viem reads, WalletProvider owns
 * discovery + the connection, TargetChainProvider holds the selected chain (the wallet's chain wins
 * when it has a deployment). All app-wide because the header, the markets teaser and the live page
 * all read the same vault and share the same connection.
 */
export function ChainProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <TargetChainProvider>{children}</TargetChainProvider>
      </WalletProvider>
    </QueryClientProvider>
  );
}
