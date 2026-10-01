/**
 * Stellar dashboard sends, and the signing session around them (2026-09-29
 * send-safety audit).
 *
 * Fakes: Horizon and the Rust commands for Stellar. Everything else is real —
 * stellar-base builds and hashes the transaction, and the fake Rust signer
 * computes the same digest `swap_sign_stellar_tx` does (sha256(network id ||
 * ENVELOPE_TYPE_TX || tx)) with the abandon seed's Stellar key.
 *
 * The Sui sends that were here moved to `suiSend.test.ts` on 2026-10-01, when
 * the send moved to GraphQL (operator request): they faked the SDK's
 * JSON-RPC client and transaction builder, and are tested now against the
 * real builder, with every rule they held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  Account,
  Keypair,
  MuxedAccount,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-base";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));

import { invoke } from "../../lib/tauri";
import {
  SESSION_SEND_TIMING,
  closeSendSession,
  executeStellarTransfer,
} from "./session-send";
import { stellarAdapter } from "../../wallets/stellar-wallet";
import { suiAdapter } from "../../wallets/sui-wallet";
import { isSendOutcomeUnknown } from "../../wallets/send-outcome";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ── The wallets: the abandon seed's keys (Rust derives the same) ──
const xlm = stellarAdapter.deriveFromMnemonic(ABANDON);
const XLM_SEED = Uint8Array.from(Buffer.from(xlm.privateKey, "hex"));
const XLM_PUB = ed25519.getPublicKey(XLM_SEED);
// The session's Sui address is what `closeSendSession` asks to tell its own
// session from a newer one.
const suiMe = suiAdapter.deriveFromMnemonic(ABANDON);

const g = (n: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey();
const DEST = g(9);
const EXCHANGE = g(10);
const NEW_ACCOUNT = g(11);
const MUXED = new MuxedAccount(new Account(EXCHANGE, "0"), "4242").accountId();

// ── Fake Horizon ──
type Submit =
  | { status: number; json?: unknown; text?: string }
  | "throw";
interface FakeHorizon {
  accounts: Record<string, Record<string, unknown>>;
  submit: Submit;
  /** GET /transactions/{hash}. */
  lookup: "success" | "failed" | "missing" | 503;
  /** Horizon's latest ledger close time. */
  closedAt: () => Date;
  posted: string[];
  gets: string[];
}
let hz: FakeHorizon;

const json = (status: number, body: unknown, type = "application/hal+json") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": type } });

function account(id: string, xlmBalance: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    account_id: id,
    sequence: "1000",
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [{ asset_type: "native", balance: xlmBalance, selling_liabilities: "0.0000000" }],
    data: {},
    ...extra,
  };
}

async function horizonFetch(input: unknown, init?: { method?: string; body?: unknown }) {
  const url = String(input);
  const path = url.replace("https://horizon.stellar.org", "");
  if (init?.method === "POST" && path === "/transactions") {
    hz.posted.push(new URLSearchParams(String(init.body)).get("tx") ?? "");
    const s = hz.submit;
    if (s === "throw") throw new TypeError("Failed to fetch");
    if (s.text !== undefined) {
      return new Response(s.text, { status: s.status, headers: { "content-type": "text/html" } });
    }
    return json(s.status, s.json ?? {}, "application/problem+json");
  }
  hz.gets.push(path);
  if (path === "/") return json(200, { history_latest_ledger_closed_at: hz.closedAt().toISOString() });
  const acct = /^\/accounts\/(.*)$/.exec(path);
  if (acct) {
    const id = decodeURIComponent(acct[1]);
    // What Horizon answers for an M… address (checked by the lead, 2026-09-29).
    if (id.startsWith("M")) return json(400, { title: "Bad Request", status: 400 }, "application/problem+json");
    const a = hz.accounts[id];
    return a ? json(200, a) : json(404, { title: "Resource Missing", status: 404 }, "application/problem+json");
  }
  if (path.startsWith("/transactions/")) {
    if (hz.lookup === 503) return new Response("busy", { status: 503 });
    if (hz.lookup === "missing") return json(404, { title: "Resource Missing", status: 404 }, "application/problem+json");
    return json(200, { successful: hz.lookup === "success", hash: path.slice(14) });
  }
  throw new Error(`unscripted Horizon ${init?.method ?? "GET"} ${path}`);
}

// ── Fake Rust core ──
let stellarSigner = xlm.address;
let suiSigner = suiMe.address;
async function fakeInvoke(cmd: string, args: any): Promise<unknown> {
  switch (cmd) {
    case "swap_get_stellar_address":
      return stellarSigner;
    case "swap_sign_stellar_tx": {
      // swap/stellar.rs sign_tx: sha256(network_id || ENVELOPE_TYPE_TX || tx).
      const tx = Buffer.from(args.input.txXdrBase64, "base64");
      const networkId = sha256(new TextEncoder().encode(Networks.PUBLIC));
      const digest = sha256(Buffer.concat([networkId, Buffer.from([0, 0, 0, 2]), tx]));
      return {
        publicKeyBase64: Buffer.from(XLM_PUB).toString("base64"),
        hintBase64: Buffer.from(XLM_PUB.subarray(28)).toString("base64"),
        signatureBase64: Buffer.from(ed25519.sign(digest, XLM_SEED)).toString("base64"),
      };
    }
    case "swap_get_sui_address":
      return suiSigner;
    case "swap_lock":
      return null;
    default:
      throw new Error(`unscripted invoke ${cmd}`);
  }
}
const invoked = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd);

