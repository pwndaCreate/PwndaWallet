/**
 * What a swap-history row says in plain words, and how the details modal
 * follows a NEAR Intents swap while it is open.
 *
 * # Why (the operator's report, 2026-09-30)
 *
 * On a live LTC -> USDC-POL swap:
 *
 *   "When I try to move the app the swap screen unfocuses and disappears. Can
 *    you make it so I can click on the recent swaps and have the swap screen
 *    re-appear, so I can read what is happening? I don't know what is
 *    happening with the swap now that it disappeared."
 *   "I want to be able to click on current and past swaps and see the data on
 *    them."
 *
 * Until then the confirm modal was the only screen that showed a running swap.
 * Once it closed, the history row said "pending" and nothing else: no hash, no
 * deposit address, no word on what NEAR Intents was doing. This module is the
 * logic behind `SwapDetailsModal`, which every swap list opens. It has no React
 * in it, so its rules are tested without a DOM (this repo has none).
 *
 * # Status semantics are not defined here
 *
 * Whether a 1Click status is terminal, and which history status it becomes,
 * is `intentsStatusToHistory` in `swap-execute.ts`: the mapping the confirm
 * modal and the resume pass already use (INCOMPLETE_DEPOSIT stays pending,
 * 2026-09-29 send-safety audit F5). The patch a terminal status writes has the
 * same shape theirs does. What this module adds is words: a sentence for each
 * state, and for the non-terminal 1Click statuses it repeats what
 * `proxy-types.ts` and `swap-execute.ts` already say they mean.
 *
 * # Explorer links are built by the wallet, never taken from a response
 *
 * 1Click's status response carries explorer URLs of its own. They are ignored:
 * a link the user clicks goes to the explorer this wallet already uses for
 * that chain, built from the hash, so a relay answer can never choose where the
 * user's browser goes.
 */
import { getIntentsStatus } from "../../api/proxy";
import type { IntentsStatusResponse } from "../../lib/proxy-types";
import { intentsStatusToHistory } from "./swap-execute";
import { extractActualReceivedFromIntents } from "./swap-actual-received";
import {
  loadSwapHistory,
  updateSwapHistoryEntry,
  type SwapHistoryEntry,
  type SwapHistoryStatus,
} from "./swap-history-store";
import { SWAP_COIN_META, getSwapCoinMeta } from "./swap-data";
import { defaultBlockchainFor } from "./intents-dedup";
import { ROUTER_MODES } from "./router-modes";
import { ASSET_CAPABILITIES } from "./asset-capabilities";
import { ALL_CHAINS } from "../../wallets";
import type { ChainType } from "../../wallets";

/** How often the open details modal asks 1Click (the ask was ~10-15 s). */
export const DETAILS_POLL_MS = 12_000;

// ─── Which route a row came from ────────────────────────────────────────

export type SwapRouteKind = "intents" | "desk" | "other";

/**
 * The route a history row came from. A deposit address means NEAR Intents
 * (only that path records one). Older Intents rows have none, so the provider
 * tag is the fallback: the confirm modal writes `"<router label> · <provider>"`
 * and the desk tracker `"<desk label> - atomic"`.
 */
export function swapRouteOf(row: SwapHistoryEntry): SwapRouteKind {
  if (row.depositAddress) return "intents";
  const provider = row.provider ?? "";
  if (provider.startsWith(ROUTER_MODES.intents.label)) return "intents";
  if (provider.startsWith(ROUTER_MODES["pwnda-desk"].label)) return "desk";
  return "other";
}

/** True when this row can be looked up live: 1Click finds a swap by its
 *  deposit address, which rows record since the 2026-09-29 audit (F5). */
export function isLiveTrackable(row: SwapHistoryEntry): boolean {
  return !!row.depositAddress;
}

// ─── The plain-words status ─────────────────────────────────────────────

export type SwapStatusKey =
  | "waiting-deposit"
  | "deposit-seen"
  | "processing"
  | "incomplete-deposit"
  | "may-have-been-sent"
  | "pending"
  | "completed"
  | "refunded"
  | "failed"
  | "not-sent";

export type SwapStatusTone = "ok" | "warn" | "bad";

export interface SwapStatusView {
  key: SwapStatusKey;
  /** The headline, e.g. "Waiting for deposit". */
  label: string;
  /** One or two sentences under it. */
  detail: string;
  tone: SwapStatusTone;
}

