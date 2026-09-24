/**
 * Config ↔ chain registry: `pickRegistryEntry` (pure), `parseConfig` with a registry entry, and
 * `loadConfig` against real files in a temp dir — including the container case (env only, no
 * registry on disk) and the repo's own shared/deployments.json.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  defaultRegistryPath,
  describeConfig,
  loadConfig,
  parseConfig,
  pickRegistryEntry,
  registryPaths,
  type EnvRecord,
} from '../../src/config.js';
import { jsonReplacer } from '../../src/logger.js';
import { ADDRESS_KEYS, buildRegistry, RegistryError } from '../../src/registry.js';
import { DEPLOYMENT_PATH, REGISTRY_PATH, readDeployment } from '../integration/helpers.js';

// Anvil account #1 — publicly known test key, inert, LOCAL ONLY.
const ANVIL_KEY_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ANVIL_ADDR_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const A = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const addrs = (base: number): Record<string, string> =>
  Object.fromEntries(ADDRESS_KEYS.map((k, i) => [k, A(base + i)]));

const REGISTRY = {
  version: 1,
  chains: {
    '4663': {
      name: 'Robinhood Chain',
      rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
      testnet: false,
      status: 'planned',
    },
    '777': {
      name: 'Some Testnet',
      rpcUrl: 'https://rpc.some-testnet.example',
      testnet: true,
      status: 'deployed',
      addresses: addrs(0x700),
    },
    '46630': {
      name: 'Robinhood Chain (local demo stack)',
      rpcUrl: 'http://127.0.0.1:8547',
      testnet: true,
      status: 'deployed',
    },
  },
};
const LOCAL_ADDRS = addrs(0x4600);
const OVERLAY = { chainId: 46630, rpcUrl: 'http://127.0.0.1:8547', ...LOCAL_ADDRS };
const LOCAL_VAULT = LOCAL_ADDRS.vault!;

const chains = () =>
  buildRegistry({ registryText: JSON.stringify(REGISTRY), localText: JSON.stringify(OVERLAY) });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp `shared/` dir holding the given registry and (optionally) the local overlay. */
function sharedDir(registry: unknown, overlay?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'poolmigo-keeper-registry-'));
  dirs.push(dir);
  if (registry !== undefined) writeFileSync(join(dir, 'deployments.json'), JSON.stringify(registry));
  if (overlay !== undefined) writeFileSync(join(dir, 'deployment.local.json'), JSON.stringify(overlay));
  return dir;
}

const identity: EnvRecord = { KEEPER_ADDRESS: ANVIL_ADDR_1 };

describe('pickRegistryEntry (pure)', () => {
  it('env CHAIN_ID wins', () => {
    expect(pickRegistryEntry({ CHAIN_ID: '777' }, chains())?.name).toBe('Some Testnet');
  });

  it('prefers the local entry, then the first deployed chain', () => {
    expect(pickRegistryEntry({}, chains())?.chainId).toBe(46630);
    const noLocal = buildRegistry({
      registryText: JSON.stringify({
        ...REGISTRY,
        chains: { '4663': REGISTRY.chains['4663'], '777': REGISTRY.chains['777'] },
      }),
    });
    expect(pickRegistryEntry({}, noLocal)?.chainId).toBe(777);
  });

  it('refuses a planned CHAIN_ID when the registry must supply the rest', () => {
    expect(() => pickRegistryEntry({ CHAIN_ID: '4663' }, chains())).toThrow(RegistryError);
    expect(() => pickRegistryEntry({ CHAIN_ID: '4663', RPC_URL: 'https://x' }, chains())).toThrow(
      /chain 4663 is planned — no deployment to act on/,
    );
  });

  it('env supplying CHAIN_ID + RPC_URL + VAULT_ADDRESS makes the registry name-only', () => {
    const full = { CHAIN_ID: '4663', RPC_URL: 'https://x', VAULT_ADDRESS: A(1) };
    expect(pickRegistryEntry(full, chains())?.name).toBe('Robinhood Chain'); // planned is fine here
    expect(pickRegistryEntry({ ...full, CHAIN_ID: '31337' }, chains())).toBeUndefined();
  });
});

