/**
 * Pending NEAR Intents rows that nothing could ever settle (2026-10-01).
 *
 * # The operator's report
 *
 *   "Why are two swaps from weeks ago still labeled pending?"
 *
 * Two ETH → BTC rows of 2026-05-06, 23 seconds apart, both "pending" five
 * months later. Rows written before 2026-09-29 carry no deposit address, and
 * 1Click finds a swap only by its deposit address, so neither the resume pass
 * nor the details view could ask about them. Their source hashes are unknown to
 * three Ethereum nodes (eth.drpc.org, ethereum.publicnode.com, 1rpc.io), while
 * the third attempt at the same swap, 76 minutes later, is the address's FIRST
 * mined transaction (nonce 0): the two earlier deposits never reached the chain,
 * no ETH left the wallet, and there was nothing to complete or refund.
 *
 * # What settles such a row
 *
 * Asked once per opened row and once per session at wallet open, for a pending
 * NEAR Intents row with a source hash and no deposit address:
 *
 *  - the deposit is on its chain → its recipient is the deposit address. Stored,
 *    so 1Click can be asked for the real outcome (`intents-status-resume.ts`);
 *  - it is not, the row is older than `NOT_SENT_AFTER_MS`, and the chain's
 *    history sources keep every mined transaction (the EVM and UTXO families) →
 *    the deposit never reached the chain: `failed`, with
 *    `failureReason: "deposit-not-on-chain"`, shown as "Not sent".
 *
 * Anything less certain leaves the row as it is: an unknown hash on a chain
 * whose public nodes prune old transactions (Sui, Solana) proves nothing, and a
 * UTXO deposit whose change cannot be told from the deposit is not guessed at.
 */
import { ASSET_CAPABILITIES } from "./asset-capabilities";
import { swapLegChain, swapRouteOf } from "./swap-details";
import type { SwapHistoryEntry } from "./swap-history-store";
import { readTxParties, type TxPartiesState } from "../../lib/txParties";
import { getUtxoAccountSummaries } from "../../lib/utxoAccountRegistry";
import type { ChainType } from "../../wallets";

/** A deposit not on its chain this long after the swap was recorded was never
 *  mined: dropped from every mempool, or never broadcast. */
export const NOT_SENT_AFTER_MS = 48 * 60 * 60_000;

/** Chain families whose history sources keep every mined transaction, so an
 *  unknown hash means "never mined" (by `chainKind` of the swap asset). */
const DEFINITIVE_KINDS: ReadonlySet<string> = new Set(["EVM", "BTC", "LTC", "DOGE", "BCH", "DASH"]);

export type StaleVerdict =
  | { kind: "not-sent" }
  | { kind: "deposit-address"; depositAddress: string };

/** A pending NEAR Intents row that only its source transaction can settle. */
export function needsSettling(row: SwapHistoryEntry): boolean {
  return (
    row.status === "pending" &&
    !row.depositAddress &&
    !!row.sourceTxHash &&
    swapRouteOf(row) === "intents"
  );
}

function norm(a: string): string {
  return /^0x[0-9a-f]+$/i.test(a) ? a.toLowerCase() : a;
}

/**
 * What the source transaction says about a row, or null when it settles
 * nothing. Pure. `ownAddresses` are the wallet's addresses on the source chain:
 * a UTXO deposit's change goes back to one of them.
 */
export function staleVerdict(
  row: SwapHistoryEntry,
  parties: TxPartiesState,
  nowMs: number,
  ownAddresses: ReadonlyArray<string>,
): StaleVerdict | null {
  if (!needsSettling(row) || parties.status !== "done") return null;
  const p = parties.parties;
  if (!p) {
    const created = Date.parse(row.createdAt);
    const old = Number.isFinite(created) && nowMs - created >= NOT_SENT_AFTER_MS;
    const kind = ASSET_CAPABILITIES[row.fromAsset.toUpperCase()]?.chainKind;
    return old && kind && DEFINITIVE_KINDS.has(kind) ? { kind: "not-sent" } : null;
  }
  const own = new Set(ownAddresses.filter(Boolean).map(norm));
  const others = p.to.filter((a) => !own.has(norm(a)));
  return others.length === 1 ? { kind: "deposit-address", depositAddress: others[0] } : null;
}

/** The history patch a verdict justifies. */
export function patchForVerdict(v: StaleVerdict, nowMs: number): Partial<SwapHistoryEntry> {
  return v.kind === "not-sent"
    ? {
        status: "failed",
        failureReason: "deposit-not-on-chain",
        outcomeUnknown: false,
        completedAt: new Date(nowMs).toISOString(),
      }
    : { depositAddress: v.depositAddress };
}

/** The wallet's addresses on a swap's source chain, as far as this layer can
 *  know them: the quote's refund address, and every address a UTXO account
 *  scan found. */
export function ownAddressesOnSource(row: SwapHistoryEntry, chain: ChainType | null): string[] {
  const scanned = chain ? (getUtxoAccountSummaries()[chain]?.entries ?? []).map((e) => e.address) : [];
  return [...(row.refundTo ? [row.refundTo] : []), ...scanned];
}

export interface SettleDeps {
  readParties: (chain: ChainType, hash: string, ownAddress: string) => Promise<TxPartiesState>;
  update: (id: string, patch: Partial<SwapHistoryEntry>) => Promise<void>;
  now: () => number;
  ownAddresses: (row: SwapHistoryEntry, chain: ChainType | null) => string[];
}

export const defaultSettleDeps = (update: SettleDeps["update"]): SettleDeps => ({
  readParties: readTxParties,
  update,
  now: () => Date.now(),
  ownAddresses: ownAddressesOnSource,
});

/**
 * Settle every row that needs it. Returns the rows whose deposit address was
 * recovered, as patched, so the caller can ask 1Click about them. Never throws;
 * a row whose read fails stays as it is.
 */
export async function settleStaleIntentsRows(
  rows: ReadonlyArray<SwapHistoryEntry>,
  deps: SettleDeps,
): Promise<SwapHistoryEntry[]> {
  const recovered: SwapHistoryEntry[] = [];
  for (const row of rows) {
    if (!needsSettling(row)) continue;
    const chain = swapLegChain(row.fromAsset);
    if (!chain) continue;
    try {
      const state = await deps.readParties(chain, row.sourceTxHash, row.refundTo ?? "");
      const v = staleVerdict(row, state, deps.now(), deps.ownAddresses(row, chain));
      if (!v) continue;
      const patch = patchForVerdict(v, deps.now());
      await deps.update(row.id, patch);
      if (v.kind === "deposit-address") recovered.push({ ...row, ...patch });
    } catch {
      // Unreadable now: the row stays pending, and is asked again next time.
    }
  }
  return recovered;
}
