/**
 * In-kind deposit against the deployed vault.
 *
 * The flow the contract actually implements: offer a MAX amount per basket token → `previewDeposit`
 * returns the shares that are computable and the exact amount that would be pulled per token →
 * approve only where the allowance is short → `deposit(tokens, amounts, minShares, receiver)`.
 * `minShares` is mandatory and non-zero: it is the depositor's only protection, because the vault
 * prices a deposit from a spot read that can over-price it.
 */
import { useMemo, useState } from 'react';
import type { Address } from 'viem';
import { erc20Abi, parseEventLogs } from 'viem';
import { vaultAbi } from '@/config/generated';
import { useWallet } from '@/wallet/context';
import { waitForReceipt } from '@/chain/client';
import { chainLabel } from '@/chain/chains';
import { useSwitchToChain } from '@/chain/useTargetChain';
import { formatAmount, formatAmountSignificant } from '@/chain/amounts';
import {
  DEFAULT_SLIPPAGE_BPS,
  dispatchBasket,
  insufficientBalance,
  minSharesFromPreview,
  parseSlippageBps,
  tokensNeedingApproval,
} from '@/chain/deposit';
import { describeChainError } from '@/chain/errors';
import { usePreviewDeposit, type LiveVault, type TokenMeta, type UserBasket } from '@/chain/useVault';
import { Button } from '@/components/ui/Button';
import { useConnectWallet } from '@/chain/useConnectWallet';
import { useStore } from '@/store/useStore';
import { cx } from '@/lib/format';
import { StepTrail } from './StepTrail';
import { Message } from './Message';
import { LiveAmountInput } from './LiveAmountInput';

type Step = 'form' | 'approving' | 'depositing' | 'done';

