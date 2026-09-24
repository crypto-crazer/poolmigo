/**
 * The chain registry (src/registry.ts): parse + validate `deployments.json`, merge the
 * `deployment.local.json` overlay, and select the chain the keeper acts on. All in-memory — the
 * module is pure; the real shared/ files are exercised in config.registry.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  ADDRESS_KEYS,
  RegistryError,
  buildRegistry,
  findDuplicateKey,
  selectChain,
  type RegistryChain,
} from '../../src/registry.js';

const A = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const ADDRS = Object.fromEntries(ADDRESS_KEYS.map((k, i) => [k, A(i + 1)])) as Record<
  (typeof ADDRESS_KEYS)[number],
  string
>;
const LOCAL_ADDRS = Object.fromEntries(ADDRESS_KEYS.map((k, i) => [k, A(0x100 + i)]));

const MAINNET = {
  name: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  testnet: false,
  status: 'planned',
};
const LOCAL = {
  name: 'Robinhood Chain (local demo stack)',
  rpcUrl: 'http://127.0.0.1:8547',
  testnet: true,
  status: 'deployed',
};

const registry = (chains: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, chains, ...extra });
const overlay = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ chainId: 46630, rpcUrl: 'http://127.0.0.1:9999', ...LOCAL_ADDRS, ...over });

/** The repo's current shape: mainnet planned, local deployed via the overlay. */
const repoLike = (): RegistryChain[] =>
  buildRegistry({ registryText: registry({ 4663: MAINNET, 46630: LOCAL }), localText: overlay() });

