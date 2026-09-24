/**
 * Local-chain conveniences. Rendered ONLY when the target chain is the local Anvil stack
 * (`isLocalChain`) and no wallet is on another network, because `MockToken.mint` is public there
 * and nowhere else.
 */
import { useState } from 'react';
import { mockTokenAbi } from '@/config/generated';
import { useWallet } from '@/wallet/context';
import { waitForReceipt } from '@/chain/client';
import { chainLabel } from '@/chain/chains';
import { parseAmount, shortHex } from '@/chain/amounts';
import { describeChainError } from '@/chain/errors';
import type { LiveVault, UserBasket } from '@/chain/useVault';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useStore } from '@/store/useStore';
import { Message } from './Message';

const DEFAULT_MINT = '1000';

export function LocalDevPanel({ vault, user }: { vault: LiveVault; user: UserBasket }) {
  const { address, write } = useWallet();
  const pushToast = useStore((s) => s.pushToast);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mint = async (token: `0x${string}`, decimals: number, symbol: string) => {
    if (!address) return;
    const parsed = parseAmount(amounts[token] ?? DEFAULT_MINT, decimals);
    if (!parsed.ok) {
      setError(`${symbol}: ${parsed.error}`);
      return;
    }
    setError(null);
    setPending(token);
    try {
      const hash = await write({
        chainId: vault.chainId,
        address: token,
        abi: mockTokenAbi,
        functionName: 'mint',
        args: [address, parsed.value],
      });
      await waitForReceipt(vault.chainId, hash);
      user.refetch();
      pushToast({ title: `Minted ${symbol}`, detail: 'Test tokens sent to your wallet (local chain only).', tone: 'up' });
    } catch (err) {
      setError(describeChainError(err));
    } finally {
      setPending(null);
    }
  };

  const deployment = vault.deployment;
  if (!deployment) return null;

  return (
    <Card
      title="Local dev tools"
      action={<span className="text-2xs text-amber">Local chain only · MockToken.mint is public here</span>}
    >
      <dl className="text-2xs num grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mb-3">
        <dt className="text-ink-3">Network</dt>
        <dd className="text-ink-2">
          {chainLabel(deployment.chainId)} · chain id {deployment.chainId}
        </dd>
        <dt className="text-ink-3">RPC</dt>
        <dd className="text-ink-2 break-all">{deployment.rpcUrl}</dd>
        <dt className="text-ink-3">Vault</dt>
        <dd className="text-ink-2" title={deployment.vault}>{shortHex(deployment.vault)}</dd>
        <dt className="text-ink-3">Keeper</dt>
        <dd className="text-ink-2" title={deployment.keeper}>{shortHex(deployment.keeper)}</dd>
      </dl>

      <div className="space-y-2">
        {vault.tokens.map((t) => (
          <div key={t.address} className="flex items-center gap-2">
            <span className="text-xs text-ink-2 w-20 shrink-0">{t.symbol}</span>
            <input
              inputMode="decimal"
              value={amounts[t.address] ?? DEFAULT_MINT}
              onChange={(e) => setAmounts((s) => ({ ...s, [t.address]: e.target.value }))}
              aria-label={`Amount of ${t.symbol} to mint`}
              className="h-9 flex-1 min-w-0 rounded-md bg-deep border border-line px-2.5 text-sm num text-ink outline-none focus:border-line-2"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!address || pending !== null}
              loading={pending === t.address}
              onClick={() => void mint(t.address, t.decimals, t.symbol)}
            >
              Mint
            </Button>
          </div>
        ))}
      </div>
      {!address && <p className="mt-2 text-2xs text-ink-3">Connect a wallet on the local chain to mint.</p>}
      {error && <div className="mt-2"><Message tone="error">{error}</Message></div>}
    </Card>
  );
}
