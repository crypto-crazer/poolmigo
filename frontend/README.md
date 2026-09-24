# Poolmigo — prototype + live vault

Automated liquidity vaults for less manual LP management on EVM chains. Internal alignment + investor demo build.

Two layers, kept visibly apart:

- **`/live` — the deployed vault.** Real viem wiring against the vault in
  `shared/deployment.local.json`: basket totals, idle vs in-position split, adapters, migoLP balance,
  in-kind deposit and redeem. Every number is a chain read; nothing there is invented.
- **Everything else — the prototype.** The product shell with demo figures (APR, USD, PMG rewards,
  locks, buybacks), all isolated in `src/demo/` and tagged with a **Demo data** badge in the UI.

This package uses **pnpm** (`packageManager` is pinned in `package.json`); npm is not used anywhere.

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # vitest: spec anchors, chain helpers, wallet picker, render smoke test
pnpm build        # tsc + vite build
pnpm sync:shared  # regenerate src/config/generated.ts from ../shared
pnpm e2e:local    # viem end-to-end against the local chain (see below)
```

## Running against the local chain

The live page reads the deployed demo stack. From the repo root:

```bash
anvil --chain-id 46630 --port 8547
cd contracts && forge clean && forge build && \
  forge script script/DemoLocal.s.sol --rpc-url http://127.0.0.1:8547 --broadcast --private-key $ANVIL_DEV_KEY
cd ../frontend && pnpm sync:shared && pnpm dev
```

Then in your wallet (MetaMask, Rabby, Coinbase Wallet, Brave, Phantom … — see **Wallets** below):

1. **Add network** — pick "Robinhood Chain (local demo stack)" in the header network selector (or
   press **Switch to …** on the live page) and approve the wallet's add-network prompt. By hand:
   RPC `http://127.0.0.1:8547`, chain id `46630`, currency `ETH`.
2. **Import account** → Anvil account #2 private key
   `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a`
   (address `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`) — a publicly known Anvil test key.
   **Local only. Never fund it on a real network.**
3. Open http://localhost:5173/live and connect. Then:
   - **Mint** — "Local dev tools" (only shown on the local chain) mints mUSDG / mWETH to your wallet.
   - **Deposit** — enter an amount for *every* basket token (the amounts are maximums; the vault
     pulls only what the binding ratio requires), approve what is short, then deposit. The card
     shows the computed shares, the per-token pull and your `minShares` floor.
   - **Redeem** — enter migoLP (or Max), check the in-kind breakdown, redeem.

Without a wallet extension the picker offers a **demo wallet** instead: the prototype flows stay
usable, the live vault stays read-only. Without a running chain the live page says so and everything
else keeps working.

If the demo stack is redeployed, re-run `pnpm sync:shared` (addresses are never hand-copied).

## Wallets

