// @vitest-environment jsdom
/**
 * Render smoke test: the real app, the real providers (React Query + the viem wallet layer),
 * no mocks.
 *
 * It catches the class of breakage unit tests cannot — a bad hook order, a missing provider, an
 * import cycle — and it asserts the live/demo separation is actually on screen. Chain reads go out
 * over HTTP to the local node; when that node is not running the page must still render its
 * "cannot reach the vault" state rather than blow up, so this test passes either way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChainProviders } from '@/chain/Providers';
import { Layout } from '@/components/layout/Layout';
import { Markets } from '@/pages/Markets';
import { LiveVault } from '@/pages/LiveVault';

/**
 * Test-environment shim, not an app concern: viem attaches a Node `AbortSignal` for its request
 * timeout, and jsdom's `Request`/`fetch` reject a signal from another realm ("Expected signal to be
 * an instance of AbortSignal"). Strip it so RPC calls reach the local node. In a real browser both
 * come from the same realm and this never happens.
 */
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

function renderAt(path: string) {
  return render(
    <ChainProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Markets />} />
            <Route path="/live" element={<LiveVault />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ChainProviders>,
  );
}

afterEach(cleanup);

describe('app renders without a wallet', () => {
  it('markets page browses and labels the demo table', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Vaults' })).toBeDefined();
    // The prototype vaults are still there…
    expect(screen.getAllByText('TSLAx / USDC').length).toBeGreaterThan(0);
    // …and they are tagged as demo data.
    expect(screen.getAllByText('Demo data').length).toBeGreaterThan(0);
    // The live vault has its own entry point.
    expect(screen.getAllByText('Live on-chain').length).toBeGreaterThan(0);
  });

  it('live vault page renders and shows no invented numbers', async () => {
    renderAt('/live');
    expect(await screen.findByText(/in-kind basket vault/i)).toBeDefined();
    // Nothing on this page may claim an APR or a USD value — the chain cannot provide either.
    await waitFor(() => expect(screen.queryByText(/APR/)).toBeNull());
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });

  it('live vault page shows chain-read basket data, or says why it cannot', async () => {
    renderAt('/live');
    await waitFor(
      () => {
        // A basket token symbol can only come from the chain (nothing hardcodes "mUSDG").
        const reached = screen.queryAllByText(/^m[A-Z]/).length > 0;
        const failed = screen.queryByText(/Cannot reach the vault/i) !== null;
        expect(reached || failed).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    if (screen.queryByText(/Cannot reach the vault/i)) {
      console.warn('render.test: local chain unreachable — asserted the offline state instead');
    } else {
      // Real reads landed: the basket table, the adapter labels and the migoLP symbol are all live.
      expect(screen.getAllByText(/^m[A-Z]/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/uniswap-v/).length).toBeGreaterThan(0);
    }
  });
});
