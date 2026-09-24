# Poolmigo

In-kind, multi-DEX / multi-pool LP auto-rebalance vault for **EVM chains**.

Depositors provide the vault's underlying tokens **in kind** and receive `migoLP` — a fungible receipt
token that is a pro-rata claim on the whole basket. Share accounting is pure pro-rata over token
balances: **no USD valuation, no on-chain NAV, no third-party oracle reads**. LP positions live
behind a generic `IPositionAdapter` interface (Uniswap v3/v4 or any venue), and deposits,
redemptions and performance-fee harvesting are all settled in-kind.

- **Genesis**: the first deposit (supply == 0) is owner-only and mints a deploy-time constant K
  (`genesisShares`). K is set from a one-time, off-chain valuation of the seed basket so display
  starts at ≈$1/share; the contract itself never prices anything. Later deposits are pure ratios.
- **Donation guard**: deposits price with virtual shares/assets (1/1) and pull only what the minted
  shares require; redemptions stay exact pro-rata.
- **Supply cap**: optional `maxTotalSupply` on migoLP (0 = uncapped), raised by the owner in stages.
- **Keeper moves**: `pullFrom` (always back into the vault) + `deployTo` re-shape positions across
  ranges/venues on-chain.

## Layout

- `src/` — `PoolmigoVaultUpgradeable.sol` (UUPS-upgradeable, ERC-7201 namespaced storage, token + adapter registries), `PoolmigoVaultV2.sol` (example upgrade), `interfaces/` (`IPositionAdapter`, `IPoolmigoVault`), `periphery/` (`PoolmigoCreate3` — deterministic deploy factory)
- `test/` — Foundry unit/fuzz/upgrade tests + test mocks (the adapters in this repo are **mocks**)
- `script/` — deploy and upgrade scripts (OpenZeppelin upgrades plugin)
- `lib/` — dependencies: OpenZeppelin contracts / contracts-upgradeable / foundry-upgrades (submodules), forge-std (vendored)

## Build & test

```bash
forge build
forge test
```

Solidity 0.8.34 · Foundry ≥ 1.8 · OpenZeppelin v5.1.0. Node.js is needed by the OpenZeppelin
upgrades plugin used in the upgrade tests and scripts.

## Deterministic deployments (CREATE3)

`src/periphery/PoolmigoCreate3.sol` deploys any contract to an address that depends only on
`(factory, salt)` — the same address on every chain where the factory itself sits at the same
address. For the vault, the UUPS **proxy** is the address that must be stable; the implementation
is a plain per-chain deploy (the proxy stores its address).

```bash
# once per chain — as the FIRST tx of the dedicated deployer (nonce 0), so the factory matches:
forge clean && forge build
forge script script/DeployCreate3Factory.s.sol --rpc-url <rpc> --account <keystore> --sender <addr> --broadcast

# the vault (salt default: keccak256("poolmigo.vault.v1")):
CREATE3_FACTORY=0x... OWNER=0x... TREASURY=0x... FEE_BPS=1000 TOKENS=0x..,0x.. \
  GENESIS_SHARES=<K, raw 18-dp units> MAX_TOTAL_SUPPLY=<cap, 0 = uncapped> \
  forge script script/DeployDeterministic.s.sol --rpc-url <rpc> --account <keystore> --sender <addr> --broadcast

# end-to-end proof: same proxy address on two fresh Anvil chains with shifted nonces
script/deterministic-address-check.sh
```

Rules: one documented salt per logical contract — never reuse a salt for different bytecode (the
address does not commit to the code it holds). Do not edit `PoolmigoCreate3.sol` once a factory is
deployed at a cross-chain-shared address: a different dispatcher init code changes every predicted
address. `initialize` runs with `msg.sender == dispatcher` when invoked atomically through the
factory — the vault initializer takes explicit addresses, so that path is safe; keep it that way.

## Status — read before using

- **Not deployed.** Do not use with real funds.
- The Uniswap v3/v4 adapters contained here are **test mocks**; production venue adapters are in
  development.
- Reward / tokenomics design is out of scope for this repository.