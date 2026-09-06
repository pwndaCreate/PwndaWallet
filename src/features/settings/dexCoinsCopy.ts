/**
 * Settings-side decisions for the **DEX COINS** section (contract C3, wave 4).
 *
 * `DexCoinCard` itself lives in `features/swap-sidecar/` and is owned by the
 * API workstream: it renders one row per coin and states the per-row facts
 * (adoption story, disk estimate, "disabled keeps the config"). What it does
 * **not** carry — because a per-row line is the wrong place for it — is the
 * section-level honest cost of turning any of this on. That copy lives here,
 * as constants, so it can be asserted by a test instead of drifting inside a
 * JSX blob.
 *
 * Three decisions, all pure, all testable:
 *
 *  1. **P1 — a user who does not swap sees no change at all.** The section is
 *     rendered only when the swap-sidecar opt-in flag reads `true`. `null`
 *     (the read is still in flight) is NOT enabled — same rule the balances
 *     hook uses, and the reason it matters is that `useCoinStatuses` invokes
 *     `swap_sidecar_coin_status` the moment it is handed `enabled: true`, and
 *     the fresh-install contract is that nothing invokes a `swap_sidecar_*`
 *     command before opt-in.
 *
 *  2. **The honest cost is stated before the Enable button, not after.** A
 *     pruned node is 5–7 GB per coin *plus* an initial sync that has to finish
 *     before that coin can trade at all. The disk figure alone reads like a
 *     one-off download; the sync is the part that makes "enable" not mean
 *     "usable in a minute".
 *
 *  3. **The zero-move sentence is conditional, because the claim is
 *     per-coin.** Descriptor adoption is what makes an existing balance
 *     spendable by the swap node, and it is measured per coin (BCH has no
 *     `importdescriptors` at all). Printing "your existing funds become
 *     spendable" when no listed coin can actually do it would be inventing a
 *     capability, so {@link zeroMoveNoteApplies} gates it on the statuses the
 *     backend actually reported.
 */
import type { CoinEnableStatus } from "../../api/basicswap";

/** Pruned-node disk cost per coin, in GB — the range quoted in the section
 *  copy. Kept as numbers so the sentence and any future per-coin estimate
 *  cannot disagree about what was promised. */
export const DEX_COIN_PRUNED_DISK_LOW_GB = 5;
export const DEX_COIN_PRUNED_DISK_HIGH_GB = 7;

/**
 * The cost of enabling a coin, stated before the toggle.
 *
 * Names both halves deliberately: the disk figure AND the initial sync. Only
 * one of them is visible on the row (`estDiskGb`), and the sync is the one
 * that makes the coin unusable for hours after the button is clicked.
 *
 * # "Each coin runs its own pruned node" stopped being true
 *
 * It was, until BTC and LTC gained a Light mode that runs no node at all. The
 * Playwright pass caught the section asserting a per-coin node directly above
 * a row reading "no chain stored locally" — a contradiction visible in one
 * screen, and the section note is the one a user reads FIRST, so it was the
 * half that was wrong. A note stating a universal rule has to be re-read every
 * time an exception is added; this one now names the exception.
 *
 * BCH joined the exception 2026-09-03 (Grove expansion plan, BCH light mode
 * over Fulcrum/electrum — `ELECTRUM_CAPABLE` in `swap_sidecar.rs` gained a
 * `bitcoincash` entry). Same rule as above applies to this addition too: a
 * coin gaining Light updates the sentence naming the exception, not a
 * second note bolted on somewhere else that this one would then contradict.
 */
export const DEX_COINS_COST_NOTE =
  `Most coins you enable run their own pruned node: roughly ` +
  `${DEX_COIN_PRUNED_DISK_LOW_GB}–${DEX_COIN_PRUNED_DISK_HIGH_GB} GB of disk ` +
  `per coin, plus an initial sync that has to finish before that coin can ` +
  `trade. Bitcoin, Litecoin and Bitcoin Cash can instead run Light — no ` +
  `chain, no sync, and they use your existing wallet directly. Disabling ` +
  `later keeps the configuration and stops the sync; it does not delete the ` +
  `chain data.`;

/**
 * What Light actually costs in privacy, stated before the choice — not after.
 *
 * # Why this note has to exist
 *
 * Light mode asks public ElectrumX servers about the wallet's addresses; that
 * is how it avoids storing a chain. Before C8 the exposure was small and
 * uninteresting — a handful of addresses belonging to a swap-only pot nobody
 * had funded. Sharing the user's own account changes the size of it: the
 * server is now asked about the addresses holding the user's actual BTC, LTC
 * or BCH, so it can associate that whole cluster and see its balance and
 * history.
 *
 * The operator accepted this trade explicitly, which is exactly why it must be
 * written down rather than assumed: consent that is not visible in the product
 * is not consent for the next user.
 *
 * Two mitigations, both real and both named: routing over Tor hides *who* is
 * asking (the engine's electrum client speaks SOCKS5 natively, with remote
 * DNS), and pointing the engine at a server you run removes the third party
 * altogether. Neither hides the addresses from the server being asked, and the
 * note does not pretend otherwise.
 */
