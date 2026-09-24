import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Lock, TxKind, UserState } from '@/lib/types';
import { demoUserState, emptyUserState } from '@/demo/data/demoUser';
import { VAULT_BY_ID } from '@/demo/data/vaults';
import { CONSTANTS } from '@/demo/constants';
import * as m from '@/demo/math';
import type { ZapPreview, WithdrawPreview } from '@/demo/math';

export interface Toast {
  id: string;
  title: string;
  detail?: string;
  tone?: 'default' | 'tide' | 'up' | 'amber';
}

export type MarketOverride = 'auto' | 'open' | 'closed';
export type Theme = 'light' | 'dark';

interface AppState {
  /** True for a real injected wallet OR the demo wallet. Gates every personal surface. */
  connected: boolean;
  connecting: boolean;
  initialized: boolean;
  /** Real wallet address from the wallet layer; null while only the demo wallet is "connected". */
  address: string | null;
  /** The demo wallet (?wallet=demo / no-browser-wallet fallback) is active. */
  demoWallet: boolean;
  user: UserState;
  /** Instant-claim forfeits added to this week's redistribution pool by the demo user. */
  forfeitsAdded: number;
  marketOverride: MarketOverride;
  theme: Theme;
  toasts: Toast[];

  /** Demo wallet only. The real connect flow lives in src/chain/useConnectWallet.ts. */
  connect: () => Promise<void>;
  /** Bridge from src/wallet: a real wallet connected (address) or went away (null). */
  setWallet: (address: string | null) => void;
  disconnect: () => void;
  reset: () => void;
  setMarketOverride: (o: MarketOverride) => void;
  setTheme: (t: Theme) => void;

  deposit: (args: { vaultId: string; preview: ZapPreview; stake: boolean; spend: Array<{ token: string; amount: number }> }) => void;
  withdraw: (args: { vaultId: string; preview: WithdrawPreview }) => void;
  stakeAll: (vaultId: string) => void;
  claimInstant: () => number;
  claimLock: () => Lock | null;
  unlock: (lockId: string) => void;
  acknowledgeDegen: () => void;
  tickPending: (now: number) => void;

  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/** In-memory fallback so the store also works outside the browser (tests). */
const memoryStorage = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
})();
const DAY = 86_400_000;

