/**
 * Cardano sends against a scripted Koios (2026-09-29 send-safety audit).
 *
 * `cardano-koios` is the only fake: derivation, CBOR, signing and the
 * adapter's routing are the real code, with the world-public abandon seed.
 * The signed transaction handed to "submit" is decoded here and checked —
 * the witness key, its signature over the body, who is paid, the change and
 * the fee.
 *
 * Each block is one finding of the audit:
 *  - C1: the send spent CIP-1852 account 0 / index 0 whatever address the
 *    wallet SHOWED (checked on `cip1852-a1-i0`, `exodus-cardano`,
 *    `exodus-cardano-split` and `pwnda-legacy`);
 *  - C2: any bech32 decoded as a recipient — testnet, stake and script
 *    addresses included;
 *  - C3: the amount went through `parseFloat` ("1,5" sent 1 ADA);
 *  - C4: change under 1 ADA was added to the fee without a word.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bech32 } from "@scure/base";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KoiosUtxo } from "./cardano-koios";
import type { WalletInfo } from "./types";
import { adaAdapter } from "./ada-wallet";
import { buildAndSignTx, decodeAddressBytes } from "./cardano-tx";
import { deriveCardanoKeySet, deriveCardanoKeySetAt } from "./cardano-cip1852";
import {
  DEFAULT_DERIVATION_CHOICE,
  derivePerChoice,
} from "../features/onboarding/derivation-detector";
import { shouldUseAccountSend } from "../features/send/accountSend";
import { isSendOutcomeUnknown } from "./send-outcome";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ── the fake Koios ──────────────────────────────────────────────────────────

let utxosByAddress: Record<string, KoiosUtxo[]>;
let koiosCalls: string[];
let submitted: Uint8Array[];
/** When set, "submit" receives the bytes and then fails with this. */
let submitFails: unknown;

vi.mock("./cardano-koios", () => ({
  getEpochParams: async () => {
    koiosCalls.push("epoch_params");
    return { min_fee_a: 44, min_fee_b: 155381, max_tx_size: 16384, epoch_no: 560 };
  },
  getCurrentTipSlot: async () => {
    koiosCalls.push("tip");
    return 150_000_000;
  },
  getAddressUtxos: async (address: string) => {
    koiosCalls.push(`utxos:${address}`);
    return utxosByAddress[address] ?? [];
  },
  submitTx: async (bytes: Uint8Array) => {
    submitted.push(bytes);
    if (submitFails !== undefined) throw submitFails;
    return "koios-accepted";
  },
  getAddressBalance: async () => 0,
}));

beforeEach(() => {
  utxosByAddress = {};
  koiosCalls = [];
  submitted = [];
  submitFails = undefined;
});

const utxo = (ada: number, n = 0): KoiosUtxo => ({
  tx_hash: (n + 1).toString(16).padStart(2, "0").repeat(32),
  tx_index: n,
  value: String(Math.round(ada * 1_000_000)),
});

// ── reading what was signed ─────────────────────────────────────────────────

/** Minimal CBOR reader for what `cardano-tx.ts` writes; returns the value and its byte span. */
function cborRead(buf: Uint8Array, start = 0): { value: any; end: number } {
  let pos = start;
  const read = (): any => {
    const ib = buf[pos++];
    const mt = ib >> 5;
    const ai = ib & 31;
    let len = 0n;
    if (ai < 24) len = BigInt(ai);
    else {
      const n = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : 0;
      if (!n) throw new Error("unsupported CBOR");
      for (let i = 0; i < n; i++) len = (len << 8n) | BigInt(buf[pos++]);
    }
    switch (mt) {
      case 0:
        return len;
      case 2: {
        const b = buf.slice(pos, pos + Number(len));
        pos += Number(len);
        return b;
      }
      case 4:
        return Array.from({ length: Number(len) }, () => read());
      case 5: {
        const m = new Map<any, any>();
        for (let i = 0; i < Number(len); i++) {
          const k = read();
          m.set(k, read());
        }
        return m;
      }
      case 7:
        return ai === 21 ? true : ai === 20 ? false : null;
      default:
        throw new Error(`CBOR major type ${mt}`);
    }
  };
  const value = read();
  return { value, end: pos };
}

