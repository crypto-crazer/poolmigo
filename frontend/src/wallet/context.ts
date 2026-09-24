/**
 * The wallet context and its shape, split out from the provider so the picker can consume it
 * without an import cycle.
 */
import { createContext, useContext } from 'react';
import type {
  Abi,
  Address,
  ContractFunctionArgs,
  ContractFunctionName,
  Hash,
} from 'viem';
import type { WalletOption, WalletStatus } from './types';

type Mutable = 'nonpayable' | 'payable';

/**
 * Same call shape as a viem `writeContract`, minus the account this layer already knows — plus the
 * chain id the transaction must land on. The wallet has to be on that chain; nothing is sent
 * otherwise (the live pages pass the target chain's id).
 */
export type WriteRequest<
  abi extends Abi | readonly unknown[] = Abi,
  fn extends ContractFunctionName<abi, Mutable> = ContractFunctionName<abi, Mutable>,
  args extends ContractFunctionArgs<abi, Mutable, fn> = ContractFunctionArgs<abi, Mutable, fn>,
> = {
  chainId: number;
  address: Address;
  abi: abi;
  functionName: fn;
  args: args;
  value?: bigint;
};

export interface WalletContextValue {
  status: WalletStatus;
  /** The connected account, or undefined when only the demo wallet (or nothing) is active. */
  address?: Address;
  /** The chain the WALLET is on — not necessarily the chain the vault is deployed on. */
  chainId?: number;
  /** Display name of the connected wallet ("MetaMask", "Rabby", "WalletConnect", …). */
  walletName?: string;
  /** Everything the visitor could connect with, right now. */
  options: WalletOption[];
  /** Id of the option currently being connected, so the picker can show it spinning. */
  pendingId?: string;
  error: Error | null;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  connect: (option: WalletOption) => Promise<void>;
  disconnect: () => Promise<void>;
  switchChain: (chainId: number) => Promise<void>;
  switching: boolean;
  /** Send a transaction on `request.chainId`. Throws with a readable message when it cannot. */
  write: <
    const abi extends Abi | readonly unknown[],
    fn extends ContractFunctionName<abi, Mutable>,
    args extends ContractFunctionArgs<abi, Mutable, fn>,
  >(
    request: WriteRequest<abi, fn, args>,
  ) => Promise<Hash>;
}

export const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside <ChainProviders>.');
  return ctx;
}