function record(user: UserState, kind: TxKind, label: string): UserState {
  return { ...user, history: [{ id: uid(), kind, at: Date.now(), label }, ...user.history].slice(0, 50) };
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      connected: false,
      connecting: false,
      initialized: false,
      address: null,
      demoWallet: false,
      user: emptyUserState(),
      forfeitsAdded: 0,
      marketOverride: 'auto',
      theme: 'light',
      toasts: [],

      connect: async () => {
        if (get().connected || get().connecting) return;
        set({ connecting: true });
        await new Promise((r) => setTimeout(r, 800));
        const s = get();
        set({
          connecting: false,
          connected: true,
          demoWallet: true,
          initialized: true,
          user: s.initialized ? { ...s.user, pendingUpdatedAt: Date.now() } : demoUserState(),
        });
      },

      setWallet: (address) =>
        set((s) => {
          if (!address) return { address: null, connected: s.demoWallet, connecting: false };
          return {
            address,
            connected: true,
            connecting: false,
            initialized: true,
            // A real connection also opens the demo surfaces, so the prototype flows stay usable.
            user: s.initialized ? { ...s.user, pendingUpdatedAt: Date.now() } : demoUserState(),
          };
        }),

      disconnect: () => set({ connected: false, address: null, demoWallet: false }),

      reset: () =>
        set({ connected: false, connecting: false, initialized: false, address: null, demoWallet: false, user: emptyUserState(), forfeitsAdded: 0, toasts: [] }),

      setMarketOverride: (o) => set({ marketOverride: o }),
      setTheme: (t) => set({ theme: t }),

      deposit: ({ vaultId, preview, stake, spend }) => {
        const v = VAULT_BY_ID[vaultId];
        if (!v) return;
        set((s) => {
          const balances = { ...s.user.balances };
          for (const sp of spend) balances[sp.token] = Math.max(0, (balances[sp.token] ?? 0) - sp.amount);
          const prev = s.user.positions[vaultId] ?? { staked: 0, unstaked: 0, costBasis: 0, depositedAt: Date.now() };
          const positions = {
            ...s.user.positions,
            [vaultId]: {
              ...prev,
              staked: prev.staked + (stake ? preview.tdlp : 0),
              unstaked: prev.unstaked + (stake ? 0 : preview.tdlp),
              costBasis: prev.costBasis + preview.inputUsd,
            },
          };
          const tvlDelta = { ...s.user.tvlDelta, [vaultId]: (s.user.tvlDelta[vaultId] ?? 0) + preview.netUsd };
          return { user: record({ ...s.user, balances, positions, tvlDelta }, 'deposit', `Deposited into ${v.token0}/${v.token1}`) };
        });
      },

      withdraw: ({ vaultId, preview }) => {
        const v = VAULT_BY_ID[vaultId];
        if (!v) return;
        set((s) => {
          const p = s.user.positions[vaultId];
          if (!p) return {};
          const total = p.staked + p.unstaked;
          const amt = Math.min(preview.tdlp, total);
          // unstaked first, then staked (one-click "Unstake & withdraw")
          const fromUnstaked = Math.min(p.unstaked, amt);
          const fromStaked = amt - fromUnstaked;
          const remaining = total - amt;
          const positions = { ...s.user.positions };
          if (remaining <= 1e-9) delete positions[vaultId];
          else {
            positions[vaultId] = {
              ...p,
              unstaked: p.unstaked - fromUnstaked,
              staked: p.staked - fromStaked,
              costBasis: p.costBasis * (remaining / total),
            };
          }
          const balances = { ...s.user.balances };
          for (const o of preview.outputs) balances[o.token] = (balances[o.token] ?? 0) + o.amount;
          // Withdrawal fee stays in the vault for remaining LPs.
          const tvlDelta = { ...s.user.tvlDelta, [vaultId]: (s.user.tvlDelta[vaultId] ?? 0) - preview.netUsd };
          return { user: record({ ...s.user, balances, positions, tvlDelta }, 'withdraw', `Withdrew ${v.receiptSymbol}`) };
        });
      },

      stakeAll: (vaultId) =>
        set((s) => {
          const p = s.user.positions[vaultId];
          if (!p || p.unstaked <= 0) return {};
          return {
            user: record(
              { ...s.user, positions: { ...s.user.positions, [vaultId]: { ...p, staked: p.staked + p.unstaked, unstaked: 0 } } },
              'stake',
              `Staked ${VAULT_BY_ID[vaultId]?.receiptSymbol ?? 'migoLP'}`,
            ),
          };
        }),

      claimInstant: () => {
        const s = get();
        const split = m.claimSplit(s.user.pendingTide);
        if (split.instant <= 0) return 0;
        set({
          forfeitsAdded: s.forfeitsAdded + split.forfeited,
          user: record(
            {
              ...s.user,
              pendingTide: 0,
              pendingUpdatedAt: Date.now(),
              balances: { ...s.user.balances, PMG: (s.user.balances.PMG ?? 0) + split.instant },
            },
            'claim',
            `Claimed ${Math.round(split.instant)} PMG`,
          ),
        });
        return split.instant;
      },

      claimLock: () => {
        const s = get();
        const amount = s.user.pendingTide;
        if (amount <= 0) return null;
        const now = Date.now();
        const lock: Lock = { id: uid(), amount, lockedAt: now, unlockAt: now + CONSTANTS.LOCK_DAYS * DAY, redistributionEarned: 0 };
        set({
          user: record({ ...s.user, pendingTide: 0, pendingUpdatedAt: now, locks: [lock, ...s.user.locks] }, 'lock', `Locked ${Math.round(amount)} PMG`),
        });
        return lock;
      },

      unlock: (lockId) =>
        set((s) => {
          const l = s.user.locks.find((x) => x.id === lockId);
          if (!l) return {};
          return {
            user: record(
              {
                ...s.user,
                locks: s.user.locks.filter((x) => x.id !== lockId),
                balances: { ...s.user.balances, PMG: (s.user.balances.PMG ?? 0) + l.amount + l.redistributionEarned },
              },
              'unlock',
              `Unlocked ${Math.round(l.amount)} PMG`,
            ),
          };
        }),

      acknowledgeDegen: () => set((s) => ({ user: { ...s.user, degenAcknowledged: true } })),

      /** Live accrual: pending PMG grows at the vault's PMG APR. */
      tickPending: (now) =>
        set((s) => {
          if (!s.connected) return {};
          const dt = Math.min(Math.max(0, (now - s.user.pendingUpdatedAt) / 1000), 3600); // cap catch-up to 1h
          const rate = m.pendingAccrualPerSecond(s.user.positions, VAULT_BY_ID, s.user.tvlDelta);
          return { user: { ...s.user, pendingTide: s.user.pendingTide + rate * dt, pendingUpdatedAt: now } };
        }),

      pushToast: (t) => {
        const id = uid();
        set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
        setTimeout(() => get().dismissToast(id), 4200);
      },
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    }),
    {
      name: 'poolmigo-demo-v1',
      storage: createJSONStorage(() => (typeof localStorage !== 'undefined' ? localStorage : memoryStorage)),
      // The real connection is the wallet layer's to restore, so `connected`/`address` are NOT persisted;
      // only the demo wallet survives a reload (it has no source of truth other than this store).
      onRehydrateStorage: () => (state) => {
        if (state) state.connected = state.demoWallet;
      },
      partialize: (s) => ({
        demoWallet: s.demoWallet,
        initialized: s.initialized,
        user: s.user,
        forfeitsAdded: s.forfeitsAdded,
        marketOverride: s.marketOverride,
        theme: s.theme,
      }),
    },
  ),
);
