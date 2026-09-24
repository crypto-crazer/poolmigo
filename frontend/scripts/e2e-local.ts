/**
 * e2e:local — exercise the deployed vault end to end with viem, straight against the local Anvil
 * node. No React, no UI framework: this is the ground truth the UI is checked against.
 *
 *   read vault → mint mock tokens → approve → previewDeposit → deposit → previewRedeem → redeem half
 *
 * Every step asserts that the chain moved exactly as the contract promises (shares minted equal the
 * preview, only the REQUIRED amount is pulled even though more was offered, redeem returns the
 * previewed basket, totals and supply move by the same deltas).
 *
 * LOCAL ONLY. The key below is Anvil dev account #2 — a publicly known test key with no value on any
 * real network. The script refuses to run against anything that is not a local RPC on the expected
 * chain id.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { vaultAbi, mockTokenAbi, positionAdapterAbi } from '../src/config/generated';
import { chainFor, deploymentForChain, type ChainDeployment } from '../src/chain/chains';

/** The local demo stack's chain id (Anvil runs with the RHC testnet id). */
const LOCAL_CHAIN_ID = 46630;

/** The registry's local entry — the one overlaid from shared/deployment.local.json. */
function localDeployment(): ChainDeployment {
  const d = deploymentForChain(LOCAL_CHAIN_ID);
  if (!d?.local) throw new Error(`no local deployment for chain ${LOCAL_CHAIN_ID} — run pnpm sync:shared after DemoLocal.s.sol`);
  return d;
}
const LOCAL_DEPLOYMENT = localDeployment();

/** Anvil dev account #2 — public, well-known, LOCAL ONLY. Never fund this on a real network. */
const ANVIL_ACCOUNT_2_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex;
const EXPECTED_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const RPC = LOCAL_DEPLOYMENT.rpcUrl;
const VAULT = LOCAL_DEPLOYMENT.vault as Address;
const SLIPPAGE_BPS = 50n; // 0.50%, the UI default

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(new URL(RPC).origin)) {
  throw new Error(`refusing to run: ${RPC} is not a local RPC (this script uses a public test key)`);
}

// The same registry-built chain the app uses (rpc from deployment.local.json).
const chain = chainFor(LOCAL_CHAIN_ID)!;

