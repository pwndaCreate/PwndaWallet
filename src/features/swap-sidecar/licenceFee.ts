import { useEffect, useState } from "react";
import { sidecarFeesQuote, type SidecarFeeQuote } from "../../api/basicswap";
import { tickerForCoin } from "./types";

/**
 * The pwnda licence fee, as one number for the quote screen.
 *
 * # Why this exists
 *
 * The confirm modal carried a hardcoded `"0.00 (not enabled)"` and five lines
 * of prose explaining that the fee was not being charged. Both were written
 * while `SHIPPED_MODE` was `Off`. Collection was turned on on 2026-09-05 and
 * neither moved: the screen went on saying "not enabled" while the watcher
 * was charging — the first live collection (bid `000000006a9c5eaa…`,
 * 0.00019999 BCH, txid `2cd4de81…`) happened under that wording.
 *
 * A string that states a fact about the backend without asking the backend is
 * the shape to avoid. This asks: `sidecar_fees_quote` runs the SAME
 * `engine::decide` branch the watcher will run after settlement, so the
 * number shown before the swap and the number charged after it cannot
 * disagree by construction.
 *
 * Display only. It moves nothing and decides nothing — see the command's own
 * doc comment and `no_command_can_trigger_settlement`.
 */

/**
 * Coins with no script layer. The fee is charged only on a pair with exactly
 * one of them, and never denominated in one.
 *
 * Mirrors `schedule::SCRIPTLESS_TICKERS`. It is a mirror rather than a fetch
 * because the answer must be available before any await — the alternative is
 * a quote screen that renders "—" for a beat on every open.
 */
export const SCRIPTLESS_FEE_TICKERS = ["XMR", "ZEPH", "ZANO"] as const;

export interface FeeLeg {
  /** The scripted ticker — what the fee is denominated in. */
  ticker: string;
  /** That leg's amount, as the decimal string the backend parses. */
  amount: string;
}

/**
 * Which leg of a pair a fee would be charged on, or `null` when none is.
 *
 * By TICKER and never by position, exactly as `schedule::fee_leg` does it: the
 * fee is charged on the scripted side, and since eligibility already requires
 * **exactly one** scriptless leg, "the other one" is unambiguous. Reading the
 * wrong leg on XMR↔LTC would misprice by the rate (~9x).
 *
 * Accepts upstream's display names as well as tickers — a `TakerOffer` carries
 * `"Litecoin"`, not `"LTC"` (the mistake `swapEta` made first).
 */
export function feeLegFor(
  sendCoin: string,
  sendAmount: string,
  receiveCoin: string,
  receiveAmount: string,
): FeeLeg | null {
  const send = tickerForCoin(sendCoin);
  const receive = tickerForCoin(receiveCoin);
  if (!send || !receive || send === receive) return null;
  const scriptless = (t: string) =>
    (SCRIPTLESS_FEE_TICKERS as readonly string[]).includes(t);
  if (scriptless(send) === scriptless(receive)) return null; // none, or both
  return scriptless(send)
    ? { ticker: receive, amount: receiveAmount }
    : { ticker: send, amount: sendAmount };
}

/** What the quote line shows. `null` while the answer is still in flight. */
export type LicenceFee =
  | { state: "loading" }
  /** Chargeable: the amount, its ticker, and the rate it works out to. */
  | { state: "charged"; amount: string; ticker: string; percent: number }
  /** Not chargeable on this pair/size, with the engine's own reason. */
  | { state: "free"; reason: string }
  /** The backend could not be asked. Never blocks anything. */
  | { state: "unknown" };

/** Atomic units to the decimal string every fee coin uses (all three are 8dp). */
function fromAtomic(atomic: number): string {
  const whole = Math.floor(atomic / 1e8);
  const frac = String(atomic % 1e8).padStart(8, "0");
  return `${whole}.${frac}`;
}

/** Turn a backend answer into the shape the line renders. */
export function licenceFeeFrom(quote: SidecarFeeQuote): LicenceFee {
  if (quote.kind === "charge") {
    return {
      state: "charged",
      amount: fromAtomic(quote.amount),
      ticker: quote.ticker,
      // Both are atomic units of the same coin, so this is exact — no price
      // feed, no cross-coin conversion, nothing that could drift.
      percent: quote.notional > 0 ? (quote.amount / quote.notional) * 100 : 0,
    };
  }
  return { state: "free", reason: quote.reason };
}

/** The one line the quote screen shows. Short by construction. */
export function licenceFeeLabel(fee: LicenceFee): string {
  switch (fee.state) {
    case "charged":
      return `${fee.amount} ${fee.ticker} (${fee.percent.toFixed(2)}%)`;
    case "free":
      // The reasons are engine-side and all mean the same thing to a reader.
      return fee.reason === "noScriptlessLeg"
        ? "none on this pair"
        : "none on this swap";
    case "unknown":
      return "—";
    default:
      return "…";
  }
}

/**
 * Ask the backend what this swap would cost. Read-only.
 *
 * Re-asks whenever the pair or either amount changes, and never throws into
 * the render: a fee line that cannot be fetched shows `—` and the swap is
 * unaffected, the same fail-open posture `engine::decide` itself has.
 */
export function useLicenceFee(
  sendCoin: string,
  sendAmount: string,
  receiveCoin: string,
  receiveAmount: string,
): LicenceFee {
  const [fee, setFee] = useState<LicenceFee>({ state: "loading" });
  useEffect(() => {
    const leg = feeLegFor(sendCoin, sendAmount, receiveCoin, receiveAmount);
    if (!leg) {
      setFee({ state: "free", reason: "noScriptlessLeg" });
      return;
    }
    let cancelled = false;
    setFee({ state: "loading" });
    void sidecarFeesQuote(leg.ticker, leg.amount)
      .then((q) => {
        if (!cancelled) setFee(licenceFeeFrom(q));
      })
      .catch(() => {
        if (!cancelled) setFee({ state: "unknown" });
      });
    return () => {
      cancelled = true;
    };
  }, [sendCoin, sendAmount, receiveCoin, receiveAmount]);
  return fee;
}
