/**
 * Typed bindings for the **BasicSwap sidecar** — the supervisor commands in
 * `src-tauri/src/swap_sidecar.rs` plus the narrow slice of upstream's local
 * JSON API that those commands proxy.
 *
 * Two rules this file exists to enforce at the type level:
 *
 * 1. **The credential never reaches the webview.** `SidecarStatus` carries no
 *    password field because the Rust struct carries none — every API call goes
 *    through `swap_sidecar_api_get` / `swap_sidecar_api_post`, which inject
 *    `Authorization: Basic` server-side.
 * 2. **The allow-list lives in Rust, not here.** `check_endpoint`
 *    (swap_sidecar.rs) is deny-by-default; `withdraw`, `getcoinseed`,
 *    `setpassword`, `unlock`, `lock`, `offers/new`, `bids/new` and every
 *    `wallets/<coin>/<cmd>` sub-command are refused there. **Do not add a
 *    helper here for an endpoint the Rust side refuses** — it would compile,
 *    ship, and fail at runtime with a deny message. Adding a reachable
 *    endpoint is a deliberate, reviewed change to `check_endpoint` *with a
 *    test*, and only then a helper here.
 *
 * Nothing in this module can create a bid, post an offer or move a coin. It is
 * a read surface. The write path (when it exists) will be a separate, reviewed
 * Rust command — not a widening of the proxy.
 *
 * Wire-shape notes that cost time if rediscovered:
 *
 * - `SidecarStatus.phase` is an **object**, not a string. The Rust `Phase` enum
 *   is `#[serde(tag = "phase")]`, so a healthy node serialises as
 *   `{"phase":{"phase":"healthy"}, ...}` and a failed one as
 *   `{"phase":{"phase":"failed","reason":"…"}}`. Use {@link phaseName} /
 *   {@link phaseFailureReason} rather than reading `.phase` twice by hand.
 * - Offer/bid `coin_from` / `coin_to` are upstream **display names**
 *   (`"Monero"`, `"Litecoin"`, `"Particl Anon"`), not tickers. `/json/coins` is
 *   the ticker↔name↔id table; fetch it once and resolve.
 * - Every amount is a **decimal string**, not a number. Parse at the edge
 *   (`src/features/swap-sidecar/offers.ts` does), never `+amount` inline.
 */
import { invoke } from "../lib/tauri";
// Type-only, and deliberately so: this is the *encrypted* vault envelope, the
// one vault-shaped thing C3.5 must hand to Rust. Erased at compile time, so it
// creates no runtime edge to `src/crypto` for anything downstream of this
// module (BOUNDARIES.md bans swap-sidecar from importing crypto at runtime).
import type { EncryptedData } from "../crypto";

// =========================================================================
// Supervisor — mirrors src-tauri/src/swap_sidecar.rs
// =========================================================================

/** Lifecycle phase names, as `Phase`'s camelCased variant tags. */
export type SidecarPhaseName =
  | "stopped"
  | "preparing"
  | "starting"
  | "healthy"
  | "stopping"
  | "failed";

/**
 * The internally-tagged `Phase` enum. `failed` is the only variant carrying a
 * payload; the rest are bare `{ phase }` objects.
 */
export type SidecarPhase =
  | { phase: Exclude<SidecarPhaseName, "failed"> }
  | { phase: "failed"; reason: string };

/** `SidecarStatus` — deliberately carries **no** credential field. */
export interface SidecarStatus {
  phase: SidecarPhase;
  running: boolean;
  optedIn: boolean;
  htmlPort: number;
  wsPort: number;
  portOffset: number;
  /** True once `basicswap.json` exists — prepare has run at least once. */
  configured: boolean;
  /** True once the embedded interpreter is present. */
  runtimeInstalled: boolean;
  datadir: string;
  /**
   * Persisted "start with the wallet" preference.
   *
   * The **record**, not the effective value — a dev run forcing autostart via
   * `PWNDA_SWAP_SIDECAR_AUTOSTART` must not make the Settings toggle claim the
   * installed wallet will do the same thing.
   */
  autostart: boolean;
  /** Coins the node is configured for, from `basicswap.json`'s `chainclients`.
   *  Empty before the first prepare. */
  coins: string[];
  /**
   * Coins this wallet and BasicSwap both support that are **not** configured
   * and cannot be added, because no daemon binary is seeded for them.
   *
   * Render this. Without it the only symptom is an order book that is always
   * empty on those pairs, which is indistinguishable from "nobody is making
   * offers" — see `swap_sidecar.rs::WALLET_SIDECAR_COINS`.
   */
  coinsUnavailable: string[];
  /**
   * True when this build ships an encrypted `grove` bundle in its resources, so
   * the engine can be installed offline ("install the swap engine") instead of
   * only by download.
   *
   * Optional because the field post-dates installs in the wild; treat absent as
   * false rather than as "bundled".
   */
  bundleAvailable?: boolean;
  /**
   * WHICH swap engine is on disk, and whether it is the one this build expects.
   *
   * Present from 2026-08-29. Absent on an older backend, which is why it is
   * optional — render nothing rather than guessing, because "unknown engine" and
   * "correct engine" must never look the same. That conflation is the whole
   * reason the field exists: see `src-tauri/src/grove.rs`.
   */
  engine?: EngineIdentity;
  /**
   * Which wallet's seed created the engine datadir (16 hex, one-way).
   *
   * Compare against `swapSeedFingerprint(material.mnemonic)` for the ACTIVE
   * wallet to decide whether the engine's balances belong to the wallet on
   * screen. The engine cannot answer that itself — it keeps reporting a coin as
   * verified-shared after a vault switch, because from its side nothing
   * changed. Absent on installs prepared before the binding existed; treat
   * absent as "not mine", never as "mine".
   */
  swapSeedFingerprint?: string | null;
  /** Set when this session started with a different seed than the one that
   *  created the datadir. While set, account-key sharing is refused. */
  seedMismatch?: { datadirSeed: string; sessionSeed: string } | null;
  /**
   * True when this node's Particl chain was synced on the old full-index
   * layout, so it keeps ~2.9 GB where a new install uses ~1.3 GB.
   *
   * particl-core cannot drop `txindex`/`spentindex` from a chain already synced
   * with them, so this is not a setting the wallet can flip — it is a fact about
   * the datadir, and reclaiming the space needs a fresh Particl sync. Surfaced
   * only so the gap between the wizard's quoted footprint and what is actually
   * on disk has an explanation; nothing acts on it automatically.
   *
   * Absent (undefined) on a status from a build that predates the flag.
   */
  particlUnpruned?: boolean;
}

/**
 * The runtime's own `pwnda-grove.json` stamp, as read by the Rust supervisor.
 *
 * `state` mirrors the Rust enum's serde tag exactly. `drift` is the one that
 * matters operationally — it means the running engine is NOT the one this build
 * was written against, the condition under which PWNDA-PATCH-9 was missing from
 * mainnet for three days in August 2026 while looking entirely healthy.
 */
export type EngineIdentity =
  /** No interpreter on disk — nothing installed yet. Not a fault. */
  | { state: "noRuntime" }
  /** Installed but carries no stamp: patch level UNKNOWN, which is weaker than
   *  "wrong" and must be shown as such. */
  | { state: "unstamped" }
  /** Stamped and matching, e.g. `pwnda-grove 0.18.4+p12`. */
  | { state: "ok"; id: string }
  /** Stamped and disagreeing. Surface both sides — the operator needs to know
   *  which way the gap runs. */
  | { state: "drift"; stamped: string; expected: string };

/** The opt-in marker. Nothing downloads, prepares or spawns before this. */
export interface OptInRecord {
  optedIn: boolean;
  /** RFC3339 timestamp of the decision, or null if never decided. */
  at: string | null;
  /** Start the node when the wallet starts. Defaults false; cleared when
   *  consent is revoked. */
  autostart: boolean;
  /**
   * C3 — per-coin DEX enablement, keyed by the engine's lowercase coin name
   * (`"btc"`, `"particl"`, …). Rust carries `#[serde(default)]`, so it is
   * always present on a real payload.
   *
   * **An ABSENT / empty map is not "nothing enabled".** A pre-C3 `opt-in.json`
   * deserializes with `coins: {}` and legacy behaviour is *every seedable coin
   * enabled* — the migration semantics are frozen in contract §1.4. Read it
   * through `coinOptInsFrom` rather than indexing it directly, and never write
   * a UI that renders an empty map as "you have no coins".
   */
  coins: Record<string, CoinOptIn>;
}

/** Payload of the `swap-sidecar-progress` event. */
export interface SidecarProgress {
  stage: string;
  percent: number;
  message: string;
}

/** Tauri event name the supervisor emits progress on. */
export const SIDECAR_PROGRESS_EVENT = "swap-sidecar-progress";

/** Which chain the node runs on. Testnet is deliberately absent upstream-side. */
export type SidecarNetwork = "mainnet" | "regtest";

/** The phase tag, flattened. */
export function phaseName(phase: SidecarPhase | undefined | null): SidecarPhaseName {
  return phase?.phase ?? "stopped";
}

/** The failure reason, or `null` when the phase is not `failed`. */
export function phaseFailureReason(
  phase: SidecarPhase | undefined | null,
): string | null {
  return phase && phase.phase === "failed" ? phase.reason : null;
}

/** Current supervisor status. Safe to poll; does not start anything. */
export function swapSidecarStatus(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>("swap_sidecar_status");
}

/**
 * Record the user's opt-in decision. `accepted: false` is a valid, meaningful
 * call — it records a decline, it does not merely fail to record consent.
 */
export function swapSidecarOptIn(accepted: boolean): Promise<OptInRecord> {
  return invoke<OptInRecord>("swap_sidecar_opt_in", { accepted });
}

