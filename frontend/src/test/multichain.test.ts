/**
 * Multi-chain: the registry (shared/deployments.json + the local overlay), the chain helpers built
 * from it, the wallet switch/add-chain fallback, and target-chain resolution. All node, no wallet —
 * the "wallet" in the switch tests is the smallest EIP-1193 object that behaves like one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClient, custom, numberToHex, type Chain } from 'viem';
import { CHAINS, DEPLOYMENTS } from '@/config/generated';
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_DEPLOYMENT_CHAIN_ID,
  SUPPORTED_CHAINS,
  chainFor,
  chainLabel,
  chainShortLabel,
  defaultChainIds,
  deploymentForChain,
  hasDeployment,
  isLocalChain,
  toViemChain,
} from '@/chain/chains';
import { addEthereumChainParams, isUnknownChain, switchWalletChain } from '@/chain/switchChain';
import { resolveTargetChain } from '@/chain/targetChain';
import { buildRegistry, findDuplicateKey } from '../../scripts/registry';

const shared = (name: string) => readFileSync(fileURLToPath(new URL(`../../../shared/${name}`, import.meta.url)), 'utf8');
const LOCAL = JSON.parse(shared('deployment.local.json')) as Record<string, string | number>;

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const ADDRS = {
  vault: A(1),
  implementation: A(2),
  usdg: A(3),
  weth: A(4),
  adapterV3: A(5),
  adapterV4: A(6),
  owner: A(7),
  keeper: A(8),
  demoUser: A(9),
};
const registry = (chains: Record<string, unknown>) => JSON.stringify({ version: 1, chains });
const chainEntryJson = (extra: Record<string, unknown> = {}) => ({
  name: 'Test Chain',
  rpcUrl: 'https://rpc.test',
  testnet: false,
  status: 'planned',
  ...extra,
});

describe('generated config — in sync with shared/', () => {
  it('CHAINS / DEPLOYMENTS are exactly what sync:shared builds from shared/ today', () => {
    const built = buildRegistry({ registryText: shared('deployments.json'), localText: shared('deployment.local.json') });
    expect(CHAINS.map((c) => c.chainId)).toEqual(built.map((c) => c.chainId));
    expect(DEPLOYMENTS.map((d) => d.chainId)).toEqual(built.filter((c) => c.status === 'deployed').map((c) => c.chainId));
    for (const d of DEPLOYMENTS) {
      const src = built.find((c) => c.chainId === d.chainId)!;
      expect({ ...d }).toMatchObject({ ...src.addresses, rpcUrl: src.rpcUrl, name: src.name });
    }
  });

  it('the local entry carries deployment.local.json verbatim', () => {
    const local = deploymentForChain(LOCAL.chainId as number);
    expect(local).toBeDefined();
    expect(local?.local).toBe(true);
    expect(local?.rpcUrl).toBe(LOCAL.rpcUrl);
    for (const k of ['vault', 'implementation', 'usdg', 'weth', 'adapterV3', 'adapterV4', 'owner', 'keeper', 'demoUser'] as const) {
      expect(local?.[k]).toBe(LOCAL[k]);
    }
  });
});

describe('chains.ts — registry-driven helpers', () => {
  it('SUPPORTED_CHAINS mirrors the registry, rpc and testnet flag included', () => {
    expect(SUPPORTED_CHAINS.map((c) => c.id)).toEqual(CHAINS.map((c) => c.chainId));
    for (const entry of CHAINS) {
      const chain = chainFor(entry.chainId)!;
      expect(chain.name).toBe(entry.name);
      expect(chain.rpcUrls.default.http).toEqual([entry.rpcUrl]);
      expect(chain.testnet).toBe(entry.testnet);
      expect(chain.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
    }
    expect(chainFor(1)).toBeUndefined();
    expect(chainFor(undefined)).toBeUndefined();
  });

  it('deploymentForChain: addresses for deployed chains only', () => {
    expect(deploymentForChain(46630)?.vault).toBe(LOCAL.vault);
    expect(deploymentForChain(46630)?.status).toBe('deployed');
    expect(deploymentForChain(4663)).toBeUndefined(); // planned: known chain, no deployment
    expect(deploymentForChain(1)).toBeUndefined(); // unknown chain
    expect(deploymentForChain(undefined)).toBeUndefined();
    expect(hasDeployment(46630)).toBe(true);
    expect(hasDeployment(4663)).toBe(false);
  });

  it('isLocalChain: only the deployment.local.json overlay', () => {
    expect(isLocalChain(46630)).toBe(true);
    expect(isLocalChain(4663)).toBe(false);
    expect(isLocalChain(1)).toBe(false);
    expect(isLocalChain(undefined)).toBe(false);
  });

  it('DEFAULT_CHAIN_ID / DEFAULT_DEPLOYMENT_CHAIN_ID prefer the local stack', () => {
    expect(DEFAULT_CHAIN_ID).toBe(46630);
    expect(DEFAULT_DEPLOYMENT_CHAIN_ID).toBe(46630);
  });

  it('default preference: local, else first deployed, else first registry chain', () => {
    const planned = { chainId: 1, name: 'a', rpcUrl: 'https://a', testnet: false, status: 'planned' } as const;
    const deployedA = { chainId: 5, name: 'b', rpcUrl: 'https://b', testnet: false, status: 'deployed' } as const;
    const deployedB = { chainId: 7, name: 'c', rpcUrl: 'https://c', testnet: true, status: 'deployed' } as const;
    const local = { ...deployedB, chainId: 9, local: true } as const;
    expect(defaultChainIds([planned, deployedA, deployedB, local])).toEqual({ chainId: 9, deploymentChainId: 9 });
    expect(defaultChainIds([planned, deployedA, deployedB])).toEqual({ chainId: 5, deploymentChainId: 5 });
    expect(defaultChainIds([planned])).toEqual({ chainId: 1, deploymentChainId: undefined });
    expect(() => defaultChainIds([])).toThrow(/empty/);
  });

  it('labels', () => {
    expect(chainLabel(46630)).toBe('Robinhood Chain (local demo stack)');
    expect(chainShortLabel(46630)).toBe('Robinhood Chain');
    expect(chainLabel(4663)).toBe('Robinhood Chain');
    expect(chainLabel(1)).toBe('Chain 1');
    expect(chainLabel(undefined)).toBe('Unknown network');
  });
});

describe('addEthereumChainParams — EIP-3085 shape', () => {
  it('local chain: hex id, name, ETH, rpc — and no blockExplorerUrls key at all', () => {
    const params = addEthereumChainParams(chainFor(46630)!);
    expect(params).toEqual({
      chainId: '0xb626',
      chainName: 'Robinhood Chain (local demo stack)',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: [LOCAL.rpcUrl],
    });
    expect('blockExplorerUrls' in params).toBe(false);
  });

  it('mainnet entry: 4663 → 0x1237', () => {
    expect(addEthereumChainParams(chainFor(4663)!)).toMatchObject({
      chainId: '0x1237',
      chainName: 'Robinhood Chain',
      rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    });
  });

  it('carries the explorer when the registry lists one', () => {
    const chain = toViemChain({ chainId: 8453, name: 'Base', rpcUrl: 'https://mainnet.base.org', testnet: false, explorerUrl: 'https://basescan.org' });
    expect(addEthereumChainParams(chain)).toEqual({
      chainId: '0x2105',
      chainName: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org'],
    });
  });
});

/** An EIP-1193 wallet that knows some chains, and records every request. */
function fakeWallet(known: number[], opts: { reject?: boolean; nested?: boolean } = {}) {
  const knows = new Set(known);
  const calls: { method: string; params?: unknown }[] = [];
  let current = known[0] ?? 1;
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push({ method, params });
      if (method === 'wallet_switchEthereumChain') {
        if (opts.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        const id = Number(BigInt((params as [{ chainId: string }])[0].chainId));
        if (!knows.has(id)) {
          const unknown = Object.assign(new Error(`Unrecognized chain ID "${numberToHex(id)}".`), { code: 4902 });
          // MetaMask mobile: 4902 nested inside an internal error.
          if (opts.nested) throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603, data: { originalError: unknown } });
          throw unknown;
        }
        current = id;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        knows.add(Number(BigInt((params as [{ chainId: string }])[0].chainId)));
        return null;
      }
      if (method === 'eth_chainId') return numberToHex(current);
      throw new Error(`unexpected ${method}`);
    },
  };
  return { client: createClient({ transport: custom(provider) }), calls, current: () => current };
}

