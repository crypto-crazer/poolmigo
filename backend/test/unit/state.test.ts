import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateStore, coerceState, emptyState, STATE_VERSION } from '../../src/state.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poolmigo-keeper-state-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('returns a fresh state when the file does not exist', () => {
    const store = new StateStore(join(dir, 'missing.json'));
    const { state, recovered } = store.read();
    expect(recovered).toBeNull();
    expect(state).toEqual(emptyState());
  });

  it('round-trips a written state', () => {
    const store = new StateStore(join(dir, 'state.json'));
    const written = { ...emptyState(), lastRebalanceAt: 1700, tickCount: 3 };
    store.write(written);
    expect(store.read().state).toEqual(written);
  });

  it('survives a restart: the state file is what the next process reads', () => {
    const path = join(dir, 'state.json');
    new StateStore(path).write({ ...emptyState(), lastRebalanceAt: 42, tickCount: 1 });
    // A completely separate store instance, as a restarted process would create.
    expect(new StateStore(path).read().state.lastRebalanceAt).toBe(42);
  });

  it('leaves no temp file behind after a write', () => {
    const store = new StateStore(join(dir, 'state.json'));
    store.write(emptyState());
    const leftovers = readFileSync(join(dir, 'state.json'), 'utf8');
    expect(leftovers).toContain('"version"');
    expect(() => readFileSync(`${join(dir, 'state.json')}.${process.pid}.tmp`, 'utf8')).toThrow();
  });

  it('degrades to a fresh state on corrupt JSON, with a reason', () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, '{ not json');
    const { state, recovered } = new StateStore(path).read();
    expect(state).toEqual(emptyState());
    expect(recovered).toMatch(/not valid JSON/);
  });

  it('degrades to a fresh state on an unknown version', () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify({ version: 999 }));
    const { state, recovered } = new StateStore(path).read();
    expect(state).toEqual(emptyState());
    expect(recovered).toMatch(/version unsupported/);
  });

  it('creates the parent directory if needed', () => {
    const store = new StateStore(join(dir, 'nested', 'deeper', 'state.json'));
    store.write(emptyState());
    expect(store.read().state).toEqual(emptyState());
  });

  it('applies update() as read-modify-write', () => {
    const store = new StateStore(join(dir, 'state.json'));
    store.write(emptyState());
    store.update((prev) => ({ ...prev, tickCount: prev.tickCount + 1 }));
    store.update((prev) => ({ ...prev, tickCount: prev.tickCount + 1 }));
    expect(store.read().state.tickCount).toBe(2);
  });
});

describe('coerceState', () => {
  it('rejects non-objects', () => {
    expect(coerceState(null)).toBeNull();
    expect(coerceState('nope')).toBeNull();
  });

  it('rejects a timestamp of the wrong type instead of trusting it', () => {
    expect(coerceState({ version: STATE_VERSION, lastRebalanceAt: 'soon' })).toBeNull();
  });

  it('fills in missing optional fields', () => {
    const state = coerceState({
      version: STATE_VERSION,
      lastTickAt: 1,
      lastSuccessfulTickAt: 1,
      lastRebalanceAt: null,
    });
    expect(state).toMatchObject({ lastDeployTxs: [], tickCount: 0, lastError: null });
  });

  it('drops malformed tx records rather than propagating them', () => {
    const state = coerceState({
      version: STATE_VERSION,
      lastTickAt: null,
      lastSuccessfulTickAt: null,
      lastRebalanceAt: null,
      lastDeployTxs: [{ hash: '0xabc', at: 1 }, { nope: true }],
      lastRebalanceTx: { garbage: true },
    });
    expect(state?.lastDeployTxs).toEqual([{ hash: '0xabc', at: 1 }]);
    expect(state?.lastRebalanceTx).toBeNull();
  });
});