/** Read the persisted opt-in decision without changing it. */
export function swapSidecarOptInStatus(): Promise<OptInRecord> {
  return invoke<OptInRecord>("swap_sidecar_opt_in_status");
}

/**
 * Set "start the swap node when the wallet starts".
 *
 * Rejects before opt-in. Note this only records a preference — it neither
 * starts nor stops the node now.
 */
export function swapSidecarSetAutostart(enabled: boolean): Promise<OptInRecord> {
  return invoke<OptInRecord>("swap_sidecar_set_autostart", { enabled });
}

export interface SwapSidecarStartArgs {
  network?: SidecarNetwork;
  /** Remote Monero node. Host and port are a PAIR — a port with no host is dropped Rust-side.
   *
   *  Leave BOTH undefined to let Rust apply the pinned node: precedence is
   *  **explicit args > store pin > none**, resolved inside
   *  `swap_sidecar_start`. A caller that cannot legally read the user's
   *  Monero-node pin (anything under `src/features/swap-sidecar/`, per
   *  BOUNDARIES.md) should pass neither and let the backend do it. */
  xmrRpcHost?: string;
  xmrRpcPort?: number;
  /** Force `basicswap-prepare` to re-run. Off for an ordinary start. */
  reconfigure?: boolean;
  /**
   * C1 — the BIP85 child phrase for the engine's Particl wallet.
   *
   * **Secret.** Wrapped in `swap_sidecar::Secret` the moment it lands
   * Rust-side; never logged, never echoed back in `SidecarStatus`, never
   * persisted by this layer. Derive it at the call site from the vault
   * (`useVault.deriveSwapMnemonic`), pass it straight in, and keep no
   * reference — do not stash it in component state or a store.
   *
   * Required only on a **first prepare** (fresh datadir, no
   * `basicswap.json`); an ordinary start early-returns before prepare and
   * ignores it. Omitting it on a first prepare is refused Rust-side with
   * *"the vault must be unlocked to create the swap wallet"* rather than
   * silently minting a second wallet nobody has a backup of.
   */
  particlMnemonic?: string;
}

/**
 * Start the node and poll it healthy. Rejects with a plain-string error if the
 * user has not opted in. Long-running: subscribe to
 * {@link SIDECAR_PROGRESS_EVENT} for stage/percent while this is in flight.
 */
export function swapSidecarStart(
  args: SwapSidecarStartArgs = {},
): Promise<SidecarStatus> {
  // Spread into a plain record: `InvokeArgs` is `Record<string, unknown>` and
  // an interface (unlike a type alias) has no index signature.
  return invoke<SidecarStatus>("swap_sidecar_start", { ...args });
}

// ── C5 — wallet encryption key ────────────────────────────────────────
//
// Both take the derived key as a plain string because there is no other way
// across the IPC boundary; the Rust side wraps it in `Secret` immediately and
// holds it in memory only, cleared on stop. Neither returns it, and
// `SidecarStatus` has no field it could surface through.
//
// Derive with `src/lib/swapWalletKey.ts` (via `useVault.deriveSwapWalletKey`),
// which never exposes the vault mnemonic to this layer.

/**
 * Hand the supervisor the wallet-encryption key for this session.
 *
 * **Call ORDER is load-bearing: this always runs BEFORE
 * {@link swapSidecarStart}.** The key is what `build_prepare_plan` /
 * `build_addcoin_plan` push as `WALLET_ENCRYPTION_PWD`, and what
 * `start_node_core` unlocks the wallets with after the health check and
 * before the node is allowed to report `healthy`. Setting it after a start
 * is a no-op for that run.
 *
 * Awaiting `void` — resolution means "accepted", not "unlocked".
 */
export function swapSidecarSetWalletKey(key: string): Promise<void> {
  return invoke<void>("swap_sidecar_set_wallet_key", { key });
}

/*
 * There is deliberately NO `swapSidecarRotateWalletPassword` binding here.
 *
 * It used to exist, and it invoked `swap_sidecar_rotate_wallet_password` with
 * the new password taken verbatim off this boundary — which is the effect of
 * upstream's `setpassword`, an endpoint that is on `DENIED_ENDPOINTS` precisely
 * so the renderer cannot reach it. After C3.5 the node's `wallet.dat` holds the
 * user's account xprv and that password is all that protects it, so a
 * compromised renderer could have rotated it to an attacker-chosen value:
 * durable key escrow over pre-existing funds, plus a lockout of the honest
 * wallet, from one invoke.
 *
 * Review finding F4 removed the Rust command from `generate_handler!`; the
 * capability survives only as the crate-private
 * `swap_sidecar::rotate_wallet_password`, whose `new_key: Secret` parameter
 * makes re-registering it a compile error. This binding was the last thing
 * still naming it, and `src/api/command-parity.test.ts` was what found it
 * still here — a TS binding to an unregistered command type-checks perfectly
 * and fails only at runtime with "command not found".
 *
 * If a key-scheme migration (v1 → v2) ever needs rotation, it needs its own
 * purpose-built command gated on a fresh vault unlock. Do not restore this.
 */

/**
 * Run the shutdown ladder. Stopping an already-stopped node is a no-op, not an
 * error — safe to fire on view teardown.
 */
export function swapSidecarStop(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>("swap_sidecar_stop");
}

/**
 * Raw proxied GET. Prefer the named helpers below; reach for this only for an
 * endpoint already on the Rust allow-list that has no helper yet.
 */
export function swapSidecarApiGet<T = unknown>(
  path: string,
  query?: string,
): Promise<T> {
  return invoke<T>("swap_sidecar_api_get", { path, query });
}

/** Raw proxied POST. Same caveat as {@link swapSidecarApiGet}. */
export function swapSidecarApiPost<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  return invoke<T>("swap_sidecar_api_post", { path, body });
}

// =========================================================================
// BasicSwap JSON API — payload types
// =========================================================================

/**
 * One entry of `POST /json/offers` (upstream `js_server.py::js_offers`).
 *
 * **Direction, stated once so nobody has to re-derive it:** the offerer sends
 * `coin_from` and wants `coin_to`. A *taker* therefore **sends `coin_to` and
 * receives `coin_from`** (upstream's own bid form labels `coin_to` "Sending"
 * and `coin_from` "Receiving", `templates/offer.html`). `rate` is
 * `coin_to per 1 coin_from` — i.e. the taker's PRICE, where lower is better.
 * `min_bid_amount` is denominated in `coin_from`, the RECEIVE leg.
 */
export interface BasicSwapOffer {
  offer_id: string;
  /** `SwapTypes` int. `5` is `XMR_SWAP` (the adaptor-signature protocol). */
  swap_type: number;
  addr_from: string;
  addr_to: string;
  created_at: number;
  expire_at: number;
  /** Display name, e.g. `"Monero"` — NOT a ticker. The taker RECEIVES this. */
  coin_from: string;
  /** Display name. The taker SENDS this. */
  coin_to: string;
  /** Decimal string, `coin_from` units. Max the taker can receive. */
  amount_from: string;
  /** Decimal string, `coin_to` units. What a full fill costs the taker. */
  amount_to: string;
  /** Decimal string, `coin_to` per 1 `coin_from`. */
  rate: string;
  /** Decimal string, `coin_from` units. */
  min_bid_amount: string;
  is_expired: boolean;
  is_own_offer: boolean;
  is_revoked: boolean;
  is_public: boolean;
  message_nets?: unknown;
  auto_accept_type?: number;
  // --- with_extra_info: true only ---
  amount_negotiable?: boolean;
  rate_negotiable?: boolean;
  lock_time_1?: number;
  lock_time_2?: number;
  feerate_from?: string;
  feerate_to?: string;
}

/** One row of `POST /json/bids` or `POST /json/sentbids`. */
export interface BasicSwapBidSummary {
  bid_id: string;
  offer_id: string;
  created_at: number;
  expire_at: number;
  coin_from: string;
  coin_to: string;
  amount_from: string;
  amount_to: string | null;
  bid_rate: string;
  /** Upstream's HUMAN string (`strBidState`), e.g. `"Failed, refunded"`. */
  bid_state: string;
  addr_from: string;
  addr_to: string | null;
  tx_state_a?: string;
  tx_state_b?: string;
}

/**
 * `GET /json/bids/<id>` (upstream `ui/util.py::describeBid`, `for_api=True`).
 *
 * `bid_state_ind` is the raw `BidStates` integer and is the **most reliable**
 * key for staging — `bid_state` is a human string that upstream is free to
 * reword. Feed either to `classifyBidState`.
 */