/**
 * The status of a swap in plain words, from its history row and (for a NEAR
 * Intents row) the latest 1Click status the modal has read.
 *
 * A terminal row keeps its status. A pending row takes a terminal 1Click
 * answer at once, through the shared mapping; the modal writes the same
 * answer back to the row on the same poll tick.
 */
export function swapStatusView(
  row: SwapHistoryEntry,
  liveStatus?: string | null,
): SwapStatusView {
  const route = swapRouteOf(row);
  const live = typeof liveStatus === "string" && liveStatus ? liveStatus : null;
  const status: SwapHistoryStatus =
    row.status !== "pending" ? row.status : live ? intentsStatusToHistory(live) : "pending";
  const hasHash = !!row.sourceTxHash;

  if (status === "success") {
    return {
      key: "completed",
      label: "Completed",
      tone: "ok",
      detail:
        route === "intents"
          ? `NEAR Intents finished the swap and sent the ${row.toAsset}.`
          : "The swap finished.",
    };
  }
  if (status === "refunded") {
    return {
      key: "refunded",
      label: "Refunded",
      tone: "warn",
      // Only NEAR Intents is known to refund to the quote's refund address
      // (the source address, `assertQuoteBinding`). A desk row's "refunded"
      // is a lossy projection of two opposite outcomes (`useDeskTracker.ts`,
      // CC-5), so it gets no sentence that claims the money is on its way.
      detail:
        route === "intents"
          ? `NEAR Intents sent the deposit back to your ${row.fromAsset} address, the refund address in the quote.`
          : "Recorded as refunded.",
    };
  }
  if (status === "failed" && row.failureReason === "deposit-not-on-chain") {
    return {
      key: "not-sent",
      label: "Not sent",
      tone: "warn",
      detail:
        `The deposit never reached ${swapNetworkName(row.fromAsset)}: its transaction is not on ` +
        "the chain, so nothing was swapped and nothing left your wallet. There is nothing to recover.",
    };
  }
  if (status === "failed") {
    return {
      key: "failed",
      label: "Failed",
      tone: "bad",
      detail: hasHash
        ? "Recorded as failed. If the deposit below went out, check it on its explorer."
        : "Recorded as failed.",
    };
  }

  // Pending from here on.
  if (row.outcomeUnknown && (!live || live === "PENDING_DEPOSIT")) {
    // F2: the wallet could not tell whether the deposit reached the network.
    // Only a 1Click status that has seen the deposit settles that.
    return {
      key: "may-have-been-sent",
      label: "May have been sent",
      tone: "warn",
      detail: hasHash
        ? "The wallet could not confirm whether this deposit reached the network. Check the source transaction below on its explorer before swapping again. This quote is never used twice."
        : `No transaction id came back. Check this wallet's recent ${row.fromAsset} activity before swapping again. This quote is never used twice.`,
    };
  }
  switch (live) {
    case "PENDING_DEPOSIT":
      return {
        key: "waiting-deposit",
        label: "Waiting for deposit",
        tone: "warn",
        detail: hasHash
          ? "NEAR Intents has not registered the deposit yet. The deposit transaction is below; on some networks it needs a few confirmations before it counts. A deposit that has not arrived in full by the deadline is refunded."
          : "NEAR Intents has not seen a deposit to this address yet.",
      };
    case "KNOWN_DEPOSIT_TX":
      // proxy-types.ts: "deposit txhash known, not yet processing".
      return {
        key: "deposit-seen",
        label: "Deposit seen",
        tone: "warn",
        detail: "NEAR Intents knows the deposit transaction; the swap has not started processing yet.",
      };
    case "PROCESSING":
      return {
        key: "processing",
        label: "Processing",
        tone: "warn",
        detail: "NEAR Intents has the deposit and is completing the swap.",
      };
    case "INCOMPLETE_DEPOSIT":
      // swap-execute.ts, INTENTS_TERMINAL: short of the quote, refunded by the
      // deadline or completed if the rest arrives. Pending, never "failed" (F5).
      return {
        key: "incomplete-deposit",
        label: "Deposit incomplete",
        tone: "warn",
        detail:
          "The deposit arrived short of the quote. NEAR Intents refunds it by the deposit deadline, or completes the swap if the rest arrives.",
      };
  }
  if (live) {
    return { key: "pending", label: "Pending", tone: "warn", detail: `NEAR Intents reports ${live}.` };
  }
  return { key: "pending", label: "Pending", tone: "warn", detail: pendingWithoutLiveStatus(row, route) };
}

