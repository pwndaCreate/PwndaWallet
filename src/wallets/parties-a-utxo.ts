/**
 * UTXO chains (BTC, LTC, BCH, DOGE, DASH, RVN): who sent a transaction and who
 * received it, read by txid (`ChainAdapter.getTransactionParties`, 2026-09-30).
 *
 * # Why this exists
 *
 * The operator asked to see, in a transaction's details, which address it was
 * sent from and which it was received at. A history row is built from ONE
 * address's point of view and names at most one other party (`counterparty`,
 * set for sends only), and DASH's BlockCypher txrefs name nobody at all. This
 * reads the transaction itself: every input's address (`from`) and every
 * output's (`to`, change included — the view marks the wallet's own).
 *
 * # Sources
 *
 * Each adapter passes the explorers it already uses, in the order its history
 * uses them, reached the way it already reaches them (`via`): the Rust proxy
 * for most, direct `fetch` for BTC's Esplora hosts. No new host.
 *
 * # "Not found" is an answer, and only its exact shape counts
 *
 * Every explorer answers an unknown txid differently (read live 2026-09-30):
 *
 *   Esplora     HTTP 404, text/plain `Transaction not found`
 *   BlockCypher HTTP 404, `{"error": "Transaction <txid> not found."}` (documented;
 *               the live probe got `429 {"error": "Limits reached."}`)
 *   Blockchair  HTTP 200, `{"data":[],"context":{"code":200,…,"results":0}}`
 *   haskoin     HTTP 404, `{"error":"not-found-or-invalid-arg","message":"Item not found or argument invalid"}`
 *   BlockBook   HTTP 400, `{"error":"Transaction '<txid>' not found"}`
 *   Insight     HTTP 404, `Not found`
 *
 * A bare status is never read as "unknown": a dead route answers 404 too (the
 * RVN Insight mirror `rvn.cryptoscope.io` 301s to an HTML 404 page), and
 * TronStack's 404 for every `/v1/*` path once passed for "no data" for weeks
 * (`tron-history.ts`). Anything that is not a transaction and not that
 * explorer's own not-found shape is a failure, and the next source is asked.
 *
 * An explorer that does not know the txid does not end the search either:
 * indexers lag, and a transaction broadcast a minute ago may be in one
 * explorer's mempool view and not another's. `null` means that no source had
 * it and at least one said so; an Error means that none answered at all.
 */
import type { TxParties } from "./types";
import { httpProxyCall } from "./_proxy";
import { errorText } from "../lib/errorText";
import { condenseHttpError, hostOf } from "./tx-history-errors";

/** The explorer software behind a source: it decides the URL and the answer's shape. */
export type UtxoExplorerKind =
  | "esplora"
  | "blockcypher"
  | "blockchair"
  | "haskoin"
  | "blockbook"
  | "insight";

export interface UtxoPartiesSource {
  kind: UtxoExplorerKind;
  /** The API base the adapter already uses, e.g. `https://blockstream.info/api`. */
  base: string;
  /** How the adapter already reaches this host: the Rust proxy, or direct `fetch`. */
  via: "proxy" | "fetch";
}

/** One HTTP answer, before it is read. */
export interface HttpAnswer {
  status: number;
  body: string;
}

/**
 * Per-request timeout for the `fetch` hosts (the proxy has its own). Mutable
 * so tests need not wait; nothing in the app writes it.
 */
export const UTXO_PARTIES_TIMING = { requestTimeoutMs: 15_000 };

/** A 32-byte txid, as every UTXO explorer spells it. */
const TXID = /^[0-9a-f]{64}$/;

/**
 * The URL for one txid. BlockCypher cuts a transaction's inputs and outputs to
 * 20 each unless asked for more (`limit`, documented default 20); a
 * consolidation spends more than that. `limit=100` itself is not verified
 * live: every BlockCypher request from the probing machine on 2026-09-30 was
 * answered `429 {"error": "Limits reached."}`. A refusal of it would read as
 * a failed source, and the next one would be asked.
 */
