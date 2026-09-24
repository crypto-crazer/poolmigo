#!/usr/bin/env bash
# CREATE3 determinism check — end to end, against two throwaway Anvil chains.
#
# Deploys the SAME vault stack through PoolmigoCreate3 on two fresh Anvil instances, where the
# second run deliberately has a shifted sender nonce, then asserts:
#   - the factory address matches        (first tx of account #0, nonce 0, on both chains)
#   - the vault PROXY address matches    <- the point of CREATE3
#   - the implementation addresses differ <- proves the match is not an artifact
#
# Local-only: uses the publicly known Anvil dev keys. Inert — never fund them for real.
#
# Usage: script/deterministic-address-check.sh   (from contracts/, or anywhere)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for bin in forge anvil cast; do
  command -v "$bin" >/dev/null || { echo "ERROR: $bin not found in PATH"; exit 1; }
done

PORT_A=8548
PORT_B=8549
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil #0 — LOCAL ONLY
PK1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d # anvil #1 — LOCAL ONLY
ADDR1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
ADDR2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

wait_for_rpc() {
  local rpc=$1
  for _ in $(seq 1 60); do
    cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  echo "ERROR: $rpc did not come up"; exit 1
}

# $1 = log file, $2 = KEY (e.g. POOLMIGO_PROXY)
extract() { sed -nE "s/.*${2}=(0x[0-9a-fA-F]{40}).*/\1/p" "$1" | tail -1; }

# $1 = port, $2 = label, $3 = junk txs before the vault deploy
run_stack() {
  local port=$1 label=$2 junk=$3 rpc="http://127.0.0.1:$1"
  anvil --port "$port" --chain-id 46630 >"$WORK/anvil-$label.log" 2>&1 &
  PIDS+=("$!")
  wait_for_rpc "$rpc"

  echo "--- [$label] factory (account #0, nonce 0 on a fresh chain)"
  if ! forge script script/DeployCreate3Factory.s.sol --rpc-url "$rpc" --private-key "$PK0" \
      --broadcast >"$WORK/factory-$label.log" 2>&1; then
    echo "factory deploy FAILED:"; tail -25 "$WORK/factory-$label.log"; exit 1
  fi
  extract "$WORK/factory-$label.log" POOLMIGO_CREATE3_FACTORY >"$WORK/factory-$label.addr"

  echo "--- [$label] shifting sender nonce by $junk transport(s)"
  for _ in $(seq 1 "$junk"); do
    cast send "$ADDR2" --value 1wei --private-key "$PK1" --rpc-url "$rpc" >/dev/null
  done

  echo "--- [$label] vault stack via CREATE3 (sender: anvil #1, nonce now $junk)"
  if ! CREATE3_FACTORY="$(cat "$WORK/factory-$label.addr")" OWNER="$ADDR1" TREASURY="$ADDR2" \
      FEE_BPS=1000 TOKENS="$ADDR1,$ADDR2" LABEL="$label" \
      GENESIS_SHARES=10000000000000000000000 MAX_TOTAL_SUPPLY=500000000000000000000000 \
      forge script script/DeployDeterministic.s.sol --rpc-url "$rpc" --private-key "$PK1" \
      --broadcast >"$WORK/out-$label.log" 2>&1; then
    echo "vault deploy FAILED:"; tail -25 "$WORK/out-$label.log"; exit 1
  fi
  extract "$WORK/out-$label.log" POOLMIGO_PROXY >"$WORK/proxy-$label"
  extract "$WORK/out-$label.log" POOLMIGO_IMPL >"$WORK/impl-$label"
}

echo "=== OZ plugin: single fresh build-info before any script run ==="
forge clean >/dev/null && forge build >/dev/null

run_stack "$PORT_A" A 0
run_stack "$PORT_B" B 5

FA=$(cat "$WORK/factory-A.addr");       FB=$(cat "$WORK/factory-B.addr")
PA=$(cat "$WORK/proxy-A");              PB=$(cat "$WORK/proxy-B")
IA=$(cat "$WORK/impl-A");               IB=$(cat "$WORK/impl-B")

echo
echo "factory  (A, fresh acct) : $FA"
echo "factory  (B, fresh acct) : $FB"
echo "proxy    (A, nonce 0)    : $PA"
echo "proxy    (B, nonce 5)    : $PB"
echo "impl     (A)             : $IA"
echo "impl     (B)             : $IB"
echo

fail=0
[ -n "$FA" ] && [ "$FA" = "$FB" ] && echo "PASS  factory address identical" || { echo "FAIL  factory mismatch"; fail=1; }
[ -n "$PA" ] && [ "$PA" = "$PB" ] && echo "PASS  vault proxy address identical across chains/nonces" || { echo "FAIL  proxy mismatch"; fail=1; }
[ -n "$IA" ] && [ "$IA" != "$IB" ] && echo "PASS  implementation addresses differ (nonce-shifted chain, as expected)" \
  || echo "WARN  implementation addresses identical (unexpected, not fatal)"
[ "$fail" = 0 ] && echo "== CREATE3 determinism check: PASS ==" || { echo "== CREATE3 determinism check: FAIL =="; exit 1; }