export interface BasicSwapBidDetail {
  offer_id: string;
  coin_from: string;
  coin_to: string;
  amt_from: string;
  amt_to: string;
  bid_rate: string;
  ticker_from: string;
  ticker_to: string;
  bid_state: string;
  bid_state_ind: number;
  state_description: string;
  itx_state: string;
  ptx_state: string;
  addr_from: string;
  created_at_timestamp: number;
  expired_at: number | string;
  was_sent: boolean;
  was_received: boolean;
  can_abandon: boolean;
  /**
   * Unix seconds: the earliest the chain-A lock's REFUND transaction becomes
   * publishable — the protocol's own deadline for a counterparty who has gone
   * quiet with both legs locked (`ui/util.py::describeBid`).
   *
   * Compared by the chain against `coin_a_last_median_time`, NOT wall clock:
   * a CSV lock matures against median-time-past — the median of the last 11
   * block timestamps, so ~5.5 blocks behind the tip. On Litecoin's 2.5-minute
   * blocks that is about 14 minutes (measured: 14, live on 2026-09-06); on
   * Bitcoin or Bitcoin Cash it is nearer 55. Showing a countdown against the
   * wall clock would promise a refund earlier than the chain will allow it.
   */
  coin_a_lock_refund_tx_est_final?: number | null;
  /**
   * Unix seconds: the earliest the chain-A lock-refund output can be SWIPED —
   * the *second* timelock, and the one that matters once the pre-refund tx is
   * already in chain (`XMR_SWAP_SCRIPT_TX_PREREFUND`).
   *
   * `coin_a_lock_refund_tx_est_final` above is the FIRST deadline and is
   * already in the past by the time a bid reaches state 14, so a screen that
   * renders only that one has no deadline left to show at exactly the point
   * the user most wants one. Missing from this interface until 2026-09-08,
   * when a live bid sat in state 14 for 28 hours with nothing on screen saying
   * when it would end.
   *
   * Measured against `coin_a_last_median_time`, never wall clock — see the
   * note on the field above. The engine's own gate is literally
   * `chain_mtp >= coin_mtp + lock_value`
   * (`interface/btc/btc.py::isCsvLockMature`), and this field is the
   * right-hand side of it.
   */
  coin_a_lock_refund_swipe_tx_est_final?: number | null;
  /** The chain's median time, the clock the locks above are measured against. */
  coin_a_last_median_time?: number | null;
  /** True when the on-chain roles are mirrored (scriptless `coin_from`). */
  reverse_bid: boolean;
  events?: unknown[];
  txns?: Array<{ type: string; txid: string; confirms?: number | null }>;
}

/** One entry of `GET /json/coins` — the ticker ↔ name ↔ id ↔ decimals table. */
export interface BasicSwapCoin {
  id: number;
  ticker: string;
  name: string;
  active: boolean;
  decimal_places: number;
  variant?: string;
}

// ── ENGINE-JSON REGIME (snake_case, verbatim upstream) ────────────────
//
// Everything from here to `isApiError` is upstream's own JSON, proxied
// byte-for-byte by `swap_sidecar_api_get/post`. It stays **snake_case**. Do
// NOT camelCase an engine type to match our Rust structs — the two regimes
// coexist in this file on purpose (contract §0.1) and renaming one to look
// like the other produces fields that are always `undefined`.

/**
 * One value of `GET /json/wallets` — the **ticker-keyed OBJECT**.
 *
 * Upstream: `js_wallets` (js_server.py:411) with no ticker in the path falls
 * through to `getWalletsInfo({"ticker_key": True})` (basicswap.py:15559),
 * which maps `<TICKER> → getWalletInfo(coin) + getBlockchainInfo(coin)`.
 *
 * **This is not the same endpoint as `/json/walletbalances`**, and the
 * difference is the reason to reach for this one:
 *
 * | | `/json/wallets` | `/json/walletbalances` |
 * |---|---|---|
 * | shape | ticker-keyed **object** | **array** |
 * | `deposit_address` | yes | **no** |
 * | ticker uniqueness | unique (it's the key) | **not unique** — PART_ANON, PART_BLIND and LTC_MWEB reuse their parent's ticker (js_server.py:266-274, :298-306) |
 * | pending | `unconfirmed` + `immature`, separate | one combined `pending` string |
 *
 * One call covers every active coin — **do not fan out** per ticker. The
 * per-ticker form (`/json/wallets/<TICKER>`) exists but costs one round trip
 * each and is the only form that runs `checkAddressesOwned`.
 *
 * **Per-coin failures are isolated**: `getWalletsInfo` catches per coin and
 * writes `{name, error}` (basicswap.py:15574) — or `{name, error: "Timeout"}`
 * (`:15603`) — for that ticker alone. Every other ticker is intact, so a
 * consumer must render an error ROW, never an error SCREEN.
 *
 * Every field is optional because the error shape shares this type and
 * because upstream's field set varies by coin family (Particl carries
 * `stealth_address`/`anon_balance`, XMR-family carries `main_address`, LTC
 * carries `mweb_*`). Amounts are decimal **strings** (contract §0.3).
 */
export interface BasicSwapWalletInfo {
  /** May be a human-readable PLACEHOLDER, not an address — always run it
   *  through {@link normalizeDepositAddress}. */
  deposit_address?: string;
  /** Decimal string. */
  balance?: string;
  /** Decimal string. */
  unconfirmed?: string;
  /** Decimal string. Absent unless the coin reports `immature_balance`. */
  immature?: string;
  /** Core-model wallet lock state. `locked: true` ⇒ cannot sign. */
  locked?: boolean;
  /** Whether the wallet file is encrypted at rest (C5's precondition). */
  encrypted?: boolean;
  /** `ci.knownWalletSeed()` — false means the daemon's wallet was not seeded
   *  from the engine's key, which is what triggers the "Unknown wallet seed"
   *  deposit-address placeholder. */
  expected_seed?: boolean;
  /** `"rpc"` | `"electrum"` | `"none"` — how the engine reaches this chain. */
  connection_type?: string;
  /** Chain height, merged in from `getBlockchainInfo`. */
  blocks?: number;
  /** Sync percentage as a **string**, e.g. `"100.00"`.
   *
   *  `round(100 * verificationprogress, 2)` — so it answers "how much of the
   *  chain have I VERIFIED", which on a chain that has downloaded nothing can
   *  read `"100.00"` (nothing to verify is vacuously complete). Never treat it
   *  as progress on its own; pair it with {@link blocks}. */
  synced?: string;
  /** Target height, when the coin reports one (`known_block_count`). Absent
   *  for coins whose backend cannot say how far there is to go. */
  known_block_count?: number;
  /** The daemon is fetching a chain snapshot rather than syncing normally
   *  (upstream's `--usebtcfastsync` path). */
  bootstrapping?: boolean;
  /** Present on BOTH the healthy and the error shape. */
  name?: string;
  /** Set (with `name`) instead of the balance fields when this coin's
   *  lookup threw. Isolated to this ticker. */
  error?: string;
}

/**
 * The strings upstream puts in `deposit_address` **in place of an address**.
 *
 * From `ui/util.py:840-864` (`checkAddressesOwned`) and `page_wallet.py:525`
 * (the `.get(..., "Refresh necessary")` default). They are human-readable
 * status text that happens to occupy an address field — offering any of them
 * behind a copy button hands the user an unpayable string, and a QR encoder
 * will happily encode one.
 */
export const DEPOSIT_ADDRESS_PLACEHOLDERS = [
  "Refresh necessary",
  "WARNING: Unknown wallet seed",
  "Error: unowned address",
] as const;

/**
 * `deposit_address` → a real address, or `null`.
 *
 * `null` for the placeholders above, for `"?"` (upstream's own
 * not-yet-known marker, `ui/util.py:816`), for empty/whitespace, and for a
 * non-string. Anything else is passed through **unmodified** — this function
 * is a filter, not a validator, and deliberately does not try to parse
 * address formats for six chains.
 *
 * Callers must treat `null` as "no address to show yet", never as an error:
 * "Refresh necessary" resolves on the next poll once the engine caches an
 * address.
 */
export function normalizeDepositAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t === "" || t === "?") return null;
  return (DEPOSIT_ADDRESS_PLACEHOLDERS as readonly string[]).includes(t)
    ? null
    : t;
}

/** One entry of `GET /json/walletbalances` — an ARRAY element, NOT keyed by
 *  ticker. See {@link BasicSwapWalletInfo} for why they differ. */
export interface BasicSwapWalletBalance {
  id: number;
  name: string;
  ticker: string;
  /** Decimal string. */
  balance: string;
  /** Decimal string — unconfirmed + immature. */
  pending: string;
  connection_type: string;
  scan_status?: unknown;
  electrum_server?: string;
  version?: string;
}

/**
 * `POST /json/offerfeeestimate`. `fee` is `null` and `error` is set when the
 * node could not price it — treat that as **advisory unavailable**, never as a
 * reason to block.
 */
export interface BasicSwapFeeEstimate {
  coin_from: string;
  fee: string | null;
  fee_rate?: string;
  fee_src?: string;
  error?: string;
}

/** Several endpoints answer `{error}` in place of their normal body. */
export interface BasicSwapApiError {
  error: string;
  locked?: boolean;
}

/** Narrow an endpoint result that may have answered `{error: …}` instead. */
export function isApiError(v: unknown): v is BasicSwapApiError {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { error?: unknown }).error === "string"
  );
}

// =========================================================================
// BasicSwap JSON API — helpers (allow-listed endpoints ONLY)
// =========================================================================

/** Upstream caps `limit` at its own `PAGE_LIMIT`; 50 is a safe page size. */
export const OFFERS_PAGE_LIMIT = 50;

export interface OfferQuery {
  limit?: number;
  offset?: number;
  /** Coin id (int) or ticker string. Filters the offerer's SEND leg. */
  coin_from?: number | string;
  /** Coin id (int) or ticker string. Filters the offerer's RECEIVE leg. */
  coin_to?: number | string;
  sort_by?: "created_at" | "rate";
  sort_dir?: "asc" | "desc";
  /** Include offers this node itself published. */
  include_sent?: boolean;
  active?: string;
}

/**
 * The resting offer book. `with_extra_info` is always on because
 * `amount_negotiable` — which decides whether a partial fill is legal at all —
 * only appears under it.
 *
 * Sorting server-side is a convenience, not the ranking: the taker-facing
 * ranking is `rankOffers` in `features/swap-sidecar/offers.ts`, and it is a
 * pure function of price.
 */
export async function fetchOffers(
  query: OfferQuery = {},
): Promise<BasicSwapOffer[] | BasicSwapApiError> {
  const body: Record<string, unknown> = {
    limit: query.limit ?? OFFERS_PAGE_LIMIT,
    with_extra_info: true,
  };
  if (query.offset != null) body.offset = query.offset;
  if (query.coin_from != null) body.coin_from = query.coin_from;
  if (query.coin_to != null) body.coin_to = query.coin_to;
  if (query.sort_by) body.sort_by = query.sort_by;
  if (query.sort_dir) body.sort_dir = query.sort_dir;
  if (query.include_sent != null) body.include_sent = query.include_sent;
  if (query.active != null) body.active = query.active;
  const rv = await swapSidecarApiPost<BasicSwapOffer[] | BasicSwapApiError>(
    "offers",
    body,
  );
  return rv;
}

