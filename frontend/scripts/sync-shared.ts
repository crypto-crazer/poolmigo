/**
 * sync:shared — regenerate `src/config/generated.ts` from the monorepo's `shared/` directory.
 *
 * Inputs:
 *   - `shared/deployments.json` — the multi-chain registry: every chain the app knows, and the
 *     addresses of every chain Poolmigo is deployed on. Adding a chain = one entry there + this.
 *   - `shared/deployment.local.json` — the local demo stack (written by DemoLocal.s.sol). Overlaid
 *     on the registry entry with the same chain id: deployed, `local: true`, its rpcUrl + addresses.
 *   - `shared/abis/*.json` — the ABIs.
 * Nothing in the frontend may hand-copy any of them. The emitted file IS committed so `pnpm build`
 * works standalone (e.g. CI without the contracts checkout).
 *
 * Validation lives in ./registry.ts and throws with the offending path/key.
 *
 * Usage: pnpm sync:shared
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADDRESS_KEYS, buildRegistry, type RegistryChain } from './registry';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..');
const sharedDir = resolve(frontend, '..', 'shared');
const outFile = resolve(frontend, 'src/config/generated.ts');

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readText(path));
  } catch (err) {
    throw new Error(`cannot parse ${path}: ${(err as Error).message}`);
  }
}

/** ABI files are plain arrays; keep only the entries a frontend can use. */
function readAbi(name: string): unknown[] {
  const abi = readJson(resolve(sharedDir, 'abis', `${name}.json`));
  if (!Array.isArray(abi)) throw new Error(`abis/${name}.json: expected a top-level array`);
  return abi;
}

const localPath = resolve(sharedDir, 'deployment.local.json');
const chains = buildRegistry({
  registryText: readText(resolve(sharedDir, 'deployments.json')),
  localText: existsSync(localPath) ? readText(localPath) : undefined,
});
const vaultAbi = readAbi('PoolmigoVaultUpgradeable');
const mockTokenAbi = readAbi('MockToken');
const mockAdapterAbi = readAbi('MockPositionAdapter');
const positionAdapterAbi = readAbi('IPositionAdapter');

const lit = (v: unknown) => JSON.stringify(v, null, 2);

/** Chain metadata only — what every registry chain has, deployed or not. */
function meta(c: RegistryChain) {
  return {
    chainId: c.chainId,
    name: c.name,
    rpcUrl: c.rpcUrl,
    testnet: c.testnet,
    ...(c.explorerUrl ? { explorerUrl: c.explorerUrl } : {}),
    status: c.status,
    ...(c.local ? { local: true } : {}),
  };
}

const deployments = chains
  .filter((c) => c.status === 'deployed')
  .map((c) => ({ ...meta(c), ...c.addresses }));

const addressFields = ADDRESS_KEYS.map((k) => `  ${k}: \`0x\${string}\`;`).join('\n');

const out = `/**
 * AUTO-GENERATED — DO NOT EDIT.
 * Source: ../../shared/deployments.json + ../../shared/deployment.local.json + ../../shared/abis/*.json
 * Regenerate with: pnpm sync:shared
 * Generated from ${chains.length} registry chains and ${vaultAbi.length} vault ABI entries.
 */

/** What every chain in shared/deployments.json carries, deployed or not. */
export interface ChainMeta {
  chainId: number;
  name: string;
  rpcUrl: string;
  testnet: boolean;
  /** Block explorer base URL, when the registry lists one. */
  explorerUrl?: string;
}

/** 'planned' = a known chain with no Poolmigo deployment yet; 'deployed' = has addresses. */
export type ChainStatus = 'planned' | 'deployed';

/** A registry chain as the app sees it. \`local\` marks the demo stack from deployment.local.json. */
export interface ChainEntry extends ChainMeta {
  status: ChainStatus;
  local?: true;
}

/** A chain Poolmigo is deployed on, with the full address set. */
export interface ChainDeployment extends ChainMeta {
  status: 'deployed';
  local?: true;
${addressFields}
}

/** Every registry chain, ascending chain id. */
export const CHAINS: readonly ChainEntry[] = ${lit(chains.map(meta))};

/** Deployed chains only, with addresses. The local entry comes from shared/deployment.local.json. */
export const DEPLOYMENTS: readonly ChainDeployment[] = ${lit(deployments)};

/** PoolmigoVaultUpgradeable — vault core + ERC-20 migoLP surface + custom errors. */
export const vaultAbi = ${lit(vaultAbi)} as const;

/** MockToken — a plain ERC-20 plus a public \`mint\` (local demo stack only). */
export const mockTokenAbi = ${lit(mockTokenAbi)} as const;

/** IPositionAdapter — the venue-agnostic adapter surface every adapter implements. */
export const positionAdapterAbi = ${lit(positionAdapterAbi)} as const;

/** MockPositionAdapter — adds \`deployed(i)\` / \`harvestable(i)\` on top of IPositionAdapter. */
export const mockAdapterAbi = ${lit(mockAdapterAbi)} as const;
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, out);
console.log(`sync:shared → ${outFile}`);
console.log(`  chains: ${chains.map((c) => c.chainId).join(', ')}`);
for (const c of chains) {
  const tag = c.local ? 'deployed · LOCAL (deployment.local.json)' : c.status;
  const where = c.addresses ? ` · vault ${c.addresses.vault}` : '';
  console.log(`    ${String(c.chainId).padEnd(8)} ${c.name} — ${tag}${where} · rpc ${c.rpcUrl}`);
}
if (!existsSync(localPath)) console.log('  (no shared/deployment.local.json — no local chain)');
console.log(`  abis: vault(${vaultAbi.length}) mockToken(${mockTokenAbi.length}) adapter(${positionAdapterAbi.length}) mockAdapter(${mockAdapterAbi.length})`);
