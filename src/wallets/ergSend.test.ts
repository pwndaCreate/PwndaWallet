/**
 * Ergo sends against a scripted explorer (2026-09-29 send-safety audit).
 *
 * `fetch` is the only fake. Box selection, Fleet's transaction builder and
 * its prover are the real code, signing with the abandon seed's Ergo key.
 *
 * The finding: the send read the first 200 unspent boxes only
 * (`offset=0&limit=200`). A mining payout address collects one box per
 * payout, so past 200 the send refused with "Insufficient balance" while the
 * balance on screen said otherwise.
 */
import { ErgoAddress, ErgoBox } from "@fleet-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ergoAdapter } from "./erg-wallet";
import { isSendOutcomeUnknown } from "./send-outcome";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const me = ergoAdapter.deriveFromMnemonic(ABANDON);
// A second real P2PK address to pay: the same seed, another index.
const other = ergoAdapter.deriveAtPath!(ABANDON, "m/44'/429'/0'/0/1").address;

const hex64 = (n: number) => n.toString(16).padStart(64, "0");
/** An unspent box of `me`, with the id its contents hash to (Fleet checks it). */
const box = (n: number, nanoErg: bigint) =>
  new ErgoBox(
    {
      value: nanoErg,
      ergoTree: ErgoAddress.fromBase58(me.address).ergoTree,
      creationHeight: 1_400_000,
      assets: [],
      additionalRegisters: {},
    },
    hex64(100_000 + n),
    0,
  ).toPlainObject("EIP-12");

let pages: Array<ReturnType<typeof box>[]>;
let total: number;
let requested: string[];
let submitted: any[];
/** Per mirror, in order: how submit answers ("throw" = no answer). Default: accept. */
let submitAnswers: Array<number | "throw">;

beforeEach(() => {
  requested = [];
  submitted = [];
  submitAnswers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      requested.push(u.pathname + u.search);
      if (u.pathname.endsWith("/info")) {
        return new Response(JSON.stringify({ height: 1_500_000 }), { status: 200 });
      }
      if (u.pathname.includes(`/boxes/unspent/byAddress/${me.address}`)) {
        const offset = Number(u.searchParams.get("offset"));
        const limit = Number(u.searchParams.get("limit"));
        const page = pages[Math.floor(offset / limit)] ?? [];
        return new Response(JSON.stringify({ items: page, total }), { status: 200 });
      }
      if (u.pathname.endsWith("/mempool/transactions/submit") && init?.method === "POST") {
        const tx = JSON.parse(String(init.body));
        submitted.push(tx);
        const answer = submitAnswers.shift();
        if (answer === "throw") throw new TypeError("Failed to fetch");
        if (answer !== undefined) return new Response("scripted", { status: answer });
        return new Response(JSON.stringify({ id: tx.id }), { status: 200 });
      }
      return new Response("not scripted", { status: 500 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ergo reads every unspent box, not the first 200 (2026-09-29 send-safety audit)", () => {
  it("finds the funds on the second page", async () => {
    // 200 payout-sized boxes (0.01 ERG, 2 ERG in all), then 60 boxes of 1 ERG.
    pages = [
      Array.from({ length: 200 }, (_, n) => box(n, 10_000_000n)),
      Array.from({ length: 60 }, (_, n) => box(200 + n, 1_000_000_000n)),
    ];
    total = 260;
    const r = await ergoAdapter.sendTransaction(me.privateKey, other, "10");
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(requested.some((p) => p.includes("offset=200"))).toBe(true);
    // Largest first across BOTH pages: eleven 1-ERG boxes, none of the dust.
    const secondPage = new Set(pages[1].map((b) => b.boxId));
    const spent: string[] = submitted[0].inputs.map((i: { boxId: string }) => i.boxId);
    expect(new Set(spent).size).toBe(11);
    for (const id of spent) expect(secondPage.has(id), id).toBe(true);
  });

  it("counts a box once when it moves between pages while they are read", async () => {
    const big = Array.from({ length: 50 }, (_, n) => box(300 + n, 1_000_000_000n));
    pages = [
      [...Array.from({ length: 199 }, (_, n) => box(n, 10_000_000n)), big[0]],
      big, // big[0] again
    ];
    total = 250;
    await ergoAdapter.sendTransaction(me.privateKey, other, "10");
    const ids = submitted[0].inputs.map((i: { boxId: string }) => i.boxId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("still says 'insufficient' with the real total when every box is read", async () => {
    pages = [Array.from({ length: 20 }, (_, n) => box(n, 100_000_000n))]; // 2 ERG
    total = 20;
    await expect(ergoAdapter.sendTransaction(me.privateKey, other, "5")).rejects.toThrow(
      /Insufficient balance: have 2 ERG/,
    );
    expect(submitted).toEqual([]);
  });
});

// Same class as the audit's six chains: a broadcast no mirror clearly answered.
describe("an Ergo broadcast without a clear answer is 'may have been sent' (2026-09-29 send-safety audit)", () => {
  beforeEach(() => {
    pages = [Array.from({ length: 5 }, (_, n) => box(n, 1_000_000_000n))];
    total = 5;
  });

  it("no answer from either mirror: unknown, with the transaction id", async () => {
    submitAnswers = ["throw", "throw"];
    const e: any = await ergoAdapter.sendTransaction(me.privateKey, other, "1").catch((x) => x);
    expect(isSendOutcomeUnknown(e), String(e)).toBe(true);
    expect(e.hash).toBe(submitted[0].id);
    // The same signed transaction went to both mirrors: nothing re-signed.
    expect(submitted[1].id).toBe(submitted[0].id);
  });

  it("a 5xx on one mirror and a refusal on the other is still unknown", async () => {
    submitAnswers = [502, 400];
    const e: any = await ergoAdapter.sendTransaction(me.privateKey, other, "1").catch((x) => x);
    expect(isSendOutcomeUnknown(e), String(e)).toBe(true);
  });

  it("a refusal from every mirror is an ordinary failure", async () => {
    submitAnswers = [400, 400];
    const e: any = await ergoAdapter.sendTransaction(me.privateKey, other, "1").catch((x) => x);
    expect(isSendOutcomeUnknown(e)).toBe(false);
    expect(e.message).toMatch(/refused by every mirror/);
  });
});