/**
 * What a pending row says before (or without) a live answer. The modal's own
 * line under it says whether it is asking NEAR Intents or that live status is
 * not available for the route, so this only gives the row's side and, for a
 * row that cannot be looked up, the reason.
 */
function pendingWithoutLiveStatus(row: SwapHistoryEntry, route: SwapRouteKind): string {
  if (isLiveTrackable(row)) return "Recorded as pending.";
  if (route === "intents") {
    return (
      "Recorded as pending. This swap was saved before the wallet recorded deposit " +
      "addresses (2026-09-29), and NEAR Intents looks a swap up by its deposit address, " +
      "so check the source transaction below."
    );
  }
  if (route === "desk") {
    return "Recorded as pending. A desk swap in progress is followed by its own tracker.";
  }
  return "This is the last status the wallet recorded for it.";
}

// ─── Reading a 1Click status response ───────────────────────────────────

/**
 * What the details modal shows from a 1Click status response.
 *
 * The response is typed `{ status, [k]: unknown }` because the relay passes
 * 1Click's body through. The fields read here follow 1Click's published status
 * shape (`swapDetails.originChainTxHashes[].hash`, `amountOutFormatted`, …,
 * and the `quoteResponse` it echoes). That shape is INFERRED from 1Click's
 * API, not observed in this repo, so every field is optional and read
 * defensively; `swap` is accepted as the container too, because that is where
 * `extractActualReceivedFromIntents` looks.
 */
export interface IntentsLiveDetails {
  status: string | null;
  /** Deposit transactions 1Click has registered for the deposit address. */
  originTxHashes: string[];
  /** Payout transactions on the destination chain. */
  destinationTxHashes: string[];
  amountInFormatted: string | null;
  amountOutFormatted: string | null;
  refundedAmountFormatted: string | null;
  /** The quote's minimum output in atomic units, when the status echoes it. */
  minAmountOutAtomic: string | null;
  /** The payout and refund addresses, from 1Click's echo of the request
   *  (`quoteResponse.quoteRequest`). For rows written before they were
   *  stored (2026-09-30). */
  recipient: string | null;
  refundTo: string | null;
}