interface SignedTx {
  bodyBytes: Uint8Array;
  inputs: Array<[Uint8Array, bigint]>;
  outputs: Array<{ address: string; coin: bigint }>;
  fee: bigint;
  vkey: Uint8Array;
  signature: Uint8Array;
}

const addressOf = (bytes: Uint8Array) => bech32.encode("addr", bech32.toWords(bytes), 1023);

function decodeSigned(tx: Uint8Array): SignedTx {
  expect(tx[0]).toBe(0x84); // [body, witnesses, true, null]
  const body = cborRead(tx, 1);
  const witnesses = cborRead(tx, body.end).value as Map<bigint, any>;
  const [vkey, signature] = witnesses.get(0n)[0];
  const b = body.value as Map<bigint, any>;
  return {
    bodyBytes: tx.slice(1, body.end),
    inputs: b.get(0n),
    outputs: (b.get(1n) as Array<[Uint8Array, bigint]>).map(([a, c]) => ({ address: addressOf(a), coin: c })),
    fee: b.get(2n),
    vkey,
    signature,
  };
}

/** The payment credential (blake2b-224 of the key) inside an address. */
const credentialOf = (address: string) => Buffer.from(decodeAddressBytes(address).slice(1, 29)).toString("hex");

function expectSignedFor(tx: SignedTx, address: string) {
  expect(Buffer.from(blake2b(tx.vkey, { dkLen: 28 })).toString("hex")).toBe(credentialOf(address));
  expect(ed25519.verify(tx.signature, blake2b(tx.bodyBytes, { dkLen: 32 }), tx.vkey)).toBe(true);
}

/** What `useSend` does for Cardano: the mnemonic as key material, the account path when the adapter offers it. */
async function dashboardSend(wallet: WalletInfo, to: string, amount: string) {
  const a = adaAdapter;
  const useAccount = shouldUseAccountSend({
    hasAccountSend: !!a.sendFromAccount,
    hasMnemonic: !!wallet.mnemonic,
    accountMatches: a.supportsAccountSend?.(wallet.mnemonic, wallet.address) ?? false,
    assetType: undefined,
  });
  return useAccount
    ? a.sendFromAccount!(wallet.mnemonic, to, amount, wallet.address, {})
    : a.sendTransaction(wallet.mnemonic, to, amount, undefined, undefined);
}

const STANDARD = deriveCardanoKeySet(ABANDON).address;
// A recipient: the same seed, another index — a real key-hash base address.
const RECIPIENT = deriveCardanoKeySetAt(ABANDON, 0, 7).address;

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the send to be refused");
}

// ── C1: spend the address the wallet shows ─────────────────────────────────

