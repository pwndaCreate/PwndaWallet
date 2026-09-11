/**
 * Particl in the wallet — a **pure presentational** card (contract §2.2).
 *
 * # Why Particl is not an ordinary chain adapter
 *
 * Every other coin in this wallet has an entry in `ChainType` and an adapter
 * under `src/wallets/`, each deriving its own keys from the vault seed. Particl
 * deliberately does **not**, and the reason is the whole convergence thesis:
 *
 * The swap node already owns a Particl wallet, seeded from a BIP85 child of the
 * same vault phrase (C1). Adding a second, independently-derived PART wallet
 * would give the user two Particl balances from one seed phrase — one holding
 * their coins and one holding the SMSG fee balance the DEX actually spends —
 * and no way to tell which is which. That is precisely the "two wallets, dust,
 * friction" problem [[basicswap-wallet-convergence]] exists to remove, and
 * re-creating it for the one coin the swap engine cannot run without would be
 * the worst possible place to do it.
 *
 * So this card surfaces **the swap node's own Particl wallet**, exactly as
 * `DexXmrWalletCard` surfaces its Monero wallet. One phrase, one PART balance,
 * restored by the same backup.
 *
 * # Why Particl gets a card of its own rather than a row in SwapBalancesCard
 *
 * PART is not a coin the user chose to trade. It is the offer/bid transport:
 * every offer, bid and message on the network is an SMSG on the Particl chain,
 * which is why `MANDATORY_COIN` exists and why particl cannot be disabled or
 * run in light mode. Two consequences a balance row cannot carry:
 *
 *  - **PART must be synced before ANY swap works**, including swaps between two
 *    coins that are not Particl. A user watching a Bitcoin sync bar has no
 *    reason to guess that.
 *  - **No PART balance is needed.** Offers and bids are sent as UNPAID SMSG
 *    (`bsx_network.py` calls `smsgsend` with `paid_msg=False`), which costs
 *    per-message proof-of-work, not coin. An earlier version of this comment
 *    claimed a small PART balance was required for "SMSG fees"; that was
 *    wrong, and the rendered copy never made the claim. Corrected 2026-09-08.
 */
import type { CSSProperties } from "react";
import { Card, Dot } from "../../design/primitives";
import type { SidecarBalanceRow } from "./useSidecarBalances";
import { syncStateOf, syncSentence } from "./useSidecarBalances";
import type { ChainSync } from "../../api/basicswap";

const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1.6,
};

/** Dot colour per sync state. `not-started` is amber, not red: nothing is
 *  broken, the chain simply has not begun — and red would send a user hunting
 *  for a fault that does not exist. */
function dotFor(kind: string): "green" | "amber" | "red" | "gray" {
  switch (kind) {
    case "synced":
      return "green";
    case "syncing":
    case "bootstrapping":
    case "not-started":
      return "amber";
    case "no-chain":
      return "gray";
    default:
      return "red";
  }
}

/**
 * @param row      the `PART` row from `useSidecarBalances`, or null when the
 *                 node reported no Particl wallet (it is down, or not yet
 *                 prepared). Null renders the "not running" branch rather than
 *                 a zero balance — a zero would be a claim.
 * @param optedIn  P1: renders nothing at all until the user has opted in.
 */