describe('buildRegistry — parse + validate', () => {
  it('accepts a valid registry and sorts by chain id', () => {
    const chains = buildRegistry({
      registryText: registry({
        46630: { ...LOCAL, addresses: ADDRS },
        4663: { ...MAINNET, explorerUrl: 'https://explorer.example' },
      }),
    });
    expect(chains.map((c) => c.chainId)).toEqual([4663, 46630]);
    expect(chains[0]).toEqual({
      chainId: 4663,
      name: 'Robinhood Chain',
      rpcUrl: MAINNET.rpcUrl,
      testnet: false,
      status: 'planned',
      explorerUrl: 'https://explorer.example',
    });
    expect(chains[1]?.addresses?.vault).toBe(ADDRS.vault);
    expect(chains[1]?.local).toBeUndefined();
  });

  it.each([
    ['invalid JSON', '{ "version": 1, ', /deployments\.json: invalid JSON/],
    ['a non-object root', '[]', /deployments\.json: \(root\) must be an object/],
    ['version != 1', registry({ 4663: MAINNET }, { version: 2 }), /deployments\.json: version must be 1 \(got 2\)/],
    ['missing chains', JSON.stringify({ version: 1 }), /deployments\.json: chains must be an object keyed by chain id/],
    ['an empty chains map', registry({}), /deployments\.json: chains must list at least one chain/],
    ['a duplicated key', '{"version":1,"chains":{"4663":{},"4663":{}}}', /deployments\.json: chains\.4663 is defined twice/],
  ])('rejects %s', (_label, text, message) => {
    expect(() => buildRegistry({ registryText: text })).toThrow(message);
  });

  it.each(['04663', '0x1237', 'abc', '-1', '0', '1.5'])('rejects non-canonical chain id key "%s"', (key) => {
    expect(() => buildRegistry({ registryText: registry({ [key]: MAINNET }) })).toThrow(
      new RegExp(`deployments\\.json: chains\\.${key.replace('.', '\\.')} is not a numeric chain id`),
    );
  });

  it.each([
    ['empty name', { name: '  ' }, /chains\.4663\.name must be a non-empty string/],
    ['missing name', { name: undefined }, /chains\.4663\.name must be a non-empty string/],
    ['non-http rpcUrl', { rpcUrl: 'ws://node:8546' }, /chains\.4663\.rpcUrl must be an http\(s\) URL/],
    ['non-http explorerUrl', { explorerUrl: 'explorer.example' }, /chains\.4663\.explorerUrl must be an http\(s\) URL/],
    ['non-boolean testnet', { testnet: 'no' }, /chains\.4663\.testnet must be true or false/],
    ['unknown status', { status: 'live' }, /chains\.4663\.status must be one of planned \| deployed \(got "live"\)/],
    ['an unknown key', { vault: ADDRS.vault }, /chains\.4663\.vault is not a known key/],
  ])('rejects a chain entry with %s', (_label, over, message) => {
    const entry = { ...MAINNET, ...over };
    expect(() => buildRegistry({ registryText: registry({ 4663: entry }) })).toThrow(message);
  });

  it('forbids addresses on a planned chain', () => {
    expect(() =>
      buildRegistry({ registryText: registry({ 4663: { ...MAINNET, addresses: ADDRS } }) }),
    ).toThrow(/chains\.4663\.addresses given for a chain with status "planned"/);
  });

  it('requires addresses on a deployed chain (when no overlay supplies them)', () => {
    expect(() => buildRegistry({ registryText: registry({ 46630: LOCAL }) })).toThrow(
      /deployments\.json: chains\.46630\.addresses is missing for a "deployed" chain/,
    );
  });

  it('requires exactly the nine address keys', () => {
    const { demoUser: _dropped, ...eight } = ADDRS;
    expect(() =>
      buildRegistry({ registryText: registry({ 46630: { ...LOCAL, addresses: eight } }) }),
    ).toThrow(/chains\.46630\.addresses\.demoUser is missing/);
    expect(() =>
      buildRegistry({
        registryText: registry({ 46630: { ...LOCAL, addresses: { ...ADDRS, treasury: A(99) } } }),
      }),
    ).toThrow(/chains\.46630\.addresses\.treasury is not an address key/);
    expect(() =>
      buildRegistry({
        registryText: registry({ 46630: { ...LOCAL, addresses: { ...ADDRS, vault: '0x1234' } } }),
      }),
    ).toThrow(/chains\.46630\.addresses\.vault is not an address/);
  });

  it('throws RegistryError, labelled with the file name it was given', () => {
    try {
      buildRegistry({ registryText: registry({}), registryLabel: 'custom-registry.json' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryError);
      expect((err as Error).message).toBe('custom-registry.json: chains must list at least one chain');
    }
  });
});

describe('buildRegistry — local overlay merge', () => {
  it('turns the matching entry into deployed + local, with the overlay rpcUrl and addresses', () => {
    const chains = buildRegistry({
      registryText: registry({ 4663: MAINNET, 46630: { ...LOCAL, status: 'planned' } }),
      localText: overlay(),
    });
    const local = chains.find((c) => c.chainId === 46630)!;
    expect(local).toMatchObject({
      name: LOCAL.name, // the registry is the only place a chain gets its name
      testnet: true,
      status: 'deployed',
      local: true,
      rpcUrl: 'http://127.0.0.1:9999',
    });
    expect(local.addresses).toEqual(LOCAL_ADDRS);
    // Other entries are untouched.
    expect(chains.find((c) => c.chainId === 4663)).toMatchObject({ status: 'planned' });
    expect(chains.find((c) => c.chainId === 4663)?.local).toBeUndefined();
  });

  it('overrides addresses the registry already had for that chain', () => {
    const chains = buildRegistry({
      registryText: registry({ 46630: { ...LOCAL, addresses: ADDRS } }),
      localText: overlay(),
    });
    expect(chains[0]?.addresses?.vault).toBe(LOCAL_ADDRS.vault);
  });

  it('rejects a local chain id that is not in the registry', () => {
    expect(() =>
      buildRegistry({
        registryText: registry({ 4663: MAINNET }),
        localText: overlay({ chainId: 31337 }),
      }),
    ).toThrow(
      'deployment.local.json: chainId 31337 has no entry in deployments.json — add it under chains.31337 first',
    );
  });

  it.each([
    ['invalid JSON', '{', /deployment\.local\.json: invalid JSON/],
    ['a string chainId', overlay({ chainId: '46630' }), /deployment\.local\.json: chainId must be a number/],
    ['a bad rpcUrl', overlay({ rpcUrl: 'localhost:8547' }), /deployment\.local\.json: rpcUrl must be an http\(s\) URL/],
    ['a missing address', overlay({ vault: undefined }), /deployment\.local\.json: vault is missing/],
    ['a malformed address', overlay({ weth: '0xnope' }), /deployment\.local\.json: weth is not an address/],
  ])('rejects an overlay with %s', (_label, localText, message) => {
    expect(() =>
      buildRegistry({ registryText: registry({ 46630: LOCAL }), localText }),
    ).toThrow(message);
  });

  it('tolerates extra flat keys in the overlay (DemoLocal.s.sol writes chainId/rpcUrl alongside)', () => {
    const chains = buildRegistry({
      registryText: registry({ 46630: LOCAL }),
      localText: overlay({ note: 'extra' }),
    });
    expect(Object.keys(chains[0]!.addresses!).sort()).toEqual([...ADDRESS_KEYS].sort());
  });

  it('uses the overlay label it was given in errors', () => {
    expect(() =>
      buildRegistry({
        registryText: registry({ 46630: LOCAL }),
        localText: '{',
        localLabel: 'my-stack.json',
      }),
    ).toThrow(/^my-stack\.json: invalid JSON/);
  });
});

describe('selectChain', () => {
  it('env chainId wins over the local preference', () => {
    const chains = buildRegistry({
      registryText: registry({
        1: { ...MAINNET, name: 'One', status: 'deployed', addresses: ADDRS },
        46630: LOCAL,
      }),
      localText: overlay(),
    });
    expect(selectChain(chains, { chainId: 1 }).name).toBe('One');
  });

  it('prefers the local entry when no chainId is requested', () => {
    const chains = buildRegistry({
      registryText: registry({
        1: { ...MAINNET, name: 'One', status: 'deployed', addresses: ADDRS },
        46630: LOCAL,
      }),
      localText: overlay(),
    });
    const picked = selectChain(chains);
    expect(picked.chainId).toBe(46630);
    expect(picked.local).toBe(true);
    expect(picked.addresses.vault).toBe(LOCAL_ADDRS.vault);
  });

  it('falls back to the first deployed chain (ascending id) without a local entry', () => {
    const chains = buildRegistry({
      registryText: registry({
        4663: MAINNET,
        20: { ...LOCAL, name: 'Twenty', addresses: ADDRS },
        10: { ...LOCAL, name: 'Ten', addresses: ADDRS },
      }),
    });
    expect(selectChain(chains).name).toBe('Ten');
  });

  it('preferLocal: false takes the first deployed chain even when a local entry exists', () => {
    const chains = buildRegistry({
      registryText: registry({ 10: { ...LOCAL, name: 'Ten', addresses: ADDRS }, 46630: LOCAL }),
      localText: overlay(),
    });
    expect(selectChain(chains, { preferLocal: false }).name).toBe('Ten');
    expect(selectChain(chains).chainId).toBe(46630);
  });

  it('refuses a requested chain that is only planned', () => {
    expect(() => selectChain(repoLike(), { chainId: 4663 })).toThrow(
      /^chain 4663 is planned — no deployment to act on \(deployments\.json lists "Robinhood Chain" with status "planned"; deployed: 46630\)$/,
    );
  });

  it('refuses a requested chain the registry does not list', () => {
    expect(() => selectChain(repoLike(), { chainId: 31337 })).toThrow(
      /chain 31337 is not in deployments\.json \(listed: 4663, 46630\)/,
    );
  });

  it('refuses when nothing is deployed at all', () => {
    const chains = buildRegistry({ registryText: registry({ 4663: MAINNET }) });
    expect(() => selectChain(chains)).toThrow(RegistryError);
    expect(() => selectChain(chains)).toThrow(/no deployed chain to act on/);
  });
});

describe('findDuplicateKey', () => {
  it('finds nested duplicates and ignores repeats across sibling objects', () => {
    expect(findDuplicateKey('{"a":{"x":1,"x":2}}')).toBe('a.x');
    expect(findDuplicateKey('{"a":{"x":1},"b":{"x":2}}')).toBeNull();
    expect(findDuplicateKey('{"a":[{"x":1},{"x":2}]}')).toBeNull();
    expect(findDuplicateKey('{"a":"has \\"quoted\\" text","a":1}')).toBe('a');
  });
});
