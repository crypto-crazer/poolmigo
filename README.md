# Poolmigo

In-kind, multi-DEX / multi-pool LP auto-rebalance vault for **EVM chains**.

Depositors provide the vault's underlying tokens **in kind** and receive `migoLP` — a fungible receipt
token that is a pro-rata claim on the whole basket. Share accounting is pure pro-rata over token
balances: **no USD valuation, no on-chain NAV, no third-party oracle reads**. LP positions live
behind a generic `IPositionAdapter` interface, and deposits, redemptions and performance-fee
harvesting are all settled in-kind.

> **Status: not deployed to production.** The venue adapters shipped in this repository are test mocks.

## Monorepo layout

| Path | What |
| --- | --- |
| `contracts/` | Foundry project — vault core, adapter interface, tests, deploy/upgrade scripts (see `contracts/README.md`) |
| `frontend/` | Web app — multi-wallet connect (viem: EIP-6963 + WalletConnect); deposits, redemptions, position views |
| `backend/` | Keeper service — executes `deployTo` / `pullFrom` / `rebalance` under keeper permissions |
| `shared/` | Shared ABIs + local deployment config consumed by frontend and backend |

## Quick start

- Contracts: `cd contracts && forge build && forge test`
- Local demo stack (Anvil + mock tokens/vault, writes `shared/deployment.local.json`):
  `cd contracts && forge script script/DemoLocal.s.sol --broadcast`
- Frontend: `cd frontend && pnpm install && pnpm dev` — live vault at `/live`; end-to-end check: `pnpm e2e:local`
- Backend: `cd backend && pnpm install && pnpm build && pnpm tick` — dry-run by default; `pnpm start` runs the loop