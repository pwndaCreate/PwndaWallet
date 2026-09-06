/**
 * TypeScript bindings for the `pwnda-desk` atomic-swap tier in the Rust core.
 *
 * Same constraint as `swap-rust.ts`, and it matters more here: an atomic swap
 * holds real value in a joint 2-of-2 output for 10-60 minutes, and the material
 * that claims or refunds it (the per-swap secret scalar share, the pre-signed
 * refund sigs, the shared view key) NEVER leaves the Rust process. The webview
 * sees swap ids, public addresses, amounts, txids, states, and countdowns.
 *
 * NEVER add a binding here that returns a scalar, a pre-signature, or a view
 * key. The Rust side agrees: `desk_accept` and `desk_status` deliberately return
 * NARROWED projections (`DeskSwapSummary` / `DeskStatusView`) rather than the
 * raw M1 proposal or `/status` body, precisely so protocol material can't reach
 * this layer by accident. See `src-tauri/src/desk/commands.rs`.
 *
 * The handshake itself (M2 keys, M3 refund-sigs, M4 lock, M5 ready-ack) has NO
 * binding by design — every one of those steps must be gated on the client's own
 * chain observation inside the Rust engine, never on a webview call.
 */
import { invoke } from "../lib/tauri";

/** One tradable pair on the desk, as reported by `GET /api/desk/pairs`. */
export interface DeskPairInfo {
  /** Always FOLLOWER/LEADER, e.g. "XMR/ADA". */
  pair: string;
  follower: string;
  leader: string;
  directions: string[];
  /** direction -> "LEADER" | "FOLLOWER" (the DESK's role). */
  deskRole: Record<string, string>;
  /** The FLAT window. Fallback only — see `sizing`: one follower-denominated
   *  window cannot honestly describe both directions, because the desk pays the
   *  leader coin on a SELL and the follower coin on a BUY. */
  minSize: string;
  maxSize: string;
  /** CC-6: which coin the window is denominated in.
   *
   *  Published because DOCUMENTING it failed: the desk's config said "the
   *  follower coin" and its DTO said "whole units of coin_in" — both true on a
   *  SELL, silently different on a BUY, and the desk's own size gate believed
   *  the wrong one (their D23). Empty from an older desk, which is
   *  could-not-look, NOT a default of XMR. */
  sizeCoin?: string;
  /** CC-6: per-direction sizing, keyed by `SELL_FOLLOWER` / `BUY_FOLLOWER`. */
  sizing?: Record<string, DeskSizingEntry>;
  indicativeMid?: string;
  indicativeMidUnit?: string;
  /** Why the pair is halted, when it is. */
  haltReason?: string;
  indicativeSpread: number;
  quoteTtlSeconds: number;
  t0Seconds: number;
  t1Seconds: number;
  t2Seconds: number;
  minConfsFollower: number;
  minConfsLeader: number;
  enabled: boolean;
  /** Oracle stale or manually halted — the pair should not be offered. */
  halted: boolean;
}

/** CC-6: one direction's sizing window and its provenance. */
export interface DeskSizingEntry {
  minSize: string;
  maxSize: string;
  /** Which control bound: `fee-erosion` | `recovery` | `protocol` |
   *  `configured` | `liquidity` | `unbounded`. The derived ones send an
   *  operator to three different places, so the basis is worth as much as the
   *  number. */
  minBasis: string;
  maxBasis: string;
  /** The desk's own sentence. Surface it verbatim — it names the four chain
   *  bodies and their costs, which a client cannot reconstruct. */
  minReason: string;
  /** Every input the desk could not look up. **Non-empty means the floor was
   *  never COMPUTED**, which is different from a floor that did not bind —
   *  paint it as a caveat, never drop it. */
  unknown: string[];
}

export interface DeskPairsResponse {
  pairs: DeskPairInfo[];
  serverTime: number;
}

/** A priced desk quote. `amountOut` is already net of `sTotal`. */
export interface DeskQuote {
  quoteId: string;
  pair: string;
  direction: string;
  /** The DESK's role for this direction; the client is the opposite. */
  deskRole: string;
  coinIn: string;
  coinOut: string;
  amountIn: string;
  amountOut: string;
  rate: string;
  /** Oracle mid, for audit/display. */
  mid: string;
  markup: number;
  sTotal: number;
  /** Unix seconds. Quotes live 30-120s — re-quote rather than settling stale. */
  expiresAt: number;
  minConfsIn: number;
  minConfsOut: number;
  t0Seconds: number;
  t1Seconds: number;
  t2Seconds: number;
}

/**
 * UI-safe view of an in-flight swap. Mirrors `desk::commands::DeskSwapSummary`.
 * Note what is NOT here: no key share, no pre-signatures, no view key.
 */
export interface DeskSwapSummary {
  swapId: string;
  pair: string;
  direction: string;
  deskRole: string;
  amountA: string;
  amountB: string;
  /** 8.1 state: ACCEPTED | A_LOCKED | B_LOCKED | READY | A_CLAIMED | SETTLED | A_REFUNDED | FAILED | ABORTED */
  state: string;
  scriptAddress: string;
  chainBJointAddr: string | null;
  lockATxid: string | null;
  lockBTxid: string | null;
  t0: number;
  /** Absolute unix seconds — the refund deadline the tracker counts down to. */
  t1: number;
  t2: number;
  createdAt: number;
}

