/**
 * Which coins the Swap surface may offer a **sweep-back** for, and the copy
 * that frames it (contract C4/C6, UI side).
 *
 * `SweepBackConfirmCard` lives in `features/swap-sidecar/` and is owned by the
 * API workstream. This module holds the two decisions the *mount* has to make
 * and which would otherwise be unverifiable JSX:
 *
 *  1. **Which coins to offer.** `swap_bridge_prepare_sweep` derives the
 *     destination Rust-side and returns `Err` for anything it has no account
 *     for. Offering a "Sweep back" button that is guaranteed to fail is worse
 *     than not offering it: the user reads the refusal as a bug in their
 *     wallet. PARTICL is the concrete case — the swap node always holds PART
 *     (it is the engine's own chain) and the user's vault has no Particl
 *     account at all, so there is nowhere to sweep it to.
 *
 *  2. **That the destination is never typed.** Stated on the list stage as
 *     well as on the confirm card, because the list stage is where the user
 *     decides whether this screen is safe to use.
 *
 * The coin list is a mirror of Rust's `pinned_destination` coverage
 * (contract §1.6: UTXO family via `swap::derive::utxo_address`, plus XMR via
 * the wallet-rpc `get_address`). It is deliberately an explicit allow-list and
 * not "every row the node reports": a new coin appearing in the engine must be
 * a decision here, not an automatic offer to sweep to an address nothing has
 * derived.
 */
import type { ChainType } from "../../wallets/types";
import { isZeroAmount, type SidecarBalanceRow } from "../swap-sidecar";

/**
 * Ticker → the wallet chain whose seed derives the destination.
 *
 * Mirrors `pinned_destination` (contract §1.6). ZEPH is absent on purpose:
 * the wallet has a Zephyr account but Rust derives no sweep destination for
 * it, so an offer would always end in `Err("unknown coin")`. PART is absent
 * because the vault holds no Particl account of any kind.
 */
export const SWEEPABLE_COIN_CHAINS: Readonly<Record<string, ChainType>> = {
  BTC: "bitcoin",
  LTC: "litecoin",
  DOGE: "dogecoin",
  DASH: "dash",
  BCH: "bitcoin-cash",
  XMR: "monero",
};

/** One offerable sweep. `coin` is what `prepareSweep({coin})` takes — Rust
 *  keys on the lowercase ticker (contract §R13: `pinned_destination(seed, "btc")`). */
export interface SweepCandidate {
  /** Uppercase ticker, as the node reported it. */
  ticker: string;
  /** Lowercase ticker — the `coin` argument for `prepareSweep`. */
  coin: string;
  /** Decimal string, straight from the node. Never parsed to a number. */
  balance: string | null;
  /** The wallet chain that owns the destination. */
  chain: ChainType;
}

/**
 * The coins to offer a sweep for.
 *
 * Every filter fails **closed**:
 *
 *  - not opted in (including the `null` in-flight read) ⇒ nothing, and no
 *    invoke was issued to populate `rows` in the first place;
 *  - a ticker with no pinned destination ⇒ never offered;
 *  - a zero / absent balance ⇒ nothing to sweep;
 *  - no wallet loaded for the destination chain ⇒ not offered. XMR is the one
 *    that bites: its destination comes from the Monero wallet-rpc, so with no
 *    Monero wallet loaded `prepare` refuses rather than falling back.
 */
export function sweepableCoins(args: {
  optedIn: boolean | null | undefined;
  rows: Record<string, SidecarBalanceRow> | null | undefined;
  /** `true` when the vault has a wallet for that chain. */
  hasWallet: (chain: ChainType) => boolean;
  /**
   * UPPERCASE tickers whose swap-node wallet IS the user's wallet — a
   * verified account-key share (BTC/LTC/BCH, `adoption === "accountkey"`) or
   * an active host wallet-rpc (XMR/ZEPH/ZANO). Nothing of theirs can be
   * "swept back": the balance is already in the user's wallet, and the
   * sweep would pay a fee to send coins from an address to itself.
   *
   * Added 2026-09-05. Until then the list showed BCH 0.6389, BTC, LTC and
   * XMR as sweepable on a node where all four were shared — every row a
   * self-transfer with a fee, presented as recovery. The operator's own
   * reaction was the right one: "why is the sweep back option a thing?
   * That should have been a legacy mechanic". It is, for shared coins.
   */
  sharedTickers?: ReadonlySet<string>;
}): SweepCandidate[] {
  if (args.optedIn !== true) return [];
  const rows = args.rows;
  if (!rows || typeof rows !== "object") return [];

  const out: SweepCandidate[] = [];
  for (const row of Object.values(rows)) {
    const ticker = String(row?.ticker ?? "").toUpperCase();
    const chain = SWEEPABLE_COIN_CHAINS[ticker];
    if (!chain) continue;
    if (args.sharedTickers?.has(ticker)) continue;
    if (isZeroAmount(row.balance)) continue;
    if (!args.hasWallet(chain)) continue;
    out.push({ ticker, coin: ticker.toLowerCase(), balance: row.balance, chain });
  }
  out.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return out;
}

/** What this section is for, on the list stage. */
export const SWEEP_INTRO_NOTE =
  `Move coins the swap node is holding back into your own wallet. The ` +
  `destination is derived inside the app from your own seed — it is not ` +
  `typed in, and nothing on this screen can change where the money goes.`;

/** Why a password is being asked for. */
export const SWEEP_UNLOCK_NOTE =
  `Your vault password unlocks the signing session so the app can derive ` +
  `your own receiving address. It is not sent anywhere and no destination is ` +
  `taken from this screen.`;

/**
 * In-flight swaps.
 *
 * Deliberately does **not** promise that the node protects reserved outputs.
 * Whether a user withdrawal and an engine lock interleave safely is on the
 * contract's own "cannot be settled by reading code" list (§4.3 item 12) — it
 * needs a funded drive. Until that drive happens the honest copy is that we do
 * not know, not a reassurance we have not earned.
 */
export const SWEEP_IN_FLIGHT_NOTE =
  `If a swap is still running, part of this balance may be committed to it. ` +
  `How the node behaves when you sweep mid-swap has not been verified — let ` +
  `in-flight swaps finish first.`;
