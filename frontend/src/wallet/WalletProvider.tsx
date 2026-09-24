/**
 * The whole wallet layer, in one provider: discovery → pick → connect → account/chain → writes.
 *
 * viem only. An injected wallet and a WalletConnect session are the same thing here — an EIP-1193
 * provider — and both become a viem wallet client through `custom(provider)`. There is no connector
 * registry, no second React state tree, and no wagmi.
 *
 * Reads never come through here: `src/chain/client.ts` talks to the target chain over HTTP so the
 * vault renders with no wallet at all. Only writes need a connection, and each write names the
 * chain it must land on (the target chain's deployment) — the wallet must already be there.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createClient,
  custom,
  getAddress,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Client,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type EIP1193Provider,
  type Hash,
  type Transport,
} from 'viem';
// Standalone actions, not `createWalletClient`: the decorator would pull every wallet action
// (and its transitive viem surface) into the bundle. Switching lives in src/chain/switchChain.ts.
import { writeContract } from 'viem/actions';
import {
  WalletContext,
  type WalletContextValue,
  type WriteRequest,
} from './context';
import { chainFor, chainLabel } from '@/chain/chains';
import { switchWalletChain } from '@/chain/switchChain';
import {
  getDiscovered,
  getLegacyInjected,
  hasLegacyInjected,
  subscribeDiscovered,
} from './discovery';
import { buildWalletOptions, findDiscovered, resolveReconnect } from './options';
import {
  LEGACY_INJECTED_ID,
  WALLETCONNECT_ID,
  type DiscoveredProvider,
  type WalletOption,
  type WalletStatus,
} from './types';
import {
  closeWalletConnect,
  loadWalletConnect,
  walletConnectAccounts,
  walletConnectEnabled,
} from './walletconnect';
import { WalletPicker } from './WalletPicker';

/** Which wallet to resume on reload. Only the id — no address, no key, nothing sensitive. */
const LAST_WALLET_KEY = 'poolmigo.wallet.last';

type Mutable = 'nonpayable' | 'payable';

interface Connection {
  option: WalletOption;
  provider: EIP1193Provider;
  address: Address;
  chainId: number;
}

/** `window.localStorage` specifically: a bare `localStorage` is not the browser's one under node. */
function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined; // private mode / blocked storage
  }
}