/**
 * One offer by id. Upstream treats the id as a *filter* and still answers with
 * a list, so this unwraps to the single entry (or `null`).
 */
export async function fetchOffer(
  offerId: string,
): Promise<BasicSwapOffer | null> {
  const rv = await swapSidecarApiGet<BasicSwapOffer[] | BasicSwapApiError>(
    `offers/${offerId}`,
  );
  if (isApiError(rv) || !Array.isArray(rv)) return null;
  return rv[0] ?? null;
}

export interface BidQuery {
  offer_id?: string;
  limit?: number;
  offset?: number;
  sort_by?: "created_at";
  sort_dir?: "asc" | "desc";
  with_extra_info?: boolean;
  with_expired?: boolean;
  with_available_or_active?: boolean;
}

/** Bids **received** by this node (i.e. on offers it published). */
export function fetchBids(
  query: BidQuery = {},
): Promise<BasicSwapBidSummary[] | BasicSwapApiError> {
  return swapSidecarApiPost<BasicSwapBidSummary[] | BasicSwapApiError>("bids", {
    with_extra_info: true,
    ...query,
  });
}

/**
 * Bids **this node sent** — the user's own taker activity, and the list the
 * swap tracker is built from.
 */
export function fetchSentBids(
  query: BidQuery = {},
): Promise<BasicSwapBidSummary[] | BasicSwapApiError> {
  return swapSidecarApiPost<BasicSwapBidSummary[] | BasicSwapApiError>(
    "sentbids",
    { with_extra_info: true, ...query },
  );
}

/**
 * One row of `GET /json/active` — the engine's own `swaps_in_progress`.
 *
 * The same source the upstream console's "Swaps in Progress" table renders, and
 * the authority on what is actually running: it covers BOTH roles (a bid this
 * node sent and one it received) and needs no filter argument to get right.
 */
export interface BasicSwapActiveSwap {
  bid_id: string;
  offer_id: string;
  created_at: number;
  expire_at: number;
  bid_state: string;
  coin_from: string;
  coin_to: string;
  amount_from: string;
  amount_to: string;
  addr_from?: string | null;
  /** True when THIS node placed the bid (taker); false when it received one. */
  was_sent?: boolean | null;
  tx_state_a?: string | null;
  tx_state_b?: string | null;
}

/**
 * Every swap the node currently has in progress.
 *
 * Read on a timer rather than once at mount: a swap that was running when the
 * app closed only shows up if the node is ANSWERING when we ask, and the node
 * takes a minute or two to come up while the UI is already on screen. A
 * one-shot read at mount is a read that lands before the node exists.
 */
export function fetchActiveSwaps(): Promise<
  BasicSwapActiveSwap[] | BasicSwapApiError
> {
  return swapSidecarApiGet<BasicSwapActiveSwap[] | BasicSwapApiError>("active");
}

/**
 * One bid in full. **GET only** — the same URL with a POST body carrying
 * `accept` / `abandon` commits funds, which is why the Rust allow-list makes
 * `bids/<id>` GET-only. Do not add a POST variant here.
 */
export function fetchBid(
  bidId: string,
): Promise<BasicSwapBidDetail | BasicSwapApiError> {
  return swapSidecarApiGet<BasicSwapBidDetail | BasicSwapApiError>(
    `bids/${bidId}`,
  );
}

/** `[timestamp, stateName]` rows — the bid's own state history. */
export type BidStateHistoryRow = [number, string, ...unknown[]];

export function fetchBidStates(
  bidId: string,
): Promise<BidStateHistoryRow[] | BasicSwapApiError> {
  return swapSidecarApiGet<BidStateHistoryRow[] | BasicSwapApiError>(
    `bids/${bidId}/states`,
  );
}

/** The ticker ↔ name ↔ id ↔ decimals table. Cache it; it changes on restart only. */
export function fetchCoins(): Promise<BasicSwapCoin[] | BasicSwapApiError> {
  return swapSidecarApiGet<BasicSwapCoin[] | BasicSwapApiError>("coins");
}

/**
 * Balances of the sidecar's own wallets (NOT the PwndaWallet vault's), as an
 * **array** (js_server.py:308).
 *
 * Prefer {@link fetchWallets} for anything user-facing: this endpoint has no
 * `deposit_address`, and its `ticker` is **not unique** (PART_ANON,
 * PART_BLIND and LTC_MWEB reuse their parent's ticker), so keying the result
 * by ticker silently drops rows. This helper survives for callers that want
 * the flat per-variant list.
 */
export function fetchWalletBalances(): Promise<
  BasicSwapWalletBalance[] | BasicSwapApiError
> {
  return swapSidecarApiGet<BasicSwapWalletBalance[] | BasicSwapApiError>(
    "walletbalances",
  );
}

/**
 * Every active coin's wallet in one call — balance, pending, deposit address
 * and lock state, keyed by UPPERCASE ticker.
 *
 * The read the balances UI is built on. Answers `{error}` (or, under C5,
 * `{error, locked: true}`) in place of the whole body when the engine's
 * `checkSystemStatus` throws; narrow with {@link isApiError} before indexing.
 * Individual coins fail *inside* the object as `{name, error}` — that is a
 * row-level fault, not a body-level one.
 */
export function fetchWallets(): Promise<
  Record<string, BasicSwapWalletInfo> | BasicSwapApiError
> {
  return swapSidecarApiGet<
    Record<string, BasicSwapWalletInfo> | BasicSwapApiError
  >("wallets");
}

/** Rounding mode for {@link validateAmount}. `rounddown` is the snap-DOWN mode. */
export type AmountRoundMethod = "none" | "roundoff" | "rounddown";

/**
 * Format/round an amount to a coin's own precision, server-side. Returns the
 * formatted decimal **string**.
 *
 * Note what this is NOT: it does not check an amount against an offer's
 * min/max. That mirror lives in `features/swap-sidecar/offers.ts::validateBid`
 * so the user gets feedback without a round trip; this endpoint is the
 * authority on *precision* only.
 */
export function validateAmount(args: {
  coin: string;
  amount: string | number;
  method?: AmountRoundMethod;
}): Promise<string> {
  return swapSidecarApiPost<string>("validateamount", {
    coin: args.coin,
    amount: String(args.amount),
    method: args.method ?? "none",
  });
}

/**
 * The node's estimate of the chain fee on the scripted leg. **Advisory.** A
 * `{error}` body or a null `fee` means "unavailable" and must degrade to a
 * missing line item, never to a blocked swap.
 */
export function fetchOfferFeeEstimate(args: {
  coin_from: number | string;
  coin_to: number | string;
}): Promise<BasicSwapFeeEstimate> {
  return swapSidecarApiPost<BasicSwapFeeEstimate>("offerfeeestimate", args);
}

// =========================================================================
// RUST-STRUCT REGIME (camelCase) — C3, C3.5, C4, C6
// =========================================================================
//
// Everything below this banner is one of OUR commands, so every field and
// every invoke argument is camelCase (contract §0.1, §0.2). Nothing here is
// proxied engine JSON — if a field needs an underscore, it belongs above the
// banner with `BasicSwapOffer` and friends, not here.
//
// These commands live in three Rust modules — `swap_sidecar.rs` (C3),
// `swap_sidecar/descriptors.rs` (C3.5) and `swap_bridge.rs` (C4/C6) — but
// share this file because they share the type vocabulary and because a
// consumer should not have to know which module answered.

// ── C3: per-coin DEX enable + the fallback gate ──────────────────────

/**
 * How this coin's pre-existing funds reach the swap node.
 *
 * - `descriptor` — zero-move: the user's account descriptors are imported into
 *   the node's wallet so it can spend what is already there (C3.5).
 * - `consolidate` — the coin cannot take a descriptor import, so funds are
 *   moved once into the node's own wallet.
 * - `deposit` — nothing is adopted; the user funds the node by sending to its
 *   deposit address. **The default**, because it is the only one that is
 *   always available.
 * - `accountkey` — C8, lean coins only: the engine's own wallet was
 *   initialised from the wallet's account key, so the two are one wallet.
 *   Zero on-chain movement, like `descriptor`, but at the key layer because a
 *   lean coin has no daemon wallet to import descriptors into.
 * - `hostwallet` — C9-shaped: the engine's main wallet for this coin IS a
 *   wallet-rpc (or JWT-RPC) process this app already runs, rather than a
 *   wallet the engine built itself. Zero on-chain movement, like `descriptor`
 *   and `accountkey`, but at neither the daemon layer nor the key layer.
 *
 *   Wire-frozen lowercase (Rust `Adoption`, `#[serde(rename_all = "lowercase")]`
 *   — `swap_sidecar.rs::Adoption::HostWallet`, Grove expansion plan Phase C,
 *   unit C-R0). Generalises Monero's own C9 mechanism, added here for ZEPH
 *   and ZANO (neither is {@link CoinEnableStatus.canRunLean} nor descriptor-
 *   importable, so this is their ONLY adoption path). **Monero itself never
 *   reaches this value** — its C9 sharing predates this variant and still
 *   reports out-of-band via {@link CoinEnableStatus.xmrHostWalletActive}
 *   rather than through `adoption`; migrating it is a separate decision. Ask
 *   `adoption === "hostwallet"` about ZEPH/ZANO, never about XMR.
 */
export type DexAdoption =
  | "descriptor"
  | "consolidate"
  | "deposit"
  | "accountkey"
  | "hostwallet";

