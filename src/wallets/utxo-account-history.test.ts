/**
 * A UTXO account's history: one row per transaction, netted across all of the
 * account's addresses (2026-09-30).
 *
 * # The incident
 *
 * The operator's Activity screen listed one Litecoin transaction five times,
 * each as "▼ recv +4.02888049 LTC". It is the 2026-08-22 send that put the
 * change on change/20: ONE input of 4.32888299 LTC from the primary address,
 * 0.3 LTC to someone else, 4.02888049 LTC change to change/20 of the same
 * account, a 250-lit fee. The right row is one SEND: 0.3 LTC, fee 0.0000025,
 * to the external address.
 *
 * The shape below is that transaction's, value for value. The addresses are
 * derived from the public test seed instead of copied from the operator's
 * wallet: this file is published.
 *
 * The rows are produced by the REAL adapter parsers (Esplora, BlockCypher,
 * BlockCypher txrefs for DASH) behind a stubbed explorer, then merged by
 * `accountTxHistory` — the merge the Activity views need (fixlog-btc-accounts.md
 * names the call sites that still list one address's rows per address).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";

vi.mock("../lib/tauri", () => ({
  invoke: (cmd: string, args: unknown) => (globalThis as any).__utxoFakeInvoke(cmd, args),
}));

import { accountTxHistory, netAccountTx } from "./utxo-account-history";
import { esploraTxToChainTx, type EsploraTx } from "./esplora-history";
import { ltcAdapter, ltcUtxoAccounts } from "./ltc-wallet";
import { btcAdapter } from "./btc-wallet";
import { dashAdapter } from "./dash-wallet";
import { deriveUtxoAddresses } from "./utxo-account";
import type { ChainTx } from "./types";

const M =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(M, ""));
const LTC = ltcUtxoAccounts[0];
const ltcAt = (chain: 0 | 1, i: number) => deriveUtxoAddresses(M, LTC, chain, i, 1)[0].address;

// The account: the primary address, and the change addresses its scan found.
const PRIMARY = ltcAt(0, 0);
const CHANGE = [0, 1, 2, 20].map((i) => ltcAt(1, i));
const CHANGE20 = ltcAt(1, 20);
// Someone else's address: another account of the seed, never scanned.
const EXTERNAL = bitcoin.payments.p2wpkh({
  pubkey: Buffer.from(root.derive("m/84'/2'/7'/0/0").publicKey!),
  network: { messagePrefix: "", bech32: "ltc", bip32: { public: 0, private: 0 }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 },
}).address!;

const TXID = "e2e3000000000000000000000000000000000000000000000000000000000001";
const BLOCK_TIME = 1787400000; // 2026-08-22

/** The incident transaction as Esplora (litecoinspace) returns it. */
const SEND: EsploraTx = {
  txid: TXID,
  fee: 250,
  status: { confirmed: true, block_height: 3160000, block_time: BLOCK_TIME },
  vin: [{ prevout: { scriptpubkey_address: PRIMARY, value: 432_888_299 } }],
  vout: [
    { scriptpubkey_address: EXTERNAL, value: 30_000_000 },
    { scriptpubkey_address: CHANGE20, value: 402_888_049 },
  ],
};

afterEach(() => vi.unstubAllGlobals());

/** Stub the Rust proxy: `routes(url)` answers, anything else is a 404. */
function stubProxy(routes: (url: string) => { status: number; body: unknown } | null) {
  const asked: string[] = [];
  vi.stubGlobal("__utxoFakeInvoke", async (cmd: string, args: any) => {
    if (cmd !== "http_proxy_call") throw new Error("unexpected invoke " + cmd);
    asked.push(args.url);
    const r = routes(args.url);
    if (!r) return { status: 404, body: "not found", headers: [] };
    return { status: r.status, body: typeof r.body === "string" ? r.body : JSON.stringify(r.body), headers: [] };
  });
  return asked;
}

/** Per-address history for every pair, as `useTxHistory` keys it. */
async function historyByKey(
  chain: "litecoin" | "bitcoin" | "dash",
  addresses: string[],
  adapter: { getTransactionHistory(a: string): Promise<{ items: ChainTx[] }> },
): Promise<Record<string, ChainTx[]>> {
  const out: Record<string, ChainTx[]> = {};
  for (const a of addresses) out[`${chain}:${a}`] = (await adapter.getTransactionHistory(a)).items;
  return out;
}

