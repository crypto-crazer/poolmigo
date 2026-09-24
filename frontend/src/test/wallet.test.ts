/**
 * The wallet picker's decision logic: which wallets are offered, in what order, and which one a
 * returning visitor silently reconnects to. Pure functions on purpose — the providers themselves
 * are browser objects, but *what we do with the announcements* is where the bugs would live.
 */
import { describe, expect, it } from 'vitest';
import { buildWalletOptions, findDiscovered, resolveReconnect } from '@/wallet/options';
import { LEGACY_INJECTED_ID, WALLETCONNECT_ID, type DiscoveredProvider } from '@/wallet/types';

const detail = (rdns: string, name: string): DiscoveredProvider => ({
  info: { uuid: `uuid-${rdns}`, rdns, name, icon: `data:image/svg+xml;base64,${rdns}` },
  provider: { rdns },
});

const metamask = detail('io.metamask', 'MetaMask');
const rabby = detail('io.rabby', 'Rabby Wallet');
const coinbase = detail('com.coinbase.wallet', 'Coinbase Wallet');

describe('buildWalletOptions — EIP-6963 discovery', () => {
  it('offers every announced wallet, with its own name and icon', () => {
    const options = buildWalletOptions({
      detected: [metamask, rabby, coinbase],
      hasLegacyInjected: true,
      walletConnectEnabled: false,
    });
    expect(options.map((o) => o.id)).toEqual(['com.coinbase.wallet', 'io.metamask', 'io.rabby']);
    expect(options.every((o) => o.kind === 'injected')).toBe(true);
    expect(options[1].name).toBe('MetaMask');
    expect(options[1].icon).toBe('data:image/svg+xml;base64,io.metamask');
  });

  it('sorts by name so a late announcement does not reshuffle the list', () => {
    const a = buildWalletOptions({ detected: [rabby, metamask], hasLegacyInjected: false, walletConnectEnabled: false });
    const b = buildWalletOptions({ detected: [metamask, rabby], hasLegacyInjected: false, walletConnectEnabled: false });
    expect(a.map((o) => o.name)).toEqual(b.map((o) => o.name));
    expect(a.map((o) => o.name)).toEqual(['MetaMask', 'Rabby Wallet']);
  });

  it('de-duplicates a wallet that announces twice', () => {
    const options = buildWalletOptions({
      detected: [metamask, detail('io.metamask', 'MetaMask (again)')],
      hasLegacyInjected: false,
      walletConnectEnabled: false,
    });
    expect(options).toHaveLength(1);
    expect(options[0].name).toBe('MetaMask');
  });

  it('ignores an announcement with no rdns', () => {
    const broken = { info: { uuid: 'x', name: 'Nameless', icon: '', rdns: '' }, provider: {} } as DiscoveredProvider;
    expect(buildWalletOptions({ detected: [broken], hasLegacyInjected: false, walletConnectEnabled: false })).toEqual([]);
  });
});

describe('buildWalletOptions — legacy window.ethereum fallback', () => {
  it('offers "Browser wallet" when nothing announced but window.ethereum exists', () => {
    const options = buildWalletOptions({ detected: [], hasLegacyInjected: true, walletConnectEnabled: false });
    expect(options).toEqual([{ id: LEGACY_INJECTED_ID, kind: 'injected', name: 'Browser wallet' }]);
  });

  it('does NOT add it alongside announced wallets — that would list the same wallet twice', () => {
    const options = buildWalletOptions({ detected: [metamask], hasLegacyInjected: true, walletConnectEnabled: false });
    expect(options.map((o) => o.id)).toEqual(['io.metamask']);
  });

  it('offers nothing at all in a browser with no wallet', () => {
    expect(buildWalletOptions({ detected: [], hasLegacyInjected: false, walletConnectEnabled: false })).toEqual([]);
  });
});

describe('buildWalletOptions — WalletConnect', () => {
  it('is hidden without a project id (never faked, never hardcoded)', () => {
    const options = buildWalletOptions({ detected: [metamask], hasLegacyInjected: false, walletConnectEnabled: false });
    expect(options.some((o) => o.kind === 'walletconnect')).toBe(false);
  });

  it('is appended last when a project id is configured', () => {
    const options = buildWalletOptions({ detected: [metamask], hasLegacyInjected: false, walletConnectEnabled: true });
    expect(options.map((o) => o.id)).toEqual(['io.metamask', WALLETCONNECT_ID]);
    expect(options[1].kind).toBe('walletconnect');
  });

  it('is the only option in a browser with no extension at all', () => {
    const options = buildWalletOptions({ detected: [], hasLegacyInjected: false, walletConnectEnabled: true });
    expect(options.map((o) => o.id)).toEqual([WALLETCONNECT_ID]);
  });
});

describe('resolveReconnect', () => {
  const options = buildWalletOptions({
    detected: [metamask, rabby],
    hasLegacyInjected: false,
    walletConnectEnabled: true,
  });

  it('resumes the wallet used last time', () => {
    expect(resolveReconnect(options, 'io.rabby')?.name).toBe('Rabby Wallet');
    expect(resolveReconnect(options, WALLETCONNECT_ID)?.kind).toBe('walletconnect');
  });

  it('resumes nothing on a first visit', () => {
    expect(resolveReconnect(options, null)).toBeUndefined();
    expect(resolveReconnect(options, '')).toBeUndefined();
  });

  it('resumes nothing when that wallet is no longer installed', () => {
    expect(resolveReconnect(options, 'app.phantom')).toBeUndefined();
  });
});

describe('findDiscovered', () => {
  it('maps an option id back to the announced provider', () => {
    expect(findDiscovered([metamask, rabby], 'io.rabby')).toBe(rabby);
    expect(findDiscovered([metamask, rabby], LEGACY_INJECTED_ID)).toBeUndefined();
  });
});