function urlFor(s: UtxoPartiesSource, txid: string): string {
  switch (s.kind) {
    case "esplora":
      return `${s.base}/tx/${txid}`;
    case "blockcypher":
      return `${s.base}/txs/${txid}?limit=100`;
    case "blockchair":
      return `${s.base}/dashboards/transaction/${txid}`;
    case "haskoin":
      return `${s.base}/transaction/${txid}`;
    case "blockbook":
      return `${s.base}/api/v2/tx/${txid}`;
    case "insight":
      return `${s.base}/tx/${txid}`;
  }
}

/** Addresses in first-seen order, each once; empty and missing ones skipped. */
export function uniqueAddresses(list: Iterable<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    if (typeof a !== "string" || !a || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

type Parties = { from: string[]; to: string[] };

function httpError(a: HttpAnswer, url: string, reason?: unknown): Error {
  // The shape `condenseHttpError` reads: status, then the source's own reason.
  const body = typeof reason === "string" && reason ? JSON.stringify({ error: reason }) : a.body.slice(0, 200);
  return new Error(`HTTP ${a.status} from ${url}: ${body}`);
}

function json(a: HttpAnswer): any {
  try {
    return JSON.parse(a.body);
  } catch {
    return undefined;
  }
}

/** A body naming a transaction other than the one asked for is not an answer. */
function sameTxid(v: unknown, txid: string): boolean {
  return typeof v === "string" && v.toLowerCase() === txid;
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

/**
 * What one explorer said about `txid`: its parties, or `null` when the
 * explorer says it does not know the transaction. Throws when the answer is
 * neither (an error status, a rate limit, a page that is not the explorer's
 * JSON). Exported for tests.
 */
export function readUtxoAnswer(
  kind: UtxoExplorerKind,
  a: HttpAnswer,
  txid: string,
  url: string = kind,
): Parties | null {
  const j = json(a);
  switch (kind) {
    case "esplora": {
      if (a.status === 404 && /^transaction not found$/i.test(a.body.trim())) return null;
      if (a.status !== 200) throw httpError(a, url);
      if (!j || !sameTxid(j.txid, txid)) throw new Error("unexpected response");
      return {
        // A coinbase input has `prevout: null`; a bare-script output has no
        // `scriptpubkey_address` (an OP_RETURN, a P2PK). Neither is an address.
        from: uniqueAddresses(arr(j.vin).map((v) => v?.prevout?.scriptpubkey_address)),
        to: uniqueAddresses(arr(j.vout).map((v) => v?.scriptpubkey_address)),
      };
    }
    case "blockcypher": {
      if (a.status === 404 && typeof j?.error === "string" && /not found/i.test(j.error)) return null;
      if (a.status !== 200) throw httpError(a, url);
      if (!j || !sameTxid(j.hash, txid)) throw new Error("unexpected response");
      // `addresses` is null on an OP_RETURN output ("null-data").
      return {
        from: uniqueAddresses(arr(j.inputs).flatMap((i) => arr(i?.addresses))),
        to: uniqueAddresses(arr(j.outputs).flatMap((o) => arr(o?.addresses))),
      };
    }
    case "blockchair": {
      // Its refusals keep the reason under `context` (HTTP 430, "Your IP
      // address is temporary blacklisted…", read live 2026-09-30).
      if (a.status !== 200) throw httpError(a, url, j?.context?.error);
      if (!j || typeof j !== "object") throw new Error("unexpected response");
      // Unknown txid: HTTP 200 with `data: []` and `context.results: 0`.
      if (Array.isArray(j.data) && j.data.length === 0 && j.context?.code === 200) return null;
      const d = j.data && typeof j.data === "object" ? (j.data[txid] ?? j.data[txid.toUpperCase()]) : undefined;
      if (!d || typeof d !== "object") {
        const why = typeof j.context?.error === "string" ? j.context.error : "unexpected response";
        throw new Error(why);
      }
      // Blockchair names an output that has no address by a synthetic
      // `d-<hash>` "recipient" (inference from its docs' nonstandard-script
      // outputs); an OP_RETURN is type `nulldata`. Neither is an address.
      const addr = (x: any) =>
        x?.type === "nulldata" || (typeof x?.recipient === "string" && x.recipient.startsWith("d-"))
          ? undefined
          : x?.recipient;
      return {
        from: uniqueAddresses(arr(d.inputs).map(addr)),
        to: uniqueAddresses(arr(d.outputs).map(addr)),
      };
    }
    case "haskoin": {
      if (a.status === 404 && j?.error === "not-found-or-invalid-arg") return null;
      if (a.status !== 200) throw httpError(a, url);
      if (!j || !sameTxid(j.txid, txid)) throw new Error("unexpected response");
      return {
        from: uniqueAddresses(arr(j.inputs).map((i) => (i?.coinbase ? undefined : i?.address))),
        to: uniqueAddresses(arr(j.outputs).map((o) => o?.address)),
      };
    }
    case "blockbook": {
      if ((a.status === 400 || a.status === 404) && typeof j?.error === "string" && /not found/i.test(j.error)) {
        return null;
      }
      if (a.status !== 200) throw httpError(a, url);
      if (!j || !sameTxid(j.txid, txid)) throw new Error("unexpected response");
      // BlockBook lists an OP_RETURN as `addresses: ["OP_RETURN …"]` with
      // `isAddress: false`: a description, not an address.
      const addrs = (x: any) => (x?.isAddress === false ? [] : arr(x?.addresses));
      return {
        from: uniqueAddresses(arr(j.vin).flatMap(addrs)),
        to: uniqueAddresses(arr(j.vout).flatMap(addrs)),
      };
    }
    case "insight": {
      if (a.status === 404 && /^not found$/i.test(a.body.trim())) return null;
      if (a.status !== 200) throw httpError(a, url);
      if (!j || !sameTxid(j.txid, txid)) throw new Error("unexpected response");
      // A coinbase `vin` carries `coinbase` and no `addr`.
      return {
        from: uniqueAddresses(arr(j.vin).map((v) => v?.addr)),
        to: uniqueAddresses(arr(j.vout).flatMap((v) => arr(v?.scriptPubKey?.addresses))),
      };
    }
  }
}

async function getViaProxy(url: string): Promise<HttpAnswer> {
  const r = await httpProxyCall({ method: "GET", url });
  return { status: r.status, body: r.body };
}

async function getViaFetch(url: string): Promise<HttpAnswer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UTXO_PARTIES_TIMING.requestTimeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    return { status: resp.status, body: await resp.text() };
  } catch (e) {
    throw new Error(ctrl.signal.aborted ? "no answer in time" : `request failed (${errorText(e)})`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `getTransactionParties` for a UTXO adapter: `sources` in order until one
 * has the transaction. `null` when none had it and at least one said so (a
 * string that is not a txid is not asked about at all); throws, naming every
 * source with its status, when none answered. `normalize` rewrites each
 * address into the form the adapter displays (BCH: CashAddr with its prefix).
 */
export async function readUtxoParties(
  ticker: string,
  hash: string,
  sources: readonly UtxoPartiesSource[],
  normalize?: (address: string) => string,
): Promise<TxParties | null> {
  const txid = String(hash ?? "").trim().toLowerCase();
  if (!TXID.test(txid)) return null;
  const failures: string[] = [];
  let unknown = false;
  for (const s of sources) {
    const url = urlFor(s, txid);
    const host = hostOf(url);
    try {
      const answer = await (s.via === "fetch" ? getViaFetch(url) : getViaProxy(url));
      const parties = readUtxoAnswer(s.kind, answer, txid, url);
      if (!parties) {
        unknown = true;
        continue;
      }
      return {
        from: normalize ? uniqueAddresses(parties.from.map(normalize)) : parties.from,
        to: normalize ? uniqueAddresses(parties.to.map(normalize)) : parties.to,
        source: host,
      };
    } catch (e) {
      failures.push(`${host}: ${condenseHttpError(e)}`);
    }
  }
  if (unknown) return null;
  throw new Error(`every ${ticker} transaction source failed — ${failures.join("; ")}`);
}