/** The transaction that was POSTed to Horizon. */
function submitted() {
  expect(hz.posted.length).toBe(1);
  return TransactionBuilder.fromXDR(hz.posted[0], Networks.PUBLIC) as any;
}

const send = (over: Partial<Parameters<typeof executeStellarTransfer>[0]> = {}) =>
  executeStellarTransfer({
    sessionId: "session-1",
    fromAddress: xlm.address,
    to: DEST,
    amount: "2",
    ...over,
  });

// Guarded so this file can also be pointed at the pre-2026-09-29 modules,
// which is how its assertions were shown to fail there.
const savedTiming = SESSION_SEND_TIMING ? { ...SESSION_SEND_TIMING } : null;
beforeEach(() => {
  hz = {
    accounts: {
      [xlm.address]: account(xlm.address, "100.0000000"),
      [DEST]: account(DEST, "5.0000000"),
      [EXCHANGE]: account(EXCHANGE, "5000.0000000", { data: { "config.memo_required": "MQ==" } }),
    },
    submit: { status: 200, json: { successful: true } },
    lookup: "missing",
    closedAt: () => new Date(),
    posted: [],
    gets: [],
  };
  stellarSigner = xlm.address;
  suiSigner = suiMe.address;
  if (SESSION_SEND_TIMING) Object.assign(SESSION_SEND_TIMING, {
    pollMs: 2,
    stellarTimeoutSecs: 1,
    stellarLedgerMarginSecs: 0,
    stellarGraceMs: 30,
    suiLookupMs: 30,
  });
  vi.stubGlobal("fetch", vi.fn(horizonFetch));
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(fakeInvoke as any);
});
afterEach(() => {
  if (SESSION_SEND_TIMING && savedTiming) Object.assign(SESSION_SEND_TIMING, savedTiming);
  vi.unstubAllGlobals();
});

describe("Stellar memo (#2)", () => {
  it("a text memo and an ID memo reach the transaction as that type", async () => {
    await send({ memo: { type: "text", value: "deposit 77" } });
    expect(submitted().memo.type).toBe("text");
    expect(String(submitted().memo.value)).toBe("deposit 77");

    hz.posted = [];
    await send({ memo: { type: "id", value: "12345" } });
    expect(submitted().memo.type).toBe("id");
    expect(submitted().memo.value).toBe("12345");
  });

  it("SEP-29: an account that requires a memo is refused without one, before signing", async () => {
    await expect(send({ to: EXCHANGE })).rejects.toThrow(/requires a memo[\s\S]*Nothing was sent/);
    expect(invoked("swap_sign_stellar_tx")).toEqual([]);
    expect(hz.posted).toEqual([]);
  });

  it("SEP-29: the same account is paid when the memo is there", async () => {
    await send({ to: EXCHANGE, memo: { type: "id", value: "900" } });
    expect(submitted().operations[0].destination).toBe(EXCHANGE);
  });

  it("a memo ID above 2^64 - 1 is refused (stellar-base would encode it as 0)", async () => {
    await expect(send({ memo: { type: "id", value: "18446744073709551616" } })).rejects.toThrow(
      /memo ID is a whole number/,
    );
    expect(hz.posted).toEqual([]);
  });
});

describe("an uncertain Stellar submit is settled by hash (#6)", () => {
  it("a 504 is not 'rejected': the transaction is found by its hash and reported sent", async () => {
    hz.submit = { status: 504, json: { title: "Timeout", status: 504 } };
    hz.lookup = "success";
    const r = await send();
    // The hash was computed before the submit, from the transaction itself.
    const tx = submitted();
    expect(r.txHash).toBe(tx.hash().toString("hex"));
  });

  it("a non-JSON 502 whose transaction never lands before its time limit is a plain failure: safe to send again", async () => {
    hz.submit = { status: 502, text: "<html>Bad gateway</html>" };
    hz.lookup = "missing";
    hz.closedAt = () => new Date(Date.now() + 3_600_000); // the ledger is past the timebound
    const err = await send().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isSendOutcomeUnknown(err)).toBe(false);
    expect(err.message).toMatch(/can no longer go through[\s\S]*safe to send again/);
  });

  it("a dropped connection that nothing settles is an unknown outcome with the hash — never 'failed'", async () => {
    hz.submit = "throw";
    hz.lookup = 503;
    const err = await send().catch((e) => e);
    expect(isSendOutcomeUnknown(err)).toBe(true);
    expect(err.hash).toBe(submitted().hash().toString("hex"));
  });

  it("a JSON 400 from Horizon is a decided rejection, and is not looked up", async () => {
    hz.submit = { status: 400, json: { extras: { result_codes: { transaction: "tx_bad_seq" } } } };
    await expect(send()).rejects.toThrow(/rejected the transaction \(tx_bad_seq\)\. Nothing was sent/);
    expect(hz.gets.filter((p) => p.startsWith("/transactions/"))).toEqual([]);
  });
});