export const DEX_COINS_LIGHT_PRIVACY_NOTE =
  `Light mode has no chain of its own, so it asks public Electrum servers ` +
  `about your addresses. When Light uses your existing wallet, those servers ` +
  `can see that wallet's addresses, balance and history — not your keys, and ` +
  `they can never spend. Routing over Tor hides your IP from them, and you ` +
  `can point the swap node at your own Electrum server instead. A local node ` +
  `(the other mode) asks nobody.`;

/**
 * The one-wallet claim, for coins that are actually sharing.
 *
 * Deliberately says what a user would otherwise go looking for: there is no
 * deposit address to find and no sweep to remember, because there is no second
 * pot. Gated by {@link sharedWalletNoteApplies} on the backend's own report —
 * capability is not the same as state, and claiming a shared wallet that is
 * not shared would send someone to trade funds the node cannot reach.
 */
export const DEX_COINS_SHARED_WALLET_NOTE =
  `Bitcoin, Litecoin and Bitcoin Cash in Light mode trade from your existing ` +
  `wallet — the same coins you already see here. Nothing is sent anywhere ` +
  `to set that up, and there is nothing to sweep back afterwards.`;

/**
 * What zero-move adoption actually means, for the coins that support it.
 *
 * Two facts the user has to have before clicking, and neither is obvious:
 * their existing balance becomes spendable *by the swap node*, and the key
 * import that makes it so is refused until the swap wallet is encrypted.
 */
export const DEX_COINS_ZERO_MOVE_NOTE =
  `Zero-move adoption leaves your existing balance where it is and gives the ` +
  `swap node keys that can spend it. That key import is refused until the ` +
  `swap wallet's encryption is set up, so turn encryption on first.`;

/**
 * Never a claim about counterparties: swaps here are with other people on an
 * open network and pwnda is not one of them. Stated on the section so the
 * per-coin toggles are not read as "listing on an exchange".
 */
export const DEX_COINS_COUNTERPARTY_NOTE =
  `Enabling a coin only lets your own node hold and trade it. Swaps are made ` +
  `directly with other users on an open network — pwnda is never the ` +
  `counterparty and never holds your funds.`;

/**
 * P1 gate. `optedIn` is the tri-state from `useSwapSidecarOptIn()`.
 *
 * Fails closed on `null`: an in-flight read is not consent.
 */
export function dexCoinsSectionVisible(optedIn: boolean | null | undefined): boolean {
  return optedIn === true;
}

/**
 * Does the zero-move sentence apply to anything the backend reported?
 *
 * True only when some coin's adoption is `"descriptor"` — the strategy that
 * hands the node spending keys for funds already on chain. `consolidate` moves
 * the funds instead and `deposit` touches nothing, so neither makes the
 * sentence true.
 */
export function zeroMoveNoteApplies(
  statuses: readonly CoinEnableStatus[] | null | undefined,
): boolean {
  if (!Array.isArray(statuses)) return false;
  return statuses.some((s) => s?.adoption === "descriptor");
}

/**
 * Is any coin actually sharing the wallet's own account right now?
 *
 * True only on `adoption === "accountkey"` — the state the backend records
 * **after** the engine's derived address was checked against the wallet's, not
 * on a coin that merely could share. The distinction is the whole point: a
 * coin whose push failed the address check reads as `deposit` here and must
 * not be described as one wallet.
 */
export function sharedWalletNoteApplies(
  statuses: readonly CoinEnableStatus[] | null | undefined,
): boolean {
  if (!Array.isArray(statuses)) return false;
  return statuses.some((s) => s?.adoption === "accountkey");
}

/**
 * Does the Light privacy note apply to what is on screen?
 *
 * Shown whenever any listed coin *can* run Light — before the choice, not
 * after it, because the note exists to inform the choice. This is the one
 * place where capability rather than state is the right trigger.
 */
export function lightPrivacyNoteApplies(
  statuses: readonly CoinEnableStatus[] | null | undefined,
): boolean {
  if (!Array.isArray(statuses)) return false;
  return statuses.some((s) => s?.canRunLean === true);
}

/** `"2 of 5 enabled"` — a scannable header count. Returns `null` when there is
 *  nothing to count, so the caller renders no header rather than "0 of 0". */
export function dexCoinsSummary(
  statuses: readonly CoinEnableStatus[] | null | undefined,
): string | null {
  if (!Array.isArray(statuses) || statuses.length === 0) return null;
  const on = statuses.filter((s) => s?.enabled === true).length;
  return `${on} of ${statuses.length} enabled`;
}
