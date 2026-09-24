import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  describeConfig,
  parseAdapterWeights,
  parseConfig,
  parseMinDeploy,
  resolveAdapterWeights,
  type EnvRecord,
} from '../../src/config.js';
import { jsonReplacer } from '../../src/logger.js';
import type { Address } from '../../src/types.js';

const VAULT = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const ADAPTER_A = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9' as Address;
const ADAPTER_B = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707' as Address;
// Anvil account #1 — publicly known test key, inert, LOCAL ONLY.
const ANVIL_KEY_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ANVIL_ADDR_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function env(over: EnvRecord = {}): EnvRecord {
  return {
    RPC_URL: 'http://127.0.0.1:8547',
    CHAIN_ID: '46630',
    VAULT_ADDRESS: VAULT,
    KEEPER_PRIVATE_KEY: ANVIL_KEY_1,
    ...over,
  };
}

describe('parseConfig — defaults', () => {
  it('applies the documented defaults, including DRY_RUN=true', () => {
    const cfg = parseConfig(env());
    expect(cfg).toMatchObject({
      dryRun: true,
      tickIntervalSec: 60,
      rebalanceIntervalSec: 86_400,
      targetIdleBps: 2000,
      maxDeployPerTickBps: 5000,
      stateFile: '.keeper-state.json',
      logLevel: 'info',
      confirmations: 1,
      txTimeoutSec: 120,
      rpcMaxRetries: 4,
      rpcBackoffBaseMs: 500,
    });
    expect(cfg.adapterWeights).toEqual({ kind: 'equal' });
    expect(cfg.minDeploy).toEqual({ fallback: 0n, byToken: new Map() });
  });

  it('defaults to dry-run even when every other var is set to act', () => {
    expect(parseConfig(env({ TICK_INTERVAL_SEC: '5' })).dryRun).toBe(true);
  });

  it('treats empty-string vars as unset rather than as invalid', () => {
    expect(parseConfig(env({ LOG_LEVEL: '  ', TARGET_IDLE_BPS: '' })).targetIdleBps).toBe(2000);
  });
});

describe('parseConfig — sources and validation', () => {
  it('falls back to the deployment file for vault, rpc and chain id', () => {
    const cfg = parseConfig(
      { KEEPER_ADDRESS: ANVIL_ADDR_1 },
      { deployment: { vault: VAULT, chainId: 46630, rpcUrl: 'http://127.0.0.1:8547' } },
    );
    expect(cfg.vaultAddress).toBe(VAULT);
    expect(cfg.chainId).toBe(46630);
    expect(cfg.rpcUrl).toBe('http://127.0.0.1:8547');
  });

  it('prefers explicit env over the deployment file', () => {
    const cfg = parseConfig(env({ CHAIN_ID: '4663' }), {
      deployment: { vault: VAULT, chainId: 46630 },
    });
    expect(cfg.chainId).toBe(4663);
  });

  it('rejects a missing vault address', () => {
    expect(() => parseConfig({ RPC_URL: 'http://x', CHAIN_ID: '1' })).toThrow(ConfigError);
  });

  it('rejects a malformed address', () => {
    expect(() => parseConfig(env({ VAULT_ADDRESS: '0x1234' }))).toThrow(/VAULT_ADDRESS/);
  });

  it('rejects an out-of-range bps value', () => {
    expect(() => parseConfig(env({ TARGET_IDLE_BPS: '10001' }))).toThrow(/TARGET_IDLE_BPS/);
  });

  it('rejects a non-numeric interval', () => {
    expect(() => parseConfig(env({ TICK_INTERVAL_SEC: 'soon' }))).toThrow(/TICK_INTERVAL_SEC/);
  });

  it('rejects an unknown log level', () => {
    expect(() => parseConfig(env({ LOG_LEVEL: 'chatty' }))).toThrow(/LOG_LEVEL/);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['off', false],
  ])('parses DRY_RUN=%s as %s', (raw, expected) => {
    expect(parseConfig(env({ DRY_RUN: raw })).dryRun).toBe(expected);
  });

  it('rejects a non-boolean DRY_RUN rather than silently treating it as false', () => {
    expect(() => parseConfig(env({ DRY_RUN: 'maybe' }))).toThrow(/DRY_RUN/);
  });
});

