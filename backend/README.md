# Poolmigo keeper

The keeper service for the [Poolmigo](../README.md) vault. It is the off-chain process that calls
the vault's two keeper-gated functions on a schedule:

- **`deployTo(adapter, amounts)`** — move idle vault tokens into a whitelisted position adapter.
- **`rebalance()`** — harvest every adapter and skim the performance fee, in kind, to the treasury.

It never calls anything owner-only. `addAdapter`, `removeAdapter`, `setKeeper`,
`setRebalancePaused`, `setPerformanceFeeBps`, `setTreasury`, `emergencyUnwind` and upgrades are
absent from this codebase's ABI selection entirely, so the keeper cannot encode them even by
accident.

> **Strategy disclaimer.** The allocation rule here is deliberately boring plumbing: keep a fixed
> fraction of each basket token idle as a redemption buffer, spread the rest over the registered
> adapters by fixed weights, ramp in gradually. It is **not alpha.** Real allocation — which pool,
> which range, when to rotate — is off-chain quant work that belongs in a replacement for
> `src/policy.ts`. Treat the defaults as a safe starting point, not as a recommendation.

> **Development build — do not point this at real money.**

---

## Quick start (local demo stack — dry run first)

The monorepo's local stack must be running (Anvil on `127.0.0.1:8547`, chain id 46630, deployed by
`contracts/script/DemoLocal.s.sol`). The chain, RPC and vault come from the monorepo chain registry
(`../shared/deployments.json`, with `../shared/deployment.local.json` overlaid — see
[Chain selection](#chain-selection-the-registry)) automatically, so you only need to supply a key.

```bash
cd backend
pnpm install
pnpm build

# 1. Look before you leap. DRY_RUN defaults to true; --dry-run makes it explicit.
KEEPER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
  node dist/cli.js tick --dry-run

# 2. Read the "policy decision" line. Happy with the amounts? Then execute one tick.
KEEPER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
  node dist/cli.js tick --execute

# 3. Run the loop.
KEEPER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
  TICK_INTERVAL_SEC=60 node dist/cli.js run
```

`0x59c6…690d` is Anvil account #1, the **publicly known** test key the demo stack grants the keeper
role. It is inert. **Never** fund it on a real network, and never use an inline key in production —
see [Secret handling](#secret-handling).

### Commands

| Command  | What it does                                                                    |
| -------- | ------------------------------------------------------------------------------- |
| `tick`   | Preflight, observe, plan, simulate, (execute), persist. One pass, then exit.     |
| `run`    | The same tick on `TICK_INTERVAL_SEC`, until SIGINT/SIGTERM.                      |
| `status` | Preflight + a fully read-only dry tick. Writes nothing, not even the state file. |

pnpm aliases: `pnpm tick`, `pnpm start`, and `pnpm dev:tick` / `pnpm dev:run` (tsx, no build).

Flags: `--dry-run` / `--execute` (aka `--no-dry-run`) override `DRY_RUN`; later flags win, so
`--execute --dry-run` is safe. `--help`, `--version`.

---

## What one tick does

1. **Preflight** — the RPC's chain id must equal `CHAIN_ID`, and `vault.isKeeper(us)` must be true.
   Either failing aborts with exit code 3 and an explicit message; the loop will not start.
2. **Observe** — `tokens()`, `adapters()`, the pause flag, fee bps, treasury, each token's
   `balanceOf(vault)` (idle), and every adapter's `position()`. All reads are pinned to one block
   number so the snapshot cannot straddle a state change.
3. **Plan** — pure functions in `src/policy.ts` (see below). No IO, no clock, no randomness.
4. **Simulate** — `simulateContract` for every intended call, plus a gas estimate, at head. A revert
   here kills that one action and is logged with the decoded custom error; the tick continues.
5. **Execute** — only when dry-run is off. Sends via viem, waits `CONFIRMATIONS`, logs hash, block
   and gas used, then **re-reads `position()` and verifies the delta equals the intent**. A mismatch
   is a `WARN` with per-token expected/observed/delta, not a crash: a real venue adapter may deploy
   less than offered, and fees accrue between the two reads.
6. **Harvest** — if `REBALANCE_INTERVAL_SEC` has elapsed since the last **confirmed** `rebalance()`,
   call it. Dry runs and failures do not advance the gate.
7. **Persist** — atomically write `STATE_FILE`.

While `rebalancePaused` is true both entry points revert on-chain, so the tick skips straight to a
`WARN` with `reason: "vault-paused"` and does no work. (Redemptions stay open regardless — that is
the vault's design, not the keeper's business.)

### The policy rule

Per basket token `i`:

```
total_i      = idle_i + Σ_adapters position_i
targetIdle_i = total_i * TARGET_IDLE_BPS      / 10_000
excess_i     = max(0, idle_i - targetIdle_i)
tickCap_i    = total_i * MAX_DEPLOY_PER_TICK_BPS / 10_000
budget_i     = min(excess_i, tickCap_i)
```

`budget_i` is split across the adapters **that actually report token `i`**, proportional to
`ADAPTER_WEIGHTS`. Splits round down; the dust stays idle rather than overdrawing the budget.
Per-adapter amounts below `MIN_DEPLOY_AMOUNT_RAW` are zeroed, and an adapter whose whole vector is
zero is dropped from the plan with a reason.

The per-tick cap is measured against **total**, not idle, on purpose: total does not move as the
tick deploys, so a fully idle vault and a nearly fully deployed one behave identically and
successive ticks converge on the target instead of oscillating. With the defaults (20% target,
50% cap) a fully idle vault reaches exactly its target in two ticks: 50% out, then the remaining
30%.

### Token-order alignment — the sharp edge

`deployTo` reads `adapter.position()` and requires `amounts` to be aligned to **that adapter's own
token order**, which is not guaranteed to equal the vault's basket registry order. Every plan this
service produces carries the adapter's token vector next to the amounts, and amounts are built by
looking each adapter token up in the registry — never by index. The logs print
`amountsByToken: [{token, amount}, …]` so a human can check it, and the unit suite covers a
reordered adapter, two adapters with different orders, an adapter holding a strict subset of the
basket, a duplicated token, and a token that is not in the registry at all.

---

## Configuration

Environment only — `.env` is **not** auto-loaded. Load it yourself
(`set -a; . ./.env; set +a`), or via `docker compose --env-file` / systemd `EnvironmentFile`.
`.env.example` documents every variable with the same defaults.

| Variable                  | Default                             | Meaning                                                                                                    |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                | *(registry: local, else 1st deployed)* | Chain to act on. Must be `deployed` in the registry unless `RPC_URL` + `VAULT_ADDRESS` are set too. Verified against the RPC at preflight. |
| `RPC_URL`                 | *(registry entry)*                  | JSON-RPC endpoint. Overrides the selected entry's `rpcUrl`.                                                   |
| `VAULT_ADDRESS`           | *(registry entry)*                  | The vault **proxy**. Overrides the selected entry's `addresses.vault`.                                       |
| `DEPLOYMENTS_FILE`        | `../shared/deployments.json`        | The chain registry (shared with the frontend). Missing file is fine when the three above are set.            |
| `DEPLOYMENT_FILE`         | `deployment.local.json` next to the registry | Local-stack overlay. Without a registry on disk, a flat file here still supplies the three above.   |
| `KEEPER_PRIVATE_KEY`      | —                                   | Hex key. Local/dev use only. Mutually exclusive with `KEEPER_KEY_FILE`.                                      |
| `KEEPER_KEY_FILE`         | —                                   | Path to a file containing only the key. The production-shaped option (secret mounts).                        |
| `KEEPER_ADDRESS`          | *(derived from the key)*            | Set **alone** for a signer-less dry-run monitor. Must match the key if both are set.                         |
| `DRY_RUN`                 | `true`                              | `true` = simulate only, never send. **Defaults to safe.**                                                    |
| `TICK_INTERVAL_SEC`       | `60`                                | Seconds between ticks in `run` mode.                                                                         |
| `REBALANCE_INTERVAL_SEC`  | `86400`                             | Minimum seconds between confirmed harvests. `0` = every tick.                                                |
| `TARGET_IDLE_BPS`         | `2000`                              | Fraction of each token's **total** to keep idle as a redemption buffer.                                      |
| `MAX_DEPLOY_PER_TICK_BPS` | `5000`                              | Per-tick ceiling, as a fraction of each token's **total**.                                                   |
| `ADAPTER_WEIGHTS`         | equal                               | `"1,3"` (positional) or `"0xA:1,0xB:3"` (by address — **recommended**). Weight `0` = never fund.              |
| `MIN_DEPLOY_AMOUNT_RAW`   | `0`                                 | Dust guard in raw units. Scalar, or `"default:0,0xToken:1000000"` per token (decimals differ per token).     |
| `STATE_FILE`              | `.keeper-state.json`                | Durable scheduling state. Put it on a volume in Docker.                                                      |
| `LOG_LEVEL`               | `info`                              | `debug` \| `info` \| `warn` \| `error`.                                                                      |
| `CONFIRMATIONS`           | `1`                                 | Receipt confirmations to wait for.                                                                           |
| `TX_TIMEOUT_SEC`          | `120`                               | Receipt wait timeout.                                                                                        |
| `RPC_MAX_RETRIES`         | `4`                                 | Retries per logical RPC operation. Contract reverts are **never** retried.                                   |
| `RPC_BACKOFF_BASE_MS`     | `500`                               | Exponential backoff base, with full jitter.                                                                  |

`ADAPTER_WEIGHTS` by address is recommended because `removeAdapter` uses swap-and-pop: a positional
list silently re-targets itself when the adapter registry changes. A positional list whose length no
longer matches `adapters()` is rejected at tick time rather than guessed at.

### Chain selection (the registry)

The keeper reads the monorepo chain registry, **`shared/deployments.json` — the same registry the
frontend uses** (`pnpm sync:shared` there). Each entry has a `name`, `rpcUrl`, `testnet`, optional
`explorerUrl`, and `status: "planned" | "deployed"`; deployed entries carry the nine-key
`addresses` object. `shared/deployment.local.json` (written by `DemoLocal.s.sol`) is overlaid onto
the entry with the same chain id: that entry becomes `deployed` + `local`, with the local RPC and
addresses. Validation is identical to the frontend's (`src/registry.ts` restates
`frontend/scripts/registry.ts`), and errors name the file and path, e.g.
`deployments.json: chains.4663.rpcUrl must be an http(s) URL (got "…")`.

Which chain:

1. **`CHAIN_ID`** from env, when set — it must be listed in the registry and `deployed`;
2. otherwise the registry's **local** entry (the demo stack);
3. otherwise the **first deployed** chain, in ascending chain-id order.

A `planned` chain is never acted on: `CHAIN_ID=4663` today fails with exit 2 and
`chain 4663 is planned — no deployment to act on (…)`. Per value, env still wins:
`CHAIN_ID` / `RPC_URL` / `VAULT_ADDRESS` override the selected entry's id / `rpcUrl` /
`addresses.vault`. The startup line and `preflight ok` / `observed vault` carry the chain's
registry name (`chain`), and the startup line adds `chainStatus` / `chainLocal` / `chainTestnet`.

**Containers and CI (env only).** The image has no `../shared`. Set `CHAIN_ID`, `RPC_URL` and
`VAULT_ADDRESS` and the keeper loads exactly as before — the registry is optional then and, when a
file is present, only names the chain (`Chain <id>` when it is absent or does not list the chain).
Env is authoritative in that mode, even for a chain the registry still lists as `planned` (the
startup line then shows `chainStatus: "planned"` — check it). A registry file that exists but is
invalid is always an error.

**Adding a chain.** Add an entry under `chains` in `shared/deployments.json` (`status: "planned"`
until the vault exists; then `"deployed"` plus all nine `addresses`). That is the only change: the
keeper and the frontend both pick it up, and the keeper can then be pointed at it with
`CHAIN_ID=<id>` (plus `RPC_URL` if you use a private endpoint). There is no chain list in this
package's code.

### State file

```json
{
  "version": 1,
  "lastTickAt": 1790078652,
  "lastSuccessfulTickAt": 1790078652,
  "lastRebalanceAt": null,
  "lastRebalanceTx": null,
  "lastDeployTxs": [],
  "tickCount": 3,
  "lastError": null
}
```

Written atomically (temp file + `rename`, mode 0600), so a crash mid-write cannot truncate it. It is
a *cache of when I last acted*, never a source of truth about money — the chain is. A corrupt or
missing file degrades to "harvest is due now", which is safe, and is logged as
`state recovered`.

---

## Secret handling

The private key is the only secret, and it is never logged: the startup line runs the config through
`describeConfig`, which reports `signer: "configured" | "absent"` and omits the key by construction.
A malformed key is rejected without echoing the value.

In order of preference:

1. **External signer / KMS.** The keeper is a hot key that can only move funds between the vault and
   *owner-whitelisted* adapters — it cannot withdraw to an arbitrary address — so the blast radius is
   bounded, but a remote signer (AWS KMS, GCP KMS, Fireblocks, `web3signer`) still removes the key
   from this process entirely. Not wired up here; it is a `viem` custom `Account`, a small change in
   `src/chain.ts`.
2. **`KEEPER_KEY_FILE` pointing at a mounted secret** (Docker/Compose `secrets:`, Kubernetes
   `Secret` volume, systemd `LoadCredential=`). Mode `0400`, owned by the service user.
3. **`KEEPER_PRIVATE_KEY` from a secret manager at process start.** Acceptable but weaker:
   environment variables show up in `docker inspect`, `/proc/<pid>/environ`, crash dumps and child
   processes.

Never: a key baked into the image, committed to `.env`, or passed on the command line (the argv of
every process on the box is world-readable).

Operationally: the vault owner grants the role with `setKeeper(addr, true)` and can revoke it the
same way — `setKeeper(addr, false)` is the kill switch for a suspected-compromised keeper, and the
next tick then exits 3. Fund the keeper address with gas only.

---

## Deployment

### Docker

```bash
docker compose build
docker compose run --rm keeper node dist/cli.js tick --dry-run   # always first
docker compose up -d
docker compose logs -f keeper
```

Multi-stage (`deps` → `build` → `runtime`) on `node:20-alpine`, running as the non-root `node` user
with production dependencies only. `src/abi/generated.ts` is committed so the build context is
`backend/` alone and the image never needs `../shared` — so set `CHAIN_ID`, `RPC_URL` and
`VAULT_ADDRESS` in `.env` (see [Chain selection](#chain-selection-the-registry)); to use the
registry in a container instead, mount it and set `DEPLOYMENTS_FILE`. Safe defaults are baked in (`DRY_RUN=true`,
state on `/var/lib/poolmigo-keeper`), and the compose service adds `read_only: true`,
`no-new-privileges`, a named volume for the state file, and log rotation.

`HEALTHCHECK` runs `node dist/cli.js status`, which exits non-zero when preflight fails (wrong
chain, or the keeper role was revoked). It is fully read-only.

**Reaching an Anvil on the host:** the container cannot see the host's `127.0.0.1`. Uncomment the
`extra_hosts` block in `docker-compose.yml` and set `RPC_URL=http://host.docker.internal:8547`.

### systemd

```ini
# /etc/systemd/system/poolmigo-keeper.service
[Unit]
Description=Poolmigo vault keeper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=poolmigo
Group=poolmigo
WorkingDirectory=/opt/poolmigo-keeper
ExecStart=/usr/bin/node dist/cli.js run

# Configuration (no secrets in here).
EnvironmentFile=/etc/poolmigo-keeper/keeper.env
# Secret: systemd mounts it at $CREDENTIALS_DIRECTORY/keeper_key, mode 0400, for this unit only.
LoadCredential=keeper_key:/etc/poolmigo-keeper/keeper_key
Environment=KEEPER_KEY_FILE=%d/keeper_key
Environment=STATE_FILE=/var/lib/poolmigo-keeper/keeper-state.json
StateDirectory=poolmigo-keeper

# SIGTERM is handled gracefully: the in-flight tick finishes first. Give it room.
KillSignal=SIGTERM
TimeoutStopSec=180

Restart=on-failure
RestartSec=30
# Exit 2 (bad config) and 3 (not an authorised keeper) will not fix themselves — do not loop on them.
SuccessExitStatus=0
RestartPreventExitStatus=2 3

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

---

## Monitoring

Structured JSON on stdout, one object per line. Every record has `ts`, `level`, `msg`, `svc`;
ticks add `tick` and `dryRun`. Token amounts are always raw integers serialised as **decimal
strings** — never JavaScript numbers, so nothing is lossy.

Messages worth alerting on or graphing:

| `msg`                                   | Level | Use                                                                    |
| --------------------------------------- | ----- | ---------------------------------------------------------------------- |
| `preflight ok` / `preflight failed`      | info/error | `preflight failed` = page. The keeper is not acting at all.        |
| `observed vault`                        | info  | `chain` (registry name), `chainId`, `vault`, `idle[]`, `adapters[].amounts[]` — the balance time series. |
| `policy decision`                       | info  | `budgets[]` with `idle/total/targetIdle/excess/tickCap/budget` per token. |
| `simulated deployTo` / `simulated rebalance` | info | Intent + `gasEstimate`. In dry-run this is the whole output.       |
| `DRY RUN — not sending …`               | info  | Confirms nothing was sent. Its absence in production is expected.       |
| `deployTo confirmed` / `rebalance confirmed` | info | `txHash`, `block`, `gasUsed`; harvest adds `harvested[{token,amount,fee}]`. |
| `post-condition verified`               | info  | The position moved by exactly the intent.                               |
| `post-condition mismatch after deployTo` | warn | **Investigate.** Per-token `expected`/`observed`/`delta`.               |
| `rebalancePaused is true …`             | warn  | Vault paused by the owner; the keeper is idling by design.              |
| `rpc call failed, backing off`          | warn  | `attempt`, `delayMs`. Sustained = RPC trouble.                          |
| `deployTo failed` / `rebalance failed`  | error | Decoded revert in `errShort`. One action failed; the tick survived.     |
| `tick threw`                            | error | `consecutiveFailures`. Alert at ≥ 3.                                    |
| `tick complete`                         | info  | `ok`, and counts of `deployed`/`simulated`/`failed`. Heartbeat.         |

A missing `tick complete` for more than ~2× `TICK_INTERVAL_SEC` means the loop is wedged or dead —
that is the liveness alert. The loop itself backs off after consecutive failures (×2 per failure,
capped at ×16) so a dead RPC is not hammered.

**Exit codes**

| Code | Meaning                                                          | Restart? |
| ---- | ---------------------------------------------------------------- | -------- |
| 0    | Clean exit (loop stopped by signal, or a successful `tick`).      | —        |
| 1    | Unexpected fatal error, or a `tick` in which an action failed.    | Yes      |
| 2    | Configuration error. Will not fix itself.                         | **No**   |
| 3    | Preflight failure: wrong chain, or not an authorised keeper.      | **No**   |

---

## Development

```bash
pnpm sync-abis   # regenerate src/abi/generated.ts from ../shared/abis/*.json
pnpm build
pnpm typecheck
pnpm test        # unit + integration
pnpm test:unit   # unit only — no chain needed
```

Package manager: **pnpm** (lockfile `pnpm-lock.yaml`; npm is not used).

TypeScript strict (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), no `any`.

- `src/policy.ts` — the entire strategy: pure, deterministic, no IO. Replace this to change
  behaviour; the tests will tell you what you broke.
- `src/keeper.ts` — tick orchestration and the supervision loop.
- `src/vault.ts` — the only module that touches contracts.
- `src/registry.ts` — the chain registry: parse/validate, local overlay, chain selection. Pure.
- `src/config.ts` / `src/state.ts` / `src/chain.ts` / `src/logger.ts` — env + registry resolution,
  durable state, viem wiring + retry policy, structured logging.

Integration tests (`test/integration/`) talk to the live local Anvil — the registry's **local**
entry (`shared/deployments.json` + `shared/deployment.local.json`); they never fall back to another
deployed chain. They **skip themselves with a printed reason** when it is unreachable, and
`assertLocalChain` refuses to run them unless the entry is the local overlay, the registry marks the
chain `testnet`, and the RPC is localhost — they send real transactions and seed mock fees, which is
only acceptable on a disposable chain.

ABIs are generated from `shared/abis/` (the monorepo's single source of truth) into a committed
`src/abi/generated.ts`, narrowed to exactly what the keeper uses. Re-run `pnpm run sync-abis` after
any contract change.