/** A hash worth showing and linking: no spaces, slashes or markup. */
const SAFE_HASH = /^[A-Za-z0-9_:+=.-]{8,200}$/;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function text(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function hashesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const raw = typeof item === "string" ? item : asRecord(item)?.hash;
    const h = typeof raw === "string" ? raw.trim() : "";
    if (SAFE_HASH.test(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

export function readIntentsLiveDetails(resp: unknown): IntentsLiveDetails {
  const r = asRecord(resp);
  const d = asRecord(r?.swapDetails) ?? asRecord(r?.swap);
  const quote = asRecord(asRecord(r?.quoteResponse)?.quote);
  const request = asRecord(asRecord(r?.quoteResponse)?.quoteRequest);
  return {
    status: text(r?.status),
    originTxHashes: hashesOf(d?.originChainTxHashes),
    destinationTxHashes: hashesOf(d?.destinationChainTxHashes),
    amountInFormatted: text(d?.amountInFormatted),
    amountOutFormatted: text(d?.amountOutFormatted),
    refundedAmountFormatted: text(d?.refundedAmountFormatted),
    minAmountOutAtomic: text(quote?.minAmountOut),
    recipient: text(request?.recipient),
    refundTo: text(request?.refundTo),
  };
}

// ─── What a status read writes back ─────────────────────────────────────

/**
 * The history patch one 1Click status read justifies. Empty when nothing
 * changes.
 *
 * - A pending row that 1Click reports terminal gets the SAME patch the resume
 *   pass and the confirm modal write: status, `outcomeUnknown: false`,
 *   `completedAt`, and `actualReceived` on success.
 * - A terminal row's status is never touched, and a status is never moved
 *   back to pending.
 * - The payout hash, once 1Click lists one, fills `destTxHash` (and its
 *   explorer link) when the row has none. The confirm modal never recorded it
 *   for NEAR Intents, so every Intents row lacked it. Not on a refund: a
 *   refunded swap paid nothing out, and a hash there would be linked to the
 *   wrong chain's explorer.
 */
export function historyPatchFromIntentsStatus(
  row: SwapHistoryEntry,
  resp: IntentsStatusResponse,
  nowMs: number,
  toExplorer?: (hash: string) => string | null,
): Partial<SwapHistoryEntry> {
  const patch: Partial<SwapHistoryEntry> = {};
  const raw = typeof resp?.status === "string" ? resp.status : undefined;
  const mapped = intentsStatusToHistory(raw);
  if (row.status === "pending" && mapped !== "pending") {
    const at = new Date(nowMs).toISOString();
    const actualReceived =
      mapped === "success" ? extractActualReceivedFromIntents(resp) : undefined;
    Object.assign(patch, {
      status: mapped,
      outcomeUnknown: false,
      completedAt: at,
      ...(actualReceived ? { actualReceived, actualReceivedAt: at } : {}),
    });
  }
  const finalStatus = patch.status ?? row.status;
  if (!row.destTxHash && finalStatus !== "refunded") {
    const dest = readIntentsLiveDetails(resp).destinationTxHashes[0];
    if (dest) {
      patch.destTxHash = dest;
      const url = toExplorer?.(dest) ?? null;
      if (url) patch.destExplorerUrl = url;
    }
  }
  return patch;
}

// ─── Following a swap while the modal is open ───────────────────────────

export interface WatchIntentsDeps {
  getStatus: (depositAddress: string) => Promise<IntentsStatusResponse>;
  update: (id: string, patch: Partial<SwapHistoryEntry>) => Promise<void>;
  /** The row as stored now: another writer may have moved it on. */
  loadRow: (id: string) => Promise<SwapHistoryEntry | undefined>;
  now: () => number;
  /** Run `fn` after `ms`; returns a cancel. */
  schedule: (fn: () => void, ms: number) => () => void;
}

const defaultWatchDeps: WatchIntentsDeps = {
  getStatus: getIntentsStatus,
  update: updateSwapHistoryEntry,
  loadRow: async (id) => (await loadSwapHistory()).find((r) => r.id === id),
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/**
 * Ask 1Click about `row` now and every `intervalMs` until the row is
 * terminal, writing back whatever the answer changes. Returns `stop`, which
 * the modal calls when it closes: nothing is asked, reported or written after
 * that.
 *
 * A row that is already terminal is asked once, for what the modal shows (the
 * payout hash, the amounts), and then left alone. A row with no deposit
 * address is never asked: 1Click has no other way to find it.
 *
 * This does not reuse `pollIntentsToTerminal`: that loop cannot be stopped
 * from outside, and it would keep polling for up to an hour past the deadline
 * after the modal closed. What it shares with that loop is the endpoint
 * (`getIntentsStatus`), the mapping and the terminal patch.
 */
export function watchIntentsSwap(args: {
  row: SwapHistoryEntry;
  onLive: (details: IntentsLiveDetails, checkedAt: number) => void;
  onError?: (message: string) => void;
  onPatched?: (patch: Partial<SwapHistoryEntry>) => void;
  toExplorer?: (hash: string) => string | null;
  intervalMs?: number;
  deps?: Partial<WatchIntentsDeps>;
}): () => void {
  const deps: WatchIntentsDeps = { ...defaultWatchDeps, ...args.deps };
  const interval = args.intervalMs ?? DETAILS_POLL_MS;
  const depositAddress = args.row.depositAddress;
  let current = args.row;
  let stopped = false;
  let cancel: (() => void) | null = null;

  const next = () => {
    if (!stopped) cancel = deps.schedule(() => void tick(), interval);
  };

  const tick = async (): Promise<void> => {
    cancel = null;
    if (stopped || !depositAddress) return;
    let resp: IntentsStatusResponse;
    try {
      resp = await deps.getStatus(depositAddress);
    } catch (e) {
      if (stopped) return;
      args.onError?.(e instanceof Error ? e.message : String(e));
      next();
      return;
    }
    if (stopped) return;
    args.onLive(readIntentsLiveDetails(resp), deps.now());

    // The stored row, not the one the modal opened on: the confirm modal's own
    // poll or the resume pass may already have written a terminal status.
    try {
      const stored = await deps.loadRow(current.id);
      if (stored) current = stored;
    } catch {
      // Keep the copy we have.
    }
    if (stopped) return;

    const patch = historyPatchFromIntentsStatus(current, resp, deps.now(), args.toExplorer);
    if (Object.keys(patch).length > 0) {
      try {
        await deps.update(current.id, patch);
        current = { ...current, ...patch };
        if (!stopped) args.onPatched?.(patch);
      } catch {
        // Not written; the next tick computes the same patch again.
      }
    }
    if (stopped || current.status !== "pending") return;
    next();
  };

  void tick();
  return () => {
    stopped = true;
    cancel?.();
    cancel = null;
  };
}

// ─── Small readers for the modal ────────────────────────────────────────

/** Only http(s) links are handed to the OS opener. */
export function isHttpUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https?:\/\/\S+$/i.test(url);
}

/**
 * The wallet's own explorer link for a destination-chain hash, resolved the
 * way the confirm modal resolves its destination (`getSwapCoinMeta` with the
 * asset's default blockchain, then the static table).
 */
export function destinationExplorerUrl(toAsset: string, hash: string): string | null {
  if (!SAFE_HASH.test(hash)) return null;
  const meta =
    getSwapCoinMeta(toAsset, defaultBlockchainFor(toAsset) ?? undefined) ??
    SWAP_COIN_META[toAsset.toUpperCase()];
  const url = meta ? meta.explorerTxUrl(hash) : null;
  return isHttpUrl(url) ? url : null;
}

/**
 * The wallet chain whose adapter reads one leg of a swap (2026-09-30): a
 * token leg by its own name (`USDC-POL` -> `usdc-pol`, whose adapter reads
 * that token's transfers), a coin by the wallet that holds it (`LTC` ->
 * `litecoin`).
 */
export function swapLegChain(asset: string): ChainType | null {
  const lower = asset.toLowerCase();
  const leg = ALL_CHAINS.find((c) => c === lower);
  if (leg) return leg;
  const cap = ASSET_CAPABILITIES[asset.toUpperCase()];
  if (!cap) return null;
  // A native EVM coin by its chain id: every EVM coin is held by the one
  // `ethereum` wallet, so `walletsByChainKey` says `ethereum` for POL,
  // AVAX, FLR, MON and BNB too, and their legs would have been looked up
  // on Ethereum's RPCs (found by the wiki pass, 2026-09-30).
  if (cap.chainKind === "EVM") {
    return typeof cap.chainId === "number" ? (EVM_NATIVE_CHAIN[cap.chainId] ?? null) : null;
  }
  return cap.walletsByChainKey ?? null;
}

/** The wallet chain of each EVM chain id a swap coin can be native to. */
const EVM_NATIVE_CHAIN: Readonly<Record<number, ChainType>> = {
  1: "ethereum",
  10: "optimism",
  14: "flare",
  56: "bsc",
  137: "polygon",
  143: "monad",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
};

/** The network a swap asset lives on, as the swap screens name it. */
export function swapNetworkName(asset: string): string {
  return ASSET_CAPABILITIES[asset.toUpperCase()]?.network ?? asset;
}

/** A history row's status as the swap lists print it: "not sent" for a
 *  deposit that never reached its chain (2026-10-01), else the status. */
export function swapStatusLabel(row: SwapHistoryEntry): string {
  return row.status === "failed" && row.failureReason === "deposit-not-on-chain"
    ? "not sent"
    : row.status;
}

/** An explorer page for an address on a swap asset's chain, or null. */
export function swapAddressExplorerUrl(asset: string, address: string): string | null {
  if (!SAFE_HASH.test(address)) return null;
  const meta =
    getSwapCoinMeta(asset, defaultBlockchainFor(asset) ?? undefined) ??
    SWAP_COIN_META[asset.toUpperCase()];
  const url = meta ? meta.explorerAddressUrl(address) : null;
  return isHttpUrl(url) ? url : null;
}

/**
 * The deposit memo, when the row carries one. Another change adds
 * `depositMemo` to history rows (the Stellar memo, 2026-09-30); read it
 * defensively so this works with or without that field.
 */
export function depositMemoOf(row: SwapHistoryEntry): string | null {
  const m = (row as unknown as { depositMemo?: unknown }).depositMemo;
  return typeof m === "string" && m.trim() ? m.trim() : null;
}

/** The stored minimum-received amount. `SwapConfirmModal` writes it since
 *  2026-09-30; for older rows the modal falls back to the quote 1Click
 *  echoes. */
export function minReceivedOf(row: SwapHistoryEntry): string | null {
  const m: unknown = row.minReceived;
  return typeof m === "string" && m.trim() ? m.trim() : null;
}

/** A stored ISO time as local date and time, or null. */
export function formatSwapTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : null;
}
