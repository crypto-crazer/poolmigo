/**
 * Guard: the frontend is viem-only.
 *
 * wagmi was removed on purpose — one chain library, not two — and nothing should quietly bring it
 * back as a direct dependency or as a `wagmi/*` import. This test is the tripwire.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('viem-only', () => {
  it('package.json does not depend on wagmi', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).filter((name) => name === 'wagmi' || name.startsWith('@wagmi/'))).toEqual([]);
  });

  it('still depends on viem', () => {
    expect(pkg.dependencies?.viem).toBeTruthy();
  });

  it('no source file imports wagmi', () => {
    const offenders = sourceFiles(join(root, 'src'))
      .concat(sourceFiles(join(root, 'scripts')))
      .filter((file) => /from\s+['"]wagmi(\/[^'"]*)?['"]|from\s+['"]@wagmi\//.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(root.length));
    expect(offenders).toEqual([]);
  });

  it('never hardcodes a WalletConnect project id', () => {
    const wc = readFileSync(join(root, 'src/wallet/walletconnect.ts'), 'utf8');
    expect(wc).toContain('import.meta.env.VITE_WALLETCONNECT_PROJECT_ID');
    // A project id is a 32-char hex string; none may be baked into the source.
    expect(/['"][0-9a-f]{32}['"]/.test(wc)).toBe(false);
  });
});
