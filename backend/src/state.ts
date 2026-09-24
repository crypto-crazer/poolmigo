/**
 * Durable keeper state (`STATE_FILE`).
 *
 * Holds only scheduling bookkeeping — timestamps, counters, the last tx hashes. It is a cache of
 * "when did I last act", never a source of truth about money: the chain is. A lost or corrupt
 * state file degrades to "rebalance is due now", which is safe (`rebalance()` on nothing harvested
 * is a no-op transaction) and is why a parse failure warns instead of crashing.
 *
 * Writes are atomic: temp file in the same directory + `rename`, so a crash mid-write can never
 * leave a truncated file behind.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const STATE_VERSION = 1;

export interface TxRecord {
  readonly hash: string;
  readonly at: number;
  readonly adapter?: string;
}

export interface KeeperState {
  readonly version: number;
  /** Unix seconds of the last tick attempt (success or failure). */
  readonly lastTickAt: number | null;
  /** Unix seconds of the last tick that completed without throwing. */
  readonly lastSuccessfulTickAt: number | null;
  /** Unix seconds of the last confirmed `rebalance()` — the interval gate reads this. */
  readonly lastRebalanceAt: number | null;
  readonly lastRebalanceTx: TxRecord | null;
  /** Deploy transactions sent during the most recent executing tick. */
  readonly lastDeployTxs: readonly TxRecord[];
  readonly tickCount: number;
  readonly lastError: { readonly at: number; readonly message: string } | null;
}

export function emptyState(): KeeperState {
  return {
    version: STATE_VERSION,
    lastTickAt: null,
    lastSuccessfulTickAt: null,
    lastRebalanceAt: null,
    lastRebalanceTx: null,
    lastDeployTxs: [],
    tickCount: 0,
    lastError: null,
  };
}

function isNullableNumber(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * Validate a parsed object into a `KeeperState`, filling in anything missing from `emptyState()`.
 * Returns `null` when the payload is not usable at all (wrong shape / unknown version).
 */
export function coerceState(raw: unknown): KeeperState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== STATE_VERSION) return null;
  if (
    !isNullableNumber(o.lastTickAt) ||
    !isNullableNumber(o.lastSuccessfulTickAt) ||
    !isNullableNumber(o.lastRebalanceAt)
  ) {
    return null;
  }
  const base = emptyState();
  return {
    version: STATE_VERSION,
    lastTickAt: o.lastTickAt,
    lastSuccessfulTickAt: o.lastSuccessfulTickAt,
    lastRebalanceAt: o.lastRebalanceAt,
    lastRebalanceTx: isTxRecord(o.lastRebalanceTx) ? o.lastRebalanceTx : null,
    lastDeployTxs: Array.isArray(o.lastDeployTxs) ? o.lastDeployTxs.filter(isTxRecord) : [],
    tickCount: typeof o.tickCount === 'number' && o.tickCount >= 0 ? o.tickCount : base.tickCount,
    lastError:
      typeof o.lastError === 'object' &&
      o.lastError !== null &&
      typeof (o.lastError as TxRecord).at === 'number' &&
      typeof (o.lastError as { message?: unknown }).message === 'string'
        ? (o.lastError as { at: number; message: string })
        : null,
  };
}

function isTxRecord(v: unknown): v is TxRecord {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.hash === 'string' && typeof o.at === 'number';
}

export class StateStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  /** Read state from disk. Missing or unreadable file => fresh state, with `recovered` set. */
  read(): { state: KeeperState; recovered: string | null } {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { state: emptyState(), recovered: null };
      return { state: emptyState(), recovered: `unreadable state file: ${String(code ?? err)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { state: emptyState(), recovered: 'state file is not valid JSON — starting fresh' };
    }
    const state = coerceState(parsed);
    if (state === null) {
      return { state: emptyState(), recovered: 'state file shape/version unsupported — starting fresh' };
    }
    return { state, recovered: null };
  }

  /** Atomically persist `state` (temp file in the same dir, then rename). */
  write(state: KeeperState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort cleanup */
      }
      throw err;
    }
  }

  /** Read-modify-write helper. */
  update(fn: (prev: KeeperState) => KeeperState): KeeperState {
    const next = fn(this.read().state);
    this.write(next);
    return next;
  }
}
