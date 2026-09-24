import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Vault } from '@/lib/types';
import { TOKEN_PRICES, vaultName } from '@/demo/data/vaults';
import { CONSTANTS } from '@/demo/constants';
import * as m from '@/demo/math';
import { useStore } from '@/store/useStore';
import { useVaultApr } from '@/store/selectors';
import { cx, fmtPct, fmtToken, fmtUsd } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { TokenIcon, TokenPair } from '@/components/ui/TokenIcon';
import { VaultSelect } from './VaultSelect';
import { useConnectWallet } from '@/chain/useConnectWallet';

const TX_DELAY = 1500;
type Tab = 'deposit' | 'withdraw';
const DUAL = '__dual__';

interface Props {
  vault: Vault;
  onVaultChange: (v: Vault) => void;
  initialAmount?: string;
  showVaultLink?: boolean;
}

export function DepositCard({ vault: v, onVaultChange, initialAmount, showVaultLink = true }: Props) {
  const [tab, setTab] = useState<Tab>('deposit');
  const [pick, setPick] = useState(false);

  return (
    <div className="w-full max-w-[440px] mx-auto">
      <div className="bg-panel border border-line rounded-lg p-4 space-y-3 shadow-pop">
        <div className="flex items-center justify-between">
          <div className="inline-flex rounded bg-deep p-0.5 gap-0.5">
            {(['deposit', 'withdraw'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cx('h-8 px-3 rounded text-sm font-medium transition-colors', tab === t ? 'bg-panel-2 text-ink' : 'text-ink-3 hover:text-ink-2')}
              >
                {t === 'deposit' ? 'Deposit' : 'Withdraw'}
              </button>
            ))}
          </div>
          {showVaultLink && <Link to={`/vault/${v.id}`} className="text-xs text-ink-3 hover:text-ink-2">View vault →</Link>}
        </div>


        {tab === 'deposit' ? (
          <DepositForm key={v.id} vault={v} onPick={() => setPick(true)} initialAmount={initialAmount} />
        ) : (
          <WithdrawForm key={v.id} vault={v} onPick={() => setPick(true)} />
        )}
      </div>
      <VaultSelect open={pick} onClose={() => setPick(false)} onSelect={onVaultChange} selectedId={v.id} />
    </div>
  );
}

// ───────────────────────── shared bits ─────────────────────────

function VaultPill({ vault: v, onPick, apr }: { vault: Vault; onPick: () => void; apr: number }) {
  return (
    <button onClick={onPick} className="w-full flex items-center gap-3 rounded-md bg-deep border border-line hover:border-line-2 px-3 h-14 text-left transition-colors">
      <TokenPair a={v.token0} b={v.token1} size={26} chain={v.chain} />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-ink">{vaultName(v)}</span>
        <span className="block text-xs num text-ink-2">{fmtPct(apr)} APR</span>
      </span>
      <Chevron />
    </button>
  );
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx('h-4 w-4 text-ink-3 shrink-0', className)} fill="none" aria-hidden>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-ink-3 mb-1.5">{label}</div>
      {children}
    </div>
  );
}

/** Amount box — the one thing the user touches. Token is shown, not chosen here. */
function AmountBox({
  value, onChange, tokenLabel, tokenIcon, balance, connected, usd, autoFocus, error,
}: {
  value: string; onChange: (s: string) => void; tokenLabel: string; tokenIcon?: React.ReactNode;
  balance?: number; connected: boolean; usd?: number; autoFocus?: boolean; error?: boolean;
}) {
  return (
    <div className={cx('rounded-md bg-deep border px-3 pt-2.5 pb-2', error ? 'border-down/60' : 'border-line focus-within:border-line-2')}>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0"
          className="flex-1 min-w-0 bg-transparent display text-3xl num text-ink placeholder:text-ink-3 outline-none"
        />
        <span className="h-9 pl-2 pr-3 rounded-full bg-panel-2 border border-line inline-flex items-center gap-1.5 text-sm font-medium">
          {tokenIcon}
          {tokenLabel}
        </span>
      </div>
      <div className="flex items-center justify-between mt-1 text-xs num">
        <span className="text-ink-3">{usd !== undefined && usd > 0 ? `≈ ${fmtUsd(usd, { compact: false, cents: true })}` : ''}</span>
        {connected && balance !== undefined && (
          <span className="text-ink-3">
            Balance {fmtToken(balance)}
            <button onClick={() => onChange(String(balance))} className="ml-1.5 text-aqua font-medium hover:brightness-110">Max</button>
          </span>
        )}
      </div>
    </div>
  );
}

