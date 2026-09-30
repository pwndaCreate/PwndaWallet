/**
 * Per-chain history status for the Activity views: the merged rows, whether a
 * load is running, and — when the last fetch failed — WHY, in a word.
 *
 * # Why this exists (operator report, 2026-09-30)
 *
 * The landscape header read
 * `· errors on ETH, USDT, USDT, USDC, USDC, USDC, USDC, USDC, USDT0, USDT0, USDC, USDT0, POL, TRX, ETH, ETH, ETH, MON, NEAR`
 * and the operator asked why so many assets had errors. The line could not
 * say: it listed TICKERS (four different chains read "ETH", five "USDC"), no
 * reason, and it counted NEAR — a chain with no history source, not a failure
 * — among the errors. The portrait line said "N of M chain explorers
 * unreachable" whatever had actually happened.
 *
 * Both views now build their status line from here: chains are named by the
 * adapter's display name ("USDC (Arbitrum)", not "USDC"), grouped by reason
 * ("rate limited", "explorer unreachable", …), and a chain whose adapter says
 * its history is not available is listed separately and never as an error.
 */
import { getAdapter } from "../../wallets";
import type { ChainTx, ChainType } from "../../wallets";
import { isHistoryUnavailableMessage } from "../../wallets/tx-history-errors";
import { mergeChainTx } from "./useTxHistory";

export type HistoryFailureKind =
  | "rate-limited"
  | "unreachable"
  | "blocked"
  | "unsupported"
  | "explorer-error"
  | "refused"
  | "bad-response"
  | "failed";

/** One-word-ish reasons, as the header prints them. */
export const FAILURE_LABEL: Record<HistoryFailureKind, string> = {
  "rate-limited": "rate limited",
  unreachable: "explorer unreachable",
  blocked: "source blocked",
  unsupported: "not supported by explorer",
  "explorer-error": "explorer error",
  refused: "explorer refused",
  "bad-response": "bad response",
  failed: "failed",
};

/**
 * Why a history fetch failed, from its error string. First match wins, in
 * this order, because an error naming several sources names the most useful
 * cause first: a 429 anywhere means "rate limited" even if a fallback then
 * timed out.
 */
export function classifyHistoryFailure(msg: string): HistoryFailureKind {
  if (/\b429\b|too many requests|rate[ -]?limit|request rate exceeded/i.test(msg)) return "rate-limited";
  if (/http_proxy allowlist/i.test(msg)) return "blocked";
  if (/chain not supported|not supported/i.test(msg)) return "unsupported";
  if (
    /timeout|timed out|abort|failed to fetch|fetch failed|network ?error|ENOTFOUND|ECONN|EAI_AGAIN|error sending request|http request to \S+ failed|dns/i.test(
      msg,
    )
  ) {
    return "unreachable";
  }
  if (/\bHTTP 5\d\d\b/.test(msg)) return "explorer-error";
  if (/\bHTTP 4\d\d\b|explorer refused/i.test(msg)) return "refused";
  if (/unexpected response|unexpected token|not valid json|JSON/i.test(msg)) return "bad-response";
  return "failed";
}

export interface ChainHistoryStatus {
  chain: ChainType;
  /** The adapter's display name — unique per chain, unlike its ticker. */
  name: string;
  txs: ChainTx[];
  loading: boolean;
  /** The adapter says it has no history source for this chain. */
  unavailable: boolean;
  /** A real failure: its kind and the stored error text. */
  failure: { kind: HistoryFailureKind; message: string } | null;
}

/**
 * One status per DISTINCT chain, each merged across all of its address keys
 * exactly once. `chainsOwned` used to repeat a UTXO chain once per account
 * address (App.tsx built it from every `chain:address` pair), which is why
 * the Activity lists showed each LTC row once per address. App passes each
 * chain once since 2026-09-30 (`ownedChainsOf`); the dedupe here stays so a
 * caller that repeats a chain still cannot list its rows twice.
 */
export function chainHistoryStatuses(
  chainsOwned: ChainType[],
  result: {
    txByChain: Record<string, ChainTx[]>;
    loading?: Record<string, boolean>;
    errors?: Record<string, string | null>;
  },
): ChainHistoryStatus[] {
  const out: ChainHistoryStatus[] = [];
  const seen = new Set<ChainType>();
  for (const chain of chainsOwned) {
    if (seen.has(chain)) continue;
    seen.add(chain);
    const merged = mergeChainTx(result, chain);
    const unavailable = isHistoryUnavailableMessage(merged.error);
    out.push({
      chain,
      name: getAdapter(chain)?.displayName ?? chain,
      txs: merged.txs,
      loading: merged.loading,
      unavailable,
      failure:
        merged.error && !unavailable
          ? { kind: classifyHistoryFailure(merged.error), message: merged.error }
          : null,
    });
  }
  return out;
}

export interface HistoryStatusSummary {
  loading: string[];
  unavailable: string[];
  /** Failures grouped by reason, largest group first. */
  failures: { kind: HistoryFailureKind; label: string; chains: { name: string; message: string }[] }[];
}

export function summarizeHistoryStatus(statuses: ChainHistoryStatus[]): HistoryStatusSummary {
  const groups = new Map<HistoryFailureKind, { name: string; message: string }[]>();
  for (const s of statuses) {
    if (!s.failure) continue;
    const g = groups.get(s.failure.kind) ?? [];
    g.push({ name: s.name, message: s.failure.message });
    groups.set(s.failure.kind, g);
  }
  return {
    loading: statuses.filter((s) => s.loading).map((s) => s.name),
    unavailable: statuses.filter((s) => s.unavailable).map((s) => s.name),
    failures: [...groups.entries()]
      .map(([kind, chains]) => ({ kind, label: FAILURE_LABEL[kind], chains }))
      .sort((a, b) => b.chains.length - a.chains.length),
  };
}