/** UI-safe view of a `/status` poll. Mirrors `desk::commands::DeskStatusView`. */
export interface DeskStatusView {
  swapId: string;
  state: string;
  lockATxid: string;
  lockBTxid: string;
  claimATxid: string;
  sweepBTxid: string;
  refundTxid: string;
  reclaimTxid: string;
  confsA: number;
  confsB: number;
  minConfsA: number;
  minConfsB: number;
  t0Remaining: number;
  t1Remaining: number;
  readyAck: boolean;
  updatedAt: number;
  error: string;
}

export interface DeskAbortResponse {
  swapId: string;
  state: string;
  reservationReleased: boolean;
  note?: string;
}

/** The tradable-pair roster. Public — safe to call before enrollment. */
export function deskPairs(): Promise<DeskPairsResponse> {
  return invoke<DeskPairsResponse>("desk_pairs");
}

/**
 * Price a swap. `pair` must be the FOLLOWER/LEADER label and `direction` the
 * matching SELL_FOLLOWER | BUY_FOLLOWER — derive BOTH from the capability
 * registry (`deskPairLabel` / `deskDirectionFor` in `asset-capabilities.ts`) so
 * the TS and Rust layers can't disagree about which side is which.
 */
export function deskQuote(args: {
  pair: string;
  direction: string;
  amountIn: string;
}): Promise<DeskQuote> {
  return invoke<DeskQuote>("desk_quote", args);
}

/**
 * Reserve inventory and create the swap. Pass the user's OWN addresses:
 * `payoutAddress` receives the bought coin, `refundAddress` receives the
 * reclaim if the swap fails. Both are public wallet addresses — resolve them
 * with `addressForTicker`.
 *
 * There is no `clientChainAPubkey` parameter on purpose: per-swap key material
 * is derived inside the Rust core, not handed in from here.
 *
 * `pair` and `direction` are what that derivation keys off — `direction` tells
 * the core whether the client leads or follows, which decides whether it
 * contributes the adaptor point and view key at all. Pass the values from the
 * quote being accepted (`quote.deskQuote.pair` / `.direction`), never a
 * re-derived guess: a mismatch produces key material for the wrong role.
 *
 * Re-quote first if the confirm modal has been open long enough for the quote
 * TTL to lapse; accepting against an expired quote returns QUOTE_EXPIRED.
 */
export function deskAccept(args: {
  quoteId: string;
  pair: string;
  direction: string;
  payoutAddress: string;
  refundAddress: string;
}): Promise<DeskSwapSummary> {
  return invoke<DeskSwapSummary>("desk_accept", args);
}

/**
 * Poll the desk's view of a swap for the tracker. This is ADVICE — the Rust
 * engine never acts on it without its own chain confirmation, so a desk that
 * lies here cannot induce a signature.
 */
export function deskStatus(swapId: string): Promise<DeskStatusView> {
  return invoke<DeskStatusView>("desk_status", { swapId });
}

/**
 * Cancel a PRE-LOCK swap and release the reservation. Rejected once the swap
 * has locked — post-lock recovery is timeout-driven (the refund watcher fires
 * at T1), not a cancel button. Surface that distinction in the UI rather than
 * offering a cancel that will 409.
 */
export function deskAbort(
  swapId: string,
  reason?: string
): Promise<DeskAbortResponse> {
  return invoke<DeskAbortResponse>("desk_abort", { swapId, reason });
}

/**
 * In-flight swaps rehydrated from the encrypted store — call on mount so a swap
 * that was running when the app closed reappears in the tracker. Terminal swaps
 * are filtered out Rust-side.
 */
export function deskListActive(): Promise<DeskSwapSummary[]> {
  return invoke<DeskSwapSummary[]>("desk_list_active");
}

/** CC-25: the desk's sizing window for one pair+direction, plus the verdict. */
export interface DeskSizeView {
  /** `within` | `belowMin` | `aboveMax` | `cannotJudge`. */
  verdict: "within" | "belowMin" | "aboveMax" | "cannotJudge";
  /** User-facing sentence. On a refusal this is the DESK's own wording where
   *  it gave one — it names the four chain bodies and their costs, which the
   *  client cannot reconstruct. Empty when the amount is within range. */
  message: string;
  min: string;
  max: string;
  /** Denomination. Empty means the desk published none, which is why the
   *  verdict will be `cannotJudge` — comparing an amount to a window of
   *  unknown units is arithmetic on two different things (their D23). */
  coin: string;
  minBasis: string;
  /** Sizing inputs the desk could not look up. **Non-empty means the floor was
   *  never COMPUTED**, which is different from one that did not bind. */
  unknown: string[];
  /** Which surface answered: the per-direction entry or the flat fallback. */
  source: string;
}

/**
 * CC-25: ask the RUST tier to judge an amount against the desk's window.
 *
 * Deliberately not reimplemented here. `engine::sizing_for` + `judge_size`
 * already encode the rule and the preflight reads the same published fields; a
 * third copy in TypeScript is the two-places-holding-one-quantity fault this
 * project keeps paying for. The webview asks and renders; it does not derive.
 */
export async function deskSizeCheck(
  pair: string,
  direction: string,
  amount: string,
  amountCoin: string
): Promise<DeskSizeView> {
  return invoke<DeskSizeView>("desk_size_check", {
    pair,
    direction,
    amount,
    amountCoin,
  });
}
