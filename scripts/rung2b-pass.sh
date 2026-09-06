#!/usr/bin/env bash
#
# Run one pass of rung 2b (the cross-machine party exchange) against Cardano
# preprod. See rung2b-relay/RELAY-CONTRACT.md for what each pass expects.
#
#   scripts/rung2b-pass.sh LEADER                                  # pass 1
#   scripts/rung2b-pass.sh FOLLOWER rung2b-relay/client-leader-pass1.json   # pass 2
#   scripts/rung2b-pass.sh LEADER   rung2b-relay/desk-follower-pass2.json   # pass 3
#
# Read-only: this rung never submits a transaction and needs no funded wallet.
#
# The Blockfrost project id is a credential. It is read from the file below and
# NEVER echoed - all output is filtered through sed before it reaches a terminal
# or a log. Do not add a command here that prints "$ID".
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

ROLE="${1:-}"
INCOMING="${2:-}"
case "$ROLE" in
  LEADER|FOLLOWER) ;;
  *) echo "usage: $0 <LEADER|FOLLOWER> [incoming-payload.json]"; exit 2 ;;
esac

: "${PWNDA_ENGINE_TEST_PYTHON:=C:/Users/user/.pwnda-engine-venv/Scripts/python.exe}"
: "${PWNDA_ENGINE_TEST_DIR:=$REPO/pwnda-engine-handoff/engine}"
: "${PWNDA_2B_SWAP_ID:=rung2b_xm_2026_07_21}"
CRED="${PWNDA_2B_PROJECT_ID_FILE:-$REPO/pwnda-testnet-credentials/blockfrost-project-id.preprod}"

ID=$(tr -d ' \r\n' < "$CRED" 2>/dev/null)
if [ -z "$ID" ]; then
  echo "FATAL: no preprod Blockfrost project id at $CRED"
  echo "       (set PWNDA_2B_PROJECT_ID_FILE to point elsewhere)"
  exit 1
fi

# The epoch both sides must share. The party-exchange shape has no HTTP M1, so
# it has no epoch pin either - this value travels in the relay payload instead,
# and a mismatch is rejected at the relay. Fetched with the SAME project id the
# sidecar uses, so it is the same view the fee estimate will see.
EPOCH_JSON=$(BFID="$ID" "$PWNDA_ENGINE_TEST_PYTHON" - <<'PY' 2>/dev/null
import os, json, datetime
from blockfrost import BlockFrostApi, ApiUrls
api = BlockFrostApi(project_id=os.environ["BFID"], base_url=ApiUrls.preprod.value)
e, b = api.epoch_latest(), api.block_latest()
print(json.dumps({
    "epoch": e.epoch,
    "ends": datetime.datetime.utcfromtimestamp(e.end_time).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "hours_left": round((e.end_time - b.time) / 3600.0, 2),
    "tip_slot": b.slot,
}))
PY
)
if [ -z "$EPOCH_JSON" ]; then
  echo "FATAL: could not read the preprod epoch (chain unreachable, or the project id is rejected)."
  echo "       Every later failure would look like a crypto disagreement, so this stops here."
  exit 1
fi
EPOCH=$(echo "$EPOCH_JSON"  | sed -n 's/.*"epoch": *\([0-9]*\).*/\1/p')
ENDS=$(echo "$EPOCH_JSON"   | sed -n 's/.*"ends": *"\([^"]*\)".*/\1/p')
HOURS=$(echo "$EPOCH_JSON"  | sed -n 's/.*"hours_left": *\([0-9.]*\).*/\1/p')
echo "rung2b: preprod epoch $EPOCH, rolls $ENDS (~${HOURS}h left)"
echo "rung2b: all passes must complete inside epoch $EPOCH - params change at the boundary."

mkdir -p "$REPO/rung2b-relay"
case "$ROLE:${INCOMING:+in}" in
  LEADER:)
    OUT="$REPO/rung2b-relay/client-leader-pass1.json"
    # That file is the RECORD of the completed 2b run, not scratch space. A bare
    # `LEADER` re-run starts a new pass 1 and would overwrite it with a different
    # swap's material, quietly destroying the evidence for a run that is closed.
    if [ -s "$OUT" ] && [ -z "${PWNDA_2B_OVERWRITE_PASS1:-}" ]; then
      echo "REFUSING: $OUT already holds a completed pass-1 payload."
      echo "  Rung 2b is closed; that file is its record. To start a genuinely new"
      echo "  run, set a fresh PWNDA_2B_SWAP_ID and PWNDA_2B_OVERWRITE_PASS1=1."
      exit 3
    fi
    ;;
  FOLLOWER:in) OUT="$REPO/rung2b-relay/client-follower-pass2.json" ;;
  LEADER:in)   OUT="$REPO/rung2b-relay/.pass3-unused.json" ;;   # pass 3 verifies; it publishes nothing
  *) echo "FATAL: a FOLLOWER cannot go first - it needs the LEADER's committed slots."; exit 2 ;;
esac

export PWNDA_ENGINE_TEST_PYTHON PWNDA_ENGINE_TEST_DIR PWNDA_2B_SWAP_ID
export PWNDA_2B_BLOCKFROST_PROJECT_ID="$ID"
# REQUIRED by the engine since v12 (D5). Never left to a default: the engine's
# old one was http://127.0.0.1:18083/json_rpc, which on the desk host was a LIVE
# MAINNET wallet and passed the loopback guard because 127.0.0.1 is loopback.
: "${XMR_WALLET_RPC:=http://127.0.0.1:38088/json_rpc}"
export XMR_WALLET_RPC
export PWNDA_2B_ROLE="$ROLE"
export PWNDA_2B_OUT="$OUT"
export PWNDA_2B_EPOCH="$EPOCH"
export PWNDA_2B_EPOCH_ENDS_UTC="$ENDS"
if [ -n "$INCOMING" ]; then
  [ -f "$INCOMING" ] || { echo "FATAL: no such payload: $INCOMING"; exit 1; }
  export PWNDA_2B_IN="$REPO/${INCOMING#"$REPO/"}"
else
  unset PWNDA_2B_IN
fi

cd "$REPO/src-tauri"
cargo test --lib desk::rung2b -- --nocapture --test-threads=1 2>&1 \
  | sed "s|$ID|<PROJECT_ID_REDACTED>|g"
