/**
 * The multi-chain registry, as data: `shared/deployments.json` merged with the local demo stack's
 * `shared/deployment.local.json`, plus the rule for which chain the keeper acts on.
 *
 * Pure — no file I/O — so `loadConfig` and the unit tests run the exact same validation. The rules
 * mirror the frontend's `frontend/scripts/registry.ts` (the reference implementation); the two
 * packages are built and shipped separately (the keeper image has no `../frontend`), so the logic
 * is restated here rather than imported. Keep them in step.
 *
 * Every rule throws with the offending path (`deployments.json: chains.4663.rpcUrl …`), because a
 * registry mistake that reaches the keeper turns into transactions against the wrong address.
 */

import type { Address } from './types.js';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const ADDRESS_KEYS = [
  'vault',
  'implementation',
  'usdg',
  'weth',
  'adapterV3',
  'adapterV4',
  'owner',
  'keeper',
  'demoUser',
] as const;
export type AddressKey = (typeof ADDRESS_KEYS)[number];

const CHAIN_KEYS = ['name', 'rpcUrl', 'testnet', 'status', 'explorerUrl', 'addresses'] as const;
const STATUSES = ['planned', 'deployed'] as const;
const REGISTRY_VERSION = 1;

export interface RegistryChain {
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly testnet: boolean;
  readonly explorerUrl?: string;
  readonly status: 'planned' | 'deployed';
  /** Set when the entry was overlaid by `deployment.local.json` (the local demo stack). */
  readonly local?: true;
  readonly addresses?: Readonly<Record<AddressKey, Address>>;
}

export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}

/** Default file labels used in error messages (`<file>: <path> <problem>`). */
export const REGISTRY_FILE = 'deployments.json';
export const LOCAL_FILE = 'deployment.local.json';

function fail(file: string, path: string, message: string): never {
  throw new RegistryError(`${file}: ${path} ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function httpUrl(file: string, path: string, v: unknown): string {
  if (typeof v !== 'string' || !/^https?:\/\/[^\s]+$/.test(v)) {
    fail(file, path, `must be an http(s) URL (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** Canonical positive decimal only: "4663" yes; "04663", "0x1237", "abc", "-1" no. */
function parseChainId(file: string, path: string, v: unknown): number {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s))) {
    fail(file, path, `is not a numeric chain id (got ${JSON.stringify(v)})`);
  }
  return Number(s);
}

function readAddresses(
  file: string,
  path: string,
  raw: Record<string, unknown>,
  strict: boolean,
): Record<AddressKey, Address> {
  const at = (k: string): string => (path ? `${path}.${k}` : k);
  if (strict) {
    const unknown = Object.keys(raw).filter((k) => !(ADDRESS_KEYS as readonly string[]).includes(k));
    if (unknown[0] !== undefined) {
      fail(file, at(unknown[0]), `is not an address key (expected exactly: ${ADDRESS_KEYS.join(', ')})`);
    }
  }
  const out = {} as Record<AddressKey, Address>;
  for (const k of ADDRESS_KEYS) {
    const v = raw[k];
    if (v === undefined) fail(file, at(k), 'is missing');
    if (typeof v !== 'string' || !ADDRESS_RE.test(v)) {
      fail(file, at(k), `is not an address (got ${JSON.stringify(v)})`);
    }
    out[k] = v as Address;
  }
  return out;
}

/**
 * `JSON.parse` keeps the LAST of two identical keys without a word — which is exactly how a
 * copy-pasted chain entry would silently replace another. Scan the raw text for repeats instead.
 * Returns the first duplicate as `path.key`, or null.
 */
export function findDuplicateKey(text: string): string | null {
  // One frame per open container: object frames collect their keys, array frames do not.
  const stack: { keys: Set<string> | null; path: string }[] = [];
  let lastKey = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++;
        s += text[j] ?? '';
        j++;
      }
      i = j;
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k] ?? '')) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ':' && top?.keys) {
        if (top.keys.has(s)) return top.path ? `${top.path}.${s}` : s;
        top.keys.add(s);
        lastKey = s;
      }
    } else if (c === '{' || c === '[') {
      const parent = stack[stack.length - 1];
      const path = parent ? (parent.path ? `${parent.path}.${lastKey}` : lastKey) : '';
      stack.push({ keys: c === '{' ? new Set() : null, path });
    } else if (c === '}' || c === ']') {
      stack.pop();
    }
  }
  return null;
}