describe("the 2026-08-22 LTC send, as the account sees it (Activity showed it 5× as '+4.02888049 LTC')", () => {
  it("per address it is a 4.32888299 send from the primary and a 4.02888049 RECEIPT at change/20", () => {
    // Each true from its own address's point of view — and the second is the
    // row the Activity screen repeated.
    expect(esploraTxToChainTx(SEND, PRIMARY, "litecoin")).toMatchObject({ direction: "out", amount: "4.32888299" });
    expect(esploraTxToChainTx(SEND, CHANGE20, "litecoin")).toMatchObject({ direction: "in", amount: "4.02888049" });
  });

  it("the account row: ONE send of 0.3 LTC, fee 0.0000025, to the external address", async () => {
    stubProxy((url) =>
      /litecoinspace\.org\/api\/address\/[^/]+\/txs$/.test(url)
        ? { status: 200, body: url.includes(PRIMARY) || url.includes(CHANGE20) ? [SEND] : [] }
        : null,
    );
    const byKey = await historyByKey("litecoin", [PRIMARY, ...CHANGE], ltcAdapter);

    const rows = accountTxHistory(byKey, "litecoin");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hash: TXID,
      direction: "out",
      amount: "0.30000000",
      fee: "0.00000250",
      counterparty: EXTERNAL,
      timestamp: BLOCK_TIME,
    });
    // The account's balance change, fee included, stays available.
    expect(rows[0].meta?.netSat).toBe(-30_000_250);
  });

  it("how five copies of the change row arose — a model of App.tsx:618-626 and the Activity views' loop", async () => {
    stubProxy((url) =>
      /litecoinspace\.org\/api\/address\/[^/]+\/txs$/.test(url)
        ? { status: 200, body: url.includes(PRIMARY) || url.includes(CHANGE20) ? [SEND] : [] }
        : null,
    );
    const byKey = await historyByKey("litecoin", [PRIMARY, ...CHANGE], ltcAdapter);

    // App.tsx: `ownedChains = txPairs.map((p) => p.chain)` — one entry per
    // PAIR — and `addressByChain[chain] = p.address` for each pair in turn,
    // so the LAST pair's address wins (change/20: the scan's highest entry).
    const txPairs = [PRIMARY, ...CHANGE].map((address) => ({ chain: "litecoin", address }));
    const ownedChains = txPairs.map((p) => p.chain);
    const addressByChain: Record<string, string> = {};
    for (const p of txPairs) addressByChain[p.chain] = p.address;
    // ActivityLandscapeView / ActivityViewPortrait / ActivityView: one
    // per-address list per ENTRY of `chainsOwned`.
    const shown: ChainTx[] = [];
    for (const c of ownedChains) shown.push(...(byKey[`${c}:${addressByChain[c] ?? ""}`] ?? []));

    expect(shown).toHaveLength(5);
    expect(shown.every((r) => r.direction === "in" && r.amount === "4.02888049")).toBe(true);
    // What those views should list instead:
    expect(accountTxHistory(byKey, "litecoin")).toHaveLength(1);
  });

  it("the same row from BlockCypher when litecoinspace is down — even with the change listed first", async () => {
    // BlockCypher's /full shape. Change FIRST: a per-address counterparty is
    // "the first output that is not this address", which from the primary is
    // our own change — the account needs every output address to do better.
    const full = {
      hash: TXID,
      confirmed: "2026-08-22T00:00:00Z",
      confirmations: 5000,
      block_height: 3160000,
      fees: 250,
      inputs: [{ addresses: [PRIMARY], output_value: 432_888_299 }],
      outputs: [
        { addresses: [CHANGE20], value: 402_888_049 },
        { addresses: [EXTERNAL], value: 30_000_000 },
      ],
    };
    stubProxy((url) => {
      if (url.includes("litecoinspace.org")) return { status: 503, body: "down" };
      const m = /api\.blockcypher\.com\/v1\/ltc\/main\/addrs\/([^/?]+)\/full/.exec(url);
      if (m) return { status: 200, body: { txs: m[1] === PRIMARY || m[1] === CHANGE20 ? [full] : [] } };
      return null;
    });
    const byKey = await historyByKey("litecoin", [PRIMARY, ...CHANGE], ltcAdapter);
    const rows = accountTxHistory(byKey, "litecoin");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: "out", amount: "0.30000000", fee: "0.00000250", counterparty: EXTERNAL });
  });
});

