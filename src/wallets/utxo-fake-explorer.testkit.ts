/**
 * An in-process fake of every block explorer the Bitcoin-family adapters talk
 * to — BTC, LTC, DOGE, DASH, BCH, RVN — for the send-safety tests
 * (2026-09-29 send-safety audit).
 *
 * TEST-ONLY. Nothing imports this outside `*.test.ts`, so it is never bundled.
 * Nothing here opens a socket: a test replaces `lib/tauri`'s `invoke` (the
 * `http_proxy_call` route every adapter but BTC uses) and `fetch` (BTC's
 * Esplora route) with {@link FakeExplorer.invokeImpl} and
 * {@link FakeExplorer.fetchImpl}, and any URL the router does not know answers
 * 404 and is recorded in `unknown`.
 *
 * Modelled on the audit's harness (`scratchpad/audit/utxo/fakenet.ts`): real,
 * parseable funding transactions, so legacy inputs can carry `nonWitnessUtxo`,
 * and a verifier that checks every signature against a sighash computed by
 * bitcoinjs-lib itself — not by the adapter under test.
 *
 * Since 2026-10-01 (BTC speed-up) a transaction the network accepts is kept
 * whole: Esplora's `/tx/:txid` answers with its prevouts, nSequence, fee and
 * status (funding transactions mined, pushed ones in the mempool), and
 * `/tx/:txid/outspends` says which pushed transaction spends each output.
 */
import * as bitcoin from "bitcoinjs-lib";
import * as tinysecp from "tiny-secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const h160 = (b: Uint8Array) => ripemd160(sha256(b));
const txidOfInput = (i: { hash: Uint8Array }) => hex(Uint8Array.from(i.hash).reverse());

/** Address → map key. CashAddr is keyed without its prefix, case-folded. */
export const addrKey = (a: string) =>
  decodeURIComponent(a).trim().replace(/^bitcoincash:/i, "").toLowerCase();

export type FakeUtxo = { txid: string; vout: number; value: number; script: Uint8Array };

/**
 * What one broadcast endpoint does with one push.
 *  - `accept`            relays it and answers with the txid.
 *  - `relay-then-drop`   relays it, then the reply is lost (the proxy's 30 s
 *                        timeout). The transaction IS on the network.
 *  - `drop`              the reply is lost and nothing is known to have been
 *                        relayed — lookups do not see the transaction.
 *  - `{status, body}`    answers exactly that and relays nothing.
 */
export type PushOutcome =
  | "accept"
  | "relay-then-drop"
  | "drop"
  | { status: number; body: string };

export type PushRecord = {
  via: string;
  url: string;
  hex: string;
  rawBody: string;
  contentType?: string;
  method: string;
};

type Reply = { status: number; body: string } | "drop";

export class FakeExplorer {
  /** addrKey → funded outputs. */
  utxos = new Map<string, FakeUtxo[]>();
  /** addrKey of every address with history. */
  used = new Set<string>();
  /** txid → raw hex of every funding transaction. */
  raw = new Map<string, string>();
  /** `${txid}:${vout}` → the output it created. */
  prevOut = new Map<string, { script: Uint8Array; value: number }>();
  /** txids the network knows about — what a lookup can find. */
  mempool = new Set<string>();
  /**
   * txids that are mined (Esplora's `status.confirmed`). Funding transactions
   * are; a pushed transaction is not until a test says so. Added 2026-10-01
   * for the BTC speed-up, which must not offer to replace a mined one.
   */
  confirmed = new Set<string>();
  pushes: PushRecord[] = [];
  requests: string[] = [];
  unknown: string[] = [];
  /** Decides each push. Default: every endpoint accepts. */
  onPush: (via: string, hex: string, txid: string) => PushOutcome = () => "accept";
  fees = {
    esplora: { "1": 10, "3": 8, "6": 5, "144": 1 } as Record<string, number>,
    mempoolRecommended: { fastestFee: 3, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 },
    /** BlockCypher `medium_fee_per_kb`, base units per kB. */
    blockcypherPerKb: 10_000,
    /** Blockchair `suggested_transaction_fee_per_byte_sat`. */
    blockchairPerByte: 1,
    /** BlockBook `estimatefee`, coins per kB. */
    blockbookPerKb: "0.01",
  };
  private salt = 1;

