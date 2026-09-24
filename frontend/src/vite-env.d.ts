/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * WalletConnect (Reown) project id — user-supplied, never committed. Get a free one at
   * https://cloud.reown.com and put it in `frontend/.env.local`. Unset ⇒ the WalletConnect entry
   * is hidden from the picker; injected wallets are unaffected.
   */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
