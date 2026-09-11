/**
 * XRP and Tron as NEAR Intents swap SOURCES (2026-09-09).
 *
 * Three things are worth pinning here, in descending order of what they would
 * cost if they broke.
 *
 * ## 1. Units. This is the fund-losing one.
 *
 * 1Click states `quote.amountIn` in ATOMIC units — drops for XRP, sun for
 * Tron. Every wallet adapter takes DISPLAY units and scales internally. Get
 * the direction wrong and nothing throws: the swap sends 1e6 times too much
 * or too little of someone's money. `executeAdapterTransfer` owns that one
 * conversion, and these tests check the number that actually reaches the
 * adapter, not that the function returned.
 *
 * ## 2. TRX and USDT-TRON must not be confused for each other.
 *
 * They share a chain, a key, a signature scheme and a `chainKind`. Only
 * `walletsByChainKey` separates them, and it selects a different adapter: a
 * native `TransferContract` versus a `transfer(address,uint256)` contract
 * call. Dispatching on `chainKind` alone would send USDT as if it were TRX —
 * to the right address, in the wrong asset.
 *
 * ## 3. The secret each chain needs is decided in one place.
 *
 * ADA needs a seed phrase, XRP and Tron need a private key. That mapping is
 * `sourceSecretFor`, and both swap surfaces call it rather than each carrying
 * a ternary. The last time this codebase kept two copies of one decision
 * (`SwapChainKind`) they drifted the same afternoon.
 *
 * What these tests deliberately do NOT prove: that a real XRP or Tron deposit
 * confirms on chain. That needs funds and a live counterparty. The first real
 * swap on either leg should be small.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASSET_CAPABILITIES,
  sourceSecretFor,
} from "./asset-capabilities";
import { SOURCE_CAPABLE_BLOCKCHAINS } from "./intents-source-capability";
import { getDropdownTickers } from "./swap-data";

/** Captures what the adapter was actually handed. */
const sent: Array<{ chain: string; pk: string; to: string; amount: string }> = [];

vi.mock("../../wallets", () => ({
  getAdapter: (chain: string) => ({
    sendTransaction: async (pk: string, to: string, amount: string) => {
      sent.push({ chain, pk, to, amount });
      return { hash: `0xhash-${chain}` };
    },
  }),
}));

const { executeAdapterTransfer } = await import("./swap-sources");

beforeEach(() => {
  sent.length = 0;
});

describe("atomic to display, the conversion that moves the money", () => {
  it("hands XRP's adapter whole units, not drops", async () => {
    // 2.6 XRP arrives from 1Click as "2600000" drops. The adapter multiplies
    // by 1e6 itself, so it must receive "2.6". Passing the atomic string
    // through unchanged would send 2,600,000 XRP.
    await executeAdapterTransfer({
      chainKey: "xrp",
      privateKey: "deadbeef",
      depositAddress: "rDepositAddr",
      amountAtomic: "2600000",
      decimals: 6,
      ticker: "XRP",
    });
    expect(sent[0].amount).toBe("2.6");
    expect(sent[0].chain).toBe("xrp");
    expect(sent[0].to).toBe("rDepositAddr");
  });

  it("keeps every significant digit at the precision limit", async () => {
    // 6dp is XRP's floor: one drop. A float round-trip is fine here and stops
    // being fine on an 18-decimal chain, which is why the implementation uses
    // exact bigint arithmetic rather than being correct by luck at this size.
    await executeAdapterTransfer({
      chainKey: "xrp", privateKey: "k", depositAddress: "r",
      amountAtomic: "1", decimals: 6, ticker: "XRP",
    });
    expect(sent[0].amount).toBe("0.000001");
  });

  it("does not lose digits on an amount past 2^53 atomic units", async () => {
    // 9,007,199,254.740993 of a 6dp asset is one atomic unit above
    // Number.MAX_SAFE_INTEGER. `Number(atomic) / 1e6` returns
    // 9007199254.740992 here — the last digit silently gone.
    await executeAdapterTransfer({
      chainKey: "tron", privateKey: "k", depositAddress: "T",
      amountAtomic: "9007199254740993", decimals: 6, ticker: "TRX",
    });
    expect(sent[0].amount).toBe("9007199254.740993");
  });

  it("refuses a zero or negative amount rather than sending it", async () => {
    await expect(
      executeAdapterTransfer({
        chainKey: "xrp", privateKey: "k", depositAddress: "r",
        amountAtomic: "0", decimals: 6, ticker: "XRP",
      }),
    ).rejects.toThrow(/must be positive/i);
    expect(sent).toHaveLength(0);
  });

  it("refuses to send without a key instead of calling the adapter", async () => {
    await expect(
      executeAdapterTransfer({
        chainKey: "xrp", privateKey: "", depositAddress: "r",
        amountAtomic: "2600000", decimals: 6, ticker: "XRP",
      }),
    ).rejects.toThrow(/private key/i);
    expect(sent).toHaveLength(0);
  });
});