  /** Create a real funding transaction paying `value` to `script` at `address`. */
  fund(address: string, script: Uint8Array, value: number): FakeUtxo {
    const tx = new bitcoin.Transaction();
    tx.version = 1;
    const prev = new Uint8Array(32);
    prev[0] = this.salt & 0xff;
    prev[1] = (this.salt >> 8) & 0xff;
    prev[31] = 0x77;
    this.salt++;
    tx.addInput(prev, 0, 0xffffffff, Uint8Array.of(0x51));
    tx.addOutput(script, BigInt(value));
    const txid = tx.getId();
    this.raw.set(txid, tx.toHex());
    this.mempool.add(txid);
    this.confirmed.add(txid);
    const u: FakeUtxo = { txid, vout: 0, value, script };
    const k = addrKey(address);
    this.used.add(k);
    this.utxos.set(k, [...(this.utxos.get(k) ?? []), u]);
    this.prevOut.set(`${txid}:0`, { script, value });
    return u;
  }

  markUsed(address: string) {
    this.used.add(addrKey(address));
  }

  /**
   * The network takes a transaction into its mempool: it can be looked up,
   * read whole (`/tx/:txid` with its prevouts, `/tx/:txid/hex`), and its
   * outputs can be spent by another. Unconfirmed. Returns its txid.
   */
  relay(hexTx: string): string {
    const tx = bitcoin.Transaction.fromHex(hexTx);
    const txid = tx.getId();
    this.mempool.add(txid);
    this.raw.set(txid, hexTx);
    tx.outs.forEach((o, vout) => this.prevOut.set(`${txid}:${vout}`, { script: o.script, value: Number(o.value) }));
    return txid;
  }

  /**
   * One transaction as Esplora's `GET /tx/:txid` gives it: inputs with their
   * prevouts and nSequence, outputs, size, weight, fee, status. Addresses are
   * encoded for the host's chain (BTC, or LTC on litecoinspace).
   */
  private esploraTx(txid: string, host: string) {
    const network: bitcoin.Network =
      host === "litecoinspace.org"
        ? { ...bitcoin.networks.bitcoin, bech32: "ltc", pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 }
        : bitcoin.networks.bitcoin;
    const addressOf = (script: Uint8Array) => {
      try {
        return bitcoin.address.fromOutputScript(script, network);
      } catch {
        return undefined;
      }
    };
    const tx = bitcoin.Transaction.fromHex(this.raw.get(txid)!);
    let inSum = 0;
    let complete = true;
    const vin = tx.ins.map((inp) => {
      const prevTxid = txidOfInput(inp);
      const prev = this.prevOut.get(`${prevTxid}:${inp.index}`);
      if (prev) inSum += prev.value;
      else complete = false;
      return {
        txid: prevTxid,
        vout: inp.index,
        sequence: inp.sequence,
        is_coinbase: false,
        prevout: prev
          ? { scriptpubkey: hex(prev.script), scriptpubkey_address: addressOf(prev.script), value: prev.value }
          : null,
      };
    });
    const vout = tx.outs.map((o) => ({
      scriptpubkey: hex(o.script),
      scriptpubkey_address: addressOf(o.script),
      value: Number(o.value),
    }));
    const outSum = vout.reduce((s, o) => s + o.value, 0);
    return {
      txid,
      version: tx.version,
      locktime: tx.locktime,
      vin,
      vout,
      size: tx.byteLength(),
      weight: tx.weight(),
      ...(complete ? { fee: inSum - outSum } : {}),
      status: this.confirmed.has(txid) ? { confirmed: true, block_height: 900_000 } : { confirmed: false },
    };
  }