/**
 * How a coin is hosted by the swap node.
 *
 * - `lean` — no local chain. The engine talks to public ElectrumX servers, so
 *   the coin costs **zero disk and zero sync time**. Only BTC and LTC can do
 *   this; check {@link CoinEnableStatus.canRunLean} before offering it.
 * - `full` — a local pruned daemon.
 *
 * **The tradeoff is not cosmetic, and the UI has to say so.** A lean coin has
 * no daemon, so there is nothing to route a send through and nothing to import
 * the user's keys into: *no daemon-direct routing and no zero-move adoption*.
 * Funding a lean coin means depositing to the node. `full` is what a user picks
 * when they want coins they already hold to be tradeable where they sit.
 *
 * `lean` is the default — light unless the user asks for more.
 */
export type CoinMode = "lean" | "full";

/** Per-coin record inside {@link OptInRecord.coins}. */
export interface CoinOptIn {
  enabled: boolean;
  /** RFC3339, or null when the coin has no explicit record. */
  at: string | null;
  adoption: DexAdoption;
  /** RFC3339 of a successful C3.5 import, or null. */
  descriptorsImportedAt: string | null;
  /**
   * The node has begun syncing this chain at least once.
   *
   * **This is the only thing standing between the user and a silent
   * zero-balance import** (contract §R12): a pruned node cannot rescan history
   * it has discarded, so a descriptor import issued after first sync returns
   * `success: true` per descriptor and finds nothing. Once true, C3.5 refuses.
   */
  firstSyncStarted: boolean;
  /**
   * Whether this coin runs a local chain. See {@link CoinMode}.
   *
   * Absent on records written before C7, where it reads as `"lean"`. That is
   * safe for existing installs because the backend refuses to change a coin
   * already present in `basicswap.json` — the default only decides what a newly
   * enabled coin does.
   */
  mode: CoinMode;
  /**
   * C9 — RFC3339 of the user's explicit "point the swap engine's Monero
   * wallet at my own monero-wallet-rpc" decision. Only meaningful on the
   * `"monero"` entry; `null`/absent when never decided.
   *
   * **Optional even though Rust always sends the key** (`#[serde(default)]`
   * never omits it): no current UI reads this raw timestamp —
   * `swap_sidecar_coin_status`'s derived {@link CoinEnableStatus.xmrHostWalletActive}
   * is what components consult instead, and marking it required would force
   * every existing `CoinOptIn` test fixture (`src/api/basicswapCommands.test.ts`)
   * to grow fields it does not exercise. Modelled here anyway so the wire
   * shape does not have to be re-derived from `swap_sidecar.rs` by hand.
   */
  xmrHostWalletAckAt?: string | null;
  /** The durable NO twin of {@link xmrHostWalletAckAt}. */
  xmrHostWalletDeclinedAt?: string | null;
  /**
   * C9-shaped twin of {@link xmrHostWalletAckAt} for Zephyr. Only meaningful
   * on the `"zephyr"` entry — Zephyr has no C8 (electrum) or C3.5 (descriptor)
   * option, so this is its ONLY sharing consent. Deliberately its own field,
   * not a reuse of the Monero one (`swap_sidecar.rs::CoinOptIn::zph_host_wallet_ack_at`).
   */
  zphHostWalletAckAt?: string | null;
  /** The durable NO twin of {@link zphHostWalletAckAt}. */
  zphHostWalletDeclinedAt?: string | null;
  /** Zano's twin of {@link zphHostWalletAckAt}. Only meaningful on the
   *  `"zano"` entry — Zano's main wallet is a stock `simplewallet` shared the
   *  same C9-shaped way, over JWT rather than HTTP Digest. */
  zanoHostWalletAckAt?: string | null;
  /** The durable NO twin of {@link zanoHostWalletAckAt}. */
  zanoHostWalletDeclinedAt?: string | null;
}

/** One row of `swap_sidecar_coin_status`. */
export interface CoinEnableStatus {
  /** Engine coin name, lowercase — `"btc"`, `"particl"`. */
  coin: string;
  /** UPPERCASE ticker — `"BTC"`. */
  ticker: string;
  enabled: boolean;
  /** A daemon binary is seeded for this coin. False means it can never be
   *  configured, no matter what the user toggles. */
  binaryPresent: boolean;
  /** A `chainclients.<coin>` block exists in `basicswap.json`. */
  configured: boolean;
  adoption: DexAdoption;
  descriptorsImported: boolean;
  /** What the user has ASKED for. Compare with {@link configuredMode}. */
  mode: CoinMode;
  /**
   * What `basicswap.json` actually encodes, or `null` when the coin has no
   * block in it yet.
   *
   * Differs from {@link mode} exactly when a change has been requested but not
   * applied — the same relationship {@link enabled} has to {@link configured},
   * and for the same reason: the engine reads its config once, at startup.
   * When the two disagree, show the CONFIGURED one as current and the requested
   * one as pending.
   */
  configuredMode: CoinMode | null;
  /**
   * Whether a lean option exists for this coin at all — only BTC and LTC.
   *
   * **Do not render the toggle when this is false.** The backend refuses the
   * call, but an offered-then-refused control is a worse UI than an absent one.
   */
  canRunLean: boolean;
  /**
   * Is there a wallet-sharing choice to offer on this row at all?
   *
   * True for a lean electrum-capable coin (C8's account-key sharing) and for
   * monero (C9's wallet-rpc sharing). These are two different mechanisms but
   * one user-facing question, so the UI renders **one** control and the
   * caller routes to the right command — see
   * {@link swapSidecarSetShareWallet} vs {@link swapSidecarSetXmrHostWallet}.
   */
  canShareWallet: boolean;
  /**
   * Is this coin's wallet CURRENTLY shared with the swap node?
   *
   * Defaults **true** for any capable coin once the DEX is opted into
   * (2026-08-20): opting in is the decision, and the disclosure lives in the
   * opt-in wizard. False only when the user explicitly declined.
   *
   * Distinct from `adoption === "accountkey"`, which means the engine was
   * **verified** to have done it. Between them sits the ordinary "will share,
   * node not started yet".
   */
  sharesWallet: boolean;
  /**
   * **Monero only.** C9 host-wallet sharing is ACTIVE in the config the swap
   * node booted from — Rust reads `chainclients.monero.mainwalletrpcport`,
   * the same key the engine itself branches on to set
   * `_external_main_wallet`. Always false for every other coin.
   *
   * **Use this, not `adoption === "accountkey"`, to ask "is XMR really
   * shared?"** Monero shares by pointing the engine at this app's own
   * `monero-wallet-rpc`; it never travels C8's account-key push, so a fully
   * shared Monero wallet reports `adoption: "deposit"` forever. Keying an XMR
   * decision on `accountkey` yields a permanent `false` — that exact bug
   * shipped on 2026-08-21 and is pinned by
   * `monero_sharing_is_not_expressible_as_adoption_accountkey`.
   */
  xmrHostWalletActive: boolean;
  /**
   * Host-wallet sharing is ACTIVE in the config the node booted from, for
   * ANY of the three host-wallet coins — monero and zephyr
   * (`chainclients.<coin>.mainwalletrpcport`) and zano
   * (`chainclients.zano.scratchwalletrpcport`, the engine-owned Scratch
   * process). Always false for every other coin.
   *
   * Added 2026-09-04 so `DexCnWalletSection` can draw the same "asked for"
   * vs "the write landed in the config the running node read" distinction
   * for ZEPH/ZANO that {@link xmrHostWalletActive} draws for Monero. Rust
   * derives the Monero field from this one, so the two cannot disagree;
   * prefer this one in new code.
   *
   * Optional on the type because pre-existing mock fixtures and tests build
   * rows without it; Rust always sends it.
   */
  hostWalletActive?: boolean;
  /**
   * The coin is configured AND will actually run this session — its
   * `connection_type` is `rpc`/`electrum`, not `none`. `null`/absent when
   * the coin has no block yet (`configured === false`).
   *
   * Added 2026-09-04: a host-wallet coin (ZEPH/ZANO) whose wallet process
   * is not running when the node starts is PARKED for that session (Rust
   * `apply_host_wallet_coin_policy`) instead of stalling the node. The swap
   * picker's live gate reads THIS, not `configured`, so a parked coin is not
   * offered as a route the engine is deliberately not running.
   */
  active?: boolean | null;
  /** Why the coin is parked this session (2026-09-04): the supervisor's own
   *  sentence from the decision that parked it. Present only with
   *  `active === false`. */
  parkedReason?: string | null;
  /**
   * Rough chaindata cost for the mode the node WILL run — i.e.
   * {@link configuredMode} where it exists. Zero for a lean coin, and for a
   * Monero pinned to a remote node.
   */
  estDiskGb: number;
}

/**
 * May PwndaWallet spend this coin from its own wallet right now?
 *
 * The DEX reserves UTXOs for in-flight swaps. Spending one of them from the
 * wallet side double-spends a reserved input, which aborts the live swap and
 * can forfeit the leg (contract §R9, P4).
 *
 * **It fails closed and that is the entire design.** An unreachable daemon
 * cannot prove the absence of locks, so Rust answers from the persisted
 * `selection-gate.json` with `{allowed: false, stale: true}`. Consumers must
 * branch on {@link SelectionGate.allowed} — never on `reason`, which is display
 * copy and will be reworded.
 */
export interface SelectionGate {
  allowed: boolean;
  /** Human copy. Never branch on it. */
  reason: string;
  lockedUtxos: number;
  activeBids: number;
  /** The daemon could not be reached; this answer came from disk. */
  stale: boolean;
  /** RFC3339 of the reading this answer is based on. */
  asOf: string;
}