describe("C1: a send spends the address the wallet shows (2026-09-29 send-safety audit)", () => {
  it.each(["cip1852", "cip1852-a1-i0", "exodus-cardano", "exodus-cardano-split", "pwnda-legacy"])(
    "derivation %s: inputs from, key for and change to the shown address",
    async (choice) => {
      const wallet = derivePerChoice(ABANDON, { ...DEFAULT_DERIVATION_CHOICE, cardano: choice }).cardano;
      // Both funded, so spending the wrong one would SUCCEED — the audit's case.
      utxosByAddress[wallet.address] = [utxo(10, 1)];
      utxosByAddress[STANDARD] = [utxo(10, 2)];
      await dashboardSend(wallet, RECIPIENT, "2");
      expect(koiosCalls.filter((c) => c.startsWith("utxos:"))).toEqual([`utxos:${wallet.address}`]);
      const tx = decodeSigned(submitted[0]);
      expectSignedFor(tx, wallet.address);
      expect(tx.outputs[0]).toEqual({ address: RECIPIENT, coin: 2_000_000n });
      expect(tx.outputs[1].address).toBe(wallet.address);
    },
  );

  it("refuses, before any network call, a shown address this phrase does not derive", async () => {
    const stranger = deriveCardanoKeySet(
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
    ).address;
    const wallet: WalletInfo = { chain: "cardano", address: stranger, mnemonic: ABANDON, privateKey: "" };
    await expect(dashboardSend(wallet, RECIPIENT, "2")).rejects.toThrow(
      /not one this recovery phrase derives .* Nothing was sent/,
    );
    expect(koiosCalls).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it("the builder will not sign for an address its key does not control", async () => {
    const other = deriveCardanoKeySetAt(ABANDON, 1, 0).address;
    utxosByAddress[other] = [utxo(10)];
    await expect(
      buildAndSignTx({ mnemonic: ABANDON, fromAddress: other, toAddress: RECIPIENT, amountAda: "2" }),
    ).rejects.toThrow(/Refusing to sign: this key does not control/);
    expect(koiosCalls).toEqual([]);
  });
});

// ── C2: who an ADA payment may go to ────────────────────────────────────────

/** The standard address's bytes with another header byte, re-encoded. */
function withHeader(header: number, hrp = "addr", length = 57): string {
  const bytes = decodeAddressBytes(STANDARD).slice(0, length);
  bytes[0] = header;
  return bech32.encode(hrp, bech32.toWords(bytes), 1023);
}

describe("C2: the recipient is checked, not just decoded (2026-09-29 send-safety audit)", () => {
  const wallet = () => adaAdapter.deriveFromMnemonic(ABANDON);

  it.each([
    ["a testnet address", withHeader(0x00, "addr_test"), /TESTNET/],
    ["a stake (reward) address", bech32.encode("stake", bech32.toWords(Uint8Array.of(0xe1, ...decodeAddressBytes(STANDARD).slice(29, 57))), 1023), /stake \(reward\) address/],
    ["a script-payment base address", withHeader(0x11), /script address/],
    ["a script-payment enterprise address", withHeader(0x71, "addr", 29), /script address/],
    ["an addr1 whose header says testnet", withHeader(0x00), /not a valid Cardano payment address/],
    ["a Byron address", "Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi", /Byron-era/],
  ])("refuses %s before touching the network", async (_label, to, why) => {
    utxosByAddress[STANDARD] = [utxo(10)];
    await expect(dashboardSend(wallet(), to, "2")).rejects.toThrow(why);
    expect(koiosCalls).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it.each([
    ["a base address", RECIPIENT],
    ["a base address with a script stake part", withHeader(0x21)],
    ["an enterprise address", withHeader(0x61, "addr", 29)],
    ["a pointer address", bech32.encode("addr", bech32.toWords(Uint8Array.of(0x41, ...decodeAddressBytes(STANDARD).slice(1, 29), 0x81, 0x00, 0x02, 0x03)), 1023)],
  ])("pays %s", async (_label, to) => {
    utxosByAddress[STANDARD] = [utxo(10)];
    await dashboardSend(wallet(), `  ${to} `, "2");
    expect(decodeSigned(submitted[0]).outputs[0]).toEqual({ address: to, coin: 2_000_000n });
  });
});

// ── C3: exact amounts ───────────────────────────────────────────────────────

describe("C3: the amount is parsed exactly (2026-09-29 send-safety audit)", () => {
  it.each(["1,5", "1e3", "2 ADA", "1.0000001", "-2"])("refuses %s instead of guessing", async (amount) => {
    utxosByAddress[STANDARD] = [utxo(5000)];
    await expect(dashboardSend(adaAdapter.deriveFromMnemonic(ABANDON), RECIPIENT, amount)).rejects.toThrow(
      /Invalid ADA amount|decimal place/,
    );
    expect(submitted).toEqual([]);
  });

  it("sends exactly the lovelace typed", async () => {
    utxosByAddress[STANDARD] = [utxo(10)];
    await dashboardSend(adaAdapter.deriveFromMnemonic(ABANDON), RECIPIENT, "1.234567");
    expect(decodeSigned(submitted[0]).outputs[0].coin).toBe(1_234_567n);
  });
});

// ── C4: change too small to be an output ───────────────────────────────────

describe("C4: change under 1 ADA is refused, not added to the fee (2026-09-29 send-safety audit)", () => {
  const wallet = () => adaAdapter.deriveFromMnemonic(ABANDON);

  it("refuses with the amount that would be lost, and amounts that lose nothing", async () => {
    utxosByAddress[STANDARD] = [utxo(3.2)];
    const e = await rejection(dashboardSend(wallet(), RECIPIENT, "3"));
    const m = /would leave (\d+\.\d{6}) ADA of change.*Send (\d+\.\d{6}) ADA instead \(all of it, after the (\d+\.\d{6}) ADA fee\), or at most (\d+\.\d{6}) ADA to keep change\./.exec(
      e.message,
    );
    expect(m, e.message).not.toBeNull();
    expect(submitted).toEqual([]);
    const [, lost, all, allFee, keep] = m!;
    // What would have been burned is exactly what "all of it" adds.
    expect(Number(all) * 1e6).toBeCloseTo((3 + Number(lost)) * 1e6, 0);

    // "All of it" goes through with no change output, and a fee of exactly the minimum.
    await dashboardSend(wallet(), RECIPIENT, all);
    const tAll = decodeSigned(submitted[0]);
    expect(tAll.outputs).toHaveLength(1);
    expect(tAll.fee).toBe(BigInt(Math.round(Number(allFee) * 1e6)));
    expect(tAll.outputs[0].coin + tAll.fee).toBe(3_200_000n);

    // "At most keep" goes through with a change output of at least 1 ADA.
    await dashboardSend(wallet(), RECIPIENT, keep);
    const tKeep = decodeSigned(submitted[1]);
    expect(tKeep.outputs).toHaveLength(2);
    expect(tKeep.outputs[1].coin).toBeGreaterThanOrEqual(1_000_000n);
  });

  it("adds another input rather than burn the change, when one exists", async () => {
    // Five 1-ADA inputs clear the old 300-byte fee GUESS by 1000 lovelace;
    // the real fee of a five-input transaction is higher, so the change came
    // out just under 1 ADA and was added to the fee — with a sixth UTXO
    // sitting unused. Found by sizing the fee per candidate transaction.
    utxosByAddress[STANDARD] = [0, 1, 2, 3, 4, 5].map((n) => utxo(1, n));
    await dashboardSend(wallet(), RECIPIENT, "3.830419");
    const tx = decodeSigned(submitted[0]);
    expect(tx.inputs).toHaveLength(6);
    expect(tx.outputs).toHaveLength(2);
    expect(tx.fee).toBeLessThan(200_000n); // the fee, not the fee plus ~0.99 ADA of change
    const inputs = 6_000_000n;
    expect(tx.outputs[0].coin + tx.outputs[1].coin + tx.fee).toBe(inputs);
  });
});

// ── an unanswered submission (same class as the audit's six chains) ────────

describe("a submission Koios did not clearly answer is 'may have been sent' (2026-09-29 send-safety audit)", () => {
  const wallet = () => adaAdapter.deriveFromMnemonic(ABANDON);
  const bodyHash = () => {
    const tx = decodeSigned(submitted[0]);
    return Buffer.from(blake2b(tx.bodyBytes, { dkLen: 32 })).toString("hex");
  };

  it("a 5xx from Koios's gateway: unknown, with the transaction's hash", async () => {
    utxosByAddress[STANDARD] = [utxo(10)];
    submitFails = new Error("Koios submit failed (HTTP 502): Bad Gateway");
    const e: any = await rejection(dashboardSend(wallet(), RECIPIENT, "2"));
    expect(isSendOutcomeUnknown(e), String(e)).toBe(true);
    expect(e.hash).toBe(bodyHash());
  });

  it("no answer through the proxy (Tauri rejects with a plain string): unknown", async () => {
    utxosByAddress[STANDARD] = [utxo(10)];
    submitFails = "error sending request for url (https://api.koios.rest/api/v1/submittx): operation timed out";
    const e: any = await rejection(dashboardSend(wallet(), RECIPIENT, "2"));
    expect(isSendOutcomeUnknown(e), String(e)).toBe(true);
    expect(e.hash).toBe(bodyHash());
  });

  it("a refusal (HTTP 400, the ledger's reason) stays an ordinary failure", async () => {
    utxosByAddress[STANDARD] = [utxo(10)];
    submitFails = new Error('Koios submit failed (HTTP 400): {"tag":"BadInputsUTxO"}');
    const e = await rejection(dashboardSend(wallet(), RECIPIENT, "2"));
    expect(isSendOutcomeUnknown(e)).toBe(false);
    expect(e.message).toMatch(/HTTP 400/);
  });
});