function readLastWallet(): string | null {
  try {
    return storage()?.getItem(LAST_WALLET_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeLastWallet(id: string | null): void {
  try {
    const store = storage();
    if (!store) return;
    if (id) store.setItem(LAST_WALLET_KEY, id);
    else store.removeItem(LAST_WALLET_KEY);
  } catch {
    /* private mode — reconnect simply will not happen */
  }
}

async function requestChainId(provider: EIP1193Provider): Promise<number> {
  const hex = (await provider.request({ method: 'eth_chainId' })) as string;
  return Number(BigInt(hex));
}

function toError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : fallback);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [detected, setDetected] = useState<readonly DiscoveredProvider[]>(() => getDiscovered());
  const [legacy, setLegacy] = useState(() => hasLegacyInjected());
  const [conn, setConn] = useState<Connection | null>(null);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  const reconnected = useRef(false);

  // EIP-6963: wallets announce on request and may announce late, so we stay subscribed.
  useEffect(() => {
    setLegacy(hasLegacyInjected());
    return subscribeDiscovered((providers) => {
      setDetected(providers);
      setLegacy(hasLegacyInjected());
    });
  }, []);

  const options = useMemo(
    () => buildWalletOptions({ detected, hasLegacyInjected: legacy, walletConnectEnabled }),
    [detected, legacy],
  );

  const providerFor = useCallback(
    async (option: WalletOption): Promise<EIP1193Provider> => {
      if (option.kind === 'walletconnect') return loadWalletConnect();
      // Only the synthetic legacy entry may fall back to `window.ethereum`. An announced wallet
      // that has since disappeared must fail, not silently connect whichever extension owns
      // `window.ethereum` — picking Rabby and getting MetaMask is worse than an error.
      const provider = (
        option.id === LEGACY_INJECTED_ID
          ? getLegacyInjected()
          : findDiscovered(detected, option.id)?.provider
      ) as EIP1193Provider | undefined;
      if (!provider) throw new Error(`${option.name} is no longer available in this browser.`);
      return provider;
    },
    [detected],
  );

  const adopt = useCallback((option: WalletOption, provider: EIP1193Provider, accounts: readonly string[], chainId: number) => {
    setConn({ option, provider, address: getAddress(accounts[0]), chainId });
    setStatus('connected');
    writeLastWallet(option.id);
  }, []);

  const connect = useCallback(
    async (option: WalletOption) => {
      setError(null);
      setStatus('connecting');
      setPendingId(option.id);
      try {
        const provider = await providerFor(option);
        // One path for both kinds: WalletConnect's provider answers eth_requestAccounts by opening
        // its QR modal and waiting for the pairing.
        const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
        if (!accounts?.length) throw new Error(`${option.name} returned no account.`);
        adopt(option, provider, accounts, await requestChainId(provider));
        setPickerOpen(false);
      } catch (err) {
        setStatus('disconnected');
        setError(toError(err, `Could not connect ${option.name}.`));
      } finally {
        setPendingId(undefined);
      }
    },
    [adopt, providerFor],
  );

  // Silent reconnect on reload: an injected wallet that still has us authorised answers
  // eth_accounts without a prompt; WalletConnect restores its own session during init().
  useEffect(() => {
    if (reconnected.current || status !== 'disconnected') return;
    const lastId = readLastWallet();
    if (!lastId) return;
    if (lastId !== WALLETCONNECT_ID && !resolveReconnect(options, lastId)) return; // not announced (yet)
    reconnected.current = true;
    let cancelled = false;
    void (async () => {
      try {
        if (lastId === WALLETCONNECT_ID) {
          if (!walletConnectEnabled) return;
          const provider = await loadWalletConnect();
          const accounts = walletConnectAccounts(provider);
          if (cancelled || accounts.length === 0) return;
          adopt(
            { id: WALLETCONNECT_ID, kind: 'walletconnect', name: 'WalletConnect' },
            provider,
            accounts,
            await requestChainId(provider),
          );
          return;
        }
        const option = resolveReconnect(options, lastId);
        if (!option) return;
        const provider = await providerFor(option);
        const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
        if (cancelled || !accounts?.length) return;
        adopt(option, provider, accounts, await requestChainId(provider));
      } catch {
        // A refused silent reconnect is not an error the visitor asked to see.
        writeLastWallet(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt, options, providerFor, status]);

  const forget = useCallback(() => {
    setConn(null);
    setStatus('disconnected');
    writeLastWallet(null);
  }, []);

  // Account / chain / session changes, straight from the provider.
  useEffect(() => {
    const provider = conn?.provider;
    if (!provider?.on) return;
    const onAccounts = (accounts: string[]) => {
      if (!accounts?.length) forget();
      else setConn((c) => (c ? { ...c, address: getAddress(accounts[0]) } : c));
    };
    const onChain = (hex: string) => setConn((c) => (c ? { ...c, chainId: Number(BigInt(hex)) } : c));
    const onDisconnect = () => forget();
    provider.on('accountsChanged', onAccounts);
    provider.on('chainChanged', onChain);
    provider.on('disconnect', onDisconnect);
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
      provider.removeListener?.('disconnect', onDisconnect);
    };
  }, [conn?.provider, forget]);

  const walletClient: Client<Transport, Chain | undefined, Account> | undefined = useMemo(() => {
    if (!conn) return undefined;
    return createClient({
      account: conn.address,
      chain: chainFor(conn.chainId),
      transport: custom(conn.provider),
    });
  }, [conn]);

  const disconnect = useCallback(async () => {
    const provider = conn?.provider;
    const isWc = conn?.option.kind === 'walletconnect';
    forget();
    if (isWc && provider) {
      try {
        await closeWalletConnect(provider);
      } catch {
        /* the session is gone from our side either way */
      }
    }
  }, [conn, forget]);

  const switchChain = useCallback(
    async (chainId: number) => {
      if (!walletClient) return;
      const target = chainFor(chainId);
      if (!target) throw new Error(`Unknown network ${chainId}.`);
      setError(null);
      setSwitching(true);
      try {
        // The local node is not in anyone's wallet by default — the helper adds it, then retries.
        await switchWalletChain(walletClient, target);
        // Wallets that do not emit `chainChanged` would otherwise leave the banner up.
        setConn((c) => (c ? { ...c, chainId } : c));
      } catch (err) {
        setError(toError(err, `Could not switch to ${chainLabel(chainId)}.`));
        throw err;
      } finally {
        setSwitching(false);
      }
    },
    [walletClient],
  );

  const write = useCallback(
    async <
      const abi extends Abi | readonly unknown[],
      fn extends ContractFunctionName<abi, Mutable>,
      args extends ContractFunctionArgs<abi, Mutable, fn>,
    >(
      request: WriteRequest<abi, fn, args>,
    ): Promise<Hash> => {
      if (!walletClient || !conn) throw new Error('Connect a wallet first.');
      const { chainId, ...call } = request;
      const chain = chainFor(chainId);
      if (!chain) throw new Error(`Chain ${chainId} is not in the registry.`);
      if (conn.chainId !== chainId) {
        throw new Error(
          `Your wallet is on ${chainLabel(conn.chainId)}. Switch to ${chainLabel(chainId)} to send this transaction.`,
        );
      }
      // `chain` is passed explicitly so viem re-asserts the wallet's chain at send time — the
      // guard above can go stale between a click and a signature.
      return writeContract(walletClient, {
        ...call,
        account: conn.address,
        chain,
      } as never);
    },
    [conn, walletClient],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      address: conn?.address,
      chainId: conn?.chainId,
      walletName: conn?.option.name,
      options,
      pendingId,
      error,
      pickerOpen,
      openPicker: () => {
        setError(null);
        setPickerOpen(true);
      },
      closePicker: () => setPickerOpen(false),
      connect,
      disconnect,
      switchChain,
      switching,
      write,
    }),
    [conn, connect, disconnect, error, options, pendingId, pickerOpen, status, switchChain, switching, write],
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      <WalletPicker />
    </WalletContext.Provider>
  );
}

