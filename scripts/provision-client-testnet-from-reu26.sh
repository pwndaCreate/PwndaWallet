#!/usr/bin/env bash
# =============================================================================
# PwndaWallet client - provision the CLIENT's testnet swap credentials by REUSING
# REU26's already-funded, already-tested testnet accounts (no new funding, no new
# accounts). Operator-run, on-box (the machine that has BOTH REU26 and this repo),
# idempotent. No secret is printed to the terminal.
#
# WHAT IT STAGES into pwnda-testnet-credentials/ (committed to THIS private repo -
# testnet/stagenet only, no real value; the same decision REU26 made):
#   - blockfrost-project-id.preprod : REU26's preprod BlockFrost project id
#       (read-only Cardano preprod; rung 2b + rung 3). SAME id the desk uses - fine,
#       protocol params are network-deterministic, so sharing one id across two
#       machines still proves the independent-views property (see README).
#   - xmr-stagenet/swap-wallet.keys : REU26 second-pair 'bob' Monero stagenet wallet
#       (addr 55e3ZVrF... , ~2.72 sXMR, EMPTY password). The CLIENT's OWN XMR wallet,
#       DISTINCT from the desk's maker reserve. Used when the client locks XMR
#       (SELL_FOLLOWER).
#   - ada-funding.preprod.skey      : REU26 main funding key (addr_test1vrkl2h... ,
#       ~9,979 preprod tADA). The ONLY spendable preprod ADA REU26 committed, so it is
#       the SAME account the desk funds from. Used when the client leads ADA
#       (BUY_FOLLOWER). Run the two swap directions SEQUENTIALLY so desk + client never
#       spend the same account's UTxOs at once (see README). SELL_FOLLOWER needs no
#       client ADA at all.
#   - client-testnet.env.sh         : a sourceable env wiring the above for the
#       client's ada-xmr sidecar.
#   - README.md                     : addresses, balances, passwords, and wiring.
#
# REU26 is READ-ONLY - this only COPIES from it.
#
# USAGE:  bash scripts/provision-client-testnet-from-reu26.sh
#         REU26_ROOT=/path bash ...   (default /home/user/REU26)
# THEN:   git add pwnda-testnet-credentials && git commit && git push
# =============================================================================
set -euo pipefail

REU26_ROOT="${REU26_ROOT:-/home/user/REU26}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CRED="$REPO_ROOT/pwnda-testnet-credentials"
XMR="$CRED/xmr-stagenet"

H="$REU26_ROOT/work/forks/ada-xmr-swap"
KM="$REU26_ROOT/zephyr-testnet/testnet-key-material"
BF_ID="$H/.blockfrost-project-id.preprod"
ADA_SKEY="$H/.preview-alice.skey"
XMR_BOB="$KM/ada-xmr-stagenet-wallets/bob.keys"
XMR_BOB_ADDR="$KM/ada-xmr-stagenet-wallets/bob.address.txt"

ok(){ echo "  [OK]  $1"; }
die(){ echo "  [FAIL] $1" >&2; exit 1; }

[ -d "$REU26_ROOT" ] || die "REU26 not found at $REU26_ROOT (set REU26_ROOT=...)"
[ -s "$BF_ID" ]    || die "BlockFrost preprod id missing: $BF_ID"
[ -s "$ADA_SKEY" ] || die "ADA funding key missing: $ADA_SKEY"
[ -s "$XMR_BOB" ]  || die "client XMR wallet missing: $XMR_BOB"

mkdir -p "$XMR"; chmod 0700 "$CRED" "$XMR"

cp "$BF_ID"   "$CRED/blockfrost-project-id.preprod"; chmod 0600 "$CRED/blockfrost-project-id.preprod"
ok "staged BlockFrost preprod id"
cp "$ADA_SKEY" "$CRED/ada-funding.preprod.skey";     chmod 0600 "$CRED/ada-funding.preprod.skey"
ok "staged ADA funding key (main account, ~9,979 preprod tADA - shared with the desk)"
cp "$XMR_BOB" "$XMR/swap-wallet.keys";               chmod 0600 "$XMR/swap-wallet.keys"
[ -s "$XMR_BOB_ADDR" ] && cp "$XMR_BOB_ADDR" "$XMR/swap-wallet.address.txt"
ok "staged client XMR wallet (bob, ~2.72 sXMR, empty password)"

