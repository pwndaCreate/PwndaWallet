/**
 * What the swap form's MIN preset should do for the selected router.
 *
 * MIN is the fifth button in the 25% / 50% / 75% / MAX row. The other four read
 * the WALLET balance; MIN reads the VENUE, because "the smallest amount worth
 * typing" is a property of where the swap will execute, not of what the user
 * holds. The rule differs per router, and until 2026-09-04 only one router had
 * the button at all:
 *
 *  - **P2P (BasicSwap)** — the cheapest fillable minimum across reasonably-
 *    priced live offers (`fetchMinFillableAmount`, 2026-08-22). Needs a fetch.
 *  - **NEAR Intents** — the venue's per-pair minimum, which the quote hook
 *    already learns for the hint below YOU SEND (`intentsMinimum`), or the
 *    per-asset deposit floor from the tokens cache when the pair probe has
 *    nothing better. No fetch: the number is already on screen.
 *  - **Auto** — NEAR's minimum when one is known (Auto quotes there first),
 *    else the P2P book when the pair has one.
 *  - **Zephyr desk** — no published minimum; the desk applies its floor at
 *    quote time. Disabled with a tooltip rather than hidden: a button that
 *    vanishes reads as a bug ("the MIN button disappeared"), which is exactly
 *    what the operator reported after the redesign.
 *
 * Pure so the routing rule is a unit test, not a screenshot.
 */
import type { RouterPreference } from "./router-modes";

export interface MinPresetInput {
  /**
   * Is the swap node up? `undefined` when the caller does not know — only an
   * explicit `false` disables the book path, so an unknowing caller behaves
   * exactly as before.
   */
  nodeRunning?: boolean;
  preferredRouter: RouterPreference;
  /** `isBasicswapRoutable(from, to)`. */
  basicswapRoutable: boolean;
  /** The quote hook's NEAR minimum for the current pair, if any. */
  intentsMinimum:
    | {
        displayAmount: string;
        ticker: string;
        source: "probe" | "upstream-error" | "loading";
      }
    | null
    | undefined;
  /** The form's source coin, as a ticker. */
  fromCoin: string;
  /** The per-asset NEAR deposit floor already formatted in `fromCoin` units
   *  (`minDisplay` in the form), or null when the tokens cache has none. */
  perAssetMinDisplay: string | null;
  /** The pair is NEAR-routable and the form can ask NEAR for its minimum on
   *  demand (`onProbeMinimum`). When no minimum is known, MIN probes instead
   *  of sitting greyed out — the ADA → LTC case, 2026-09-04. */
  probeAvailable?: boolean;
}

export type MinPresetPlan =
  | { kind: "book" }
  | { kind: "fill"; amount: string; source: "intents-pair" | "intents-asset" }
  | { kind: "probe" }
  | { kind: "wait" }
  | { kind: "none"; reason: string };

const NODE_DOWN =
  "The swap node is not running, so its offer book has no minimum to read. " +
  "Start it from Settings.";
const NO_BOOK = "Not a pair the swap node holds a book for.";
const NO_MIN = "No minimum is published for this route yet.";
const DESK = "The Zephyr desk applies its minimum when it quotes.";

function intentsFill(
  input: MinPresetInput,
): Extract<MinPresetPlan, { kind: "fill" }> | null {
  const m = input.intentsMinimum;
  if (
    m &&
    m.source !== "loading" &&
    m.displayAmount &&
    m.ticker.toUpperCase() === input.fromCoin.toUpperCase()
  ) {
    return { kind: "fill", amount: m.displayAmount, source: "intents-pair" };
  }
  if (input.perAssetMinDisplay) {
    return { kind: "fill", amount: input.perAssetMinDisplay, source: "intents-asset" };
  }
  return null;
}

export function planMinPreset(input: MinPresetInput): MinPresetPlan {
  switch (input.preferredRouter) {
    case "basicswap":
      if (!input.basicswapRoutable) return { kind: "none", reason: NO_BOOK };
      // A stopped node cannot answer, and asking anyway costs the caller the
      // full HTTP timeout — up to 30 s of a button that looks frozen, which is
      // the "MIN is unresponsive" of 2026-09-05. `nodeRunning === false` is a
      // fact the form already holds; `undefined` means "not known here", which
      // must not disable the button.
      if (input.nodeRunning === false) return { kind: "none", reason: NODE_DOWN };
      return { kind: "book" };
    case "pwnda-desk":
      return { kind: "none", reason: DESK };
    case "intents":
    case "swapkit": {
      const fill = intentsFill(input);
      if (fill) return fill;
      if (input.intentsMinimum?.source === "loading") return { kind: "wait" };
      if (input.probeAvailable) return { kind: "probe" };
      return { kind: "none", reason: NO_MIN };
    }
    case "auto":
    default: {
      const fill = intentsFill(input);
      if (fill) return fill;
      if (input.intentsMinimum?.source === "loading") return { kind: "wait" };
      if (input.probeAvailable) return { kind: "probe" };
      if (input.basicswapRoutable) return { kind: "book" };
      return { kind: "none", reason: NO_MIN };
    }
  }
}

/** Tooltip for the button, per plan. */
export function minPresetTitle(plan: MinPresetPlan): string {
  switch (plan.kind) {
    case "book":
      return "Fill in the cheapest fillable amount on the current offer book";
    case "fill":
      return plan.source === "intents-pair"
        ? "Fill in NEAR Intents' minimum for this pair"
        : "Fill in NEAR Intents' minimum deposit for this asset";
    case "probe":
      return "Ask NEAR Intents for the smallest size it will quote for this pair";
    case "wait":
      return "Finding the minimum for this pair…";
    case "none":
      return plan.reason;
  }
}
