/**
 * A transaction's sender and recipient, read from its chain when a details
 * view opens (2026-09-30).
 *
 * The operator asked to see, for every transaction, which address it was
 * sent from and which it was received at. History rows cannot always say: a
 * row is built from one address's point of view, and several list sources
 * carry no addresses at all. The details views (Activity's `TxDetails`, the
 * swap details' two legs) ask the adapter's `getTransactionParties` for the
 * side a row lacks — once per opened transaction, never from the history poll.
 *
 * Answers are cached for the session: a mined transaction's parties never
 * change. A "not found yet" (null) or a failed read is not cached, so opening
 * the details again asks again.
 */
import { useEffect, useState } from "react";
import { getAdapter } from "../wallets";
import type { ChainType, TxParties } from "../wallets";

export type TxPartiesState =
  /** Not asked: the row names both sides, or the chain has no reader. */
  | { status: "idle" }
  | { status: "loading" }
  /** `parties` null: the chain does not know the transaction (yet). */
  | { status: "done"; parties: TxParties | null }
  | { status: "error"; message: string };

const answered = new Map<string, TxParties>();
const inflight = new Map<string, Promise<TxPartiesState>>();

function keyOf(chain: ChainType, hash: string, ownAddress: string): string {
  // Hex values compare case-insensitively; base58 ids (Solana) do not.
  const norm = (v: string) => (/^(0x)?[0-9a-f]+$/i.test(v) ? v.toLowerCase() : v);
  // The asking address is part of the answer for some readers (an SPL
  // row's direction, a token leg's transfers that involve the wallet), so
  // two wallets opening the same transaction do not share one answer.
  return `${chain}|${norm(hash)}|${norm(ownAddress)}`;
}

/** Whether this chain's adapter can read a transaction's parties by hash. */
export function txPartiesSupported(chain: ChainType): boolean {
  return typeof getAdapter(chain)?.getTransactionParties === "function";
}

/** One read, shared by every view that asks for the same transaction. */
export function readTxParties(
  chain: ChainType,
  hash: string,
  ownAddress: string,
): Promise<TxPartiesState> {
  const key = keyOf(chain, hash, ownAddress);
  const known = answered.get(key);
  if (known) return Promise.resolve({ status: "done", parties: known });
  const running = inflight.get(key);
  if (running) return running;
  const read = getAdapter(chain)?.getTransactionParties;
  if (!read) return Promise.resolve({ status: "idle" });
  const p: Promise<TxPartiesState> = read
    .call(getAdapter(chain), hash, ownAddress)
    .then(
      (parties): TxPartiesState => {
        if (parties) answered.set(key, parties);
        return { status: "done", parties };
      },
      (e: unknown): TxPartiesState => ({
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      }),
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test seam: forget every cached answer. */
export function clearTxPartiesCache(): void {
  answered.clear();
  inflight.clear();
}

/**
 * The parties of one transaction, read when `enabled` and the chain has a
 * reader. `enabled` is the caller's "this row does not name both sides".
 */
export function useTxParties(
  chain: ChainType | null | undefined,
  hash: string | null | undefined,
  ownAddress: string | undefined,
  enabled: boolean,
): TxPartiesState {
  const ask = !!(enabled && chain && hash && txPartiesSupported(chain));
  const [state, setState] = useState<TxPartiesState>(() => {
    if (!ask) return { status: "idle" };
    const known = answered.get(keyOf(chain!, hash!, ownAddress ?? ""));
    return known ? { status: "done", parties: known } : { status: "loading" };
  });
  useEffect(() => {
    if (!ask) {
      setState({ status: "idle" });
      return;
    }
    let live = true;
    const known = answered.get(keyOf(chain!, hash!, ownAddress ?? ""));
    setState(known ? { status: "done", parties: known } : { status: "loading" });
    void readTxParties(chain!, hash!, ownAddress ?? "").then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [ask, chain, hash, ownAddress]);
  return state;
}