describe('switchWalletChain — switch, or add then switch', () => {
  const local = chainFor(46630) as Chain;

  it('a known chain is just switched', async () => {
    const w = fakeWallet([4663, 46630]);
    await expect(switchWalletChain(w.client, local)).resolves.toBe('switched');
    expect(w.calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain']);
    expect(w.calls[0].params).toEqual([{ chainId: '0xb626' }]);
  });

  it('an unknown chain (4902) is added with addEthereumChainParams, then switched', async () => {
    const w = fakeWallet([4663]);
    await expect(switchWalletChain(w.client, local)).resolves.toBe('added');
    expect(w.calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
    expect(w.calls[1].params).toEqual([addEthereumChainParams(local)]);
    expect(w.current()).toBe(46630);
  });

  it('also recognises 4902 nested inside a -32603 (MetaMask mobile)', async () => {
    const w = fakeWallet([4663], { nested: true });
    await expect(switchWalletChain(w.client, local)).resolves.toBe('added');
    expect(w.calls.filter((c) => c.method === 'wallet_addEthereumChain')).toHaveLength(1);
  });

  it('a user rejection is rethrown and nothing is added', async () => {
    const w = fakeWallet([4663], { reject: true });
    await expect(switchWalletChain(w.client, local)).rejects.toThrow();
    expect(w.calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain']);
  });

  it('isUnknownChain walks cause / data.originalError, and nothing else matches', () => {
    expect(isUnknownChain({ code: 4902 })).toBe(true);
    expect(isUnknownChain({ code: -32603, cause: { code: 4902 } })).toBe(true);
    expect(isUnknownChain({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(true);
    expect(isUnknownChain(new Error('Unrecognized chain ID "0xb626"'))).toBe(true);
    expect(isUnknownChain({ code: 4001, message: 'User rejected' })).toBe(false);
    expect(isUnknownChain(undefined)).toBe(false);
  });
});

describe('resolveTargetChain — wallet chain if deployed, else the selected chain', () => {
  const at = (walletChainId: number | undefined, selectedChainId: number | undefined) => {
    const t = resolveTargetChain({ walletChainId, selectedChainId });
    return { id: t.chain.id, hasDeployment: t.hasDeployment, isWrongChain: t.isWrongChain, vault: t.deployment?.vault };
  };

  it('no wallet: the selected chain, read-only', () => {
    expect(at(undefined, DEFAULT_CHAIN_ID)).toEqual({ id: 46630, hasDeployment: true, isWrongChain: false, vault: LOCAL.vault });
    expect(at(undefined, 4663)).toEqual({ id: 4663, hasDeployment: false, isWrongChain: false, vault: undefined });
  });

  it('wallet on a deployed chain: that chain wins over the selection', () => {
    expect(at(46630, 4663)).toEqual({ id: 46630, hasDeployment: true, isWrongChain: false, vault: LOCAL.vault });
  });

  it('wallet on a chain with no deployment: the selected chain, flagged wrong', () => {
    expect(at(4663, 46630)).toEqual({ id: 46630, hasDeployment: true, isWrongChain: true, vault: LOCAL.vault });
    expect(at(1, 46630)).toEqual({ id: 46630, hasDeployment: true, isWrongChain: true, vault: LOCAL.vault });
  });

  it('wallet and selection both on a planned chain: "no deployment", not "wrong network"', () => {
    expect(at(4663, 4663)).toEqual({ id: 4663, hasDeployment: false, isWrongChain: false, vault: undefined });
  });

  it('a selection outside the registry falls back to the default chain', () => {
    expect(at(undefined, 999)).toMatchObject({ id: DEFAULT_CHAIN_ID });
    expect(at(undefined, undefined)).toMatchObject({ id: DEFAULT_CHAIN_ID });
  });
});

describe('registry validation (sync:shared) — fails loudly, with the path', () => {
  const build = (chains: Record<string, unknown>, localText?: string) => () => buildRegistry({ registryText: registry(chains), localText });

  it('accepts planned + deployed chains and sorts by chain id', () => {
    const out = buildRegistry({ registryText: registry({ '20': chainEntryJson({ status: 'deployed', addresses: ADDRS }), '10': chainEntryJson() }) });
    expect(out.map((c) => [c.chainId, c.status])).toEqual([
      [10, 'planned'],
      [20, 'deployed'],
    ]);
    expect(out[1].addresses?.vault).toBe(ADDRS.vault);
  });

  it('rejects a bad address, naming the key', () => {
    expect(build({ '10': chainEntryJson({ status: 'deployed', addresses: { ...ADDRS, vault: '0x1234' } }) })).toThrow(
      'deployments.json: chains.10.addresses.vault is not an address',
    );
  });

  it('rejects a deployed chain with no addresses', () => {
    expect(build({ '10': chainEntryJson({ status: 'deployed' }) })).toThrow('chains.10.addresses is missing for a "deployed" chain');
  });

  it('rejects a missing or an extra address key', () => {
    const { keeper: _drop, ...missing } = ADDRS;
    expect(build({ '10': chainEntryJson({ status: 'deployed', addresses: missing }) })).toThrow('chains.10.addresses.keeper is missing');
    expect(build({ '10': chainEntryJson({ status: 'deployed', addresses: { ...ADDRS, router: A(10) } }) })).toThrow(
      'chains.10.addresses.router is not an address key',
    );
  });

  it('rejects addresses on a planned chain', () => {
    expect(build({ '10': chainEntryJson({ addresses: ADDRS }) })).toThrow('chains.10.addresses given for a chain with status "planned"');
  });

  it('rejects non-numeric and non-canonical chain ids', () => {
    expect(build({ abc: chainEntryJson() })).toThrow('chains.abc is not a numeric chain id');
    expect(build({ '0x1237': chainEntryJson() })).toThrow('chains.0x1237 is not a numeric chain id');
    expect(build({ '04663': chainEntryJson() })).toThrow('chains.04663 is not a numeric chain id');
  });

  it('rejects a chain id defined twice (JSON.parse would silently keep the last)', () => {
    const text = `{ "version": 1, "chains": { "10": ${JSON.stringify(chainEntryJson())}, "10": ${JSON.stringify(chainEntryJson({ name: 'Other' }))} } }`;
    expect(() => buildRegistry({ registryText: text })).toThrow('deployments.json: chains.10 is defined twice');
    expect(findDuplicateKey('{"a":{"b":1,"c":{"b":2}},"d":[{"x":1},{"x":2}]}')).toBeNull(); // same key in different objects is fine
    expect(findDuplicateKey('{"a":{"b":1,"b":2}}')).toBe('a.b');
  });

  it('rejects typos, bad types and bad urls', () => {
    expect(build({ '10': { ...chainEntryJson(), rpcURL: 'https://x' } })).toThrow('chains.10.rpcURL is not a known key');
    expect(build({ '10': chainEntryJson({ status: 'live' }) })).toThrow('chains.10.status must be one of planned | deployed');
    expect(build({ '10': chainEntryJson({ testnet: 'no' }) })).toThrow('chains.10.testnet must be true or false');
    expect(build({ '10': chainEntryJson({ rpcUrl: 'ws://x' }) })).toThrow('chains.10.rpcUrl must be an http(s) URL');
    expect(build({ '10': chainEntryJson({ name: '' }) })).toThrow('chains.10.name must be a non-empty string');
    expect(() => buildRegistry({ registryText: JSON.stringify({ version: 2, chains: {} }) })).toThrow('version must be 1');
    expect(build({})).toThrow('chains must list at least one chain');
  });

  it('overlays deployment.local.json: deployed, local, its rpc and addresses', () => {
    const local = JSON.stringify({ chainId: 10, rpcUrl: 'http://127.0.0.1:9999', ...ADDRS });
    const [c] = buildRegistry({ registryText: registry({ '10': chainEntryJson({ status: 'deployed' }) }), localText: local });
    expect(c).toMatchObject({ chainId: 10, status: 'deployed', local: true, rpcUrl: 'http://127.0.0.1:9999', name: 'Test Chain' });
    expect(c.addresses).toEqual(ADDRS);
    // A planned registry entry is promoted by the overlay.
    const [p] = buildRegistry({ registryText: registry({ '10': chainEntryJson() }), localText: local });
    expect(p.status).toBe('deployed');
  });

  it('rejects a local file for a chain the registry does not list, or with a bad address', () => {
    const local = (extra: Record<string, unknown>) => JSON.stringify({ chainId: 10, rpcUrl: 'http://127.0.0.1:9999', ...ADDRS, ...extra });
    expect(build({ '20': chainEntryJson() }, local({}))).toThrow('deployment.local.json: chainId 10 has no entry in deployments.json');
    expect(build({ '10': chainEntryJson() }, local({ weth: 'nope' }))).toThrow('deployment.local.json: weth is not an address');
    expect(build({ '10': chainEntryJson() }, local({ chainId: '10' }))).toThrow('deployment.local.json: chainId must be a number');
  });
});
