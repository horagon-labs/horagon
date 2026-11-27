#!/usr/bin/env bash
# The program's own suite (tests/integration) on a local chain, the way CI runs it
# (.github/workflows/program.yml, job `integration`). Linux or macOS, with Agave
# (solana-test-validator, solana-keygen, solana), Surfpool, Node 22 and pnpm, after
# `pnpm install` and `anchor build` (target/deploy/horagon.so). From anywhere in the repo:
#   bash scripts/program-it.sh
#
# Two local processes, no secret, and nothing sent to devnet but reads:
# - solana-test-validator is a clean upstream. It clones pm-AMM and Metaplex from devnet and
#   loads target/deploy/horagon.so at the program id, with a throwaway upgrade authority made
#   here (the suite's admin, HORAGON_IT_ADMIN).
# - Surfpool forks that validator, for its clock cheatcode (surfnet_timeTravel). It does not fork
#   devnet: there the program id holds the live program and its Config, so initialize_config
#   could never run, and every account the suite touches would be one more devnet request.
# Logs and the JSON test report land in $HORAGON_IT_WORK (default target/program-it).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

HORAGON=HtDJ3vfx8vtFSmskm2Ks39kBMuDmFZH3H2B173BB9qHF
PM_AMM=GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y
METAPLEX=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
SO=target/deploy/horagon.so
WORK="${HORAGON_IT_WORK:-$PWD/target/program-it}"
# Surfpool takes 8899 (RPC), 8900 (WebSocket) and 8001 to 8004. The validator's RPC sits apart,
# and its other ports come from a range of their own.
UPSTREAM_PORT=28899
UPSTREAM="http://127.0.0.1:$UPSTREAM_PORT"
RPC="http://127.0.0.1:8899"

fail() {
  echo "program-it: $*" >&2
  exit 1
}

for tool in solana-test-validator solana-keygen solana surfpool pnpm node curl; do
  command -v "$tool" >/dev/null || fail "$tool is not on PATH (docs/testing.md)"
done
[ -f "$SO" ] || fail "no $SO: run anchor build first"
for url in "$UPSTREAM" "$RPC"; do
  if curl -s -m 2 -o /dev/null "$url"; then
    fail "something already answers at $url: stop it first (the suite needs a fresh chain)"
  fi
done

rm -rf "$WORK"
mkdir -p "$WORK/surfnet"
PIDS=()
cleanup() {
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

# Returns once $1 answers getSlot with a slot of at least $3; fails when process $2 has exited
# or after 120 s.
wait_for_slot() {
  local url=$1 pid=$2 min=$3 slot
  for _ in $(seq 1 120); do
    slot=$(curl -s -m 5 -X POST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' "$url" 2>/dev/null |
      sed -n 's/.*"result":\([0-9][0-9]*\).*/\1/p' || true)
    if [ -n "$slot" ] && [ "$slot" -ge "$min" ]; then
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

ADMIN_KEY="$WORK/it-admin.json"
solana-keygen new --no-bip39-passphrase --silent --force --outfile "$ADMIN_KEY" >/dev/null
ADMIN=$(solana-keygen pubkey "$ADMIN_KEY")
echo "program-it: throwaway upgrade authority $ADMIN"

# The clone reads devnet once, at startup; a busy public RPC gets two more tries.
for attempt in 1 2 3; do
  echo "program-it: starting solana-test-validator at $UPSTREAM (attempt $attempt)"
  solana-test-validator --reset --quiet --ledger "$WORK/ledger" \
    --rpc-port "$UPSTREAM_PORT" --dynamic-port-range 30000-31000 \
    --url devnet \
    --clone-upgradeable-program "$PM_AMM" \
    --clone-upgradeable-program "$METAPLEX" \
    --upgradeable-program "$HORAGON" "$SO" "$ADMIN" \
    >>"$WORK/test-validator.out" 2>&1 &
  UPSTREAM_PID=$!
  PIDS+=("$UPSTREAM_PID")
  # A few slots in, so that the loaded programs are past their deployment slot.
  if wait_for_slot "$UPSTREAM" "$UPSTREAM_PID" 5; then
    break
  fi
  kill "$UPSTREAM_PID" 2>/dev/null || true
  wait "$UPSTREAM_PID" 2>/dev/null || true
  if [ "$attempt" = 3 ]; then
    tail -n 40 "$WORK/test-validator.out" >&2 || true
    fail "solana-test-validator did not start: $WORK/test-validator.out, $WORK/ledger/validator.log"
  fi
  sleep 10
done

solana program show --url "$UPSTREAM" "$HORAGON" | tee "$WORK/program-show.txt"
SHOW=$(solana program show --url "$UPSTREAM" --output json-compact "$HORAGON")
case "$SHOW" in
  *"\"authority\":\"$ADMIN\""*) ;;
  *) fail "the program's upgrade authority is not the throwaway admin $ADMIN: $SHOW" ;;
esac

echo "program-it: starting Surfpool at $RPC, forking $UPSTREAM"
# From an empty directory: inside an Anchor workspace Surfpool plans deployments of its own.
(cd "$WORK/surfnet" && exec surfpool start --rpc-url "$UPSTREAM" --no-tui --no-studio --no-deploy) \
  >"$WORK/surfpool.out" 2>&1 &
SURFPOOL_PID=$!
PIDS+=("$SURFPOOL_PID")
if ! wait_for_slot "$RPC" "$SURFPOOL_PID" 1; then
  tail -n 40 "$WORK/surfpool.out" >&2 || true
  fail "Surfpool did not start: $WORK/surfpool.out"
fi
# Loads the program through Surfpool before the first timed case; the suite fails clearly if not.
solana program show --url "$RPC" "$HORAGON" ||
  echo "program-it: warning: Surfpool could not show the program yet"

pnpm turbo run build --filter=@horagon/integration...
HORAGON_IT_RPC="$RPC" HORAGON_IT_ADMIN="$ADMIN_KEY" \
  pnpm --filter @horagon/integration exec vitest run \
  --reporter=default --reporter=json --outputFile.json="$WORK/vitest.json"

# describe.skipIf passes when HORAGON_IT_RPC never reached the suite: a green run must have
# run every case.
node -e '
const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
const skipped = r.numPendingTests + r.numTodoTests
console.log(`program-it: ${r.numPassedTests} of ${r.numTotalTests} passed, ${skipped} skipped`)
if (r.numTotalTests === 0 || r.numPassedTests !== r.numTotalTests || skipped > 0) process.exit(1)
' "$WORK/vitest.json"
