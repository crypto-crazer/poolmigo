/**
 * Configuration: environment -> validated `KeeperConfig`.
 *
 * `parseConfig` is pure (env record + the resolved registry entry in, config out) so the defaults
 * and the parsers are unit testable; `loadConfig` is the thin IO wrapper that reads the chain
 * registry (`shared/deployments.json` + the `deployment.local.json` overlay) and the key file.
 *
 * Chain selection (see `pickRegistryEntry` / `selectChain`): env `CHAIN_ID` > the registry's local
 * entry > the first deployed chain; per value, env `CHAIN_ID` / `RPC_URL` / `VAULT_ADDRESS` beat the
 * registry entry. With all three set in env the registry is optional (container story).
 *
 * SECRETS: `keeperPrivateKey` is the only sensitive field. It is never logged — `describeConfig`
 * exists precisely so that "log the config at startup" cannot leak it. See README for the
 * production story (secret manager / keystore / remote signer).
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLogLevel, type LogLevel } from './logger.js';
import {
  ADDRESS_RE,
  LOCAL_FILE,
  RegistryError,
  buildRegistry,
  selectChain,
  type RegistryChain,
} from './registry.js';
import type { Address, Hex } from './types.js';

export { ADDRESS_RE };
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** Weights aligned positionally to `vault.adapters()`, keyed by address, or "spread equally". */
export type AdapterWeightSpec =
  | { readonly kind: 'equal' }
  | { readonly kind: 'positional'; readonly weights: readonly bigint[] }
  | { readonly kind: 'byAddress'; readonly weights: ReadonlyMap<string, bigint> };

export interface MinDeploySpec {
  readonly fallback: bigint;
  readonly byToken: ReadonlyMap<string, bigint>;
}

/** What the keeper knows about the chain it acts on, beyond its id. */
export interface ChainMeta {
  /** Registry name, or `Chain <id>` when the chain is not in the registry (env-only config). */
  readonly name: string;
  /**
   * Registry status of `chainId`; `null` when the registry does not list it (or is absent). Can be
   * `planned` only when env supplied CHAIN_ID + RPC_URL + VAULT_ADDRESS itself — see README.
   */
  readonly status: RegistryChain['status'] | null;
  /** The registry entry was overlaid by `deployment.local.json` (the local demo stack). */
  readonly local: boolean;
  /** Registry `testnet` flag; `null` when the chain is not in the registry. */
  readonly testnet: boolean | null;
}

export interface KeeperConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly chain: ChainMeta;
  readonly vaultAddress: Address;

  readonly dryRun: boolean;
  readonly tickIntervalSec: number;
  readonly rebalanceIntervalSec: number;

  readonly targetIdleBps: number;
  readonly maxDeployPerTickBps: number;
  readonly adapterWeights: AdapterWeightSpec;
  readonly minDeploy: MinDeploySpec;

  readonly stateFile: string;
  readonly logLevel: LogLevel;

  readonly confirmations: number;
  readonly txTimeoutSec: number;
  readonly rpcMaxRetries: number;
  readonly rpcBackoffBaseMs: number;

  /**
   * Address the keeper acts as. Derived from the private key when one is configured; otherwise it
   * comes from `KEEPER_ADDRESS`, which enables a signer-less dry-run monitor.
   */
  readonly keeperAddress: Address | null;

  /** Never log this. `null` is valid: a read-only / dry-run keeper needs no signer. */
  readonly keeperPrivateKey: Hex | null;
}

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * Subset of a flat deployment file (`deployment.local.json` shape) the keeper consumes. Used only
 * when there is no registry on disk — with a registry, the file is merged into it instead.
 */
export interface DeploymentFile {
  readonly vault?: string;
  readonly chainId?: number;
  readonly rpcUrl?: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/* ----------------------------------- primitive parsers ----------------------------------- */

function str(env: EnvRecord, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function parseBool(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  const v = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got "${value}"`);
}

export function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  bounds: { min: number; max: number },
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${name} must be a non-negative integer, got "${value}"`);
  }
  const n = Number(value);
  if (n < bounds.min || n > bounds.max) {
    throw new ConfigError(`${name} must be in [${bounds.min}, ${bounds.max}], got ${n}`);
  }
  return n;
}

export function parseAddress(value: string, name: string): Address {
  if (!ADDRESS_RE.test(value)) {
    throw new ConfigError(`${name} must be a 0x-prefixed 20-byte address, got "${value}"`);
  }
  return value as Address;
}