export function DexParticlCard({
  row,
  chain = null,
  optedIn,
}: {
  row: SidecarBalanceRow | null;
  /** Direct daemon sync read — preferred over `row` for progress, since the
   *  balance endpoint times out during IBD. */
  chain?: ChainSync | null;
  optedIn: boolean;
}) {
  if (!optedIn) return null;

  const sync = row ? syncStateOf(row) : null;
  const balance = row?.balance ?? null;
  // A locked wallet still HAS a balance; it just cannot sign. Saying "0" or
  // hiding it would both be wrong.
  const locked = row?.locked === true;

  return (
    <Card title="PARTICL · PART">
      <div style={{ ...mono, color: "var(--text-dim)", fontSize: 10.5, marginBottom: 8 }}>
        The swap node's own Particl wallet — restored by your existing recovery
        phrase, not a separate one. Particl carries every offer and bid on the
        network, so it must be synced before any swap can run, whichever coins
        that swap is between.
      </div>

      {row == null && !chain ? (
        <div style={{ ...mono, color: "var(--text-muted)" }}>
          {/* Covers "node stopped" and "never prepared" alike; the balance read
              cannot tell them apart and guessing would be a claim. BOTH
              sources must be silent to say this: during IBD the engine's
              balance call times out while the daemon answers instantly, and
              "start it from Settings" about a node that is visibly syncing
              sent the user chasing a fault that did not exist. */}
          The swap node is not reporting a Particl wallet. Start it from
          Settings ▸ Swap node.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              ...mono,
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span style={{ color: "var(--text-muted)", fontSize: 10 }}>BALANCE</span>
            <span style={{ color: "var(--text)", letterSpacing: 0.5 }}>
              {balance == null ? "—" : `${balance} PART`}
            </span>
          </div>

          {chain && chain.headers > 0 ? (
            <div style={{ ...mono }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Dot color={chain.blocks < chain.headers ? "amber" : "green"} />
                <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
                  {chain.blocks < chain.headers
                    ? `syncing — ${chain.blocks.toLocaleString()} of ${chain.headers.toLocaleString()} blocks (${chain.verifiedPct.toFixed(2)}% verified)`
                    : `synced — ${chain.blocks.toLocaleString()} blocks`}
                </span>
              </div>
              {chain.blocks < chain.headers ? (
                <div
                  style={{
                    height: 4,
                    background: "var(--border-soft)",
                    borderRadius: 2,
                    overflow: "hidden",
                    marginTop: 2,
                  }}
                  role="progressbar"
                  aria-valuenow={Math.round((chain.blocks / chain.headers) * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    style={{
                      width: `${Math.min(100, (chain.blocks / chain.headers) * 100)}%`,
                      height: "100%",
                      background: "var(--accent)",
                      transition: "width 0.3s linear",
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : sync ? (
            <div style={{ ...mono, display: "flex", alignItems: "center", gap: 6 }}>
              <Dot color={dotFor(sync.kind)} />
              <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
                {syncSentence(sync)}
              </span>
            </div>
          ) : null}

          {/* Live progress bar. Rendered only mid-sync — a bar at 100% is
              noise, and a bar for a not-started chain would move on the wrong
              signal. Uses HEIGHT/target rather than the verification percent
              alone: verificationprogress reports 100% for a chain with no
              blocks, and this is the coin the whole order book waits on, so
              the number the user sees has to be honest. */}
          {/* Legacy bar from the engine's own numbers — only when the direct
              daemon read is absent, or two bars render for one chain. */}
          {!chain && sync && sync.kind === "syncing" && sync.target ? (
            <div>
              <div
                style={{
                  height: 4,
                  background: "var(--border-soft)",
                  borderRadius: 2,
                  overflow: "hidden",
                  marginTop: 2,
                }}
                role="progressbar"
                aria-valuenow={Math.round((sync.blocks / sync.target) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  style={{
                    width: `${Math.min(
                      100,
                      Math.max(0, (sync.blocks / sync.target) * 100),
                    )}%`,
                    height: "100%",
                    background: "var(--accent)",
                    transition: "width 0.3s linear",
                  }}
                />
              </div>
              <div style={{ ...mono, fontSize: 9.5, color: "var(--text-muted)", marginTop: 2 }}>
                the order book is empty until this reaches 100%; PART carries
                every offer and bid on the network
              </div>
            </div>
          ) : null}

          {sync?.kind === "not-started" && (
            <div style={{ ...mono, fontSize: 10, color: "var(--text-muted)" }}>
              The node is pruned, so it settles at about 1.3 GB — but the first
              sync still downloads and checks the whole chain, which takes a few
              hours. Nothing can trade until it finishes.
            </div>
          )}

          {locked && (
            <div style={{ ...mono, fontSize: 10, color: "var(--warn, var(--text-dim))" }}>
              This wallet is encrypted and currently locked — it can receive, but
              cannot sign until the swap node unlocks it.
            </div>
          )}

          {row?.error && (
            <div style={{ ...mono, fontSize: 10, color: "var(--danger)", wordBreak: "break-word" }}>
              {row?.error}
            </div>
          )}

          {row?.depositAddress && (
            <div style={{ ...mono, fontSize: 10, color: "var(--text-muted)", wordBreak: "break-all" }}>
              <div style={{ marginBottom: 2 }}>DEPOSIT ADDRESS</div>
              <div style={{ color: "var(--text-dim)" }}>{row?.depositAddress}</div>
            </div>
          )}

        </div>
      )}
    </Card>
  );
}