describe("TRX and USDT-TRON are the same chain and different assets", () => {
  it("routes each to its own adapter", async () => {
    await executeAdapterTransfer({
      chainKey: "tron", privateKey: "k", depositAddress: "T1",
      amountAtomic: "5000000", decimals: 6, ticker: "TRX",
    });
    await executeAdapterTransfer({
      chainKey: "usdt-tron", privateKey: "k", depositAddress: "T2",
      amountAtomic: "5000000", decimals: 6, ticker: "USDT",
    });
    // Same key, same chain, same amount — different adapter. That difference
    // is a native transfer versus a TRC-20 contract call.
    expect(sent.map((s) => s.chain)).toEqual(["tron", "usdt-tron"]);
  });

  it("registers both under one chain in the source-capability set", () => {
    // The set is keyed by CHAIN, so `tron` enables both assets. Listing
    // `usdt-tron` here would be a category error — it is not a blockchain.
    expect(SOURCE_CAPABLE_BLOCKCHAINS.has("tron")).toBe(true);
    expect(SOURCE_CAPABLE_BLOCKCHAINS.has("xrp")).toBe(true);
  });

  it("gives them the same signer and different wallet keys", () => {
    expect(ASSET_CAPABILITIES.TRX.tsSourceSigner).toBe("tron");
    expect(ASSET_CAPABILITIES["USDT-TRON"].tsSourceSigner).toBe("tron");
    expect(ASSET_CAPABILITIES.TRX.chainKind).toBe("TRON");
    expect(ASSET_CAPABILITIES["USDT-TRON"].chainKind).toBe("TRON");
    expect(ASSET_CAPABILITIES.TRX.walletsByChainKey).toBe("tron");
    expect(ASSET_CAPABILITIES["USDT-TRON"].walletsByChainKey).toBe("usdt-tron");
  });
});

describe("sourceSecretFor — one mapping, not one per surface", () => {
  const wallets = {
    cardano: { mnemonic: "abandon abandon about", privateKey: "" },
    xrp: { mnemonic: "", privateKey: "xrp-key" },
    tron: { mnemonic: "", privateKey: "tron-key" },
    "usdt-tron": { mnemonic: "", privateKey: "tron-key" },
    ethereum: { mnemonic: "m", privateKey: "eth-key" },
  };

  it("asks Cardano for a mnemonic and XRP/Tron for a key", () => {
    expect(sourceSecretFor("ADA", wallets)).toEqual({
      kind: "mnemonic", value: "abandon abandon about",
    });
    expect(sourceSecretFor("XRP", wallets)).toEqual({
      kind: "privateKey", value: "xrp-key",
    });
    expect(sourceSecretFor("TRX", wallets)).toEqual({
      kind: "privateKey", value: "tron-key",
    });
  });

  it("reads USDT-TRON's key from its OWN wallet entry, not the signer name", () => {
    // The signer is "tron" for both; the wallet entry is per-asset. Reading
    // through the signer name would work today only because both hold the
    // same key, and would break the moment they did not.
    expect(sourceSecretFor("USDT-TRON", wallets)).toEqual({
      kind: "privateKey", value: "tron-key",
    });
  });

  it("returns nothing for a Rust-signed chain", () => {
    // ETH signs inside the swap session; handing it a secret here would be
    // spreading key material for no reason.
    expect(sourceSecretFor("ETH", wallets)).toBeUndefined();
    expect(sourceSecretFor("BTC", wallets)).toBeUndefined();
  });

  it("returns nothing when the chain is not derived yet", () => {
    // So the executor raises its actionable "open the chain in the dashboard"
    // error, rather than this handing back a secret with an empty value.
    expect(sourceSecretFor("XRP", {})).toBeUndefined();
    expect(sourceSecretFor("ADA", { cardano: { privateKey: "x" } })).toBeUndefined();
  });
});

describe("they reach the picker, in both directions", () => {
  it("offers XRP, TRX and USDT-TRON as sources", () => {
    // The bug this closes: all three were in a roster array and none reached
    // the user, because `getDropdownTickers` filters through the registry and
    // none had an entry. A roster line is a wish; the registry is the fact.
    const src = getDropdownTickers({ sourceOnly: true, router: "intents" });
    expect(src).toContain("XRP");
    expect(src).toContain("TRX");
    expect(src).toContain("USDT-TRON");
  });

  it("offers them as destinations too", () => {
    const dst = getDropdownTickers({ router: "intents" });
    expect(dst).toContain("XRP");
    expect(dst).toContain("TRX");
    expect(dst).toContain("USDT-TRON");
  });

  it("carries the asset ids 1Click actually publishes", () => {
    // Verified against the live catalog on 2026-09-09. USDT-TRON was matched
    // by CONTRACT (TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t), the rule that kept
    // USDT0 on Arbitrum from being dropped as "not USDT".
    expect(ASSET_CAPABILITIES.XRP.nearIntentsAsset).toBe("nep141:xrp.omft.near");
    expect(ASSET_CAPABILITIES.TRX.nearIntentsAsset).toBe("nep141:tron.omft.near");
    expect(ASSET_CAPABILITIES["USDT-TRON"].nearIntentsAsset).toBe(
      "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
    );
  });

  it("has no USDC-TRON entry, because 1Click has no such asset", () => {
    // USDC is a real TRC-20 token on Tron and 1Click does not carry it: the
    // catalog lists USDC on sixteen chains, Tron not among them, while USDT
    // on Tron IS there. An entry would be a picker row nothing can route —
    // the LTC failure in a new costume.
    expect(ASSET_CAPABILITIES["USDC-TRON"]).toBeUndefined();
    expect(getDropdownTickers({ router: "intents" })).not.toContain("USDC-TRON");
  });
});