/**
 * Read {@link OptInRecord.coins} defensively.
 *
 * Returns `{}` for a record that predates C3 or arrived from a mock that has
 * not caught up. `{}` means **"no explicit per-coin choices"**, which under the
 * frozen migration semantics is *legacy: everything seedable is enabled* — it
 * does NOT mean "all coins disabled". That distinction is why this returns a
 * plain map and callers must consult `swapSidecarCoinStatus()` for the
 * effective answer rather than deriving it here.
 */
export function coinOptInsFrom(
  rec: OptInRecord | null | undefined,
): Record<string, CoinOptIn> {
  const raw = rec?.coins;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw;
}

/**
 * Enable or disable one coin for the DEX.
 *
 * **Disable is not symmetric with enable.** It writes
 * `chainclients.<coin>.manage_daemon = false`; the chainclient block survives,
 * the chain simply stops syncing. Nothing is deleted and no chaindata is
 * removed — say so in the UI, because "disable" reads as "remove" otherwise.
 *
 * Invoke args: `{ coin, enabled }`.
 */
export function swapSidecarSetCoin(
  coin: string,
  enabled: boolean,
): Promise<OptInRecord> {
  return invoke<OptInRecord>("swap_sidecar_set_coin", { coin, enabled });
}

/**
 * Choose whether a coin runs a local chain (`"full"`) or none (`"lean"`).
 *
 * Rejects, with a message meant to be shown verbatim:
 *
 * - a `"lean"` request for a coin with no light-client support — everything
 *   except BTC and LTC. Gate on {@link CoinEnableStatus.canRunLean} first.
 * - a `"lean"` request for `particl`, which carries the offer/bid transport.
 * - **any change to a coin already present in `basicswap.json`.** The mode is
 *   written when the coin is created and the engine never re-reads it, so the
 *   remedy is to disable the coin, restart the node, and re-enable it. The
 *   error says exactly that.
 *
 * Re-sending the mode a coin already has is a no-op, not an error, so a
 * controlled component may send its current value freely.
 *
 * Like {@link swapSidecarSetCoin} this records intent; the config is written on
 * the next start.
 *
 * Invoke args: `{ coin, mode }`.
 */
export function swapSidecarSetCoinMode(
  coin: string,
  mode: CoinMode,
): Promise<OptInRecord> {
  return invoke<OptInRecord>("swap_sidecar_set_coin_mode", { coin, mode });
}

/**
 * Open the BasicSwap console in a pwnda-owned window, already logged in.
 *
 * pwnda performs the login itself and installs the resulting session, so the
 * user never sees or handles the console password. The credential is
 * deliberately **kept** rather than removed: upstream's Host and Origin checks
 * already block browser attacks with or without it, and its one real job is
 * stopping OTHER local accounts on the machine from reaching a fund-moving API
 * on loopback. Removing it would hand them that API unauthenticated.
 *
 * Rejects when the node is not running — there is nothing to log in to, and
 * opening a window onto a dead port would show a browser error page rather
 * than say so.
 *
 * Takes no arguments: the port and the credential are backend state, and a
 * renderer-supplied port would be a way to point the login at another server.
 */
/**
 * Tail of the console-open trace log, for handing back when the window
 * misbehaves.
 *
 * The blank-console bug survived two diagnoses because nothing host-side
 * recorded what the window did — the webview's own `console.log` goes to
 * devtools nobody had open. This reads what Rust wrote instead.
 */
export function swapSidecarConsoleTrace(): Promise<string> {
  return invoke<string>("swap_sidecar_console_trace");
}

/**
 * Place a bid on a BasicSwap offer. **Commits funds.**
 *
 * NOT `swapSidecarApiPost("bids/new", ...)`: that generic proxy is a
 * pass-through and `bids/new` stays off its allow-list and on
 * `DENIED_ENDPOINTS`, deliberately. This is a dedicated Rust command
 * (`src-tauri/src/swap_bid.rs`) that re-reads the offer from the engine and
 * re-checks the amount and rate against the engine's own copy before writing,
 * so a compromised renderer cannot show one price and submit another.
 *
 * Resolves to the engine's bid id.
 */
export function swapSidecarPlaceBid(args: {
  offerId: string;
  /** RECEIVE-leg amount — upstream denominates a bid in the offer's coin_from. */
  amountFrom: string;
  /** Pinned to the offer's own rate; Rust refuses drift beyond 0.01 %. */
  rate: string;
  addrTo?: string;
  validForSeconds?: number;
}): Promise<string> {
  return invoke<string>("swap_sidecar_place_bid", {
    offerId: args.offerId,
    amountFrom: args.amountFrom,
    rate: args.rate,
    addrTo: args.addrTo,
    validForSeconds: args.validForSeconds,
  });
}

/** What the engine concluded about a recovery attempt (PWNDA-PATCH-11). */
export interface RecoverOutcome {
  recovered: boolean;
  /** The engine's own sentence, present when it REFUSED. Safe to show. */
  reason?: string | null;
  state?: string | null;
  stateBefore?: string | null;
  retryInSeconds?: number | null;
  /** PWNDA-PATCH-27 (2026-09-04): the engine re-queued nothing — it found the
   *  chain-A redeem already confirmed and marked the swap Completed. */
  settled?: boolean | null;
  confirmations?: number | null;
  txid?: string | null;
}

/**
 * Ask the swap node to restart a swap it parked in `BID_ERROR`.
 *
 * `BID_ERROR` is terminal for the engine's adaptor-sig state machine — nothing
 * re-examines a bid that lands there — so a swap whose cause was transient
 * stays stuck even though the funds are fine. The 2026-08-23 mainnet case was
 * a chain-A redeem that had ALREADY confirmed and was rejected on rebroadcast
 * as a duplicate.
 *
 * Commits nothing: the engine side takes no target state, restores the one
 * step/action pairing it uses itself, and lets that step's existing guards
 * decide. `recovered: false` is a normal answer with a `reason` — the engine
 * refuses rather than raising when a gate is not met.
 */
export function swapSidecarRecoverBid(bidId: string): Promise<RecoverOutcome> {
  return invoke<RecoverOutcome>("swap_sidecar_recover_bid", { bidId });
}

/**
 * Install the swap engine this build ships, replacing an older one already in
 * app-data.
 *
 * The same reconcile runs by itself on the next node start
 * (`reconcile_bundled_engine`); this exists so the drift note can carry a
 * button rather than an instruction. Refuses while the node is running — an
 * engine swap under a live node drops a process that may be watching a swap's
 * timelocks — and on a dev checkout, which ships no payload to install from,
 * says exactly that instead of reporting a success it did not achieve.
 */
export function swapSidecarUpdateEngine(): Promise<string> {
  return invoke<string>("swap_sidecar_update_engine");
}

/**
 * The bid janitor's report (2026-09-04). The supervisor runs the same sweep
 * itself 45 s after every healthy start and every ten minutes, and emits
 * `JANITOR_EVENT` with this payload whenever it found a bid in Error — so a
 * swap the engine parked (the 2026-08-23 mainnet bid sat "in progress" for
 * twelve days) is settled or re-queued without anyone finding a button.
 * `swapSidecarJanitorRun` is the on-demand form of the same sweep.
 */
export interface JanitorReport {
  at: number;
  scanned: number;
  errored: number;
  settled: Array<{ bidId: string; txid?: string | null; confirmations?: number | null }>;
  requeued: string[];
  left: Array<{ bidId: string; reason: string }>;
  capped: string[];
}

export const JANITOR_EVENT = "swap-sidecar-janitor";

export function swapSidecarJanitorRun(): Promise<JanitorReport> {
  return invoke<JanitorReport>("swap_sidecar_janitor_run");
}

/**
 * The unpark doorbell (2026-09-04). The supervisor emits this when a parked
 * host-wallet coin's wallet is up, sharing is consented, and the node has no
 * swap in flight — i.e. a restart would add the coin and interrupt nothing.
 * It asks rather than restarts because the wallet key is cleared at every
 * stop and only the unlocked app can supply it again (`useSwapAutoSetup`).
 */
export const UNPARK_EVENT = "swap-sidecar-unpark";

export interface UnparkRequest {
  coin: string;
  attempt: number;
  max: number;
}

/** Tail of the supervisor's own log (`swap-sidecar.log`): the host-wallet
 *  activation decisions, the warm-up wait, the janitor and unpark restarts. */
export function swapSidecarSupervisorLog(): Promise<string> {
  return invoke<string>("swap_sidecar_supervisor_log");
}

export function swapSidecarOpenConsole(): Promise<void> {
  return invoke<void>("swap_sidecar_open_console");
}

/**
 * Unlock the RUNNING swap node's wallets with the key already pushed this
 * session (`swapSidecarSetWalletKey` first, always).
 *
 * This is what makes the web UI's "Unlock BasicSwap" page disappear. That
 * page validates the C5 wallet-encryption key — a secret DERIVED from the
 * vault that the user never sees, so no password they can type belongs there
 * (pasting the console password into it is the natural mistake, and it reads
 * as broken auth). An autostarted node is always keyless and therefore locked;
 * this unlocks it in place, no restart.
 *
 * Rejects with an actionable message when the node is not running or no key
 * was pushed this session.
 */
export function swapSidecarUnlockWallets(): Promise<void> {
  return invoke<void>("swap_sidecar_unlock_wallets");
}

/** One coin's account node, on its way to the engine. */
export interface AccountKeyPush {
  /** UPPERCASE ticker. */
  ticker: string;
  /**
   * The 74-byte account node, hex — `src/lib/swapAccountKey.ts`.
   *
   * **Spending authority for that coin's entire branch.** Derive it
   * immediately before this call; never hoist it, never put it in React state
   * or a store, never log it.
   */
  accountKey: string;
  /** The index-0 receive address the WALLET derives for the same account. */
  expectedAddress: string;
  /** `"p2wpkh"` (default) or `"p2pkh"` for a wallet whose funds live on
   *  legacy base58 addresses — the Exodus/Atomic import case. The engine
   *  watches AND spends in this script type (PWNDA-PATCH-3/-6). */
  addressType: "p2wpkh" | "p2pkh";
}