describe('parseConfig with a registry entry', () => {
  const local = chains().find((c) => c.local === true)!;

  it('takes chainId, rpcUrl and vault from the entry when env leaves them unset', () => {
    const cfg = parseConfig(identity, { chain: local });
    expect(cfg.chainId).toBe(46630);
    expect(cfg.rpcUrl).toBe('http://127.0.0.1:8547');
    expect(cfg.vaultAddress).toBe(LOCAL_VAULT);
    expect(cfg.chain).toEqual({
      name: 'Robinhood Chain (local demo stack)',
      status: 'deployed',
      local: true,
      testnet: true,
    });
  });

  it('env RPC_URL / VAULT_ADDRESS beat the entry, value by value', () => {
    const cfg = parseConfig(
      { ...identity, RPC_URL: 'http://host.docker.internal:8547', VAULT_ADDRESS: A(0xbeef) },
      { chain: local },
    );
    expect(cfg.rpcUrl).toBe('http://host.docker.internal:8547');
    expect(cfg.vaultAddress).toBe(A(0xbeef));
    expect(cfg.chain.name).toBe(local.name);
  });

  it('ignores a flat deployment file once a registry entry is given', () => {
    const cfg = parseConfig(identity, {
      chain: local,
      deployment: { vault: A(0xdead), chainId: 1, rpcUrl: 'http://elsewhere' },
    });
    expect(cfg.vaultAddress).toBe(LOCAL_VAULT);
    expect(cfg.chainId).toBe(46630);
  });

  it('rejects a CHAIN_ID that contradicts the entry it was handed', () => {
    expect(() => parseConfig({ ...identity, CHAIN_ID: '777' }, { chain: local })).toThrow(
      /CHAIN_ID 777 does not match the registry entry passed in \(chain 46630\)/,
    );
  });

  it('describeConfig names the chain and still omits the key', () => {
    const cfg = parseConfig({ KEEPER_PRIVATE_KEY: ANVIL_KEY_1 }, { chain: local });
    const described = describeConfig(cfg);
    expect(described).toMatchObject({
      chainId: 46630,
      chain: 'Robinhood Chain (local demo stack)',
      chainStatus: 'deployed',
      chainLocal: true,
      chainTestnet: true,
      signer: 'configured',
    });
    expect(JSON.stringify(described, jsonReplacer)).not.toContain(ANVIL_KEY_1.slice(2, 20));
  });
});

describe('loadConfig — files on disk', () => {
  it('defaults to ../shared/deployments.json with the sibling deployment.local.json', () => {
    expect(defaultRegistryPath()).toBe(REGISTRY_PATH);
    expect(registryPaths({})).toMatchObject({
      registry: REGISTRY_PATH,
      overlay: DEPLOYMENT_PATH,
      registryExplicit: false,
      overlayExplicit: false,
    });
  });

  it("selects the repo registry's local entry with no chain env at all", () => {
    const cfg = loadConfig(identity);
    const local = readDeployment();
    expect(cfg.chainId).toBe(local.chainId);
    expect(cfg.rpcUrl).toBe(local.rpcUrl);
    expect(cfg.vaultAddress).toBe(local.vault);
    expect(cfg.chain).toMatchObject({ name: local.entry.name, local: true, status: 'deployed' });
  });

  it('DEPLOYMENTS_FILE: local entry preferred, overlay read from the sibling file', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const cfg = loadConfig({ ...identity, DEPLOYMENTS_FILE: join(dir, 'deployments.json') });
    expect(cfg.chainId).toBe(46630);
    expect(cfg.vaultAddress).toBe(LOCAL_VAULT);
  });

  it('CHAIN_ID from env selects another deployed chain', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const cfg = loadConfig({
      ...identity,
      DEPLOYMENTS_FILE: join(dir, 'deployments.json'),
      CHAIN_ID: '777',
    });
    expect(cfg.chainId).toBe(777);
    expect(cfg.rpcUrl).toBe('https://rpc.some-testnet.example');
    expect(cfg.vaultAddress).toBe(A(0x700));
    expect(cfg.chain).toEqual({ name: 'Some Testnet', status: 'deployed', local: false, testnet: true });
  });

  it('without an overlay the first deployed chain is selected', () => {
    const dir = sharedDir({ ...REGISTRY, chains: { '4663': REGISTRY.chains['4663'], '777': REGISTRY.chains['777'] } });
    const cfg = loadConfig({ ...identity, DEPLOYMENTS_FILE: join(dir, 'deployments.json') });
    expect(cfg.chainId).toBe(777);
  });

  it('DEPLOYMENT_FILE replaces the sibling overlay', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const other = join(dir, 'other-stack.json');
    writeFileSync(other, JSON.stringify({ ...OVERLAY, vault: A(0xabc) }));
    const cfg = loadConfig({
      ...identity,
      DEPLOYMENTS_FILE: join(dir, 'deployments.json'),
      DEPLOYMENT_FILE: other,
    });
    expect(cfg.vaultAddress).toBe(A(0xabc));
  });

  it('a planned CHAIN_ID is a ConfigError (exit 2) with the planned-chain message', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const run = () =>
      loadConfig({ ...identity, DEPLOYMENTS_FILE: join(dir, 'deployments.json'), CHAIN_ID: '4663' });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/^chain 4663 is planned — no deployment to act on/);
  });

  it('an invalid registry is a ConfigError naming the file and path', () => {
    const dir = sharedDir({ ...REGISTRY, version: 2 });
    expect(() => loadConfig({ ...identity, DEPLOYMENTS_FILE: join(dir, 'deployments.json') })).toThrow(
      new ConfigError('deployments.json: version must be 1 (got 2)'),
    );
  });

  it('an overlay for a chain the registry lacks is a ConfigError', () => {
    const dir = sharedDir(REGISTRY, { ...OVERLAY, chainId: 31337 });
    expect(() => loadConfig({ ...identity, DEPLOYMENTS_FILE: join(dir, 'deployments.json') })).toThrow(
      /deployment\.local\.json: chainId 31337 has no entry in deployments\.json/,
    );
  });

  it('an explicit DEPLOYMENTS_FILE that does not exist is an error when the run needs it', () => {
    expect(() => loadConfig({ ...identity, DEPLOYMENTS_FILE: '/nope/deployments.json' })).toThrow(
      /DEPLOYMENTS_FILE \/nope\/deployments\.json could not be read/,
    );
  });

  it('no registry on disk but a flat DEPLOYMENT_FILE: the pre-registry behaviour still works', () => {
    const dir = sharedDir(undefined, OVERLAY); // overlay only, no deployments.json
    const cfg = loadConfig(
      { ...identity, DEPLOYMENT_FILE: join(dir, 'deployment.local.json') },
      join(dir, 'deployments.json'),
    );
    expect(cfg.chainId).toBe(46630);
    expect(cfg.vaultAddress).toBe(LOCAL_VAULT);
    expect(cfg.chain).toEqual({ name: 'Chain 46630', status: null, local: false, testnet: null });
  });
});