describe('parseConfig — keeper identity', () => {
  it('accepts a private key from KEEPER_KEY_FILE contents', () => {
    const cfg = parseConfig(
      env({ KEEPER_PRIVATE_KEY: undefined, KEEPER_KEY_FILE: '/run/secrets/keeper' }),
      { keyFileContents: `${ANVIL_KEY_1}\n` },
    );
    expect(cfg.keeperPrivateKey).toBe(ANVIL_KEY_1);
  });

  it('adds the 0x prefix when the key file omits it', () => {
    const cfg = parseConfig(
      env({ KEEPER_PRIVATE_KEY: undefined, KEEPER_KEY_FILE: '/run/secrets/keeper' }),
      { keyFileContents: ANVIL_KEY_1.slice(2) },
    );
    expect(cfg.keeperPrivateKey).toBe(ANVIL_KEY_1);
  });

  it('refuses both key sources at once', () => {
    expect(() => parseConfig(env({ KEEPER_KEY_FILE: '/run/secrets/keeper' }))).toThrow(
      /only one of/,
    );
  });

  it('refuses a key file that could not be read', () => {
    expect(() =>
      parseConfig(env({ KEEPER_PRIVATE_KEY: undefined, KEEPER_KEY_FILE: '/nope' })),
    ).toThrow(/could not be read/);
  });

  it('never echoes the key material in the error message', () => {
    const secretish = '0xdeadbeef';
    try {
      parseConfig(env({ KEEPER_PRIVATE_KEY: secretish }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(secretish);
      expect((err as Error).message).toMatch(/32-byte hex private key/);
    }
  });

  it('allows a signer-less identity via KEEPER_ADDRESS', () => {
    const cfg = parseConfig(env({ KEEPER_PRIVATE_KEY: undefined, KEEPER_ADDRESS: ANVIL_ADDR_1 }));
    expect(cfg.keeperPrivateKey).toBeNull();
    expect(cfg.keeperAddress).toBe(ANVIL_ADDR_1);
  });

  it('refuses to start with no identity at all', () => {
    expect(() => parseConfig(env({ KEEPER_PRIVATE_KEY: undefined }))).toThrow(/no keeper identity/);
  });
});

describe('describeConfig', () => {
  it('omits the private key entirely', () => {
    const cfg = parseConfig(env());
    const described = describeConfig(cfg);
    // Serialised the way the logger serialises it (bigint-safe), then searched for key material.
    expect(JSON.stringify(described, jsonReplacer)).not.toContain(ANVIL_KEY_1.slice(2, 20));
    expect(described.signer).toBe('configured');
    expect(Object.keys(described)).not.toContain('keeperPrivateKey');
  });

  it('reports an absent signer', () => {
    const cfg = parseConfig(env({ KEEPER_PRIVATE_KEY: undefined, KEEPER_ADDRESS: ANVIL_ADDR_1 }));
    expect(describeConfig(cfg).signer).toBe('absent');
  });
});

describe('parseAdapterWeights', () => {
  it('defaults to equal', () => {
    expect(parseAdapterWeights(undefined)).toEqual({ kind: 'equal' });
  });

  it('parses a positional list', () => {
    expect(parseAdapterWeights('1, 3')).toEqual({ kind: 'positional', weights: [1n, 3n] });
  });

  it('parses an address-keyed list case-insensitively', () => {
    const spec = parseAdapterWeights(`${ADAPTER_A}:3,${ADAPTER_B.toLowerCase()}:1`);
    expect(spec.kind).toBe('byAddress');
    if (spec.kind !== 'byAddress') throw new Error('unreachable');
    expect(spec.weights.get(ADAPTER_A.toLowerCase())).toBe(3n);
    expect(spec.weights.get(ADAPTER_B.toLowerCase())).toBe(1n);
  });

  it('rejects an all-zero weight set', () => {
    expect(() => parseAdapterWeights('0,0')).toThrow(/all zero/);
    expect(() => parseAdapterWeights(`${ADAPTER_A}:0`)).toThrow(/all zero/);
  });

  it('rejects duplicates and bad addresses', () => {
    expect(() => parseAdapterWeights(`${ADAPTER_A}:1,${ADAPTER_A}:2`)).toThrow(/twice/);
    expect(() => parseAdapterWeights('0xnope:1')).toThrow(/ADAPTER_WEIGHTS adapter/);
  });
});

describe('resolveAdapterWeights', () => {
  it('spreads equal weights over the discovered adapters', () => {
    const w = resolveAdapterWeights({ kind: 'equal' }, [ADAPTER_A, ADAPTER_B]);
    expect([...w.values()]).toEqual([1n, 1n]);
  });

  it('aligns positional weights to the on-chain adapter order', () => {
    const w = resolveAdapterWeights({ kind: 'positional', weights: [3n, 1n] }, [
      ADAPTER_A,
      ADAPTER_B,
    ]);
    expect(w.get(ADAPTER_A.toLowerCase())).toBe(3n);
    expect(w.get(ADAPTER_B.toLowerCase())).toBe(1n);
  });

  it('refuses a positional list whose length no longer matches the registry', () => {
    expect(() =>
      resolveAdapterWeights({ kind: 'positional', weights: [1n] }, [ADAPTER_A, ADAPTER_B]),
    ).toThrow(/registered adapters/);
  });

  it('gives an unlisted adapter weight 0 under the address-keyed form', () => {
    const spec = parseAdapterWeights(`${ADAPTER_A}:5`);
    const w = resolveAdapterWeights(spec, [ADAPTER_A, ADAPTER_B]);
    expect(w.get(ADAPTER_A.toLowerCase())).toBe(5n);
    expect(w.get(ADAPTER_B.toLowerCase())).toBe(0n);
  });
});

describe('parseMinDeploy', () => {
  it('defaults to zero', () => {
    expect(parseMinDeploy(undefined)).toEqual({ fallback: 0n, byToken: new Map() });
  });

  it('parses a bare scalar as the floor for every token', () => {
    expect(parseMinDeploy('1000000')).toEqual({ fallback: 1_000_000n, byToken: new Map() });
  });

  it('parses per-token floors with an explicit default', () => {
    const spec = parseMinDeploy(`default:5,${ADAPTER_A}:1000000`);
    expect(spec.fallback).toBe(5n);
    expect(spec.byToken.get(ADAPTER_A.toLowerCase())).toBe(1_000_000n);
  });

  it('rejects negative or non-integer amounts', () => {
    expect(() => parseMinDeploy('-1')).toThrow(/MIN_DEPLOY_AMOUNT_RAW/);
    expect(() => parseMinDeploy('1.5')).toThrow(/MIN_DEPLOY_AMOUNT_RAW/);
  });

  it('rejects a mix of keyed and scalar entries', () => {
    expect(() => parseMinDeploy(`5,${ADAPTER_A}:1`)).toThrow(/mixes keyed and scalar/);
  });
});
