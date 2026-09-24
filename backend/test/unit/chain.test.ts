import { readFileSync } from 'node:fs';

import { BaseError, HttpRequestError } from 'viem';
import { describe, expect, it } from 'vitest';

import { createClients, defineKeeperChain, isRetryable, withBackoff } from '../../src/chain.js';
import { parseConfig } from '../../src/config.js';
import { createMemoryLogger } from '../../src/logger.js';
import { buildRegistry } from '../../src/registry.js';
import { DEPLOYMENT_PATH, REGISTRY_PATH } from '../integration/helpers.js';

const realRegistry = () =>
  buildRegistry({
    registryText: readFileSync(REGISTRY_PATH, 'utf8'),
    localText: readFileSync(DEPLOYMENT_PATH, 'utf8'),
  });

describe('defineKeeperChain', () => {
  it('names every chain by its registry name (shared/deployments.json)', () => {
    const chains = realRegistry();
    expect(chains.map((c) => c.chainId)).toEqual([4663, 46630]);
    for (const c of chains) {
      expect(defineKeeperChain(c.chainId, c.rpcUrl, c.name).name).toBe(c.name);
    }
    const mainnet = chains.find((c) => c.chainId === 4663)!;
    expect(defineKeeperChain(mainnet.chainId, 'http://x', mainnet.name).name).toBe('Robinhood Chain');
  });

  it('falls back to a generic name for a chain the registry does not list', () => {
    expect(defineKeeperChain(31337, 'http://x').name).toBe('Chain 31337');
  });

  it('createClients names the viem chain from the config (registry entry or fallback)', () => {
    const base = {
      RPC_URL: 'http://127.0.0.1:8547',
      CHAIN_ID: '46630',
      VAULT_ADDRESS: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
      KEEPER_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    };
    const entry = realRegistry().find((c) => c.chainId === 46630)!;
    expect(createClients(parseConfig(base, { chain: entry })).chain.name).toBe(entry.name);
    expect(createClients(parseConfig(base)).chain.name).toBe('Chain 46630');
  });

  it('wires the configured RPC url', () => {
    expect(defineKeeperChain(46630, 'http://127.0.0.1:8547').rpcUrls.default.http).toEqual([
      'http://127.0.0.1:8547',
    ]);
  });
});

describe('isRetryable', () => {
  it('retries transport failures', () => {
    expect(isRetryable(new HttpRequestError({ url: 'http://x' }))).toBe(true);
    expect(isRetryable(new Error('connect ECONNREFUSED 127.0.0.1:8547'))).toBe(true);
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
  });

  it('does NOT retry a contract revert — it is a deterministic answer, not a blip', () => {
    const revert = new BaseError('The contract function reverted.', {
      details: 'execution reverted: PoolmigoVault__InsufficientIdle',
    });
    expect(isRetryable(revert)).toBe(false);
  });

  it('does not retry arbitrary non-network errors', () => {
    expect(isRetryable(new Error('amounts must be aligned'))).toBe(false);
    expect(isRetryable('not even an error')).toBe(false);
  });
});

describe('withBackoff', () => {
  const { logger } = createMemoryLogger('error');

  it('returns the first successful result without sleeping', async () => {
    const slept: number[] = [];
    const result = await withBackoff(() => Promise.resolve(42), {
      maxRetries: 3,
      baseMs: 100,
      label: 'noop',
      logger,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(result).toBe(42);
    expect(slept).toEqual([]);
  });

  it('retries a retryable failure and backs off exponentially', async () => {
    const slept: number[] = [];
    let attempts = 0;
    const result = await withBackoff(
      () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error('fetch failed'));
        return Promise.resolve('ok');
      },
      {
        maxRetries: 5,
        baseMs: 100,
        label: 'flaky',
        logger,
        sleep: async (ms) => void slept.push(ms),
      },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(slept).toHaveLength(2);
    // Full-jitter: delay_n ∈ [base*2^n / 2, base*2^n]
    expect(slept[0]).toBeGreaterThanOrEqual(50);
    expect(slept[0]).toBeLessThanOrEqual(100);
    expect(slept[1]).toBeGreaterThanOrEqual(100);
    expect(slept[1]).toBeLessThanOrEqual(200);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    let attempts = 0;
    await expect(
      withBackoff(
        () => {
          attempts += 1;
          return Promise.reject(new Error('fetch failed'));
        },
        { maxRetries: 2, baseMs: 1, label: 'dead', logger, sleep: async () => {} },
      ),
    ).rejects.toThrow('fetch failed');
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('rethrows a non-retryable error immediately', async () => {
    let attempts = 0;
    await expect(
      withBackoff(
        () => {
          attempts += 1;
          return Promise.reject(new Error('PoolmigoVault__NotKeeper'));
        },
        { maxRetries: 5, baseMs: 1, label: 'revert', logger, sleep: async () => {} },
      ),
    ).rejects.toThrow('PoolmigoVault__NotKeeper');
    expect(attempts).toBe(1);
  });
});
