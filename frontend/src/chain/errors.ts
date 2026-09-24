/**
 * Turn a viem failure into one sentence a depositor can act on.
 * The vault's custom errors are in the generated ABI, so viem decodes name + args for us; this
 * maps the ones a user can actually hit. Anything unknown falls back to viem's short message —
 * never a swallowed error.
 */
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';
import { formatAmount, shortHex } from './amounts';

export interface ErrorContext {
  /** migoLP decimals, for share-denominated error args. */
  shareDecimals?: number;
  /** Token decimals by address, for ERC-20 error args. */
  tokenDecimals?: Record<string, number>;
  /** Symbol by address, purely for nicer text. */
  tokenSymbols?: Record<string, string>;
}

function token(addr: unknown, ctx: ErrorContext): string {
  const a = String(addr);
  return ctx.tokenSymbols?.[a] ?? ctx.tokenSymbols?.[a.toLowerCase()] ?? shortHex(a);
}

function tokenAmount(addr: unknown, v: unknown, ctx: ErrorContext): string {
  const a = String(addr);
  const d = ctx.tokenDecimals?.[a] ?? ctx.tokenDecimals?.[a.toLowerCase()] ?? 18;
  return `${formatAmount(BigInt(String(v)), d, 6)} ${token(addr, ctx)}`;
}

function shares(v: unknown, ctx: ErrorContext): string {
  return `${formatAmount(BigInt(String(v)), ctx.shareDecimals ?? 18, 6)} migoLP`;
}

function describeRevert(name: string, args: readonly unknown[], ctx: ErrorContext): string | null {
  switch (name) {
    case 'PoolmigoVault__ZeroMinShares':
      return 'minShares must be non-zero — the vault rejects an unbounded deposit by design.';
    case 'PoolmigoVault__InsufficientSharesOut':
      return `Basket moved: this deposit now mints ${shares(args[1], ctx)}, below your minimum of ${shares(args[0], ctx)}. Nothing was pulled — retry or raise the slippage tolerance.`;
    case 'PoolmigoVault__ZeroShares':
      return 'These amounts compute to zero shares. Offer more of the binding token.';
    case 'PoolmigoVault__ZeroAmount':
      return 'Every basket token needs a non-zero amount on the first (bootstrap) deposit.';
    case 'PoolmigoVault__MissingBasketToken':
      return `Every basket token must be offered — ${token(args[0], ctx)} is missing.`;
    case 'PoolmigoVault__TokenNotRegistered':
      return `${token(args[0], ctx)} is not a basket token of this vault.`;
    case 'PoolmigoVault__DuplicateToken':
      return `${token(args[0], ctx)} was offered twice.`;
    case 'PoolmigoVault__LengthMismatch':
      return 'tokens[] and amounts[] must be the same non-empty length.';
    case 'PoolmigoVault__RebalancePaused':
      return 'Deposits are paused by the vault owner. Redeem stays available.';
    case 'PoolmigoVault__InsufficientShares':
      return `You hold ${shares(args[0], ctx)} but tried to redeem ${shares(args[1], ctx)}.`;
    case 'PoolmigoVault__ZeroAddress':
      return 'Zero address rejected.';
    case 'PoolmigoVault__NotKeeper':
      return 'Keeper-only function — the connected wallet is not the keeper.';
    case 'OwnableUnauthorizedAccount':
      return 'Owner-only function — the connected wallet is not the vault owner.';
    case 'ERC20InsufficientAllowance':
      return `Approval too low: the vault may pull ${tokenAmount(args[0], args[1], ctx)} but needs ${tokenAmount(args[0], args[2], ctx)}.`;
    case 'ERC20InsufficientBalance':
      return `Wallet balance too low: ${formatAmount(BigInt(String(args[1])), 18, 6)} available, ${formatAmount(BigInt(String(args[2])), 18, 6)} needed (base units).`;
    case 'SafeERC20FailedOperation':
      return `Token transfer failed for ${token(args[0], ctx)}.`;
    default:
      return null;
  }
}

export function describeChainError(err: unknown, ctx: ErrorContext = {}): string {
  if (err == null) return '';
  if (err instanceof BaseError) {
    const rejected = err.walk((e) => e instanceof UserRejectedRequestError);
    if (rejected) return 'Transaction rejected in your wallet.';
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) {
        const described = describeRevert(name, (reverted.data?.args ?? []) as readonly unknown[], ctx);
        if (described) return described;
        return `${name}${reverted.data?.args?.length ? `(${reverted.data.args.map(String).join(', ')})` : ''}`;
      }
      if (reverted.reason) return reverted.reason;
    }
    return err.shortMessage || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Custom-error NAME only (for tests / compact UI), or null when it is not a decodable revert. */
export function chainErrorName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? null) : null;
}