function parseBigUint(value: string, name: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${name} must be a non-negative integer in raw units, got "${value}"`);
  }
  return BigInt(value);
}

/**
 * ADAPTER_WEIGHTS. Accepts:
 *   (unset)                       -> equal weights across whatever `adapters()` returns
 *   "1,3"                         -> positional, aligned to `adapters()` order
 *   "0xAdapterA:1,0xAdapterB:3"   -> keyed by adapter address (recommended)
 *
 * Address-keyed is recommended because `removeAdapter` uses swap-and-pop: positional weights
 * silently re-target themselves when an adapter is removed.
 */
export function parseAdapterWeights(value: string | undefined): AdapterWeightSpec {
  if (value === undefined) return { kind: 'equal' };
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return { kind: 'equal' };

  const keyed = parts.some((p) => p.includes(':'));
  if (!keyed) {
    const weights = parts.map((p) => parseBigUint(p, 'ADAPTER_WEIGHTS'));
    if (weights.every((w) => w === 0n)) {
      throw new ConfigError('ADAPTER_WEIGHTS must not be all zero');
    }
    return { kind: 'positional', weights };
  }

  const weights = new Map<string, bigint>();
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx < 0) {
      throw new ConfigError(
        `ADAPTER_WEIGHTS mixes keyed and positional entries near "${part}" — use one form`,
      );
    }
    const address = parseAddress(part.slice(0, idx).trim(), 'ADAPTER_WEIGHTS adapter');
    const weight = parseBigUint(part.slice(idx + 1).trim(), `ADAPTER_WEIGHTS[${address}]`);
    if (weights.has(address.toLowerCase())) {
      throw new ConfigError(`ADAPTER_WEIGHTS lists ${address} twice`);
    }
    weights.set(address.toLowerCase(), weight);
  }
  if ([...weights.values()].every((w) => w === 0n)) {
    throw new ConfigError('ADAPTER_WEIGHTS must not be all zero');
  }
  return { kind: 'byAddress', weights };
}

/**
 * MIN_DEPLOY_AMOUNT_RAW. Accepts:
 *   (unset) / "0"                          -> 0 for every token
 *   "1000000"                              -> same raw floor for every token
 *   "default:0,0xToken:1000000"            -> per-token floors + optional fallback
 * Per-token form matters in practice: basket tokens have different decimals, so one raw scalar
 * is either meaningless for the 6-decimal token or absurd for the 18-decimal one.
 */
export function parseMinDeploy(value: string | undefined): MinDeploySpec {
  if (value === undefined) return { fallback: 0n, byToken: new Map() };
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return { fallback: 0n, byToken: new Map() };

  if (parts.length === 1 && !parts[0]!.includes(':')) {
    return { fallback: parseBigUint(parts[0]!, 'MIN_DEPLOY_AMOUNT_RAW'), byToken: new Map() };
  }

  let fallback = 0n;
  const byToken = new Map<string, bigint>();
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx < 0) {
      throw new ConfigError(
        `MIN_DEPLOY_AMOUNT_RAW mixes keyed and scalar entries near "${part}" — use one form`,
      );
    }
    const lhs = part.slice(0, idx).trim();
    const rhs = part.slice(idx + 1).trim();
    if (lhs.toLowerCase() === 'default') {
      fallback = parseBigUint(rhs, 'MIN_DEPLOY_AMOUNT_RAW[default]');
      continue;
    }
    const token = parseAddress(lhs, 'MIN_DEPLOY_AMOUNT_RAW token');
    if (byToken.has(token.toLowerCase())) {
      throw new ConfigError(`MIN_DEPLOY_AMOUNT_RAW lists ${token} twice`);
    }
    byToken.set(token.toLowerCase(), parseBigUint(rhs, `MIN_DEPLOY_AMOUNT_RAW[${token}]`));
  }
  return { fallback, byToken };
}

function parsePrivateKey(value: string, source: string): Hex {
  const v = value.trim();
  const withPrefix = v.startsWith('0x') ? v : `0x${v}`;
  if (!PRIVATE_KEY_RE.test(withPrefix)) {
    // Deliberately does not echo the value.
    throw new ConfigError(`${source} must be a 32-byte hex private key`);
  }
  return withPrefix as Hex;
}

/* ------------------------------------- config assembly ------------------------------------- */

export interface ParseOptions {
  /**
   * The registry entry `loadConfig` resolved for this run (see `pickRegistryEntry`): supplies the
   * chain's name/flags, and the fallback rpcUrl / vault / chainId for whatever env leaves unset.
   */
  readonly chain?: RegistryChain | undefined;
  /** A flat deployment file — consulted only when there is no registry entry (no registry on disk). */
  readonly deployment?: DeploymentFile | undefined;
  /** Private key already read from `KEEPER_KEY_FILE`, when that var was set. */
  readonly keyFileContents?: string | undefined;
}

function parseChainIdEnv(env: EnvRecord): number | undefined {
  const raw = str(env, 'CHAIN_ID');
  return raw === undefined
    ? undefined
    : parseInteger(raw, 0, 'CHAIN_ID', { min: 1, max: Number.MAX_SAFE_INTEGER });
}

/** True when env alone names the chain, the RPC and the vault — the registry is then optional. */
export function envSuppliesChain(env: EnvRecord): boolean {
  return (
    str(env, 'CHAIN_ID') !== undefined &&
    str(env, 'RPC_URL') !== undefined &&
    str(env, 'VAULT_ADDRESS') !== undefined
  );
}

/**
 * Pure: the registry entry this run acts on.
 *  - env supplies CHAIN_ID + RPC_URL + VAULT_ADDRESS: env is authoritative, the registry only names
 *    the chain — its entry for CHAIN_ID if it lists one (any status), else `undefined`;
 *  - otherwise `selectChain`: env `CHAIN_ID` > the local entry > the first deployed chain, and a
 *    `planned` or unlisted CHAIN_ID is an error.
 * @throws RegistryError when no deployed chain can be selected.
 */
export function pickRegistryEntry(
  env: EnvRecord,
  chains: readonly RegistryChain[],
  registryLabel?: string,
): RegistryChain | undefined {
  const chainId = parseChainIdEnv(env);
  if (envSuppliesChain(env)) return chains.find((c) => c.chainId === chainId);
  return selectChain(chains, {
    chainId,
    preferLocal: true,
    ...(registryLabel !== undefined ? { registryLabel } : {}),
  });
}

export function parseConfig(env: EnvRecord, opts: ParseOptions = {}): KeeperConfig {
  const entry = opts.chain;
  // A flat deployment file is the no-registry fallback; with a registry entry it is never mixed in.
  const deployment = entry === undefined ? opts.deployment : undefined;

  const rpcUrl = str(env, 'RPC_URL') ?? entry?.rpcUrl ?? deployment?.rpcUrl;
  if (rpcUrl === undefined) {
    throw new ConfigError(
      'RPC_URL is required (no rpcUrl in the chain registry or the deployment file either)',
    );
  }

  const vaultRaw = str(env, 'VAULT_ADDRESS') ?? entry?.addresses?.vault ?? deployment?.vault;
  if (vaultRaw === undefined) {
    throw new ConfigError(
      'VAULT_ADDRESS is required (set it, or point DEPLOYMENTS_FILE at a registry with a deployed chain)',
    );
  }
  const vaultAddress = parseAddress(vaultRaw, 'VAULT_ADDRESS');

  const chainId = parseChainIdEnv(env) ?? entry?.chainId ?? deployment?.chainId;
  if (chainId === undefined) {
    throw new ConfigError(
      'CHAIN_ID is required (no chain in the chain registry or the deployment file either)',
    );
  }
  if (entry !== undefined && entry.chainId !== chainId) {
    // pickRegistryEntry never produces this; a caller wiring parseConfig by hand might.
    throw new ConfigError(
      `CHAIN_ID ${chainId} does not match the registry entry passed in (chain ${entry.chainId})`,
    );
  }
  const chain: ChainMeta =
    entry !== undefined
      ? { name: entry.name, status: entry.status, local: entry.local === true, testnet: entry.testnet }
      : { name: `Chain ${chainId}`, status: null, local: false, testnet: null };

  const targetIdleBps = parseInteger(str(env, 'TARGET_IDLE_BPS'), 2000, 'TARGET_IDLE_BPS', {
    min: 0,
    max: 10_000,
  });
  const maxDeployPerTickBps = parseInteger(
    str(env, 'MAX_DEPLOY_PER_TICK_BPS'),
    5000,
    'MAX_DEPLOY_PER_TICK_BPS',
    { min: 0, max: 10_000 },
  );

  const logLevelRaw = (str(env, 'LOG_LEVEL') ?? 'info').toLowerCase();
  if (!isLogLevel(logLevelRaw)) {
    throw new ConfigError(`LOG_LEVEL must be one of debug|info|warn|error, got "${logLevelRaw}"`);
  }

  let keeperPrivateKey: Hex | null = null;
  const inlineKey = str(env, 'KEEPER_PRIVATE_KEY');
  const keyFile = str(env, 'KEEPER_KEY_FILE');
  if (inlineKey !== undefined && keyFile !== undefined) {
    throw new ConfigError('set only one of KEEPER_PRIVATE_KEY or KEEPER_KEY_FILE');
  }
  if (inlineKey !== undefined) {
    keeperPrivateKey = parsePrivateKey(inlineKey, 'KEEPER_PRIVATE_KEY');
  } else if (keyFile !== undefined) {
    if (opts.keyFileContents === undefined) {
      throw new ConfigError(`KEEPER_KEY_FILE is set (${keyFile}) but the file could not be read`);
    }
    keeperPrivateKey = parsePrivateKey(opts.keyFileContents, `KEEPER_KEY_FILE (${keyFile})`);
  }

  const keeperAddressRaw = str(env, 'KEEPER_ADDRESS');
  const keeperAddress =
    keeperAddressRaw !== undefined ? parseAddress(keeperAddressRaw, 'KEEPER_ADDRESS') : null;
  if (keeperAddress === null && keeperPrivateKey === null) {
    throw new ConfigError(
      'no keeper identity: set KEEPER_PRIVATE_KEY / KEEPER_KEY_FILE to act, or KEEPER_ADDRESS for a signer-less dry-run',
    );
  }

  return {
    rpcUrl,
    chainId,
    chain,
    vaultAddress,
    dryRun: parseBool(str(env, 'DRY_RUN'), true, 'DRY_RUN'),
    tickIntervalSec: parseInteger(str(env, 'TICK_INTERVAL_SEC'), 60, 'TICK_INTERVAL_SEC', {
      min: 1,
      max: 86_400,
    }),
    rebalanceIntervalSec: parseInteger(
      str(env, 'REBALANCE_INTERVAL_SEC'),
      86_400,
      'REBALANCE_INTERVAL_SEC',
      { min: 0, max: 31_536_000 },
    ),
    targetIdleBps,
    maxDeployPerTickBps,
    adapterWeights: parseAdapterWeights(str(env, 'ADAPTER_WEIGHTS')),
    minDeploy: parseMinDeploy(str(env, 'MIN_DEPLOY_AMOUNT_RAW')),
    stateFile: str(env, 'STATE_FILE') ?? '.keeper-state.json',
    logLevel: logLevelRaw,
    confirmations: parseInteger(str(env, 'CONFIRMATIONS'), 1, 'CONFIRMATIONS', { min: 0, max: 64 }),
    txTimeoutSec: parseInteger(str(env, 'TX_TIMEOUT_SEC'), 120, 'TX_TIMEOUT_SEC', {
      min: 5,
      max: 3600,
    }),
    rpcMaxRetries: parseInteger(str(env, 'RPC_MAX_RETRIES'), 4, 'RPC_MAX_RETRIES', {
      min: 0,
      max: 10,
    }),
    rpcBackoffBaseMs: parseInteger(str(env, 'RPC_BACKOFF_BASE_MS'), 500, 'RPC_BACKOFF_BASE_MS', {
      min: 10,
      max: 60_000,
    }),
    keeperAddress,
    keeperPrivateKey,
  };
}

/** Default location of the monorepo chain registry, relative to this source file. */
export function defaultRegistryPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../shared/deployments.json');
}

/**
 * Read a config file. A missing file is `undefined` unless `required` (the operator named it and
 * the run depends on it); a file that exists but cannot be read is always an error.
 */
function readOptionalFile(path: string, varName: string, required: boolean): string | undefined {
  if (!existsSync(path)) {
    if (required) throw new ConfigError(`${varName} ${path} could not be read: no such file`);
    return undefined; // optional (e.g. inside a container, where env supplies the chain)
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `${varName} ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** No-registry fallback: a flat deployment file, as the keeper read it before the registry. */
function parseDeploymentFile(path: string, text: string): DeploymentFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`DEPLOYMENT_FILE ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigError(`DEPLOYMENT_FILE ${path} is not a JSON object`);
  }
  return parsed as DeploymentFile;
}

/** Where the registry and its local overlay live for this env. */
export function registryPaths(
  env: EnvRecord,
  defaultRegistry: string = defaultRegistryPath(),
): {
  readonly registry: string;
  readonly overlay: string;
  readonly registryExplicit: boolean;
  readonly overlayExplicit: boolean;
} {
  const registryEnv = str(env, 'DEPLOYMENTS_FILE');
  const overlayEnv = str(env, 'DEPLOYMENT_FILE');
  const registry = registryEnv ?? defaultRegistry;
  return {
    registry,
    overlay: overlayEnv ?? join(dirname(registry), LOCAL_FILE),
    registryExplicit: registryEnv !== undefined,
    overlayExplicit: overlayEnv !== undefined,
  };
}

/**
 * Resolve the config from `process.env`: read the chain registry + local overlay (both optional
 * when env supplies the whole chain), select the chain, read the key file, then `parseConfig`.
 * `defaultRegistry` exists for tests (a checkout without `shared/`); the CLI never passes it.
 */
export function loadConfig(
  env: EnvRecord = process.env,
  defaultRegistry: string = defaultRegistryPath(),
): KeeperConfig {
  const paths = registryPaths(env, defaultRegistry);
  // An explicitly named file is required only when the run actually depends on it.
  const needsFiles = !envSuppliesChain(env);
  const registryText = readOptionalFile(
    paths.registry,
    'DEPLOYMENTS_FILE',
    paths.registryExplicit && needsFiles,
  );
  const overlayText = readOptionalFile(
    paths.overlay,
    'DEPLOYMENT_FILE',
    paths.overlayExplicit && needsFiles,
  );

  let chain: RegistryChain | undefined;
  let deployment: DeploymentFile | undefined;
  if (registryText !== undefined) {
    const registryLabel = basename(paths.registry);
    try {
      const chains = buildRegistry({
        registryText,
        localText: overlayText,
        registryLabel,
        localLabel: basename(paths.overlay),
      });
      chain = pickRegistryEntry(env, chains, registryLabel);
    } catch (err) {
      // Registry problems are configuration problems: exit 2, not a generic fatal.
      if (err instanceof RegistryError) throw new ConfigError(err.message);
      throw err;
    }
  } else if (overlayText !== undefined) {
    // No registry on disk but a flat deployment file: the pre-registry behaviour, unchanged.
    deployment = parseDeploymentFile(paths.overlay, overlayText);
  }

  let keyFileContents: string | undefined;
  const keyFile = str(env, 'KEEPER_KEY_FILE');
  if (keyFile !== undefined) {
    try {
      keyFileContents = readFileSync(keyFile, 'utf8');
    } catch {
      keyFileContents = undefined; // parseConfig raises the user-facing error
    }
  }

  return parseConfig(env, { chain, deployment, keyFileContents });
}

/** Loggable view of the config. Never includes the private key. */
export function describeConfig(cfg: KeeperConfig): Record<string, unknown> {
  return {
    rpcUrl: cfg.rpcUrl,
    chainId: cfg.chainId,
    chain: cfg.chain.name,
    chainStatus: cfg.chain.status ?? 'not-in-registry',
    chainLocal: cfg.chain.local,
    chainTestnet: cfg.chain.testnet,
    vault: cfg.vaultAddress,
    dryRun: cfg.dryRun,
    tickIntervalSec: cfg.tickIntervalSec,
    rebalanceIntervalSec: cfg.rebalanceIntervalSec,
    targetIdleBps: cfg.targetIdleBps,
    maxDeployPerTickBps: cfg.maxDeployPerTickBps,
    adapterWeights: describeWeights(cfg.adapterWeights),
    minDeployDefault: cfg.minDeploy.fallback,
    minDeployByToken: Object.fromEntries(cfg.minDeploy.byToken),
    stateFile: cfg.stateFile,
    logLevel: cfg.logLevel,
    confirmations: cfg.confirmations,
    keeperAddressOverride: cfg.keeperAddress,
    signer: cfg.keeperPrivateKey === null ? 'absent' : 'configured',
  };
}

function describeWeights(spec: AdapterWeightSpec): unknown {
  switch (spec.kind) {
    case 'equal':
      return 'equal';
    case 'positional':
      return spec.weights;
    case 'byAddress':
      return Object.fromEntries(spec.weights);
  }
}

/**
 * Resolve the weight spec against the adapter list discovered on-chain.
 * @throws if a positional spec does not match the number of registered adapters.
 */
export function resolveAdapterWeights(
  spec: AdapterWeightSpec,
  adapters: readonly Address[],
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  switch (spec.kind) {
    case 'equal':
      for (const a of adapters) out.set(a.toLowerCase(), 1n);
      return out;
    case 'positional': {
      if (spec.weights.length !== adapters.length) {
        throw new ConfigError(
          `ADAPTER_WEIGHTS has ${spec.weights.length} entries but the vault has ${adapters.length} registered adapters — ` +
            'use the 0xAdapter:weight form to stay robust against adapter registry changes',
        );
      }
      adapters.forEach((a, i) => out.set(a.toLowerCase(), spec.weights[i] ?? 0n));
      return out;
    }
    case 'byAddress': {
      for (const a of adapters) out.set(a.toLowerCase(), spec.weights.get(a.toLowerCase()) ?? 0n);
      return out;
    }
  }
}