describe('loadConfig — container case (env only, no shared/ on disk)', () => {
  const env: EnvRecord = {
    ...identity,
    CHAIN_ID: '46630',
    RPC_URL: 'http://host.docker.internal:8547',
    VAULT_ADDRESS: A(0xc0ffee),
  };
  /** Default registry path inside an empty dir — what the image sees (no ../shared). */
  const noShared = (): string => join(sharedDir(undefined), 'deployments.json');

  it('loads exactly as parseConfig alone when env supplies chain, RPC and vault', () => {
    const cfg = loadConfig(env, noShared());
    expect(cfg).toEqual(parseConfig(env));
    expect(cfg.chainId).toBe(46630);
    expect(cfg.rpcUrl).toBe('http://host.docker.internal:8547');
    expect(cfg.vaultAddress).toBe(A(0xc0ffee));
    expect(cfg.chain).toEqual({ name: 'Chain 46630', status: null, local: false, testnet: null });
    expect(describeConfig(cfg).chainStatus).toBe('not-in-registry');
  });

  it('tolerates DEPLOYMENTS_FILE / DEPLOYMENT_FILE pointing at missing files when env is complete', () => {
    const cfg = loadConfig(
      { ...env, DEPLOYMENTS_FILE: '/nope/deployments.json', DEPLOYMENT_FILE: '/nope/local.json' },
      noShared(),
    );
    expect(cfg.vaultAddress).toBe(A(0xc0ffee));
  });

  it('fails the old way when env is incomplete and nothing is on disk', () => {
    const run = () => loadConfig({ ...identity, CHAIN_ID: '46630', RPC_URL: 'http://x' }, noShared());
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/VAULT_ADDRESS is required/);
  });

  it('with the repo registry present, env still wins and the registry only names the chain', () => {
    const cfg = loadConfig(env); // the repo's real shared/deployments.json
    expect(cfg.vaultAddress).toBe(A(0xc0ffee));
    expect(cfg.rpcUrl).toBe('http://host.docker.internal:8547');
    expect(cfg.chain.name).toBe(readDeployment().entry.name);
  });

  it('full env on a chain the registry lists as planned: env is authoritative', () => {
    const cfg = loadConfig({ ...env, CHAIN_ID: '4663', RPC_URL: 'https://rpc.example' });
    expect(cfg.chainId).toBe(4663);
    expect(cfg.chain).toEqual({ name: 'Robinhood Chain', status: 'planned', local: false, testnet: false });
    expect(describeConfig(cfg).chainStatus).toBe('planned'); // visible in the startup line
  });
});
