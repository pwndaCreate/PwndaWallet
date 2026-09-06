/**
 * C8's authority switch — the wallet dashboard's half.
 *
 * # The gap this closes
 *
 * A lean coin's wallet lives inside the engine (`WalletManager` derives BIP84,
 * signs, tracks UTXOs; ElectrumX supplies only chain data). Once a coin is
 * VERIFIED shared (`adoption === "accountkey"`), the engine holds the
 * **complete account** — both derivation branches, every UTXO — while this
 * wallet's own adapter (`btc-wallet.ts` / `ltc-wallet.ts`) still reads only
 * index-0's single address. The moment the engine spends, change lands on the
 * internal branch and new deposits may land past index 0; the adapter's
 * balance silently becomes a shrinking subset of the truth.
 *
 * [[pwnda-basicswap-convergence-plan]] § C8 step 21 names the fix: **one
 * selector per keyset**, and for a shared coin that selector is the engine.
 * This module is the display half of that rule — the wallet dashboard must
 * show the engine's number for a shared coin, not the adapter's.
 *
 * # Why this is a pure merge function, not a fetch
 *
 * The actual network read is `fetchWallets()` (already built, already used by
 * `useSidecarBalances`) — reusing it rather than adding a second wallets
 * endpoint. What is NEW here is the DECISION of which chains' displayed
 * balance to override and with what, which has to be exhaustively testable on
 * its own: getting this wrong either hides real funds (shows the adapter's
 * stale subset) or invents funds (applies an engine balance to a coin that was
 * never actually verified shared).
 */
import type { CoinEnableStatus } from "../../api/basicswap";

// Plain strings, not `ChainType`, throughout this module — BOUNDARIES.md
// scopes swap-sidecar's allowed imports to `src/wallets/{usd-prices,coin-metadata}`
// and does not include `src/wallets/types`. The mining feature sets the same
// precedent (`addressFor: (coin) => string | null`, never a
// `Record<ChainType, WalletInfo>` hook input) — a feature boundary is crossed
// with a string key, and the caller (App.tsx, which owns `ChainType`) narrows
// at its own edge.

/** UPPERCASE ticker → the chain key (a `ChainType` value, kept as a plain
 *  string at this boundary) that `balancesByChain` is keyed by. Deliberately
 *  narrow: exactly the coins C8 can share — the `ELECTRUM_CAPABLE` set in
 *  `swap_sidecar.rs`. Extending this table is exactly how another coin's
 *  balance authority would silently switch, so it must stay a closed,
 *  reviewed list that mirrors that Rust table by hand.
 *
 *  BCH joined 2026-09-04: `bitcoincash` has been `ELECTRUM_CAPABLE` (and so
 *  C8-admissible via `adoption_coins`) since Phase C unit C-R0, but this
 *  table and `App.tsx`'s two gates still said "BTC/LTC only", so a verified-
 *  shared BCH account would have kept showing the adapter's own reading —
 *  the same stale-subset number C8's authority switch exists to replace. */
export const SHARED_COIN_CHAINS: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
};

/** Which of `balancesByChain`'s keys are eligible for the engine to author.
 *  Pure lookup — no I/O — so it can be asserted against a hand-built status
 *  list without touching the network. */
export function sharedChains(): readonly string[] {
  return Object.values(SHARED_COIN_CHAINS);
}

/** Is `chain` one the engine can author the balance for? The App-side gate
 *  used to be two hardcoded `=== "bitcoin" || === "litecoin"` checks, which
 *  is how BCH's admission to `ELECTRUM_CAPABLE` went unreflected here for a
 *  day — one table, one predicate. */
export function isSharedCoinChain(chain: string): boolean {
  return Object.values(SHARED_COIN_CHAINS).includes(chain);
}

/**
 * Tickers that are VERIFIED shared — the engine's own derived address already
 * matched this wallet's, at push time.
 *
 * Deliberately checks `adoption === "accountkey"`, not
 * `shareWalletAck` (consent). Consent means a push was attempted; only
 * verified adoption means it landed. Rendering the engine's balance for a
 * merely-consented coin would show a number that might belong to nobody's
 * wallet — the same distinction `coin_is_verified_shared` enforces
 * Rust-side for the send path, and it must hold on the read path too.
 */
export function verifiedSharedTickers(
  statuses: readonly CoinEnableStatus[] | null,
): string[] {
  if (!statuses) return [];
  return statuses
    .filter(
      (s) =>
        s.adoption === "accountkey" &&
        Object.prototype.hasOwnProperty.call(SHARED_COIN_CHAINS, s.ticker),
    )
    .map((s) => s.ticker);
}

/** One shared coin's authoritative reading. */
export interface SharedCoinBalance {
  ticker: string;
  /** A `ChainType` value, kept as `string` at this module boundary. */
  chain: string;
  /** Decimal string, or null when the engine reported nothing readable for
   *  this coin (row-level fault — see `fetchWallets`'s own contract). A null
   *  here means "show the honest absence", never "fall back silently to the
   *  adapter's stale number" — see {@link applySharedCoinBalances}. */
  balance: string | null;
}