  /** Esplora's `GET /tx/:txid/outspends`: which transaction, if any, spends each output. */
  private outspends(txid: string) {
    const tx = bitcoin.Transaction.fromHex(this.raw.get(txid)!);
    return tx.outs.map((_o, vout) => {
      for (const [otherId, otherHex] of this.raw) {
        if (otherId === txid) continue;
        const other = bitcoin.Transaction.fromHex(otherHex);
        const at = other.ins.findIndex((i) => txidOfInput(i) === txid && i.index === vout);
        if (at >= 0) {
          return { spent: true, txid: otherId, vin: at, status: { confirmed: this.confirmed.has(otherId) } };
        }
      }
      return { spent: false };
    });
  }

  private list(a: string) {
    return this.utxos.get(addrKey(a)) ?? [];
  }
  private bal(a: string) {
    return this.list(a).reduce((s, u) => s + u.value, 0);
  }
  private isUsed(a: string) {
    return this.used.has(addrKey(a));
  }

  /** Record a push and apply `onPush`. */
  private push(
    via: string,
    method: string,
    url: string,
    hexTx: string,
    rawBody: string,
    contentType: string | undefined,
    ok: (txid: string) => { status: number; body: string },
  ): Reply {
    this.pushes.push({ via, url, hex: hexTx, rawBody, contentType, method });
    let txid = "";
    try {
      txid = bitcoin.Transaction.fromHex(hexTx).getId();
    } catch {
      return { status: 400, body: JSON.stringify({ error: "-22: TX decode failed" }) };
    }
    const outcome = this.onPush(via, hexTx, txid);
    if (outcome === "accept") {
      this.relay(hexTx);
      return ok(txid);
    }
    if (outcome === "relay-then-drop") {
      this.relay(hexTx);
      return "drop";
    }
    if (outcome === "drop") return "drop";
    return outcome;
  }

