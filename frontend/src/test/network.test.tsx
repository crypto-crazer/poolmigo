// @vitest-environment jsdom
/**
 * Chain switching, mounted for real: the header network selector, the "no deployment" state, and a
 * wallet parked on a chain without a deployment being walked through switch → add chain → switch.
 *
 * Same rule as the picker test: no mocking of the app's wallet layer. The only fake is the wallet —
 * an EIP-6963-announced EIP-1193 object that knows RHC mainnet but not the local Anvil chain, which
 * is exactly the state a fresh MetaMask is in. Chain reads go to the local node when it is up; every
 * assertion that needs the vault's data is conditional on that, as in render.test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { numberToHex } from 'viem';
import { ChainProviders } from '@/chain/Providers';
import { chainFor } from '@/chain/chains';
import { addEthereumChainParams } from '@/chain/switchChain';
import { Layout } from '@/components/layout/Layout';
import { LiveVault } from '@/pages/LiveVault';

/* Test-environment shims (see render.test / picker.test for why): cross-realm AbortSignal, and a
   node global `localStorage` that shadows jsdom's. Neither exists in a real browser. */
const JsdomRequest = globalThis.Request;
const jsdomFetch = globalThis.fetch;
const stripSignal = (init?: RequestInit) => (init ? { ...init, signal: undefined } : init);
class RequestWithoutSignal extends JsdomRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, stripSignal(init));
  }
}
globalThis.Request = RequestWithoutSignal as typeof Request;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => jsdomFetch(input, stripSignal(init))) as typeof fetch;
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

const LOCAL = 'Robinhood Chain (local demo stack)';
const ACCOUNT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

/** A wallet on RHC mainnet (4663) that has never heard of the local chain. */
const wallet = (() => {
  const known = new Set([4663]);
  let current = 4663;
  const calls: { method: string; params?: unknown }[] = [];
  const provider = {
    calls,
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push({ method, params });
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return numberToHex(current);
      if (method === 'wallet_switchEthereumChain') {
        const id = Number(BigInt((params as [{ chainId: string }])[0].chainId));
        if (!known.has(id)) throw Object.assign(new Error(`Unrecognized chain ID "${numberToHex(id)}".`), { code: 4902 });
        current = id;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        known.add(Number(BigInt((params as [{ chainId: string }])[0].chainId)));
        return null;
      }
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({
          info: { uuid: 'uuid-fake', name: 'Fake Wallet', rdns: 'test.fake', icon: 'data:image/svg+xml;base64,AA==' },
          provider,
        }),
      }),
    );
  window.addEventListener('eip6963:requestProvider', announce);
  return { provider, announce };
})();

function renderLive() {
  return render(
    <ChainProviders>
      <MemoryRouter initialEntries={['/live']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/live" element={<LiveVault />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ChainProviders>,
  );
}

/** Wait until the live page has either real vault data or its offline state; true = reachable. */
async function settled(): Promise<boolean> {
  await waitFor(
    () => {
      const reached = screen.queryAllByText(/^m[A-Z]/).length > 0;
      const failed = screen.queryByText(/Cannot reach the vault/i) !== null;
      expect(reached || failed).toBe(true);
    },
    { timeout: 15_000, interval: 100 },
  );
  return screen.queryByText(/Cannot reach the vault/i) === null;
}

afterEach(cleanup);

describe('network selector — no wallet', () => {
  it('lists every registry chain, marks the planned one, and switches what the page reads', async () => {
    renderLive();
    const selector = await screen.findByRole('button', { name: `Network: ${LOCAL}` });
    await act(async () => selector.click());

    const list = screen.getByRole('listbox', { name: 'Networks' });
    expect(within(list).getAllByRole('option')).toHaveLength(2);
    expect(within(list).getByText('chain id 4663 · no deployment')).toBeDefined();
    expect(within(list).getByText('chain id 46630 · testnet')).toBeDefined();

    // Pick the planned chain: no wallet, so this only changes what the page looks at.
    await act(async () => within(list).getByText('Robinhood Chain').click());
    expect(await screen.findByText(/No Poolmigo deployment on Robinhood Chain yet/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Network: Robinhood Chain' })).toBeDefined();
    expect(screen.queryByText('Local dev tools')).toBeNull();

    // …and the page offers the way back.
    await act(async () => screen.getByRole('button', { name: `Switch to ${LOCAL}` }).click());
    await waitFor(() => expect(screen.queryByText(/No Poolmigo deployment/)).toBeNull());
    expect(screen.getByRole('button', { name: `Network: ${LOCAL}` })).toBeDefined();
  });
});

describe('wrong network — wallet on a chain with no deployment', () => {
  it('shows the banner, then adds + switches to the deployment chain', async () => {
    renderLive();
    await act(async () => wallet.announce());
    await act(async () => screen.getAllByRole('button', { name: 'Connect wallet' })[0].click()); // header first
    await act(async () => screen.getByText('Fake Wallet').click());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Wallet on 4663 (planned) → target stays the local deployment, flagged wrong.
    expect(await screen.findByText(new RegExp(`Your wallet is on Robinhood Chain\\. Reads below come from ${LOCAL.replace(/[()]/g, '\\$&')}`))).toBeDefined();
    const reachable = await settled();
    expect(screen.queryByText('Local dev tools')).toBeNull();

    wallet.provider.calls.splice(0);
    await act(async () => screen.getAllByRole('button', { name: `Switch to ${LOCAL}` })[0].click());

    await waitFor(() => expect(screen.queryByText(/Your wallet is on/)).toBeNull());
    const walletCalls = wallet.provider.calls.filter((c) => c.method.startsWith('wallet_'));
    expect(walletCalls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
    expect(walletCalls[1].params).toEqual([addEthereumChainParams(chainFor(46630)!)]);

    // On the local chain now: the local-only conveniences come back (when the node is up).
    if (reachable) expect(await screen.findByText('Local dev tools')).toBeDefined();
    else console.warn('network.test: local chain unreachable — skipped the LocalDevPanel assertion');
  });
});