export interface BuildInput {
  /** Raw text of shared/deployments.json. */
  readonly registryText: string;
  /** Raw text of shared/deployment.local.json, or undefined when the file is absent. */
  readonly localText?: string | undefined;
  /** File names used in error messages; default `deployments.json` / `deployment.local.json`. */
  readonly registryLabel?: string;
  readonly localLabel?: string;
}

/**
 * Registry + local overlay → the validated chain list, in ascending chain-id order.
 *
 * The local file is an OVERLAY on the registry entry with the same chain id: that entry becomes
 * `status: 'deployed'`, `local: true`, takes the local `rpcUrl` and the local addresses. Its chain
 * id must already be in the registry — the registry is the only place a chain gets a name.
 */
export function buildRegistry(input: BuildInput): RegistryChain[] {
  const REGISTRY = input.registryLabel ?? REGISTRY_FILE;
  const LOCAL = input.localLabel ?? LOCAL_FILE;

  const dup = findDuplicateKey(input.registryText);
  if (dup !== null) fail(REGISTRY, dup, 'is defined twice');

  let raw: unknown;
  try {
    raw = JSON.parse(input.registryText);
  } catch (err) {
    throw new RegistryError(`${REGISTRY}: invalid JSON (${(err as Error).message})`);
  }
  if (!isRecord(raw)) fail(REGISTRY, '(root)', 'must be an object');
  if (raw.version !== REGISTRY_VERSION) {
    fail(REGISTRY, 'version', `must be ${REGISTRY_VERSION} (got ${JSON.stringify(raw.version)})`);
  }
  if (!isRecord(raw.chains)) fail(REGISTRY, 'chains', 'must be an object keyed by chain id');

  const byId = new Map<number, RegistryChain>();
  for (const [key, entry] of Object.entries(raw.chains)) {
    const path = `chains.${key}`;
    const chainId = parseChainId(REGISTRY, path, key);
    if (byId.has(chainId)) fail(REGISTRY, path, `duplicates chain id ${chainId}`);
    if (!isRecord(entry)) fail(REGISTRY, path, 'must be an object');
    const unknown = Object.keys(entry).filter((k) => !(CHAIN_KEYS as readonly string[]).includes(k));
    if (unknown[0] !== undefined) {
      fail(REGISTRY, `${path}.${unknown[0]}`, `is not a known key (allowed: ${CHAIN_KEYS.join(', ')})`);
    }

    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      fail(REGISTRY, `${path}.name`, 'must be a non-empty string');
    }
    if (typeof entry.testnet !== 'boolean') fail(REGISTRY, `${path}.testnet`, 'must be true or false');
    if (!(STATUSES as readonly unknown[]).includes(entry.status)) {
      fail(
        REGISTRY,
        `${path}.status`,
        `must be one of ${STATUSES.join(' | ')} (got ${JSON.stringify(entry.status)})`,
      );
    }
    const status = entry.status as RegistryChain['status'];
    let chain: RegistryChain = {
      chainId,
      name: entry.name.trim(),
      rpcUrl: httpUrl(REGISTRY, `${path}.rpcUrl`, entry.rpcUrl),
      testnet: entry.testnet,
      status,
    };
    if (entry.explorerUrl !== undefined) {
      chain = { ...chain, explorerUrl: httpUrl(REGISTRY, `${path}.explorerUrl`, entry.explorerUrl) };
    }
    if (entry.addresses !== undefined) {
      if (status !== 'deployed') {
        fail(
          REGISTRY,
          `${path}.addresses`,
          `given for a chain with status "${status}" — set status to "deployed"`,
        );
      }
      if (!isRecord(entry.addresses)) fail(REGISTRY, `${path}.addresses`, 'must be an object');
      chain = { ...chain, addresses: readAddresses(REGISTRY, `${path}.addresses`, entry.addresses, true) };
    }
    byId.set(chainId, chain);
  }
  if (byId.size === 0) fail(REGISTRY, 'chains', 'must list at least one chain');

  if (input.localText !== undefined) {
    let local: unknown;
    try {
      local = JSON.parse(input.localText);
    } catch (err) {
      throw new RegistryError(`${LOCAL}: invalid JSON (${(err as Error).message})`);
    }
    if (!isRecord(local)) fail(LOCAL, '(root)', 'must be an object');
    if (typeof local.chainId !== 'number') {
      fail(LOCAL, 'chainId', `must be a number (got ${JSON.stringify(local.chainId)})`);
    }
    const chainId = parseChainId(LOCAL, 'chainId', local.chainId);
    const base = byId.get(chainId);
    if (base === undefined) {
      fail(LOCAL, 'chainId', `${chainId} has no entry in ${REGISTRY} — add it under chains.${chainId} first`);
    }
    // The local file carries chainId/rpcUrl next to the addresses (DemoLocal.s.sol writes it flat),
    // so extra keys are tolerated here and only the nine address keys are taken.
    byId.set(chainId, {
      ...base,
      status: 'deployed',
      local: true,
      rpcUrl: httpUrl(LOCAL, 'rpcUrl', local.rpcUrl),
      addresses: readAddresses(LOCAL, '', local, false),
    });
  }

  for (const chain of byId.values()) {
    if (chain.status === 'deployed' && chain.addresses === undefined) {
      fail(
        REGISTRY,
        `chains.${chain.chainId}.addresses`,
        `is missing for a "deployed" chain (add addresses, or provide ${LOCAL} with chainId ${chain.chainId})`,
      );
    }
  }

  return [...byId.values()].sort((a, b) => a.chainId - b.chainId);
}