const account = privateKeyToAccount(ANVIL_ACCOUNT_2_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

/* ------------------------------------- tiny test harness ------------------------------------- */

let checks = 0;
function assert(condition: boolean, label: string, detail?: string): void {
  checks++;
  if (!condition) {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    throw new Error(`assertion failed: ${label}`);
  }
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Adaptive precision, same rule as the UI: small migoLP slices stay readable. */
function fmt(value: bigint, decimals: number, sig = 6): string {
  const base = 10n ** BigInt(decimals);
  const int = (value / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let digits = sig;
  if (value > 0n && value < base) {
    let probe = value * 10n;
    while (probe < base && digits < decimals) {
      digits++;
      probe *= 10n;
    }
  }
  const frac = (value % base).toString().padStart(decimals, '0').slice(0, digits).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

function ascii(hex: string): string {
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);
}

async function send(hash: Hex, label: string): Promise<Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted (${hash})`);
  return receipt;
}

/* ----------------------------------------- the run ------------------------------------------- */

async function main(): Promise<void> {
  console.log('Poolmigo frontend e2e — local Anvil');
  console.log(`rpc ${RPC} · chain ${LOCAL_DEPLOYMENT.chainId} · vault ${VAULT}`);
  console.log(`account #2 ${account.address}`);

  assert(account.address.toLowerCase() === EXPECTED_ADDRESS.toLowerCase(), 'signer is Anvil account #2');
  const liveChainId = await publicClient.getChainId();
  assert(liveChainId === LOCAL_DEPLOYMENT.chainId, 'chain id matches shared/deployment.local.json', String(liveChainId));

  /* ------------------------------------- 1. read the vault ------------------------------------ */
  section('1. read the vault');

  const vault = { address: VAULT, abi: vaultAbi } as const;
  const [name, symbol, decimals, tokens, totalsBefore, supplyBefore, feeBps, paused, adapters] = await Promise.all([
    publicClient.readContract({ ...vault, functionName: 'name' }) as Promise<string>,
    publicClient.readContract({ ...vault, functionName: 'symbol' }) as Promise<string>,
    publicClient.readContract({ ...vault, functionName: 'decimals' }) as Promise<number>,
    publicClient.readContract({ ...vault, functionName: 'tokens' }) as Promise<readonly Address[]>,
    publicClient.readContract({ ...vault, functionName: 'totalTokens' }) as Promise<readonly [readonly Address[], readonly bigint[]]>,
    publicClient.readContract({ ...vault, functionName: 'totalSupply' }) as Promise<bigint>,
    publicClient.readContract({ ...vault, functionName: 'performanceFeeBps' }) as Promise<number>,
    publicClient.readContract({ ...vault, functionName: 'rebalancePaused' }) as Promise<boolean>,
    publicClient.readContract({ ...vault, functionName: 'adapters' }) as Promise<readonly Address[]>,
  ]);

  console.log(`  ${name} (${symbol}), ${decimals} decimals · fee ${feeBps / 100}% · paused ${paused}`);
  assert(tokens.length > 0, 'vault has basket tokens', `${tokens.length} tokens`);
  assert(!paused, 'deposits are not paused');

  const meta = await Promise.all(
    tokens.map(async (address) => ({
      address,
      symbol: (await publicClient.readContract({ address, abi: mockTokenAbi, functionName: 'symbol' })) as string,
      decimals: Number(await publicClient.readContract({ address, abi: mockTokenAbi, functionName: 'decimals' })),
    })),
  );
  for (const [i, t] of meta.entries()) {
    console.log(`  token ${i}: ${t.symbol} (${t.decimals} dp) ${t.address} · total ${fmt(totalsBefore[1][i], t.decimals)}`);
  }
  console.log(`  ${symbol} supply ${fmt(supplyBefore, decimals)} (${supplyBefore} base units)`);

  for (const a of adapters) {
    const [dex, poolId, position] = await Promise.all([
      publicClient.readContract({ address: a, abi: positionAdapterAbi, functionName: 'dex' }) as Promise<Hex>,
      publicClient.readContract({ address: a, abi: positionAdapterAbi, functionName: 'poolId' }) as Promise<Hex>,
      publicClient.readContract({ address: a, abi: positionAdapterAbi, functionName: 'position' }) as Promise<
        readonly [readonly Address[], readonly bigint[]]
      >,
    ]);
    console.log(
      `  adapter ${a} · ${ascii(dex)} · ${ascii(poolId)} · position ${position[1]
        .map((v, i) => `${fmt(v, meta[i]?.decimals ?? 18)} ${meta[i]?.symbol ?? '?'}`)
        .join(' + ')}`,
    );
  }
  assert(adapters.length > 0, 'adapters are registered', `${adapters.length}`);

  /* ------------------------------------ 2. mint test tokens ----------------------------------- */
  section('2. mint mock tokens to account #2');

  const balanceOf = async (token: Address, who: Address) =>
    (await publicClient.readContract({ address: token, abi: mockTokenAbi, functionName: 'balanceOf', args: [who] })) as bigint;

  const mintAmounts = meta.map((t) => 50_000n * 10n ** BigInt(t.decimals));
  for (const [i, t] of meta.entries()) {
    const before = await balanceOf(t.address, account.address);
    const hash = await walletClient.writeContract({
      address: t.address,
      abi: mockTokenAbi,
      functionName: 'mint',
      args: [account.address, mintAmounts[i]],
    });
    await send(hash, `mint ${t.symbol}`);
    const after = await balanceOf(t.address, account.address);
    assert(after - before === mintAmounts[i], `minted ${fmt(mintAmounts[i], t.decimals)} ${t.symbol}`, `balance ${fmt(after, t.decimals)}`);
  }

  /* --------------------------------- 3. previewDeposit + approve ------------------------------ */
  section('3. previewDeposit (offers are maximums)');

  // Deliberately lopsided: plenty of token 0, far more of token 1 than the ratio needs.
  const offered = meta.map((t, i) => (i === 0 ? 10_000n : 10n) * 10n ** BigInt(t.decimals));
  console.log(`  offering ${offered.map((v, i) => `${fmt(v, meta[i].decimals)} ${meta[i].symbol}`).join(' + ')}`);

  const [previewShares, required] = (await publicClient.readContract({
    ...vault,
    functionName: 'previewDeposit',
    args: [tokens, offered],
  })) as readonly [bigint, readonly bigint[]];

  console.log(`  preview: ${fmt(previewShares, decimals)} ${symbol} (${previewShares} base units)`);
  console.log(`  required: ${required.map((v, i) => `${fmt(v, meta[i].decimals)} ${meta[i].symbol}`).join(' + ')}`);
  assert(previewShares > 0n, 'previewDeposit returns a positive share count');
  assert(
    required.every((v, i) => v <= offered[i]),
    'required ≤ offered for every token (excess is never pulled)',
  );
  assert(
    required.some((v, i) => v < offered[i]),
    'at least one token is pulled below the offer — the binding ratio, not the offer, sets the pull',
  );

  section('4. approve the vault');
  for (const [i, t] of meta.entries()) {
    const hash = await walletClient.writeContract({
      address: t.address,
      abi: mockTokenAbi,
      functionName: 'approve',
      args: [VAULT, offered[i]],
    });
    await send(hash, `approve ${t.symbol}`);
    const allowance = (await publicClient.readContract({
      address: t.address,
      abi: mockTokenAbi,
      functionName: 'allowance',
      args: [account.address, VAULT],
    })) as bigint;
    assert(allowance >= required[i], `${t.symbol} allowance covers the required pull`, fmt(allowance, t.decimals));
  }

  /* -------------------------------------- 5. deposit ------------------------------------------ */
  section('5. deposit');

  const minShares = (previewShares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  assert(minShares > 0n, 'minShares is non-zero (the contract rejects 0)', fmt(minShares, decimals));

  const walletBefore = await Promise.all(meta.map((t) => balanceOf(t.address, account.address)));
  const sharesBefore = (await publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [account.address] })) as bigint;

  const { result: simulatedShares, request } = await publicClient.simulateContract({
    ...vault,
    functionName: 'deposit',
    args: [tokens, offered, minShares, account.address],
    account,
  });
  assert(simulatedShares === previewShares, 'simulated deposit mints exactly the previewed shares', fmt(simulatedShares, decimals));

  const depositReceipt = await send(await walletClient.writeContract(request), 'deposit');
  const deposited = parseEventLogs({ abi: vaultAbi, logs: depositReceipt.logs, eventName: 'Deposited' })[0];
  const mintedShares = (deposited.args as { shares: bigint }).shares;
  const pulled = (deposited.args as { amounts: readonly bigint[] }).amounts;

  const sharesAfter = (await publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [account.address] })) as bigint;
  const walletAfter = await Promise.all(meta.map((t) => balanceOf(t.address, account.address)));

  assert(mintedShares === previewShares, 'Deposited event shares == previewDeposit', fmt(mintedShares, decimals));
  assert(sharesAfter - sharesBefore === previewShares, 'migoLP balance grew by exactly the minted shares');
  assert(
    pulled.every((v, i) => v === required[i]),
    'Deposited event amounts == previewDeposit requiredAmounts',
  );
  for (const [i, t] of meta.entries()) {
    assert(
      walletBefore[i] - walletAfter[i] === required[i],
      `${t.symbol} wallet balance fell by exactly the required amount`,
      fmt(required[i], t.decimals),
    );
  }

  const totalsAfterDeposit = (await publicClient.readContract({ ...vault, functionName: 'totalTokens' })) as readonly [
    readonly Address[],
    readonly bigint[],
  ];
  for (const [i, t] of meta.entries()) {
    assert(
      totalsAfterDeposit[1][i] - totalsBefore[1][i] === required[i],
      `vault total ${t.symbol} grew by the pulled amount`,
      fmt(totalsAfterDeposit[1][i], t.decimals),
    );
  }
  const supplyAfterDeposit = (await publicClient.readContract({ ...vault, functionName: 'totalSupply' })) as bigint;
  assert(supplyAfterDeposit - supplyBefore === previewShares, 'migoLP supply grew by the minted shares');

  /* --------------------------------- 6. previewRedeem + redeem -------------------------------- */
  section('6. previewRedeem + redeem half');

  const half = sharesAfter / 2n;
  const [, owed] = (await publicClient.readContract({ ...vault, functionName: 'previewRedeem', args: [half] })) as readonly [
    readonly Address[],
    readonly bigint[],
  ];
  console.log(`  redeeming ${fmt(half, decimals)} ${symbol}`);
  console.log(`  previewRedeem: ${owed.map((v, i) => `${fmt(v, meta[i].decimals)} ${meta[i].symbol}`).join(' + ')}`);
  assert(
    owed.some((v) => v > 0n),
    'previewRedeem returns a non-empty basket',
  );

  const preRedeemWallet = await Promise.all(meta.map((t) => balanceOf(t.address, account.address)));
  const redeemReceipt = await send(
    await walletClient.writeContract({ ...vault, functionName: 'redeem', args: [half, account.address] }),
    'redeem',
  );
  const redeemed = parseEventLogs({ abi: vaultAbi, logs: redeemReceipt.logs, eventName: 'Redeemed' })[0];
  const delivered = (redeemed.args as { amounts: readonly bigint[] }).amounts;

  const postRedeemWallet = await Promise.all(meta.map((t) => balanceOf(t.address, account.address)));
  const sharesFinal = (await publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [account.address] })) as bigint;
  const supplyFinal = (await publicClient.readContract({ ...vault, functionName: 'totalSupply' })) as bigint;
  const totalsFinal = (await publicClient.readContract({ ...vault, functionName: 'totalTokens' })) as readonly [
    readonly Address[],
    readonly bigint[],
  ];

  assert(
    delivered.every((v, i) => v === owed[i]),
    'Redeemed event amounts == previewRedeem',
  );
  for (const [i, t] of meta.entries()) {
    assert(
      postRedeemWallet[i] - preRedeemWallet[i] === owed[i],
      `${t.symbol} arrived in the wallet in kind`,
      fmt(owed[i], t.decimals),
    );
    assert(
      totalsAfterDeposit[1][i] - totalsFinal[1][i] === owed[i],
      `vault total ${t.symbol} fell by exactly what was delivered`,
      fmt(totalsFinal[1][i], t.decimals),
    );
  }
  assert(sharesAfter - sharesFinal === half, 'migoLP balance fell by the redeemed shares', fmt(sharesFinal, decimals));
  assert(supplyAfterDeposit - supplyFinal === half, 'migoLP supply fell by the redeemed shares', fmt(supplyFinal, decimals));
  assert(sharesFinal > 0n, 'half the position is still held after redeeming half');

  section('done');
  console.log(`${checks} assertions passed.`);
}

main().catch((err: unknown) => {
  console.error('\ne2e FAILED');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