describe("Stellar sends only from the account the signer holds (#8)", () => {
  it("refuses a wallet whose address is not the session's, before signing", async () => {
    stellarSigner = g(3); // the phrase's account; the dashboard shows another
    await expect(send()).rejects.toThrow(/isn't supported yet[\s\S]*Nothing was signed/);
    expect(invoked("swap_sign_stellar_tx")).toEqual([]);
    expect(hz.posted).toEqual([]);
  });
});

describe("the Stellar minimum balance is not spendable (#11)", () => {
  beforeEach(() => {
    // 10 XLM with 2 entries (e.g. two trustlines): minimum balance 2 XLM.
    hz.accounts[xlm.address] = account(xlm.address, "10.0000000", { subentry_count: 2 });
  });

  it("refuses more than balance - minimum - fee, and says how much can go", async () => {
    await expect(send({ amount: "8" })).rejects.toThrow(/at most 7\.99 XLM[\s\S]*2 XLM/);
    expect(hz.posted).toEqual([]);
    await send({ amount: "7.99" });
    expect(submitted().operations[0].amount).toBe("7.9900000");
  });

  it("creating a new account takes at least 1 XLM", async () => {
    await expect(send({ to: NEW_ACCOUNT, amount: "0.5" })).rejects.toThrow(/at least 1 XLM/);
    expect(hz.posted).toEqual([]);
    await send({ to: NEW_ACCOUNT, amount: "1" });
    expect(submitted().operations[0].type).toBe("createAccount");
  });
});

describe("Stellar recipients (#12)", () => {
  it("a muxed address is looked up by its base account and paid as the muxed address", async () => {
    await send({ to: MUXED });
    expect(hz.gets).toContain(`/accounts/${EXCHANGE}`);
    expect(hz.gets.some((p) => p.startsWith("/accounts/M"))).toBe(false);
    // Paid to the M address, so the id arrives; and SEP-29 is not asked of it.
    expect(submitted().operations[0].destination).toBe(MUXED);
  });

  it("a federation address is refused with an explanation", async () => {
    await expect(send({ to: "bob*example.com" })).rejects.toThrow(/Federation addresses/);
    expect(hz.posted).toEqual([]);
  });

  it("surrounding whitespace is trimmed", async () => {
    await send({ to: `  ${DEST}\n` });
    expect(submitted().operations[0].destination).toBe(DEST);
  });

  it("a malformed address is refused before any lookup", async () => {
    await expect(send({ to: DEST.slice(0, -1) })).rejects.toThrow(/not a Stellar address/);
    expect(hz.gets).toEqual([]);
  });
});

describe("Stellar amounts go through the decimal parser (#13)", () => {
  it.each(["0x10", "1e2", "+5", "1.12345678", "0"])("refuses %s", async (amount) => {
    await expect(send({ amount })).rejects.toThrow();
    expect(hz.posted).toEqual([]);
  });

  it("sends the canonical amount", async () => {
    await send({ amount: " 1.50 " });
    expect(submitted().operations[0].amount).toBe("1.5000000");
  });
});

// The Sui sends (#3, #8, #9) moved to `suiSend.test.ts` (2026-10-01).

describe("the signing session is locked when the send is over (#14)", () => {
  it("locks it when it is still this send's session", async () => {
    await closeSendSession("mine");
    expect(invoked("swap_lock").length).toBe(1);
  });

  it("leaves it alone when another operation has opened a newer one", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "swap_get_sui_address") throw "session expired or invalid";
      return null;
    }) as any);
    await closeSendSession("stale");
    expect(invoked("swap_lock")).toEqual([]);
  });

  it("App.tsx locks in `finally`, routes NEAR through executeNearSend, and passes the memo on", () => {
    const app = readFileSync(join(__dirname, "../../App.tsx"), "utf8").replace(/\r\n/g, "\n");
    const start = app.indexOf("const sessionSignedSendOverride = useMemo(");
    const end = app.indexOf("}, [activeChain, walletsByChain, sessionPassword]);", start);
    expect(start).toBeGreaterThan(-1);
    const body = app.slice(start, end);
    expect(body).toContain("memo: opts?.memo");
    expect(body).toContain("executeNearSend({");
    expect(body).not.toContain("executeNearNativeTransfer(");
    expect(body).toMatch(/finally \{\s*await closeSendSession\(sessionId\);\s*\}/);
  });
});