/** Visible choice of what to pay with — single tokens or both, each with its logo. */
function PayWith({ options, value, onChange }: { options: Array<{ id: string; label: string; icon: React.ReactNode }>; value: string; onChange: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={cx(
            'h-9 pl-1.5 pr-3 rounded-full border text-sm font-medium inline-flex items-center gap-1.5 transition-colors',
            value === o.id ? 'border-aqua bg-aqua/10 text-ink' : 'border-line bg-panel text-ink-2 hover:border-line-2',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── Deposit ─────────────────────────

function DepositForm({ vault: v, onPick, initialAmount }: { vault: Vault; onPick: () => void; initialAmount?: string }) {
  const connected = useStore((s) => s.connected);
  const { connectWallet: connect, isPending: connecting } = useConnectWallet();
  const balances = useStore((s) => s.user.balances);
  const degenAck = useStore((s) => s.user.degenAcknowledged);
  const acknowledgeDegen = useStore((s) => s.acknowledgeDegen);
  const deposit = useStore((s) => s.deposit);
  const pushToast = useStore((s) => s.pushToast);
  const { tvl, breakdown: b } = useVaultApr(v);
  const apr = b.totalApr;

  const [asset, setAsset] = useState('USDC');
  const [amount, setAmount] = useState(initialAmount ?? '');
  const [amount1, setAmount1] = useState('');
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [degenOpen, setDegenOpen] = useState(false);
  const [ack, setAck] = useState(false);

  const bal = (t: string) => balances[t] ?? 0;
  const payOptions = useMemo(() => {
    const singles = Array.from(new Set(['USDC', v.token0, v.token1])).map((t) => ({ id: t, label: t, icon: <TokenIcon symbol={t} size={22} /> }));
    return [...singles, { id: DUAL, label: `${v.token0} + ${v.token1}`, icon: <TokenPair a={v.token0} b={v.token1} size={22} /> }];
  }, [v]);
  const isDual = asset === DUAL;
  const amt = Number(amount) || 0;
  const amt1 = Number(amount1) || 0;

  const preview = useMemo(() => {
    if (isDual) return amt + amt1 > 0 ? m.dualPreview(v, amt, amt1, TOKEN_PRICES) : null;
    return amt > 0 ? m.zapPreview(v, tvl, asset, amt, TOKEN_PRICES) : null;
  }, [isDual, amt, amt1, v, tvl, asset]);

  const insufficientToken = isDual ? (amt > bal(v.token0) ? v.token0 : amt1 > bal(v.token1) ? v.token1 : null) : amt > bal(asset) ? asset : null;
  const insufficient = connected && !!insufficientToken;
  const monthly = preview ? (preview.netUsd * apr) / 12 : 0;

  const doDeposit = async () => {
    if (!preview) return;
    setBusy(true);
    await new Promise((r) => setTimeout(r, TX_DELAY));
    const spend = isDual ? [{ token: v.token0, amount: amt }, { token: v.token1, amount: amt1 }] : [{ token: asset, amount: amt }];
    deposit({ vaultId: v.id, preview, stake: true, spend });
    setBusy(false);
    setAmount('');
    setAmount1('');
    setDone(true);
    setTimeout(() => setDone(false), 2200);
    const what = isDual ? `${fmtToken(amt)} ${v.token0} + ${fmtToken(amt1)} ${v.token1}` : `${fmtToken(amt)} ${asset}`;
    pushToast({ title: 'Deposit confirmed', detail: `${what} into ${vaultName(v)} · earning ${fmtPct(apr)} APR`, tone: 'up' });
  };

  const onSubmit = () => {
    if (!connected) return void connect();
    if (v.tier === 'Degen' && !degenAck) return setDegenOpen(true);
    void doDeposit();
  };

  // Button state machine — the button is the guidance.
  let cta: { label: string; disabled: boolean; variant?: 'primary' | 'secondary' } = { label: 'Deposit', disabled: true };
  if (busy) cta = { label: 'Confirming…', disabled: true };
  else if (done) cta = { label: 'Deposited ✓', disabled: true };
  else if (!connected) cta = { label: 'Connect wallet', disabled: false };
  else if (!preview || preview.netUsd <= 0) cta = { label: 'Enter an amount', disabled: true };
  else if (insufficient) cta = { label: `Insufficient ${insufficientToken}`, disabled: true };
  else cta = { label: isDual ? `Deposit ${v.token0} + ${v.token1}` : `Deposit ${fmtToken(amt)} ${asset}`, disabled: false };

  return (
    <div className="space-y-3">
      <Field label="Vault">
        <VaultPill vault={v} onPick={onPick} apr={apr} />
      </Field>

      <Field label="Pay with">
        <PayWith options={payOptions} value={asset} onChange={(id) => { setAsset(id); setAmount(''); setAmount1(''); }} />
      </Field>

      <Field label="Amount">
        {isDual ? (
          <div className="space-y-2">
            <AmountBox value={amount} onChange={setAmount} tokenLabel={v.token0} tokenIcon={<TokenIcon symbol={v.token0} size={20} />} balance={bal(v.token0)} connected={connected} usd={amt * TOKEN_PRICES[v.token0]} autoFocus error={connected && amt > bal(v.token0)} />
            <AmountBox value={amount1} onChange={setAmount1} tokenLabel={v.token1} tokenIcon={<TokenIcon symbol={v.token1} size={20} />} balance={bal(v.token1)} connected={connected} usd={amt1 * TOKEN_PRICES[v.token1]} error={connected && amt1 > bal(v.token1)} />
          </div>
        ) : (
          <AmountBox value={amount} onChange={setAmount} tokenLabel={asset} tokenIcon={<TokenIcon symbol={asset} size={20} />} balance={bal(asset)} connected={connected} usd={preview?.inputUsd} autoFocus error={insufficient} />
        )}
      </Field>

      <Field label="You receive">
        <div className="rounded-md bg-deep border border-line px-3 py-2.5 num">
          <div className="flex items-baseline justify-between gap-3">
            <span className={cx('display text-2xl font-semibold truncate', preview ? 'text-ink' : 'text-ink-3')}>
              {preview ? fmtToken(preview.tdlp, 1) : '0'} <span className="text-sm font-normal text-ink-2">{v.receiptSymbol}</span>
            </span>
            {preview && <span className="text-xs text-ink-3 shrink-0">≈ {fmtUsd(preview.netUsd, { compact: false, cents: true })}</span>}
          </div>
          <div className="flex items-center justify-between mt-1.5 text-xs">
            <span className={preview ? 'text-up' : 'text-ink-3'}>{preview ? `Earning ~${fmtUsd(monthly, { compact: false, cents: monthly < 100 })} / month` : 'Earning'}</span>
            <span className="text-ink-2">at {fmtPct(apr)} APR</span>
          </div>
        </div>
      </Field>

      <Button block size="lg" onClick={onSubmit} disabled={cta.disabled} loading={busy || connecting}>{cta.label}</Button>

      <div className="text-xs num">
        <button onClick={() => setDetails(!details)} className="w-full flex items-center justify-between text-ink-3 hover:text-ink-2">
          <span>
            1 {v.receiptSymbol} = ${v.pricePerShare.toFixed(4)}
            {preview && !isDual && <> · {fmtPct(preview.priceImpact, 2)} impact</>}
          </span>
          <Chevron className={cx('transition-transform', details && 'rotate-180')} />
        </button>
        {details && (
          <dl className="mt-2 space-y-1.5 text-ink-2 animate-fade-in">
            {preview && !isDual && (
              <>
                <Row k="Auto-swap" v={preview.legs.map((l) => `${fmtToken(l.amount)} ${l.token}`).join(' + ')} />
                <Row k="Price impact" v={fmtPct(preview.priceImpact, 2)} />
                <Row k="Swap fee" v={`~${fmtUsd(preview.swapFeeUsd, { compact: false, cents: true })}`} />
              </>
            )}
            <Row k="Performance fee" v={`${fmtPct(CONSTANTS.PERFORMANCE_FEE, 0)} of earnings`} />
            <Row k="Withdrawal fee" v={fmtPct(CONSTANTS.WITHDRAWAL_FEE)} />
            <Row k="Lock-up" v="None · redeem anytime" />
          </dl>
        )}
        <p className="mt-2 text-2xs text-ink-3 leading-relaxed">LP positions can lose value and may underperform holding the assets. Review the vault strategy, fees and risks before depositing.</p>
      </div>

      <Modal
        open={degenOpen}
        onClose={() => setDegenOpen(false)}
        title="High-risk vault"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDegenOpen(false)}>Cancel</Button>
            <Button disabled={!ack} onClick={() => { acknowledgeDegen(); setDegenOpen(false); void doDeposit(); }}>I understand, deposit</Button>
          </>
        }
      >
        <p>Degen vaults run narrow, high-frequency ranges on volatile pairs. Higher fees, higher impermanent loss risk. Net value can underperform holding.</p>
        <label className="mt-4 flex items-start gap-2.5 cursor-pointer text-ink">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 accent-[#244742]" />
          <span className="text-sm">I understand this vault can lose value versus holding the underlying tokens.</span>
        </label>
      </Modal>
    </div>
  );
}

// ───────────────────────── Withdraw ─────────────────────────

function WithdrawForm({ vault: v, onPick }: { vault: Vault; onPick: () => void }) {
  const connected = useStore((s) => s.connected);
  const { connectWallet: connect, isPending: connecting } = useConnectWallet();
  const position = useStore((s) => s.user.positions[v.id]);
  const withdraw = useStore((s) => s.withdraw);
  const pushToast = useStore((s) => s.pushToast);
  const { breakdown: b } = useVaultApr(v);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'usdc' | 'both'>('usdc');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const total = m.positionTdlp(position);
  const amt = Number(amount) || 0;
  const preview = amt > 0 ? m.withdrawPreview(v, amt, mode, TOKEN_PRICES) : null;
  const insufficient = connected && amt > total + 1e-9;

  const submit = async () => {
    if (!connected) return void connect();
    if (!preview) return;
    setBusy(true);
    await new Promise((r) => setTimeout(r, TX_DELAY));
    withdraw({ vaultId: v.id, preview });
    setBusy(false);
    setAmount('');
    setDone(true);
    setTimeout(() => setDone(false), 2200);
    pushToast({ title: 'Withdrawal confirmed', detail: `Received ${preview.outputs.map((o) => `${fmtToken(o.amount)} ${o.token}`).join(' + ')}`, tone: 'up' });
  };

  let cta = { label: 'Withdraw', disabled: true };
  if (busy) cta = { label: 'Confirming…', disabled: true };
  else if (done) cta = { label: 'Withdrawn ✓', disabled: true };
  else if (!connected) cta = { label: 'Connect wallet', disabled: false };
  else if (total <= 0) cta = { label: 'Nothing to withdraw', disabled: true };
  else if (!preview) cta = { label: 'Enter an amount', disabled: true };
  else if (insufficient) cta = { label: `Insufficient ${v.receiptSymbol}`, disabled: true };
  else cta = { label: 'Withdraw', disabled: false };

  return (
    <div className="space-y-3">
      <Field label="Vault">
        <VaultPill vault={v} onPick={onPick} apr={b.totalApr} />
      </Field>
      <Field label="Amount">
        <AmountBox value={amount} onChange={setAmount} tokenLabel={v.receiptSymbol} tokenIcon={<TokenPair a={v.token0} b={v.token1} size={18} />} balance={connected ? total : undefined} connected={connected} usd={amt * v.pricePerShare} error={insufficient} />
      </Field>
      <Field label="Receive">
        <div className="rounded-md bg-deep border border-line px-3 py-2.5 num">
          <div className="flex items-center justify-between">
            <div className="display text-2xl font-semibold text-ink">
              {preview ? preview.outputs.map((o) => `${fmtToken(o.amount)} ${o.token}`).join(' + ') : <span className="text-ink-3">0</span>}
            </div>
            <div className="inline-flex rounded bg-panel-2 p-0.5 gap-0.5">
              {(['usdc', 'both'] as const).map((k) => (
                <button key={k} onClick={() => setMode(k)} className={cx('h-7 px-2 rounded text-xs font-medium', mode === k ? 'bg-panel text-ink' : 'text-ink-3')}>
                  {k === 'usdc' ? 'USDC' : 'Both'}
                </button>
              ))}
            </div>
          </div>
          <div className="text-xs text-ink-3 mt-1">{preview ? `${fmtUsd(preview.netUsd, { compact: false, cents: true })} after ${fmtPct(CONSTANTS.WITHDRAWAL_FEE)} fee` : 'No lock-up. Redeem anytime.'}</div>
        </div>
      </Field>
      <Button block size="lg" variant="secondary" onClick={submit} disabled={cta.disabled} loading={busy || connecting}>{cta.label}</Button>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-3">{k}</dt>
      <dd className="text-ink-2 text-right">{v}</dd>
    </div>
  );
}