/** What became of one push. */
export interface AccountKeyOutcome {
  ticker: string;
  /** The engine stood the wallet up now. False means "stored, pending
   *  unlock" — the ordinary push-before-unlock order, not a failure. */
  initialized: boolean;
  /** True only when the engine's derived address matched the wallet's. Until
   *  this is true the coin is NOT sharing the wallet. */
  shared: boolean;
  /** Refusal, or an address mismatch, verbatim. */
  error: string | null;
}

/**
 * C8 — hand the swap node the wallet's own account keys, so a **lean** BTC or
 * LTC coin's wallet *is* the user's wallet.
 *
 * ## Why this exists
 *
 * A lean coin has no local daemon, so C3.5's descriptor import has nothing to
 * import into — but the engine in that mode holds the wallet itself, and which
 * wallet it is comes down to the key it was initialised from. Giving it the
 * account the wallet already uses collapses two wallets into one: no deposit
 * address, no sweep-back, no on-chain hop, no split custody.
 *
 * Requires an engine carrying `upstream/patches/0003`–`0004`; against an
 * unpatched runtime this rejects with a message naming the patches rather than
 * appearing to succeed.
 *
 * ## The check that matters
 *
 * Every push returns the deposit address the ENGINE derived, and the backend
 * compares it against `expectedAddress`. `shared: false` with an `error` means
 * the engine stood up a wallet nobody intended — the one failure mode this
 * mechanism must not have, and the reason the address is round-tripped instead
 * of assumed.
 *
 * Idempotent: the engine holds keys in memory only, so this runs on every
 * session after the vault unlocks.
 */
export function swapSidecarPushAccountKeys(
  keys: AccountKeyPush[],
): Promise<AccountKeyOutcome[]> {
  return invoke<AccountKeyOutcome[]>("swap_sidecar_push_account_keys", { keys });
}

/**
 * C8 — record (or withdraw) consent for one coin's lean wallet to use the
 * wallet's own account keys.
 *
 * **Enabling a coin is not consent to this.** Enabling says "sync this chain";
 * sharing keys is a different question with a different cost — the chosen
 * ElectrumX servers can then see that account's addresses, balance and
 * history. `DEX_COINS_LIGHT_PRIVACY_NOTE` is the copy that must be on screen
 * before this is called.
 *
 * Takes effect on the next node start, and arming it is what makes the engine
 * refuse to build that wallet from its own seed in the meantime — so the
 * ordering "consent, then start, then push" has no window in which the engine
 * could quietly create a different wallet.
 *
 * Rejects for a coin with no light mode: there is nothing to consent to, since
 * a full-mode coin adopts by descriptor import instead.
 */
export function swapSidecarSetShareWallet(
  coin: string,
  share: boolean,
): Promise<OptInRecord> {
  return invoke<OptInRecord>("swap_sidecar_set_share_wallet", { coin, share });
}

/**
 * C9 — record (or withdraw) consent to point the swap engine's Monero wallet
 * at this app's own `monero-wallet-rpc`.
 *
 * **Deliberately not {@link swapSidecarSetShareWallet}.** The two consents
 * authorise mechanistically different things — that one hands the engine an
 * account key so its own lean wallet becomes the user's; this one repoints
 * the engine at a wallet-rpc *process* the app already runs, with per-swap
 * wallets kept on the engine's own second client. Reusing one flag for both
 * would let the same toggle mean two different security properties depending
 * on which coin it's read for.
 *
 * Refuses for every coin except `"monero"`.
 */
export function swapSidecarSetXmrHostWallet(
  coin: string,
  share: boolean,
): Promise<OptInRecord> {
  return invoke<OptInRecord>("swap_sidecar_set_xmr_host_wallet", {
    coin,
    share,
  });
}

/**
 * C9 — is a swap actively using the shared Monero wallet right now?
 *
 * `true` means Lock Wallet / Forget Monero must refuse and explain why,
 * rather than tearing down a wallet-rpc the swap engine is depending on.
 * `false` covers both "nothing to protect" (not consented, or the swap node
 * is not running) and "consented and running, but no XMR bid is in flight" —
 * the caller does not need to tell those apart, only whether it may proceed.
 *
 * Read-only: never tears anything down itself.
 */
export function swapSidecarXmrSharedInUse(): Promise<boolean> {
  return invoke<boolean>("swap_sidecar_xmr_shared_in_use");
}

/** The two CryptoNote followers that share a host wallet PROCESS with the
 *  swap engine (Grove expansion plan, units C-RZ / C-RX). */
export type CnHostWalletCoin = "zephyr" | "zano";

/**
 * C-RZ / C-RX — record (or withdraw) consent to point the swap engine's
 * Zephyr main wallet at this app's own `zephyr-wallet-rpc`, or to run Zano's
 * engine-owned SCRATCH `simplewallet` beside the app's own Main.
 *
 * The ZEPH/ZANO twin of {@link swapSidecarSetXmrHostWallet}, and deliberately
 * a separate command for the same reason that one is separate from
 * {@link swapSidecarSetShareWallet}: three consents, three mechanisms, and a
 * single flag would mean three different security properties depending on
 * which coin read it. Refuses every other coin.
 *
 * Takes effect on the next node start (the engine reads its config once).
 */
export function swapSidecarSetCnHostWallet(
  coin: CnHostWalletCoin,
  share: boolean,
): Promise<OptInRecord> {
  return invoke<OptInRecord>("swap_sidecar_set_cn_host_wallet", { coin, share });
}

/**
 * C-RZ / C-RX — is a swap actively using the shared ZEPH or ZANO wallet right
 * now? Twin of {@link swapSidecarXmrSharedInUse}; same fail-closed rule.
 */
export function swapSidecarCnSharedInUse(coin: CnHostWalletCoin): Promise<boolean> {
  return invoke<boolean>("swap_sidecar_cn_shared_in_use", { coin });
}

/**
 * C8 — send FROM a coin's shared wallet, through the engine.
 *
 * Only reachable for a coin the backend has VERIFIED as shared
 * (`adoption === "accountkey"`) — the engine refuses every other coin before
 * opening a socket, and separately refuses if the engine has any bid in
 * flight for that coin (draining the wallet it needs to fund a lock would
 * abort the swap).
 *
 * This is an ordinary send: an arbitrary destination and amount, exactly like
 * every other chain's Send flow in this wallet. It differs from
 * {@link swapSidecarPushAccountKeys} in kind — that pushes KEYS once at setup;
 * this moves COIN, every time the user sends.
 *
 * Resolves with the transaction id.
 */
export function swapSidecarSharedCoinWithdraw(
  coin: string,
  address: string,
  amount: string,
): Promise<string> {
  return invoke<string>("swap_bridge_shared_coin_withdraw", {
    coin,
    address,
    amount,
  });
}

/**
 * Add every enabled-but-unconfigured coin to the swap node.
 *
 * **Restarts the node**, and cannot avoid it: `--addcoin` starts its own
 * particl daemon to seed the new coin's wallet, and a running node already
 * holds that port. So the choice is whether the app performs the restart or
 * asks the user to — this performs it.
 *
 * Refuses while any swap is in flight (a restart drops the process watching
 * timelocks) and fails closed if it cannot read the bid list. Resolves with
 * the coins actually added.
 */
export function swapSidecarApplyPendingCoins(): Promise<string[]> {
  return invoke<string[]>("swap_sidecar_apply_pending_coins");
}

/** Effective per-coin state: opt-in record joined with what is actually on
 *  disk and seeded. This — not the store mirror — is the authority. */
export function swapSidecarCoinStatus(): Promise<CoinEnableStatus[]> {
  return invoke<CoinEnableStatus[]>("swap_sidecar_coin_status");
}

/** One coin's chain-sync progress, read DIRECTLY from its daemon. */
export interface ChainSync {
  /** Engine coin name, lowercase. */
  coin: string;
  /** UPPERCASE ticker — the key to join on. */
  ticker: string;
  blocks: number;
  headers: number;
  /** Percent, `100 * verificationprogress`. Use WITH {@link blocks} — a chain
   *  with no blocks reports 100% verified. */
  verifiedPct: number;
  /** This coin's daemon was momentarily unreachable (a flush stall). Isolated
   *  to this row; the others are unaffected. */
  error: string | null;
}

/**
 * Per-coin chain progress, straight from the managed daemons.
 *
 * This exists because `/json/wallets` — the balance endpoint — aggregates
 * across every coin under one server-side timeout and returns `error: Timeout`
 * for ALL of them under IBD load (measured: 10s, all coins). A daemon's own
 * `getblockchaininfo` is a local read that answers in milliseconds even
 * mid-sync, so THIS is the source for a sync bar; balances stay on
 * `/json/wallets`. Only bitcoin-family local daemons appear — a remote-XMR or
 * light coin has no local chain to report, which is correct.
 */
export function swapSidecarChainSync(): Promise<ChainSync[]> {
  return invoke<ChainSync[]>("swap_sidecar_chain_sync");
}

/**
 * Ask whether the wallet may spend this coin right now. See
 * {@link SelectionGate} for why a failure to answer is itself an answer.
 *
 * Invoke args: `{ coin }`.
 */
export function swapSidecarSelectionGate(coin: string): Promise<SelectionGate> {
  return invoke<SelectionGate>("swap_sidecar_selection_gate", { coin });
}

// ── C3.5: descriptor import ──────────────────────────────────────────