( umask 077
  {
    echo "# PwndaWallet client testnet env (committed in this PRIVATE repo; testnet-only). Plain ASCII."
    echo "# 'source' before starting the client's ada-xmr sidecar for a preprod/stagenet run."
    echo "export ADA_ENGINE_ENV=preprod"
    echo "export ADA_BLOCKFROST_URL=https://cardano-preprod.blockfrost.io/api"
    echo "export CARDANO_NETWORK=testnet"
    printf 'export BLOCKFROST_PROJECT_ID=%s\n' "$(cat "$CRED/blockfrost-project-id.preprod")"
    echo "# ADA funding (BUY_FOLLOWER, when the client leads ADA) - shared main account:"
    printf 'export ADA_FUNDING_SKEY_HEX=%s\n' "$(cat "$CRED/ada-funding.preprod.skey")"
    echo "# Client's own Monero stagenet wallet-rpc (loopback; run monero-wallet-rpc on the bob wallet):"
    echo "export XMR_WALLET_RPC=http://127.0.0.1:38088/json_rpc"
  } > "$CRED/client-testnet.env.sh" )
chmod 0600 "$CRED/client-testnet.env.sh"
ok "wrote client-testnet.env.sh"

cat > "$CRED/README.md" <<'RM'
# Client testnet credentials (reused from REU26, testnet-only)

These are TESTNET/STAGENET accounts with NO real-world value, reused from REU26's already-funded,
already-tested swap accounts so the client side needs no new funding or setup. This repo is private, so
committing them is safe - the same decision REU26 made. All Monero wallets use an EMPTY password.

| File | What it is | Account / balance (2026-07-21) |
|---|---|---|
| `blockfrost-project-id.preprod` | Read-only Cardano preprod BlockFrost id | (same id the desk uses) |
| `xmr-stagenet/swap-wallet.keys` | The client's OWN Monero stagenet wallet | `55e3ZVrF...` , ~2.72 sXMR |
| `ada-funding.preprod.skey` | ADA lock funding key (raw 64-hex) | `addr_test1vrkl2h...` , ~9,979 preprod tADA |
| `client-testnet.env.sh` | Sourceable env wiring the above | - |

## Wiring
- `source client-testnet.env.sh` before starting the client's ada-xmr sidecar. It sets
  `ADA_ENGINE_ENV=preprod`, `BLOCKFROST_PROJECT_ID`, `ADA_FUNDING_SKEY_HEX`, and `XMR_WALLET_RPC`.
- XMR: run a loopback stagenet wallet-rpc on the client wallet, then it answers on the URL above:
  `monero-wallet-rpc --stagenet --disable-rpc-login --rpc-bind-port 38088 \`
  `  --wallet-file pwnda-testnet-credentials/xmr-stagenet/swap-wallet --password "" \`
  `  --daemon-address <public-stagenet-node>:38081 --untrusted-daemon`
  (public nodes: stagenet.xmr-tw.org:38081 , node.monerodevs.org:38089)

## Two things to know
1. The BlockFrost id is the SAME one the desk uses. That is fine: a project id is only an auth token; the
   protocol params come from the Cardano network (a per-epoch consensus constant), so two machines
   fetching with the same id still fetch independently and agree. (A separate free id is optional polish.)
2. The ADA funding key is the SAME account the desk funds from - the only spendable preprod ADA REU26
   committed. It only matters for BUY_FOLLOWER (when the client leads ADA); SELL_FOLLOWER needs no client
   ADA. Run the two directions SEQUENTIALLY (SELL_FOLLOWER, then BUY_FOLLOWER) so the desk and client never
   spend the same account's UTxOs concurrently. For a first bidirectional rung-3 test that is natural.
RM
ok "wrote README.md"

echo
ok "Client testnet credentials staged in pwnda-testnet-credentials/ (0700). To share to the client machine:"
cat <<EOF
      git add pwnda-testnet-credentials
      git commit -m "testnet: reuse REU26 preprod/stagenet credentials for the client swap side"
      git push origin feat/swap-desk-client
EOF