/**
 * Merge verified-shared engine balances into a `balancesByChain`-shaped map.
 *
 * @param existing   the map App.tsx already populated from each chain's own
 *                    adapter — untouched for every chain not in `overrides`.
 * @param overrides   this refresh's shared-coin readings. Only tickers here
 *                    can change anything; an empty array is a no-op.
 *
 * **Reversed 2026-08-22 — the engine's reading is authoritative only when it
 * is READY.** This used to say "absence is not silence": a `null` engine
 * balance overrode the adapter's figure with `"—"`, on the theory that a
 * stale subset is worse than honest absence. Live use proved the opposite
 * failure far more common: on every start the engine's BTC/LTC wallets spend
 * their first minute not yet initialised from the account key (the console
 * shows `Expected Seed: False`, balance `0.0`), and a 4-second engine timeout
 * is routine — and both blanked or zeroed a reading the adapter had right.
 * The operator saw `0 LTC` over a real ~4 LTC. So:
 *
 *  - `null` (engine unreachable / row not ready) **keeps** a numeric adapter
 *    value; `"—"` only when there was never one.
 *  - Otherwise, **take whichever of engine/adapter is numerically larger.**
 *
 * **Reversed AGAIN, 2026-08-23 — "the engine wins whenever nonzero" assumed
 * the engine's view could only ever be MORE complete than the adapter's.**
 * That was true when this file was written: the adapter read index-0 only.
 * It stopped being true the moment [[utxo-account-scanning]] shipped the
 * same day — the adapter now scans the whole account too (both chains, gap
 * limit 40), so it can independently discover funds the engine's own
 * bookkeeping hasn't recorded. Confirmed live: the dashboard showed
 * `0.00823047 LTC` (the engine's figure, nonzero, so it used to win
 * unconditionally) while the account-scan panel on the SAME page showed
 * `4.03711096 LTC` at the same seed's addresses — a real, independently-
 * verified on-chain balance the engine's own `/json/wallets` simply never
 * counted. Traced to source: `WalletManager.getCachedTotalBalance`
 * (`wallet_manager.py`) sums `cached_balance` over rows already in the
 * engine's own `wallet_addresses` table; nothing forces that table to stay
 * complete relative to the chain, and the engine's only rescan command
 * (`rescanWalletAddresses` → `runMigration`) is capped at the standard
 * 20-address default and can never even discover an address past that —
 * the same class of gap-limit bug [[utxo-account-scanning]] already fixed
 * on the adapter side, now confirmed on the engine's side too. Full trace:
 * `PwndaWalletVault/log.md`, 2026-08-23.
 *
 * **Why "take the max" is safe, not just convenient.** Both sides read the
 * SAME real blockchain — the adapter's account scan cannot invent a balance
 * that isn't genuinely there, it can only discover funds a DIFFERENT
 * bookkeeping table missed. The failure mode this averts (engine
 * under-counts real funds, permanently, with no self-correction) is
 * strictly worse than the failure mode it risks (adapter briefly shows a
 * balance the engine hasn't caught up to after a very recent spend) —
 * and the adapter's own cheap-path re-probe (`resolveUtxoAccountBalance`,
 * re-checks every KNOWN address on every load) self-corrects that second
 * case within one refresh, whereas nothing self-corrects the first.
 *
 * Readiness itself is decided in `readSharedBalance` (locked / not on the
 * user's seed → `null`), so `fetchSharedCoinOverrides` needs no new logic.
 */
export function applySharedCoinBalances(
  existing: Readonly<Partial<Record<string, string>>>,
  overrides: readonly SharedCoinBalance[],
): Partial<Record<string, string>> {
  if (overrides.length === 0) return { ...existing };
  const merged: Partial<Record<string, string>> = { ...existing };
  for (const o of overrides) {
    const prev = existing[o.chain];
    if (o.balance == null) {
      merged[o.chain] = numeric(prev) != null ? (prev as string) : "—";
      continue;
    }
    const engine = numeric(o.balance);
    const mine = numeric(prev);
    if (mine != null && engine != null && mine > engine) {
      merged[o.chain] = prev as string;
      continue;
    }
    merged[o.chain] = o.balance;
  }
  return merged;
}

/** Parse a balance string, or `null` for anything that is not a plain number
 *  ("—", "Syncing…", an error message, empty). Local on purpose: this module
 *  must stay free of wallet-layer imports. */
function numeric(s: string | undefined | null): number | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read one ticker's balance out of a `fetchWallets()` body.
 *
 * Row-level faults (`{name, error}` per coin — see `fetchWallets`'s own
 * contract) and a missing/malformed entry both resolve to `null`, never to a
 * thrown exception: a single unreadable coin must not prevent the OTHER
 * shared coin's balance from rendering.
 */
export function readSharedBalance(
  wallets: Record<
    string,
    { balance?: string; error?: string; locked?: boolean; expected_seed?: boolean }
  > | null,
  ticker: string,
): string | null {
  if (!wallets) return null;
  const row = wallets[ticker];
  if (!row || row.error) return null;
  // Readiness (2026-08-22). A LOCKED wallet cannot have scanned, and a wallet
  // whose `expected_seed` is explicitly false is not yet the user's wallet
  // at all — it is the engine's own lean wallet before the account-key push
  // landed, and its balance is a true statement about the wrong keys. Either
  // reading, taken as authoritative, is the bug the operator hit live
  // (`0 LTC` over a real ~4 LTC). `undefined` stays permissive: older engine
  // rows and test fixtures do not carry the field.
  if (row.locked === true) return null;
  if (row.expected_seed === false) return null;
  const balance = row.balance;
  return typeof balance === "string" && balance.trim() !== "" ? balance : null;
}