  handle(method: string, url: string, body?: string, contentType?: string): Reply {
    this.requests.push(`${method} ${url}`);
    const u = new URL(url);
    const host = u.hostname;
    const p = u.pathname;
    const q = u.searchParams;
    const J = (o: unknown, status = 200) => ({ status, body: JSON.stringify(o) });
    const notFound = { status: 404, body: "Transaction not found" };

    // ── Esplora: blockstream.info, mempool.space, litecoinspace.org ──────────
    if (host === "blockstream.info" || host === "mempool.space" || host === "litecoinspace.org") {
      const base = p.replace(/^\/api/, "");
      if (method === "POST" && base === "/tx") {
        const h = (body ?? "").trim();
        return this.push("esplora:" + host, method, url, h, body ?? "", contentType, (txid) => ({
          status: 200,
          body: txid,
        }));
      }
      if (base === "/fee-estimates") return J(this.fees.esplora);
      if (base === "/v1/fees/recommended") return J(this.fees.mempoolRecommended);
      let m = /^\/address\/([^/]+)\/utxo$/.exec(base);
      if (m) {
        return J(this.list(m[1]).map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, status: { confirmed: true } })));
      }
      m = /^\/address\/([^/]+)$/.exec(base);
      if (m) {
        const b = this.bal(m[1]);
        const used = this.isUsed(m[1]);
        return J({
          chain_stats: { funded_txo_sum: used ? Math.max(b, 1) : 0, spent_txo_sum: used ? Math.max(b, 1) - b : 0, tx_count: used ? 1 : 0 },
          mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
        });
      }
      m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(base);
      if (m) return this.raw.has(m[1]) ? { status: 200, body: this.raw.get(m[1])! } : notFound;
      m = /^\/tx\/([0-9a-f]{64})\/outspends$/.exec(base);
      if (m) return this.raw.has(m[1]) ? J(this.outspends(m[1])) : notFound;
      m = /^\/tx\/([0-9a-f]{64})$/.exec(base);
      if (m) {
        if (this.raw.has(m[1])) return J(this.esploraTx(m[1], host));
        return this.mempool.has(m[1]) ? J({ txid: m[1], status: { confirmed: false } }) : notFound;
      }
    }

    // ── BlockCypher (LTC / DOGE / DASH) ──────────────────────────────────────
    if (host === "api.blockcypher.com") {
      const rest = "/" + p.split("/").slice(4).join("/");
      if (method === "POST" && rest === "/txs/push") {
        const h = String(JSON.parse(body ?? "{}").tx ?? "");
        return this.push("blockcypher", method, url, h, body ?? "", contentType, (txid) => ({
          status: 201,
          body: JSON.stringify({ tx: { hash: txid } }),
        }));
      }
      if (rest === "/" || rest === "") {
        const k = this.fees.blockcypherPerKb;
        return J({ height: 1, high_fee_per_kb: k * 2, medium_fee_per_kb: k, low_fee_per_kb: Math.ceil(k / 2) });
      }
      let m = /^\/addrs\/([^/]+)\/balance$/.exec(rest);
      if (m) {
        const used = this.isUsed(m[1]);
        return J({ balance: this.bal(m[1]), unconfirmed_balance: 0, n_tx: used ? 1 : 0, final_n_tx: used ? 1 : 0 });
      }
      m = /^\/addrs\/([^/]+)$/.exec(rest);
      if (m && q.get("unspentOnly") === "true") {
        return J({ txrefs: this.list(m[1]).map((x) => ({ tx_hash: x.txid, tx_output_n: x.vout, value: x.value })) });
      }
      m = /^\/txs\/([0-9a-f]{64})$/.exec(rest);
      if (m) {
        if (q.get("includeHex") === "true") {
          return this.raw.has(m[1]) ? J({ hash: m[1], hex: this.raw.get(m[1]) }) : J({ error: "not found" }, 404);
        }
        return this.mempool.has(m[1]) ? J({ hash: m[1] }) : J({ error: `Transaction ${m[1]} not found.` }, 404);
      }
    }

    // ── Blockchair (LTC / DOGE / DASH / BCH) ─────────────────────────────────
    if (host === "api.blockchair.com") {
      const rest = "/" + p.split("/").slice(2).join("/");
      if (method === "POST" && rest === "/push/transaction") {
        const h = decodeURIComponent(/data=([^&]*)/.exec(body ?? "")?.[1] ?? "");
        return this.push("blockchair", method, url, h, body ?? "", contentType, (txid) =>
          J({ data: { transaction_hash: txid }, context: { code: 200 } }),
        );
      }
      if (rest === "/stats") {
        return J({ data: { blocks: 1, suggested_transaction_fee_per_byte_sat: this.fees.blockchairPerByte } });
      }
      let m = /^\/dashboards\/address\/([^/]+)$/.exec(rest);
      if (m) {
        const a = decodeURIComponent(m[1]);
        const entry = {
          address: { balance: this.bal(a), transaction_count: this.isUsed(a) ? 1 : 0, received: this.bal(a), spent: 0 },
          transactions: [],
          utxo: this.list(a).map((x) => ({ transaction_hash: x.txid, index: x.vout, value: x.value })),
        };
        return J({ data: { [a]: entry, [a.replace(/^bitcoincash:/i, "")]: entry } });
      }
      m = /^\/raw\/transaction\/([0-9a-f]{64})$/.exec(rest);
      if (m) return this.raw.has(m[1]) ? J({ data: { [m[1]]: { raw_transaction: this.raw.get(m[1]) } } }) : J({ data: {} });
      m = /^\/dashboards\/transaction\/([0-9a-f]{64})$/.exec(rest);
      if (m) {
        return this.mempool.has(m[1])
          ? J({ data: { [m[1]]: { transaction: { hash: m[1] } } } })
          : J({ data: [], context: { code: 404 } });
      }
    }

    // ── Bitpay Bitcore ───────────────────────────────────────────────────────
    if (host === "api.bitcore.io") {
      if (method === "POST" && p.endsWith("/tx/send")) {
        const h = String(JSON.parse(body ?? "{}").rawTx ?? "");
        return this.push("bitcore", method, url, h, body ?? "", contentType, (txid) => J({ txid }));
      }
      let m = /\/fee\/(\d+)$/.exec(p);
      if (m) return J({ feerate: 0.00001, blocks: Number(m[1]) });
      m = /\/tx\/([0-9a-f]{64})$/.exec(p);
      if (m) return this.mempool.has(m[1]) ? J({ txid: m[1] }) : notFound;
      m = /\/address\/([^/]+)\/txs$/.exec(p);
      if (m) return J(this.isUsed(m[1]) ? [{ mintTxid: "x" }] : []);
      m = /\/address\/([^/]+)\/balance$/.exec(p);
      if (m) return J({ confirmed: this.bal(m[1]), unconfirmed: 0 });
      m = /\/address\/([^/]+)\/$/.exec(p);
      if (m) return J(this.list(m[1]).map((x) => ({ mintTxid: x.txid, mintIndex: x.vout, value: x.value })));
    }

    // ── haskoin-store (BCH) ──────────────────────────────────────────────────
    if (host === "api.blockchain.info" || host === "api.haskoin.com") {
      if (method === "POST" && p.endsWith("/transactions")) {
        const h = (body ?? "").trim();
        return this.push("haskoin:" + host, method, url, h, body ?? "", contentType, (txid) => J({ txid }));
      }
      if (p.endsWith("/address/balances")) {
        const list = (q.get("addresses") ?? "").split(",").filter(Boolean);
        return J(
          list.map((a) => {
            const used = this.isUsed(a);
            const b = this.bal(a);
            return { address: a, confirmed: b, unconfirmed: 0, utxo: this.list(a).length, txs: used ? 1 : 0, received: used ? Math.max(b, 1) : 0 };
          }),
        );
      }
      let m = /\/address\/([^/]+)\/balance$/.exec(p);
      if (m) {
        const a = decodeURIComponent(m[1]);
        const used = this.isUsed(a);
        const b = this.bal(a);
        return J({ address: a, confirmed: b, unconfirmed: 0, txs: used ? 1 : 0, received: used ? Math.max(b, 1) : 0 });
      }
      m = /\/address\/([^/]+)\/unspent$/.exec(p);
      if (m) return J(this.list(m[1]).map((x) => ({ txid: x.txid, index: x.vout, value: x.value })));
      m = /\/transaction\/([0-9a-f]{64})$/.exec(p);
      if (m) return this.mempool.has(m[1]) ? J({ txid: m[1] }) : J({ error: "not-found-or-invalid-arg" }, 404);
    }

    // ── FullStack (dead in reality: a marketing SPA answers every path) ──────
    if (host === "bchn.fullstack.cash") {
      if (method === "POST") this.pushes.push({ via: "fullstack", url, hex: "", rawBody: body ?? "", contentType, method });
      return { status: 200, body: "<!doctype html><html><body>marketing</body></html>" };
    }

    // ── dogechain.info ───────────────────────────────────────────────────────
    if (host === "dogechain.info") {
      if (method === "POST" && p.endsWith("/pushtx")) {
        const h = String(JSON.parse(body ?? "{}").tx ?? "");
        return this.push("dogechain", method, url, h, body ?? "", contentType, (txid) => J({ success: 1, tx_hash: txid }));
      }
      return { status: 403, body: "<html>Just a moment...</html>" };
    }

    // ── Ravencoin BlockBook ──────────────────────────────────────────────────
    if (host === "blockbook.ravencoin.org") {
      if (p === "/api/v2/sendtx" || p === "/api/v2/sendtx/") {
        if (method === "POST" && p === "/api/v2/sendtx") {
          // The real host answers 301 to the slash-less path, and the proxy's
          // HTTP client re-sends the redirect as a bodiless GET.
          this.pushes.push({ via: "blockbook-redirected", url, hex: "", rawBody: body ?? "", contentType, method });
          return J({ error: "Missing tx blob" }, 400);
        }
        if (method !== "POST") return J({ error: "Missing tx blob" }, 400);
        const raw = body ?? "";
        if (!/^[0-9a-fA-F]+$/.test(raw)) {
          // The node's `sendrawtransaction` of a body that is not pure hex.
          this.pushes.push({ via: "blockbook", url, hex: "", rawBody: raw, contentType, method });
          return J({ error: "-22: TX decode failed" }, 400);
        }
        return this.push("blockbook", method, url, raw, raw, contentType, (txid) => J({ result: txid }));
      }
      let m = /^\/api\/v2\/utxo\/([^/]+)$/.exec(p);
      if (m) return J(this.list(m[1]).map((x) => ({ txid: x.txid, vout: x.vout, value: String(x.value), confirmations: 10 })));
      m = /^\/api\/v2\/tx\/([0-9a-f]{64})$/.exec(p);
      if (m) {
        if (this.raw.has(m[1])) {
          const tx = bitcoin.Transaction.fromHex(this.raw.get(m[1])!);
          return J({ txid: m[1], hex: this.raw.get(m[1]), vout: tx.outs.map((o, n) => ({ n, value: String(o.value), hex: hex(o.script) })) });
        }
        return this.mempool.has(m[1]) ? J({ txid: m[1] }) : J({ error: "Transaction not found" }, 400);
      }
      if (/^\/api\/v2\/estimatefee\/\d+$/.test(p)) return J({ result: this.fees.blockbookPerKb });
      m = /^\/api\/v2\/address\/([^/]+)$/.exec(p);
      if (m) return J({ address: m[1], balance: String(this.bal(m[1])), unconfirmedBalance: "0", txs: this.isUsed(m[1]) ? 1 : 0 });
    }

    // ── Insight mirrors: RVN's two are dead (as the audit found them) ────────
    if (host === "api.ravencoin.org" || host === "rvn.cryptoscope.io") {
      if (method === "POST") this.pushes.push({ via: "insight:" + host, url, hex: "", rawBody: body ?? "", contentType, method });
      return { status: 404, body: "<html><body>Not Found</body></html>" };
    }
    if (host === "insight.dash.org") {
      let m = /\/addr\/([^/]+)$/.exec(p);
      if (m) return J({ balanceSat: this.bal(m[1]), unconfirmedBalanceSat: 0 });
      m = /\/tx\/([0-9a-f]{64})$/.exec(p);
      if (m) return this.mempool.has(m[1]) ? J({ txid: m[1] }) : notFound;
    }

    this.unknown.push(`${method} ${url}`);
    return { status: 404, body: "not found (fake)" };
  }

  /**
   * Stand-in for `invoke("http_proxy_call", …)`. A test wires it up with
   * `vi.stubGlobal("__utxoFakeInvoke", fake.invokeImpl)` plus a
   * `vi.mock("../lib/tauri", …)` that forwards to that global (vi.mock is
   * hoisted per test file, so it cannot live in this module). A dropped reply
   * rejects with the proxy's own error shape: a plain string.
   */
  invokeImpl = async (cmd: string, args: any) => {
    if (cmd !== "http_proxy_call") throw new Error("unexpected invoke " + cmd);
    const headers: Array<{ name: string; value: string }> = args.headers ?? [];
    const ct = headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
    const r = this.handle(String(args.method).toUpperCase(), args.url, args.body, ct);
    if (r === "drop") throw `http request to ${args.url} failed: operation timed out`;
    return { status: r.status, body: r.body, headers: [] };
  };

  /** Stand-in for `fetch` (BTC's Esplora calls): `vi.stubGlobal("fetch", fake.fetchImpl)`. */
  fetchImpl = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    const r = this.handle(String(init?.method ?? "GET").toUpperCase(), url, init?.body);
    if (r === "drop") throw new TypeError("Failed to fetch");
    return new Response(r.body, { status: r.status });
  };

  /** Every distinct transaction pushed, by hex. */
  distinctPushedHex(): string[] {
    return [...new Set(this.pushes.map((p) => p.hex).filter(Boolean))];
  }
}