describe("the netting rules, for every UTXO chain (2026-09-30)", () => {
  const own = (...a: string[]) => new Set(a);
  const esplora = (tx: EsploraTx, a: string) => esploraTxToChainTx(tx, a, "litecoin");

  it("a self-transfer (every output ours) is `self`, with the fee — never a receipt", () => {
    const tx: EsploraTx = {
      txid: "aa".repeat(32),
      fee: 300,
      status: { confirmed: true, block_time: 1 },
      vin: [
        { prevout: { scriptpubkey_address: CHANGE[0], value: 1_000 } },
        { prevout: { scriptpubkey_address: CHANGE[1], value: 2_000 } },
      ],
      vout: [{ scriptpubkey_address: PRIMARY, value: 2_700 }],
    };
    const row = netAccountTx(
      [esplora(tx, CHANGE[0]), esplora(tx, CHANGE[1]), esplora(tx, PRIMARY)],
      own(PRIMARY, CHANGE[0], CHANGE[1]),
      "litecoin",
    );
    expect(row).toMatchObject({ direction: "self", amount: "0.00000000", fee: "0.00000300", counterparty: undefined });
  });

  it("a payment from someone else is a receipt of what reached us, with no fee of ours", () => {
    const tx: EsploraTx = {
      txid: "bb".repeat(32),
      fee: 500,
      status: { confirmed: true, block_time: 2 },
      vin: [{ prevout: { scriptpubkey_address: EXTERNAL, value: 10_000_000 } }],
      vout: [
        { scriptpubkey_address: PRIMARY, value: 1_000_000 },
        { scriptpubkey_address: EXTERNAL, value: 8_999_500 },
      ],
    };
    const row = netAccountTx([esplora(tx, PRIMARY)], own(PRIMARY), "litecoin");
    expect(row).toMatchObject({ direction: "in", amount: "0.01000000", fee: undefined });
  });

  it("a co-funded transaction (an input that is not ours) keeps the whole outflow and does not claim the fee", () => {
    const tx: EsploraTx = {
      txid: "cc".repeat(32),
      fee: 1_000,
      status: { confirmed: true, block_time: 3 },
      vin: [
        { prevout: { scriptpubkey_address: PRIMARY, value: 5_000_000 } },
        { prevout: { scriptpubkey_address: EXTERNAL, value: 5_000_000 } },
      ],
      vout: [{ scriptpubkey_address: EXTERNAL, value: 9_999_000 }],
    };
    const row = netAccountTx([esplora(tx, PRIMARY)], own(PRIMARY), "litecoin");
    expect(row).toMatchObject({ direction: "out", amount: "0.05000000", fee: undefined });
  });

  it("an unconfirmed send stays pending, netted, with the arrow in meta.netDirection", () => {
    const unconfirmed = { ...SEND, status: { confirmed: false } };
    const row = netAccountTx(
      [esplora(unconfirmed, PRIMARY), esplora(unconfirmed, CHANGE20)],
      own(PRIMARY, CHANGE20),
      "litecoin",
    );
    expect(row).toMatchObject({ direction: "pending", amount: "0.30000000", fee: "0.00000250", confirmations: 0 });
    expect(row.meta?.netDirection).toBe("out");
  });

  it("the same txid twice under one address is counted once", () => {
    const r = esplora(SEND, PRIMARY);
    const rows = accountTxHistory(
      { [`litecoin:${PRIMARY}`]: [r, { ...r }], [`litecoin:${CHANGE20}`]: [esplora(SEND, CHANGE20)] },
      "litecoin",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe("0.30000000");
  });

  it("BCH: CashAddr with and without the prefix is one address", () => {
    const me = "qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6";
    const other = "qz9vvrfhvhs4nj0drapgs4hmk5ucw0gjr5drfylfxj";
    const rowMe: ChainTx = {
      chain: "bitcoin-cash",
      hash: "dd".repeat(32),
      direction: "out",
      amount: "0.10000500",
      fee: "0.00000500",
      timestamp: 4,
      meta: {
        netSat: -10_000_500,
        inputs: [`bitcoincash:${me}`],
        outputs: [`bitcoincash:${other}`, `bitcoincash:${me}`],
      },
    };
    const rows = accountTxHistory({ [`bitcoin-cash:bitcoincash:${me}`]: [rowMe] }, "bitcoin-cash");
    expect(rows[0]).toMatchObject({ direction: "out", amount: "0.10000000", counterparty: `bitcoincash:${other}` });
  });

  it("a row set it cannot sign is left as it was, not netted from half a picture", () => {
    const a: ChainTx = { chain: "litecoin", hash: "ee".repeat(32), direction: "pending", amount: "3.0" };
    const b: ChainTx = { chain: "litecoin", hash: "ee".repeat(32), direction: "pending", amount: "2.0" };
    expect(netAccountTx([a, b], own("x", "y"), "litecoin")).toBe(a);
  });
});

describe("BTC rows carry what the account merge needs (2026-09-30)", () => {
  it("getTransactionHistory maps through the shared Esplora mapper: signed net, inputs, outputs", async () => {
    const shown = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
    const ext = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
    const tx: EsploraTx = {
      txid: "ff".repeat(32),
      fee: 141,
      status: { confirmed: true, block_time: 5, block_height: 900000 },
      vin: [{ prevout: { scriptpubkey_address: shown, value: 100_000 } }],
      vout: [
        { scriptpubkey_address: ext, value: 60_000 },
        { scriptpubkey_address: shown, value: 39_859 },
      ],
    };
    vi.stubGlobal("fetch", async (input: any) =>
      String(input).endsWith(`/address/${shown}/txs`)
        ? new Response(JSON.stringify([tx]), { status: 200 })
        : new Response("not found", { status: 404 }),
    );
    const [row] = (await btcAdapter.getTransactionHistory(shown)).items;
    expect(row).toMatchObject({ direction: "out", amount: "0.00060141", fee: "0.00000141", counterparty: ext });
    expect(row.meta).toMatchObject({ netSat: -60_141, inputs: [shown], outputs: [ext, shown] });
    // …so the account row splits the fee out.
    expect(accountTxHistory({ [`bitcoin:${shown}`]: [row] }, "bitcoin")[0]).toMatchObject({
      direction: "out",
      amount: "0.00060000",
      fee: "0.00000141",
    });
  });
});

describe("DASH lists ONE row per transaction, not one per txref (2026-09-30)", () => {
  const ADDR = "XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5";
  const txref = (o: Partial<Record<string, unknown>>) => ({
    tx_hash: "12".repeat(32),
    block_height: 2000000,
    confirmations: 10,
    confirmed: "2026-09-01T00:00:00Z",
    spent: false,
    tx_input_n: -1,
    tx_output_n: -1,
    value: 0,
    ...o,
  });

  it("a send with change back to the same address is one 'out' of the difference", async () => {
    stubProxy((url) =>
      url.includes(`/v1/dash/main/addrs/${ADDR}?`)
        ? {
            status: 200,
            body: {
              txrefs: [
                // BlockCypher: one ref for the input it spent, one for the change.
                txref({ tx_input_n: 0, value: 100_000_000, spent: true }),
                txref({ tx_output_n: 1, value: 69_990_000 }),
              ],
            },
          }
        : null,
    );
    const { items } = await dashAdapter.getTransactionHistory(ADDR);
    // Was two rows of one txid: "out 1.0" and "in 0.6999".
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ direction: "out", amount: "0.30010000" });
    expect(items[0].meta?.netSat).toBe(-30_010_000);
  });

  it("a source that fails is an error, not an empty history the hook would store", async () => {
    stubProxy(() => ({ status: 429, body: "Limits reached." }));
    await expect(dashAdapter.getTransactionHistory(ADDR)).rejects.toThrow(/429/);
  });
});
