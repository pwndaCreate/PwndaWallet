/**
 * The swap node's Monero wallet, as it appears in the **XMR wallet surface**
 * (contract C6, UI side).
 *
 * `DexXmrWalletCard` lives in `features/swap-sidecar/` and is owned by the API
 * workstream. This module holds the mount's own decisions — the ones that
 * would otherwise be unverifiable JSX — plus the two sentences that make the
 * card safe to put next to the vault's own Monero panel.
 *
 * # Why a second Monero wallet needs its own copy
 *
 * The user is looking at a screen that already says "Monero" and shows a
 * balance. Adding a second Monero balance a few centimetres away, with no
 * statement of what it is, produces exactly one outcome: the two get added
 * together in the user's head, or the wrong one gets treated as spendable.
 * So the mount states both facts explicitly:
 *
 *  1. **It is not your wallet's XMR.** Different seed, different address, not
 *     part of the wallet total shown above it.
 *  2. **It can only SEND while the swap node is running.** Receiving is a
 *     chain event and happens regardless; spending goes through the node's
 *     wallet-rpc, so with the node stopped the balance is visible and immobile.
 *     That asymmetry is the single most surprising property of this wallet and
 *     is the reason the caveat is mandatory rather than a tooltip.
 *
 * # What this module deliberately does not do
 *
 * It never invents a "reserved for swaps" figure. No endpoint reports XMR
 * committed to live bids (`spendableXmr` takes `reserved` from its caller for
 * exactly that reason), so the mount passes `null` and the card prints
 * "unknown". A plausible-looking zero would be a fabricated number on a
 * fund-moving surface.
 */
import type { SidecarBalanceRow } from "../swap-sidecar";

/** What the card is, said next to the wallet's own Monero panel. */
export const DEX_XMR_DISTINCT_NOTE =
  `This is the swap node's own Monero wallet, not the one in your vault. It ` +
  `has its own seed and its own address, and its balance is not part of your ` +
  `wallet's XMR total.`;

/**
 * The honest caveat. Send is node-dependent; receive is not.
 *
 * Stated as "cannot be moved", not "unavailable" — the balance is still
 * visible and still yours, which is precisely why "unavailable" would read as
 * a bug rather than as a consequence of stopping the node.
 */
export const DEX_XMR_SEND_CAVEAT =
  `It can only send while the swap node is running. Deposits still arrive ` +
  `when the node is stopped, but nothing can be moved out of it until the ` +
  `node is started again.`;

/**
 * C9 — the offer, shown when the user has not yet consented.
 *
 * Updated 2026-08-21: now promises "the next swap-node start", the same
 * pattern C8's lean-coin copy (`DexCoinCard.tsx`) already uses — and for
 * the same reason it's now honest: `maybe_activate_xmr_host_wallet` runs
 * inside `swap_sidecar_start`, before the config write, on every start.
 * Consenting now genuinely takes effect the next time the node starts,
 * exactly like it says.
 *
 * Still can't promise MORE than that, and this is deliberate, not a
 * remaining gap in the copy: activation itself can still silently not
 * happen (an unpatched engine, a wallet-rpc that fails to start) — see
 * `maybe_activate_xmr_host_wallet`'s doc comment for why that's a fail-open
 * design, not a bug — so the copy promises "will use", not "now uses".
 * Whether it actually took is what `DexXmrWalletCard`'s own balance/address
 * display already answers, the same way it does for BTC/LTC.
 */
export const DEX_XMR_HOST_WALLET_OFFER =
  `You can also ask the swap node to use YOUR Monero wallet directly, instead ` +
  `of keeping a separate one. Turning this on will use your existing wallet ` +
  `once the swap node next starts — no deposit, no separate balance to fund.`;

/** C9 — shown once consent is recorded. Mirrors the offer's honesty
 *  boundary: says WHEN activation happens (next start), not that it has
 *  already happened — the node may not be running right now to restart. */
export const DEX_XMR_HOST_WALLET_RECORDED =
  `Recorded — the swap node will use your own Monero wallet once it next ` +
  `starts. Until then it keeps its own separate wallet, exactly as before.`;

/** The one line to show beside the C9 toggle, chosen by consent state. */
export function xmrHostWalletCopy(ack: boolean): string {
  return ack ? DEX_XMR_HOST_WALLET_RECORDED : DEX_XMR_HOST_WALLET_OFFER;
}

/**
 * Minimal `/json/wallets` entry shape the card reads.
 *
 * Declared locally rather than imported so this module carries no dependency
 * on the engine-JSON types; every field is optional in `BasicSwapWalletInfo`,
 * so this is structurally assignable to it.
 *
 * **snake_case on purpose** — contract §0.1: engine-JSON payloads keep their
 * upstream casing, and `deposit_address` is an engine field. camelCasing it
 * here would silently produce a card with no address.
 */
export interface DexXmrWalletInfo {
  balance?: string;
  unconfirmed?: string;
  deposit_address?: string;
  locked?: boolean;
  error?: string;
}

/**
 * Is there a DEX Monero wallet WORTH ASKING ABOUT?
 *
 * This is the eligibility gate, not the final show/hide decision — it feeds
 * `useXmrHostWalletConsent`'s own `enabled` flag, since that hook needs a
 * signal that does not depend on its own result. `DexXmrWalletSection` ANDs
 * this with `!hostWallet.active`: once C9 sharing is CONFIRMED, the node's
 * wallet and this wallet are the same account, and there is nothing left to
 * show separately even though this function would still say yes.
 *
 * Fails closed twice over: not opted in (including the `null` in-flight read)
 * ⇒ no, and no `swap_sidecar_*` invoke was issued to produce `row` either; no
 * XMR row ⇒ no, which also covers "the node is not running", since
 * `useSidecarBalances` clears its rows on `SIDECAR_NOT_RUNNING`.
 */
export function dexXmrVisible(
  optedIn: boolean | null | undefined,
  row: SidecarBalanceRow | null | undefined,
): boolean {
  return optedIn === true && row != null;
}

/**
 * Adapt the normalized balances row back into the engine-JSON shape the card
 * expects.
 *
 * `rotated` wins over the polled address when present. That is not cosmetic:
 * `DexXmrWalletCard` renders `displayAddress(null, info)`, so it never sees the
 * hook's own `rotated` value — without threading it through `info` here, the
 * "New address" button would call `nextdepositaddr`, succeed, and change
 * nothing on screen, which reads as a dead button and invites the user to
 * press it repeatedly (each press derives another subaddress).
 *
 * `depositAddress` is already `null` for upstream's placeholder strings (§R18)
 * and is passed through as such — this function must not resurrect them.
 */
export function walletInfoFromRow(
  row: SidecarBalanceRow | null | undefined,
  rotated?: string | null,
): DexXmrWalletInfo | null {
  if (!row) return null;
  const address = rotated ?? row.depositAddress;
  return {
    balance: row.balance ?? undefined,
    unconfirmed: row.pending ?? undefined,
    deposit_address: address ?? undefined,
    locked: row.locked,
    error: row.error ?? undefined,
  };
}