/**
 * The encrypted vault blob, as Rust's `swap::keystore::EncryptedVault` expects
 * it. Structurally identical to `src/crypto.ts`'s `EncryptedData`, aliased here
 * so the contract's name resolves without a second definition drifting from it.
 */
export type EncryptedVault = EncryptedData;

/**
 * What C3.5 actually imported.
 *
 * `imported` carries **branch labels only** — `"bip84-external"`,
 * `"bip44-internal"`. It never carries a descriptor string, because a
 * descriptor built from an account xprv *is* a spending key and this struct is
 * serialized to the webview (contract §R16).
 */
export interface DescriptorImportReport {
  coin: string;
  /** The `_rpc_wallet` the import targeted. */
  walletName: string;
  /** Branch labels, e.g. `["bip84-external", "bip84-internal"]`. */
  imported: string[];
  method: "importdescriptors" | "importmulti";
  warnings: string[];
}

/**
 * Import the user's own account descriptors into the swap node's wallet, so
 * the node can spend funds that are already there without moving them first.
 *
 * # What crosses this boundary, and what never does
 *
 * The **encrypted** vault and the password cross. The decrypted mnemonic and
 * the derived account xprv are produced *inside Rust*
 * (`swap::derive::derive_xpriv`) and never come back — there is deliberately no
 * TS helper for account-xprv derivation anywhere in this codebase, and adding
 * one would defeat the arrangement rather than complement it.
 *
 * # The four refusals (all hard errors, not warnings)
 *
 * 1. C5 wallet encryption is not configured, or `getwalletinfo` does not prove
 *    the wallet unlocked. Importing spending keys into a wallet file that is
 *    not encrypted at rest is the single largest key-handling expansion in the
 *    plan (§R10); the encryption is its only protection.
 * 2. `firstSyncStarted` is already true (§R12) — a post-sync import on a pruned
 *    node reports success and finds nothing.
 * 3. The coin has no adoption plan.
 * 4. The derived material is not an *account*-level key.
 *
 * `birthdayUnix` becomes the descriptors' `timestamp`; omitted means `0`
 * (rescan from genesis). It is **never** `"now"` — `"now"` would skip the
 * user's entire history, which is the one thing the import exists to find.
 *
 * `rangeEnd` is only meaningful for the ranged `importmulti` path (BCH).
 *
 * Invoke args: `{ coin, encrypted, password, birthdayUnix, rangeEnd }`.
 */
export function swapSidecarImportDescriptors(a: {
  coin: string;
  encrypted: EncryptedVault;
  password: string;
  birthdayUnix?: number;
  rangeEnd?: number;
}): Promise<DescriptorImportReport> {
  return invoke<DescriptorImportReport>("swap_sidecar_import_descriptors", {
    coin: a.coin,
    encrypted: a.encrypted,
    password: a.password,
    birthdayUnix: a.birthdayUnix,
    rangeEnd: a.rangeEnd,
  });
}

// ── C4 / C6: destination-pinned sweep-back ───────────────────────────

/**
 * A prepared sweep from the swap node back to the user's own wallet.
 *
 * **`destination` is an output, never an input.** It is derived Rust-side from
 * the unlocked vault session — `swap::derive::utxo_address` for the UTXO
 * family, the XMR wallet-rpc's own `get_address` for Monero. No command in this
 * file accepts a destination address, and adding a parameter that did would
 * break the §R13 test at compile time. That is the whole security argument for
 * C4: a compromised renderer cannot name where the money goes.
 *
 * The token is single-use with a **120 s** TTL.
 */
export interface SweepPlan {
  /** 32 random bytes, hex. Single-use, consumed by {@link executeSweep}. */
  token: string;
  coin: string;
  /** Derived Rust-side from the vault session. Display it; never supply it. */
  destination: string;
  /** Decimal string for the bitcoin family; `null` when `sweepall`. */
  amount: string | null;
  /** XMR family sweeps everything (`sweepall: true`). */
  sweepall: boolean;
  /** RFC3339. Past this, `executeSweep` refuses. */
  expiresAt: string;
}

/**
 * Derive the destination and reserve a token. Reads only — nothing moves.
 *
 * Refuses rather than falling back when the destination cannot be derived
 * (XMR wallet-rpc down, unknown coin). A fallback here would mean accepting an
 * address from somewhere less trustworthy than the vault, which is exactly the
 * attack C4 is shaped to prevent.
 *
 * Invoke args: `{ sessionId, coin }`.
 */
export function prepareSweep(a: {
  sessionId: string;
  coin: string;
}): Promise<SweepPlan> {
  return invoke<SweepPlan>("swap_bridge_prepare_sweep", {
    sessionId: a.sessionId,
    coin: a.coin,
  });
}

/**
 * Spend the token and perform the withdrawal. Resolves to the txid.
 *
 * `confirmPhrase` must equal the **last 6 characters of the plan's
 * destination**, typed by the user against the plan card. There is no dialog
 * plugin in this app, so this is the mandatory confirmation step, not a
 * nicety — see `confirmPhraseFor` in `features/swap-sidecar/sweepBack.ts` for
 * the client-side mirror, and note that Rust checks it independently.
 *
 * Invoke args: `{ token, confirmPhrase }`.
 */
export function executeSweep(a: {
  token: string;
  confirmPhrase: string;
}): Promise<string> {
  return invoke<string>("swap_bridge_execute_sweep", {
    token: a.token,
    confirmPhrase: a.confirmPhrase,
  });
}

/**
 * A fresh deposit address for the node's own wallet (C6 — an XMR subaddress).
 *
 * Reaches the engine's `wallets/<TICKER>/nextdepositaddr` through the
 * **privileged Rust-only** path (`swap_bridge::api_post_privileged`), which
 * asserts a literal path. The webview allow-list is unchanged and still refuses
 * `nextdepositaddr` — that refusal is re-asserted by a standing test every
 * phase (§R15). Do not "simplify" this by allow-listing the endpoint.
 *
 * Invoke args: `{ ticker }`.
 */
export function nextDepositAddr(ticker: string): Promise<string> {
  return invoke<string>("swap_bridge_next_deposit_addr", { ticker });
}

// =========================================================================
// Sidecar interface fee — READ-ONLY
// =========================================================================

/**
 * The fee's whole TypeScript surface is **display only**, and that is a design
 * constraint rather than an omission.
 *
 * The Rust watcher detects settlement and issues the payment as a *consequence*
 * of detecting it. There is deliberately NO command here that triggers, retries
 * or cancels a collection — a Rust `settle_fee()` invoked from TS would be
 * defeated by patching this file, which is the easier half of the binary. See
 * `src-tauri/src/sidecar_fees/mod.rs` and its `no_command_can_trigger_settlement`
 * test, which fails the build if a command named settle/collect/pay/charge ever
 * appears.
 *
 * Published schedule and rationale: `FEE.md`.
 */
export type SidecarFeeMode = "off" | "dark" | "live";

export interface SidecarFeeCoinInfo {
  ticker: string;
  address: string;
  /** Flat floor in atomic units (1e-8). */
  flatAtomic: number;
  /** The same floor as a decimal string. */
  flat: string;
  /** USD price the floor was derived from — lets a reader check the maths. */
  priceUsdAtDerivation: number;
}

export interface SidecarFeesStatus {
  mode: SidecarFeeMode;
  /** Swaps still being watched. */
  open: number;
  /** Priced by a dark run but deliberately not collected. */
  observed: number;
  paid: number;
  deferred: number;
  /** Interrupted mid-payment. NEVER retried automatically — needs a human. */
  indeterminate: number;
  /** Records that can never change again. */
  closed: number;
  /** Unreadable records. Non-zero means collection is halted until reconciled. */
  unreadable: number;
  coins: SidecarFeeCoinInfo[];
  rateBps: number;
}

/** One swap's fee record. `state` is the serde tag of the Rust enum. */
export interface SidecarFeeRecord {
  bidId: string;
  state:
    | "watching"
    | "noFee"
    | "observed"
    | "attempting"
    | "paid"
    | "indeterminate"
    | "deferred";
  ticker?: string;
  amount?: number;
  notional?: number;
  txid?: string;
  at?: string;
  reason?: string;
  note?: string;
  detail?: string;
}

/** What a swap of this size WOULD cost. Never moves money. */
export type SidecarFeeQuote =
  | { kind: "charge"; ticker: string; amount: number; address: string; notional: number }
  | { kind: "skip"; reason: string };

/**
 * How much of a balance to hold back so a completed swap can still pay its
 * fee. Returns a decimal string in the coin's own units — `"0"` when this
 * coin, or this size, is not chargeable.
 *
 * Display/arithmetic only: it moves nothing and decides nothing. The charge
 * itself is decided by the Rust watcher after the swap completes, from the
 * same schedule (`engine::reserve_for_sale` mirrors `engine::decide`'s
 * branch deliberately, so the two cannot disagree).
 *
 * Wired to MAX on the peer-to-peer route (2026-09-05). Without it, selling
 * the whole scripted balance left nothing to collect from: the record
 * deferred for forty passes and then expired as `deferredExpired`, which is
 * a fee silently never taken rather than a fee waived.
 */
export function sidecarFeesReserve(
  ticker: string,
  balance: string,
): Promise<string> {
  return invoke<string>("sidecar_fees_reserve", { ticker, balance });
}


export function sidecarFeesStatus(): Promise<SidecarFeesStatus> {
  return invoke<SidecarFeesStatus>("sidecar_fees_status");
}

export function sidecarFeesHistory(): Promise<SidecarFeeRecord[]> {
  return invoke<SidecarFeeRecord[]>("sidecar_fees_history");
}

export function sidecarFeesQuote(
  ticker: string,
  amount: string
): Promise<SidecarFeeQuote> {
  return invoke<SidecarFeeQuote>("sidecar_fees_quote", { ticker, amount });
}