**Connect wallet** opens a picker listing every wallet the browser actually has. There is no
hardcoded list of "supported" wallets and no wallet SDK: discovery is **EIP-6963**
([`mipd`](https://github.com/wevm/mipd)), so any wallet that announces itself shows up with its own
name and icon — MetaMask, Rabby, Coinbase Wallet, Brave, Phantom, Frame, Zerion, Rainbow, and
anything else installed. A pre-EIP-6963 `window.ethereum` still appears, as **Browser wallet**.

Each choice becomes a viem wallet client (`createClient({ transport: custom(provider) })`). Reads
never need a wallet; only deposit / redeem / mint do, and only on a chain Poolmigo is deployed on,
with a one-click network switch — see **Multi-chain** below.

## Multi-chain

Poolmigo targets any EVM chain. The app knows chains from one registry, **`shared/deployments.json`**:

```json
{
  "version": 1,
  "chains": {
    "4663":  { "name": "Robinhood Chain", "rpcUrl": "https://rpc.mainnet.chain.robinhood.com",
               "testnet": false, "status": "planned" },
    "46630": { "name": "Robinhood Chain (local demo stack)", "rpcUrl": "http://127.0.0.1:8547",
               "testnet": true, "status": "deployed" }
  }
}
```

- `status: "planned"` — a known chain with no Poolmigo deployment yet. It is offered in the network
  selector; the live page shows "no deployment on this network" there.
- `status: "deployed"` — needs `"addresses": { vault, implementation, usdg, weth, adapterV3,
  adapterV4, owner, keeper, demoUser }` (exactly those keys, all `0x…40`).
- Optional `explorerUrl` — passed to the wallet as `blockExplorerUrls` when it adds the chain.

**Adding a chain** = append an entry (key = decimal chain id) → `pnpm sync:shared` → commit the
regenerated `src/config/generated.ts`. No code change. `sync:shared` validates loudly and names the
offending key (bad address, missing addresses on a deployed chain, non-numeric or duplicate chain id,
unknown key, …).

**The local stack keeps flowing from `shared/deployment.local.json`.** `sync:shared` overlays it on the
registry entry with the same chain id: that entry becomes `deployed` + `local`, with the local file's
RPC and addresses. So the `46630` entry carries no addresses of its own, and a redeploy of the demo
stack is still just `pnpm sync:shared`. Local-only conveniences (Local dev tools / mint) appear only
on that `local` chain.

**Which chain the app uses** (the *target chain*, `src/chain/targetChain.ts`):

- no wallet → the chain picked in the header selector (default: the local stack, else the first
  deployed chain) — read-only, so the vault renders without any extension;
- wallet on a chain with a deployment → that chain, automatically;
- wallet on a chain without one (a `planned` chain, or anything else) → the selected chain, with a
  "wrong network" banner and a **Switch to …** button; deposit/redeem are blocked until it switches.

**Switching** (`src/chain/switchChain.ts`): `wallet_switchEthereumChain`; if the wallet answers
"unknown chain" (4902, also when nested inside a -32603), `wallet_addEthereumChain` with parameters
built from the registry (`addEthereumChainParams`), then switch again. A rejection is surfaced, never
retried. Every read, receipt wait and write names its chain explicitly — nothing reads a module-level
"the chain" constant.

### WalletConnect (phones and QR)

WalletConnect is **off until you supply a project id** — none is hardcoded, and the option is hidden
(with a short hint) when it is missing.

1. Get a free project id at <https://cloud.reown.com> (create a project → copy the Project ID).
2. `cp .env.example .env.local` and set it:

   ```bash
   VITE_WALLETCONNECT_PROJECT_ID=your_project_id_here
   ```

3. Restart `pnpm dev`. "WalletConnect" now appears in the picker and opens a QR code.

`.env.local` is gitignored; only `.env.example` is committed. The WalletConnect module is loaded on
demand, so it costs a visitor who connects with a browser extension nothing.

## Demo controls

| Control | How |
|---|---|
| Connect the demo wallet | `?wallet=demo` on any URL, or **Use demo wallet** in the wallet picker |
| Reset demo state | Click the **Poolmigo** wordmark 5 times within 2.5 s |
| Force US market status | `?market=closed` / `?market=open` / `?market=auto` (persists until changed) |
| Open the deposit modal on Explore | `/?deposit=tsla-usdc` |
| Open the claim modal on Explore | `/?claim=1` |
| Force a theme | `?theme=dark` / `?theme=light` (persists; header toggle does the same) |

State is persisted to `localStorage` under `poolmigo-demo-v1`.

## Where things live

| Path | What |
|---|---|
| `src/chain/` | Chain code: registry-driven chains, target chain + switching, per-chain viem clients, live reads, amount math, error decoding |
| `src/wallet/` | The wallet layer: EIP-6963 discovery, WalletConnect, picker modal, connection |
| `src/config/generated.ts` | `CHAINS` / `DEPLOYMENTS` + ABIs, generated from `../shared` by `pnpm sync:shared` — do not edit |
| `src/pages/LiveVault.tsx` | The live vault page (100% chain reads) |
| `src/components/live/` | Live deposit / redeem cards, adapter list, local dev tools |
| `src/components/ui/DataBadge.tsx` | `Demo data` / `Live on-chain` provenance badges |
| **`src/demo/`** | **Every invented number**: constants, math, seeded series, vault/protocol/user data |
| `src/lib/market.ts` | US market clock (America/New_York, weekdays 09:30–16:00 ET, holidays ignored) |
| `src/store/useStore.ts` | zustand store (persisted) with deposit / withdraw / stake / claim / lock / unlock |
| `src/store/selectors.ts` | Derived hooks shared by Explore, Vault and Rewards |
| `src/components/deposit/DepositCard.tsx` | The prototype deposit / withdraw card (demo data) |
| `src/components/vault/PriceRange.tsx` | Price chart with the LP range band (lightweight-charts) |
| `src/test/` | Spec anchors, store consistency, chain helpers, multi-chain registry + switching, wallet picker, render smoke test |
| `scripts/` | `sync-shared.ts` + `registry.ts` (config generation + validation), `e2e-local.ts` (viem end-to-end) |

## Brand

Follows the Poolmigo brand kit v1.0 (`brand-tokens.json`). Tailwind token *names* were kept from the original build so
components did not need to change; only the values did:

| Token | Value | Role |
|---|---|---|
| `deep` | `#FFF8EF` cream | page background, inset fields |
| `panel` / `panel-2` | `#FFFFFF` / `#F6EFE4` | cards / hover surfaces |
| `line` / `line-2` | `#DDD9D1` / `#C9C3B9` | borders |
| `ink` / `ink-2` / `ink-3` | `#302823` / `#625D57` / `#8F8981` | text, muted, quiet labels |
| `aqua` | `#244742` deep teal | primary actions, in-range, APR |
| `up` / `down` / `amber` | `#28614F` / `#A33832` / `#8B5A13` | success / negative / warning |
| `apricot` / `glass` | `#F3A66E` / `#7BB8B2` | character colours (decorative; apricot + ink for secondary CTAs) |
| `tide` | `#9A5A22` | PMG-denominated numbers — apricot darkened for text contrast (not in the kit) |

Type is Rubik (400 / 500 / 700) via Google Fonts with tabular numerals. Cards use a 16 px radius, buttons a 12 px radius,
and every action target is at least 36 px tall (44 px for primary CTAs). Wordmark SVGs and mascot crops live in `public/brand/`;
the mascot appears only in empty states, never inside data tables.

## Design tokens

Tailwind config is the token source: surfaces `deep` / `panel` / `line`, accent `aqua`, semantic `up` / `down` / `amber`,
token colour `tide`. Display type is Archivo, body and numerals are Inter with tabular figures on by default.
