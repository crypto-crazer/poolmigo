/**
 * The wallet picker: every wallet this browser can actually reach, in one modal.
 *
 * Names and icons are whatever the wallet announced over EIP-6963 — nothing here is a hardcoded
 * list of "supported" wallets, which is the point of the rework. WalletConnect appears only when a
 * project id is configured, and the demo wallet stays available so the prototype works on a laptop
 * with no extension at all.
 */
import { useStore } from '@/store/useStore';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { useWallet } from './context';
import type { WalletOption } from './types';

export function WalletPicker() {
  const { pickerOpen, closePicker, options, connect, status, error, pendingId } = useWallet();
  const demoConnect = useStore((s) => s.connect);
  const connecting = status === 'connecting';

  return (
    <Modal open={pickerOpen} onClose={closePicker} title="Connect a wallet">
      {options.length === 0 ? (
        <p className="text-ink-2 leading-snug">
          No browser wallet detected. Install MetaMask, Rabby, Coinbase Wallet or any other EIP-6963
          wallet to use the live vault, or browse the prototype with demo data.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {options.map((o) => (
            <li key={o.id}>
              <WalletRow
                option={o}
                busy={connecting && pendingId === o.id}
                disabled={connecting}
                onClick={() => void connect(o)}
              />
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="mt-3 rounded border border-down/40 bg-down/10 px-2.5 py-2 text-xs text-down leading-snug">
          {error.message}
        </p>
      )}

      <div className="mt-4 pt-3 border-t border-line">
        <div className="flex items-start justify-between gap-3">
          <p className="text-2xs text-ink-3 leading-snug">
            No wallet, or just looking around? The demo wallet opens every prototype surface with
            demo data — the live vault stays read-only.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => {
              void demoConnect();
              closePicker();
            }}
          >
            Use demo wallet
          </Button>
        </div>
        <WalletConnectHint />
      </div>
    </Modal>
  );
}

function WalletRow({
  option,
  busy,
  disabled,
  onClick,
}: {
  option: WalletOption;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full h-12 px-3 rounded-md border border-line bg-deep hover:border-ink-3 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center gap-3 text-left"
    >
      <WalletIcon option={option} />
      <span className="flex-1 min-w-0 text-sm font-medium text-ink truncate">{option.name}</span>
      {busy ? (
        <Spinner className="h-4 w-4 text-ink-3" />
      ) : (
        <span className="text-2xs text-ink-3">
          {option.kind === 'walletconnect' ? 'QR / mobile' : 'Browser'}
        </span>
      )}
    </button>
  );
}

function WalletIcon({ option }: { option: WalletOption }) {
  if (option.icon) {
    return (
      <img
        src={option.icon}
        alt=""
        className="h-7 w-7 rounded-md shrink-0 bg-panel-2 object-contain"
        draggable={false}
      />
    );
  }
  return (
    <span className="h-7 w-7 rounded-md shrink-0 bg-panel-2 border border-line inline-flex items-center justify-center text-2xs font-semibold text-ink-2">
      {option.name.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Only shown when WalletConnect is missing, so the gap is explained instead of silent. */
function WalletConnectHint() {
  const { options } = useWallet();
  if (options.some((o) => o.kind === 'walletconnect')) return null;
  return (
    <p className="mt-2 text-2xs text-ink-3 leading-snug">
      Mobile and QR wallets need a free WalletConnect project id in{' '}
      <span className="num">VITE_WALLETCONNECT_PROJECT_ID</span> — see the README.
    </p>
  );
}