export function LiveDepositCard({ vault, user }: { vault: LiveVault; user: UserBasket }) {
  const { address, chainId, write } = useWallet();
  const { connectWallet, isPending: connecting } = useConnectWallet();
  const { switchTo, switching } = useSwitchToChain();
  const pushToast = useStore((s) => s.pushToast);

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [slippage, setSlippage] = useState(String(DEFAULT_SLIPPAGE_BPS / 100));
  const [step, setStep] = useState<Step>('form');
  const [pendingToken, setPendingToken] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<bigint | null>(null);

  const offer = useMemo(
    () =>
      dispatchBasket(
        vault.tokens.map((t, i) => ({
          token: t.address,
          decimals: t.decimals,
          input: inputs[t.address] ?? '',
          total: vault.totals[i] ?? 0n,
        })),
      ),
    [vault.tokens, vault.totals, inputs],
  );

  const preview = usePreviewDeposit(vault, offer.tokens, offer.amounts, offer.ready);
  const slip = parseSlippageBps(slippage);
  const bps = slip.ok ? slip.bps : DEFAULT_SLIPPAGE_BPS;
  const minShares = minSharesFromPreview(preview.shares ?? 0n, bps);

  const required = preview.required ?? [];
  const needsApproval = tokensNeedingApproval(offer.tokens, required, user.allowances);
  const short = insufficientBalance(offer.tokens, required, user.balances);
  const errCtx = {
    shareDecimals: vault.decimals,
    tokenDecimals: Object.fromEntries(vault.tokens.map((t) => [t.address, t.decimals])),
    tokenSymbols: Object.fromEntries(vault.tokens.map((t) => [t.address, t.symbol])),
  };
  const symbolOf = (a: Address) => vault.tokens.find((t) => t.address === a)?.symbol ?? 'token';

  const wrongChain = Boolean(address) && chainId !== vault.chainId;
  const busy = step === 'approving' || step === 'depositing';

  const refresh = () => {
    vault.refetch();
    user.refetch();
    preview.refetch();
  };

  const approveNext = async () => {
    const token = needsApproval[0];
    if (!token) return;
    const i = offer.tokens.indexOf(token);
    setError(null);
    setStep('approving');
    setPendingToken(token);
    try {
      // Approve the MAX the user offered (≥ what the vault will pull), so a basket that shifts
      // between the preview and the transaction does not strand the deposit on a stale allowance.
      const hash = await write({
        chainId: vault.chainId,
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [vault.address, offer.amounts[i] ?? 0n],
      });
      await waitForReceipt(vault.chainId, hash);
      user.refetch();
      pushToast({ title: `${symbolOf(token)} approved`, detail: 'The vault may now pull this token.', tone: 'up' });
    } catch (err) {
      setError(describeChainError(err, errCtx));
    } finally {
      setPendingToken(null);
      setStep('form');
    }
  };

  const submit = async () => {
    if (!address || minShares === 0n) return;
    setError(null);
    setStep('depositing');
    try {
      const hash = await write({
        chainId: vault.chainId,
        address: vault.address,
        abi: vaultAbi,
        functionName: 'deposit',
        args: [offer.tokens, offer.amounts, minShares, address],
      });
      const receipt = await waitForReceipt(vault.chainId, hash);
      const events = parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: 'Deposited' });
      const shares = (events[0]?.args as { shares?: bigint } | undefined)?.shares ?? 0n;
      setMinted(shares);
      setStep('done');
      setInputs({});
      refresh();
      pushToast({
        title: 'Deposit confirmed',
        detail: `Minted ${formatAmountSignificant(shares, vault.decimals)} ${vault.symbol ?? 'migoLP'} on ${chainLabel(vault.chainId)}`,
        tone: 'up',
      });
    } catch (err) {
      setError(describeChainError(err, errCtx));
      setStep('form');
    }
  };

  // The button is the guidance — one action at a time, in contract order.
  let cta: { label: string; disabled: boolean; onClick: () => void } = {
    label: 'Deposit',
    disabled: true,
    onClick: () => {},
  };
  if (!address) cta = { label: 'Connect wallet', disabled: false, onClick: connectWallet };
  else if (wrongChain) {
    cta = { label: `Switch to ${chainLabel(vault.chainId)}`, disabled: false, onClick: () => void switchTo(vault.chainId).catch(() => {}) };
  }
  else if (vault.rebalancePaused) cta = { label: 'Deposits paused by the owner', disabled: true, onClick: () => {} };
  else if (Object.keys(offer.errors).length > 0) cta = { label: 'Fix the amounts', disabled: true, onClick: () => {} };
  else if (offer.hasMissingAmount) cta = { label: 'Enter an amount for every token', disabled: true, onClick: () => {} };
  else if (preview.error) cta = { label: 'Deposit not possible', disabled: true, onClick: () => {} };
  else if (preview.shares === undefined) cta = { label: 'Previewing…', disabled: true, onClick: () => {} };
  else if (short) cta = { label: `Insufficient ${symbolOf(short)}`, disabled: true, onClick: () => {} };
  else if (!slip.ok) cta = { label: 'Fix the slippage tolerance', disabled: true, onClick: () => {} };
  else if (needsApproval.length > 0) {
    cta = { label: `Approve ${symbolOf(needsApproval[0])}`, disabled: false, onClick: () => void approveNext() };
  } else cta = { label: `Deposit ${vault.tokens.length} tokens`, disabled: false, onClick: () => void submit() };

  const previewError = preview.error ? describeChainError(preview.error, errCtx) : null;

  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="display text-sm font-semibold">Deposit in kind</h3>
        <span className="text-2xs text-ink-3">Offers are maximums · only what is required is pulled</span>
      </div>

      <StepTrail
        steps={[
          { label: 'Amounts', state: offer.ready && preview.shares !== undefined ? 'done' : 'active' },
          {
            label: 'Approve',
            state: !offer.ready || preview.shares === undefined ? 'todo' : needsApproval.length === 0 ? 'done' : 'active',
          },
          { label: 'Deposit', state: step === 'done' ? 'done' : step === 'depositing' ? 'active' : 'todo' },
        ]}
      />

      <div className="space-y-2">
        {vault.tokens.map((t, i) => (
          <LiveDepositRow
            key={t.address}
            token={t}
            value={inputs[t.address] ?? ''}
            onChange={(v) => { setInputs((s) => ({ ...s, [t.address]: v })); setStep('form'); setMinted(null); }}
            balance={user.balances[i] ?? 0n}
            error={offer.errors[t.address]}
            required={required[i]}
            autoFocus={i === 0}
          />
        ))}
      </div>

      <div className="rounded-md bg-deep border border-line px-3 py-2.5 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-ink-3">You receive</span>
          <span className="display num text-xl font-semibold text-ink">
            {preview.shares !== undefined ? formatAmountSignificant(preview.shares, vault.decimals) : '0'}{' '}
            <span className="text-sm font-normal text-ink-2">{vault.symbol ?? 'migoLP'}</span>
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 text-xs num">
          <label className="flex items-center gap-2 text-ink-3">
            Slippage tolerance
            <span className="inline-flex items-center rounded border border-line bg-panel px-1.5 h-7">
              <input
                inputMode="decimal"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                aria-label="Slippage tolerance in percent"
                className="w-12 bg-transparent outline-none text-right text-ink"
              />
              <span className="text-ink-3 ml-0.5">%</span>
            </span>
          </label>
          <span className={cx('text-right', slip.ok ? 'text-ink-2' : 'text-down')}>
            {slip.ok ? (
              <>minShares {formatAmountSignificant(minShares, vault.decimals)}</>
            ) : (
              slip.error
            )}
          </span>
        </div>
      </div>

      {previewError && <Message tone="warn">{previewError}</Message>}
      {error && <Message tone="error">{error}</Message>}
      {step === 'done' && minted !== null && (
        <Message tone="ok">
          Deposited. Minted {formatAmountSignificant(minted, vault.decimals)} {vault.symbol ?? 'migoLP'}.
        </Message>
      )}

      <Button
        block
        size="lg"
        onClick={cta.onClick}
        disabled={cta.disabled || busy}
        loading={busy || connecting || (wrongChain && switching)}
      >
        {step === 'approving' ? `Approving ${pendingToken ? symbolOf(pendingToken) : ''}…` : step === 'depositing' ? 'Depositing…' : cta.label}
      </Button>

      <p className="text-2xs text-ink-3 leading-relaxed">
        Shares are the minimum binding ratio across the basket: <span className="num">min(offered × supply / total)</span>. Anything
        offered above the required amount is never pulled — no refund transfer needed.
      </p>
    </section>
  );
}

function LiveDepositRow({
  token,
  value,
  onChange,
  balance,
  error,
  required,
  autoFocus,
}: {
  token: TokenMeta;
  value: string;
  onChange: (v: string) => void;
  balance: bigint;
  error?: string;
  required?: bigint;
  autoFocus?: boolean;
}) {
  const hint = required !== undefined && required > 0n ? `Vault pulls ${formatAmount(required, token.decimals, 6)}` : undefined;
  return <LiveAmountInput token={token} value={value} onChange={onChange} balance={balance} error={error} hint={hint} autoFocus={autoFocus} />;
}