// ── Independent verification of a signed transaction ──────────────────────

export type SigKind = "p2wpkh" | "p2pkh" | "bch";

export interface Verified {
  ok: boolean;
  problems: string[];
  inputs: number;
  outputs: Array<{ scriptHex: string; value: number }>;
  fee: number;
  vsize: number;
  txid: string;
}

/**
 * Check every input's signature against a sighash computed by bitcoinjs-lib's
 * own `Transaction` methods — never the adapter's — with tiny-secp256k1 doing
 * the ECDSA verify. BCH's replay-protected sighash is BIP-143 with the FORKID
 * bit, which `hashForWitnessV0` computes when handed hashtype 0x41.
 */
export function verifySignedTx(
  txHex: string,
  kind: SigKind,
  prevOut: Map<string, { script: Uint8Array; value: number }>,
): Verified {
  const tx = bitcoin.Transaction.fromHex(txHex);
  const problems: string[] = [];
  let inSum = 0;
  tx.ins.forEach((inp, i) => {
    const prev = prevOut.get(`${txidOfInput(inp)}:${inp.index}`);
    if (!prev) {
      problems.push(`input ${i} spends an unknown outpoint`);
      return;
    }
    inSum += prev.value;
    let sigT: Uint8Array;
    let pub: Uint8Array;
    if (kind === "p2wpkh") {
      [sigT, pub] = inp.witness as unknown as [Uint8Array, Uint8Array];
    } else {
      const chunks = bitcoin.script.decompile(inp.script) as Uint8Array[];
      if (!chunks || chunks.length !== 2) {
        problems.push(`input ${i}: scriptSig is not [sig, pubkey]`);
        return;
      }
      [sigT, pub] = chunks;
    }
    const hashType = sigT[sigT.length - 1];
    const d = bitcoin.script.signature.decode(
      Buffer.concat([Buffer.from(sigT.subarray(0, sigT.length - 1)), Buffer.from([0x01])]),
    );
    const lock =
      kind === "p2wpkh"
        ? bitcoin.payments.p2wpkh({ hash: Buffer.from(h160(pub)) }).output!
        : bitcoin.payments.p2pkh({ hash: Buffer.from(h160(pub)) }).output!;
    if (hex(lock) !== hex(prev.script)) problems.push(`input ${i}: key does not own the spent output`);
    let digest: Uint8Array;
    if (kind === "p2wpkh") {
      const code = bitcoin.payments.p2pkh({ hash: Buffer.from(h160(pub)) }).output!;
      digest = tx.hashForWitnessV0(i, code, BigInt(prev.value), hashType);
    } else if (kind === "p2pkh") {
      digest = tx.hashForSignature(i, prev.script, hashType);
    } else {
      if (hashType !== 0x41) problems.push(`input ${i}: BCH hashtype 0x${hashType.toString(16)}`);
      digest = tx.hashForWitnessV0(i, prev.script, BigInt(prev.value), 0x41);
    }
    if (!tinysecp.verify(digest, pub, Uint8Array.from(d.signature))) {
      problems.push(`input ${i}: signature does not verify`);
    }
  });
  const outputs = tx.outs.map((o) => ({ scriptHex: hex(o.script), value: Number(o.value) }));
  const outSum = outputs.reduce((s, o) => s + o.value, 0);
  return {
    ok: problems.length === 0,
    problems,
    inputs: tx.ins.length,
    outputs,
    fee: inSum - outSum,
    vsize: tx.virtualSize(),
    txid: tx.getId(),
  };
}
