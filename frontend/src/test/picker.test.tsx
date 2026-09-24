// @vitest-environment jsdom
/**
 * The wallet picker, mounted for real: a wallet announces itself over EIP-6963 and has to appear
 * in the modal, by its own name, behind the app's single "Connect wallet" entry point.
 *
 * No mocking of the wallet layer — the only fake here is the wallet itself, which is exactly what
 * a browser extension is from the page's point of view: an object that answers `eip6963:
 * requestProvider` and then `eth_requestAccounts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { ChainProviders } from '@/chain/Providers';
import { useConnectWallet } from '@/chain/useConnectWallet';

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * Test-environment shim, not an app concern: node 26 defines a global `localStorage` that is
 * `undefined` unless `--localstorage-file` is passed, and it shadows jsdom's. Every browser has
 * the real thing. (jsdom's `sessionStorage` is untouched and works — same interface.)
 */
if (!window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
  });
}

/** The smallest thing that behaves like an installed wallet. */
function fakeWallet(name: string, rdns: string) {
  const calls: string[] = [];
  const provider = {
    calls,
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return '0xb606'; // 46630
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({
          info: { uuid: `uuid-${rdns}`, name, rdns, icon: `data:image/svg+xml;base64,${rdns}` },
          provider,
        }),
      }),
    );
  // Wallets announce on request as well as once at start-up.
  window.addEventListener('eip6963:requestProvider', announce);
  return { provider, announce, stop: () => window.removeEventListener('eip6963:requestProvider', announce) };
}

function Harness() {
  const { connectWallet } = useConnectWallet();
  return (
    <button onClick={connectWallet} type="button">
      Connect wallet
    </button>
  );
}

/**
 * Created once, on purpose: EIP-6963 discovery keeps ONE store for the page (a wallet announces
 * itself once), so re-creating the fakes per test would leave the store holding the first pair.
 */
const wallets = [fakeWallet('MetaMask', 'io.metamask'), fakeWallet('Rabby Wallet', 'io.rabby')];

beforeEach(() => {
  window.localStorage.clear();
  wallets.forEach((w) => w.provider.calls.splice(0));
});

afterEach(cleanup);

async function openPicker() {
  render(
    <ChainProviders>
      <Harness />
    </ChainProviders>,
  );
  // Announce after mount too, the way an extension that boots late would.
  await act(async () => {
    wallets.forEach((w) => w.announce());
  });
  await act(async () => {
    screen.getByRole('button', { name: 'Connect wallet' }).click();
  });
}

describe('wallet picker', () => {
  it('lists every announced wallet, not just MetaMask', async () => {
    await openPicker();
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(screen.getByText('MetaMask')).toBeDefined();
    expect(screen.getByText('Rabby Wallet')).toBeDefined();
  });

  it('always keeps the demo wallet reachable', async () => {
    await openPicker();
    expect(screen.getByRole('button', { name: 'Use demo wallet' })).toBeDefined();
  });

  it('explains how to enable WalletConnect when no project id is configured', async () => {
    await openPicker();
    // The test env sets no VITE_WALLETCONNECT_PROJECT_ID, so the option must be hidden…
    expect(screen.queryByText('WalletConnect')).toBeNull();
    // …but not silently.
    expect(screen.getByText(/VITE_WALLETCONNECT_PROJECT_ID/)).toBeDefined();
  });

  it('connecting a picked wallet requests its accounts and closes the picker', async () => {
    await openPicker();
    await act(async () => {
      screen.getByText('Rabby Wallet').click();
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(wallets[1].provider.calls).toContain('eth_requestAccounts');
    expect(wallets[0].provider.calls).not.toContain('eth_requestAccounts');
    // The choice is remembered so the next reload can reconnect silently.
    expect(window.localStorage.getItem('poolmigo.wallet.last')).toBe('io.rabby');
  });
});