export interface SelectOptions {
  /** Explicitly requested chain (env `CHAIN_ID`). Wins over everything else. */
  readonly chainId?: number | undefined;
  /** Prefer the `local` entry over the first deployed chain. Default true. */
  readonly preferLocal?: boolean | undefined;
  /** File name used in error messages; default `deployments.json`. */
  readonly registryLabel?: string;
}

/**
 * Which registry chain the keeper acts on:
 *   1. `chainId` (env `CHAIN_ID`) when given — it must be listed AND deployed;
 *   2. otherwise the `local` entry (the demo stack), unless `preferLocal: false`;
 *   3. otherwise the first `deployed` chain in ascending chain-id order.
 * A `planned` chain is never selected: it has no vault to act on.
 */
export function selectChain(
  chains: readonly RegistryChain[],
  opts: SelectOptions = {},
): RegistryChain & { readonly addresses: Readonly<Record<AddressKey, Address>> } {
  const REGISTRY = opts.registryLabel ?? REGISTRY_FILE;
  const deployed = chains.filter(
    (c): c is RegistryChain & { addresses: Record<AddressKey, Address> } =>
      c.status === 'deployed' && c.addresses !== undefined,
  );
  const listDeployed = deployed.length > 0 ? deployed.map((c) => c.chainId).join(', ') : 'none';

  if (opts.chainId !== undefined) {
    const entry = chains.find((c) => c.chainId === opts.chainId);
    if (entry === undefined) {
      throw new RegistryError(
        `chain ${opts.chainId} is not in ${REGISTRY} (listed: ${chains.map((c) => c.chainId).join(', ')}) — ` +
          'add it to the registry, or set RPC_URL and VAULT_ADDRESS explicitly',
      );
    }
    const hit = deployed.find((c) => c.chainId === opts.chainId);
    if (hit === undefined) {
      throw new RegistryError(
        `chain ${opts.chainId} is planned — no deployment to act on ` +
          `(${REGISTRY} lists "${entry.name}" with status "${entry.status}"; deployed: ${listDeployed})`,
      );
    }
    return hit;
  }

  if (opts.preferLocal ?? true) {
    const local = deployed.find((c) => c.local === true);
    if (local !== undefined) return local;
  }
  const first = deployed[0];
  if (first === undefined) {
    throw new RegistryError(
      `${REGISTRY}: chains has no deployed chain to act on (every entry is "planned") — ` +
        'deploy first, or set CHAIN_ID, RPC_URL and VAULT_ADDRESS explicitly',
    );
  }
  return first;
}
