/**
 * The account node pwnda hands the swap engine must decode, inside the engine,
 * into the wallet the user already owns.
 *
 * That claim spans two languages and two crypto stacks, so the tests that
 * matter here are **cross-implementation vectors**: the expected bytes below
 * were produced by the engine's own `ExtKeyPair.encode_v()`, run under the
 * sidecar's embedded CPython against the published BIP-39 test mnemonic:
 *
 * ```
 * .swap-sidecar-work/runtime/python.exe -s -E -c "
 * import hashlib; from basicswap.util.extkey import ExtKeyPair
 * m='abandon '*11+'about'
 * mk=ExtKeyPair(); mk.set_seed(hashlib.pbkdf2_hmac('sha512',m.encode(),b'mnemonic',2048,64))
 * print(mk.derive_path('84h/0h/0h').encode_v().hex())"
 * ```
 *
 * A test that recomputed the encoding in TypeScript could not fail for the
 * reason it is run: it would agree with itself no matter which field order or
 * endianness both sides used. `scripts/swap/verify-account-key-patches.py` is
 * the same assertion from the engine's side.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  ACCOUNT_NODE_BYTES,
  ADOPTABLE_ACCOUNTS,
  deriveSwapAccountKey,
  deriveSwapAccountKeys,
  encodeAccountNode,
  isAdoptableCoin,
} from "./swapAccountKey";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Produced by the ENGINE, not by this codebase. See the file header. */
const ENGINE_VECTORS: Record<string, string> = {
  BTC:
    "037ef32bdb800000004a53a0ab21b9dc95869c4e92a161194e03c0ef3ff5014ac692f433c476" +
    "5490fc00e14f274d16ca0d91031b98b162618061d03930fa381af6d4caf44b01819ab6d4",
  LTC:
    "03929a9080800000006 9ec1293116855fdd96736a4f3bb71fe097e255856b3fd11feda4e6644" +
    "241f1e005a27801ac91d93adcaf558ce677e666bc88269f8435b025f7e358f442a8f4624".replace(
      / /g,
      "",
    ),
};

function readSrc(rel: string): string {
  return readFileSync(resolve(__dirname, rel), "utf8");
}

describe("account node encoding matches the engine byte for byte", () => {
  for (const ticker of ["BTC", "LTC"]) {
    it(`${ticker} account node equals the engine's encode_v()`, async () => {
      const got = await deriveSwapAccountKey(MNEMONIC, ticker);
      expect(got).toBe(ENGINE_VECTORS[ticker].replace(/\s/g, ""));
      expect(got.length).toBe(ACCOUNT_NODE_BYTES * 2);
    });
  }

  it("field layout is depth ‖ fingerprint ‖ index ‖ chaincode ‖ 00 ‖ key", async () => {
    const hex = await deriveSwapAccountKey(MNEMONIC, "BTC");
    // depth 3 = m/84'/0'/0'
    expect(hex.slice(0, 2)).toBe("03");
    // hardened child 0 -> 0x80000000, big-endian
    expect(hex.slice(10, 18)).toBe("80000000");
    // the private-key marker upstream branches on
    expect(hex.slice(82, 84)).toBe("00");
  });

  it("derives the same account the wallet adapter uses", async () => {
    // Not a re-derivation of the constant: this walks the SAME path the
    // adapter's own source declares, so a change there fails here.
    for (const [ticker, file, adapter] of [
      ["BTC", "../wallets/btc-wallet.ts", "m/84'/0'/0'/0/0"],
      ["LTC", "../wallets/ltc-wallet.ts", "m/84'/2'/0'/0/0"],
    ] as const) {
      const src = readSrc(file);
      expect(src).toContain(`const DERIVATION_PATH = "${adapter}"`);
      // The adapter's address path must be the account path plus /0/0.
      expect(adapter).toBe(`${ADOPTABLE_ACCOUNTS[ticker]}/0/0`);
    }
  });

  it("the engine's index-0 address is the wallet's own address", async () => {
    // The whole point of C8, expressed as key equality: deriving 0/0 beneath
    // the pushed account must land on the same private key the adapter signs
    // with. (Address encoding is covered on the engine side by
    // scripts/swap/verify-account-key-patches.py against the BIP-84 vector.)
    const seed = mnemonicToSeedSync(MNEMONIC);
    const master = HDKey.fromMasterSeed(seed);
    for (const ticker of ["BTC", "LTC"] as const) {
      const viaAdapterPath = master.derive(`${ADOPTABLE_ACCOUNTS[ticker]}/0/0`);
      const viaAccount = master
        .derive(ADOPTABLE_ACCOUNTS[ticker])
        .deriveChild(0)
        .deriveChild(0);
      expect(Buffer.from(viaAccount.privateKey!)).toEqual(
        Buffer.from(viaAdapterPath.privateKey!),
      );
    }
  });
});

describe("refusals", () => {
  it("refuses a watch-only node", () => {
    const pub = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
      .derive("m/84'/0'/0'")
      .wipePrivateData();
    expect(() => encodeAccountNode(pub)).toThrow(/watch-only/i);
  });

  it("refuses an empty mnemonic", async () => {
    await expect(deriveSwapAccountKey("   ", "BTC")).rejects.toThrow(/empty/i);
  });

  it("refuses a coin with no adoptable account rather than defaulting", async () => {
    // A silent fallback to BTC's account would produce a valid wallet the user
    // does not own — the exact failure this module is built to avoid.
    await expect(deriveSwapAccountKey(MNEMONIC, "DOGE")).rejects.toThrow(
      /no adoptable account/i,
    );
    expect(isAdoptableCoin("DOGE")).toBe(false);
    expect(isAdoptableCoin("btc")).toBe(true);
  });

  it("exactly BTC, LTC and BCH are adoptable (the engine's SUPPORTED_COINS since PATCH-24)", () => {
    // BCH joined 2026-09-05 — see the BCH block at the end of this file for
    // why its absence here read as `NaN BCH` on the console.
    expect(Object.keys(ADOPTABLE_ACCOUNTS).sort()).toEqual(["BCH", "BTC", "LTC"]);
  });
});

describe("batch derivation", () => {
  it("agrees with the single-coin path", async () => {
    const batch = await deriveSwapAccountKeys(MNEMONIC, ["btc", "LTC"]);
    expect(batch.map((b) => b.ticker)).toEqual(["BTC", "LTC"]);
    for (const entry of batch) {
      expect(entry.accountKey).toBe(
        await deriveSwapAccountKey(MNEMONIC, entry.ticker),
      );
    }
  });

  it("skips non-adoptable coins instead of throwing", async () => {
    // Callers pass "every enabled coin"; a full-mode DOGE in that list is
    // normal, not an error.
    const batch = await deriveSwapAccountKeys(MNEMONIC, ["BTC", "DOGE", "XMR"]);
    expect(batch.map((b) => b.ticker)).toEqual(["BTC"]);
    expect(await deriveSwapAccountKeys(MNEMONIC, ["DOGE"])).toEqual([]);
  });

  it("deduplicates", async () => {
    const batch = await deriveSwapAccountKeys(MNEMONIC, ["BTC", "btc", "BTC"]);
    expect(batch).toHaveLength(1);
  });

  it("two different mnemonics give different accounts", async () => {
    const other =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const a = await deriveSwapAccountKey(MNEMONIC, "BTC");
    const b = await deriveSwapAccountKey(other, "BTC");
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Derivation-aware resolution (2026-08-21). The incident these pin: the
// operator's wallet was imported through the derivation picker — LTC on
// BIP-44 legacy (L…) and BTC on the pre-2026-05-06 PwndaWallet path (m/44'
// encoded as bech32) — and the first factory pushed the standard BIP-84
// accounts anyway. The engine derived a wallet the user does not own and
// the round-trip check refused both coins.
// ─────────────────────────────────────────────────────────────────────
import * as bitcoin from "bitcoinjs-lib";
import {
  deriveAccountNodeAtPath,
  makeAccountKeyDeriver,
  resolveDerivation,
} from "./swapAccountKey";

const LTC_NET: bitcoin.networks.Network = {
  messagePrefix: "\x19Litecoin Signed Message:\n",
  bech32: "ltc",
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

function addrAt(path: string, net: bitcoin.networks.Network, kind: "p2wpkh" | "p2pkh"): string {
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(path);
  const pubkey = Buffer.from(node.publicKey!);
  return kind === "p2wpkh"
    ? bitcoin.payments.p2wpkh({ pubkey, network: net }).address!
    : bitcoin.payments.p2pkh({ pubkey, network: net }).address!;
}

describe("resolveDerivation — works backwards from the displayed address", () => {
  it("standard BIP-84 BTC resolves shareable at m/84'/0'/0'", async () => {
    // The published BIP-84 vector — same constant the engine-side suite pins.
    const r = await resolveDerivation(
      MNEMONIC, "BTC", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    );
    expect(r?.shareable).toBe(true);
    expect(r?.candidate.accountPath).toBe("m/84'/0'/0'");
  });

  it("standard BIP-84 LTC resolves — pinning the inlined LTC network params", async () => {
    // ltc1qjmxnz78… is the address the ENGINE derives for this vector
    // (verify-account-key-patches.py) and the address ltc-wallet.ts derives.
    // This is the drift guard for LTC_NETWORK being duplicated in the module.
    const r = await resolveDerivation(
      MNEMONIC, "LTC", "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh",
    );
    expect(r?.shareable).toBe(true);
    expect(r?.candidate.accountPath).toBe("m/84'/2'/0'");
  });

  it("the pwnda-legacy BTC trap: m/44' path, bech32 encoding — shareable at the RIGHT account", async () => {
    // Looks exactly like a standard bc1q… address and is not. Pushing the
    // m/84' account for this wallet is the operator's exact failure.
    const legacyBech = addrAt("m/44'/0'/0'/0/0", bitcoin.networks.bitcoin, "p2wpkh");
    const r = await resolveDerivation(MNEMONIC, "BTC", legacyBech);
    expect(r?.shareable).toBe(true);
    expect(r?.candidate.accountPath).toBe("m/44'/0'/0'");
  });

  it("LTC BIP-44 legacy (L…) is RECOGNIZED but unshareable — reverted 2026-08-21", async () => {
    // PWNDA-PATCH-3/4/6 CAN derive/watch/sign this wallet — proven true and
    // still true (verify-account-key-patches.py sections 8-9 stay green).
    // But PWNDA-PATCH-7's swap-safety audit found the capability didn't
    // deliver what it was built for: BasicSwap pre-signs the chain-A lock's
    // refund against the lock tx's own pre-broadcast txid, which only a
    // segwit-funded lock tx keeps stable — so a legacy-only wallet could
    // receive/hold/send through the engine but still never fund a swap. The
    // operator chose to revert to requiring the sweep rather than carry
    // legacy-signing patch surface for a capability that doesn't reach the
    // goal. The engine patches stay applied and tested; this module simply
    // stops calling the p2pkh path. See
    // PwndaWalletVault/wiki/queries/2026-08-21-multi-derivation-support.md.
    const legacy = addrAt("m/44'/2'/0'/0/0", LTC_NET, "p2pkh");
    expect(legacy.startsWith("L")).toBe(true);
    // Cross-implementation pin: the engine's own crypto derives this same
    // string for this mnemonic (see verify-account-key-patches.py section 8).
    expect(legacy).toBe("LUWPbpM43E2p7ZSh8cyTBEkvpHmr3cB8Ez");
    const r = await resolveDerivation(MNEMONIC, "LTC", legacy);
    // Recognized (the account path is found) — just not pushed.
    expect(r).not.toBeNull();
    expect(r?.candidate.accountPath).toBe("m/44'/2'/0'");
    expect(r?.shareable).toBe(false);
  });

  it("BIP-49 wrapped SegWit stays unshareable — no P2SH spend path exists", async () => {
    const wrapped = (() => {
      const node = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(
        "m/49'/0'/0'/0/0",
      );
      const pubkey = Buffer.from(node.publicKey!);
      return bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.bitcoin }),
        network: bitcoin.networks.bitcoin,
      }).address!;
    })();
    const r = await resolveDerivation(MNEMONIC, "BTC", wrapped);
    expect(r).not.toBeNull();
    expect(r?.shareable).toBe(false);
  });

  it("an unrecognized address resolves to null, never a guess", async () => {
    expect(
      await resolveDerivation(MNEMONIC, "BTC", "bc1qsomebodyelsesaddressxxxxxxxxxxxxxxxxx"),
    ).toBeNull();
  });
});

describe("makeAccountKeyDeriver — pushes the account that PRODUCED the address", () => {
  it("pushes the resolved (non-standard) account, not the standard one", async () => {
    const legacyBech = addrAt("m/44'/0'/0'/0/0", bitcoin.networks.bitcoin, "p2wpkh");
    const derive = makeAccountKeyDeriver({
      BTC: { mnemonic: MNEMONIC, address: legacyBech },
    });
    const { pushes, skipped } = await derive();
    expect(skipped).toEqual([]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].expectedAddress).toBe(legacyBech);
    // bech32-encoded, so the ENGINE must keep watching/signing segwit.
    expect(pushes[0].addressType).toBe("p2wpkh");
    expect(pushes[0].accountKey).toBe(
      await deriveAccountNodeAtPath(MNEMONIC, "m/44'/0'/0'"),
    );
    // And decisively NOT the standard account.
    expect(pushes[0].accountKey).not.toBe(
      await deriveAccountNodeAtPath(MNEMONIC, "m/84'/0'/0'"),
    );
  });

  it("skips a legacy LTC wallet with a reason naming the sweep", async () => {
    const legacy = addrAt("m/44'/2'/0'/0/0", LTC_NET, "p2pkh");
    const derive = makeAccountKeyDeriver({
      LTC: { mnemonic: MNEMONIC, address: legacy },
    });
    const { pushes, skipped } = await derive();
    expect(pushes).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].ticker).toBe("LTC");
    // The p2pkh case has an actual fix (unlike BIP-49 below) — the message
    // must point at it by name, not just say "cannot spend from yet".
    expect(skipped[0].reason).toContain("Move balance");
    expect(skipped[0].reason).toContain("BIP-44 legacy (Exodus)");
  });

  it("skips a BIP-49 wallet with a reason, instead of pushing unspendable keys", async () => {
    const wrapped = (() => {
      const node = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(
        "m/49'/0'/0'/0/0",
      );
      const pubkey = Buffer.from(node.publicKey!);
      return bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.bitcoin }),
        network: bitcoin.networks.bitcoin,
      }).address!;
    })();
    const derive = makeAccountKeyDeriver({
      BTC: { mnemonic: MNEMONIC, address: wrapped },
    });
    const { pushes, skipped } = await derive();
    expect(pushes).toEqual([]);
    expect(skipped[0].reason).toMatch(/cannot spend from yet/i);
    expect(skipped[0].reason).toMatch(/deposit/i);
  });

  it("an unresolved coin is skipped as unrecognized", async () => {
    const derive = makeAccountKeyDeriver({
      BTC: { mnemonic: MNEMONIC, address: "bc1qnotoneofourcandidatesxxxxxxxxxxxxxxxx" },
    });
    const { pushes, skipped } = await derive();
    expect(pushes).toEqual([]);
    expect(skipped[0].reason).toMatch(/not one the swap node can share/i);
  });

  it("a not-yet-loaded chain is OMITTED entirely — not a skip", async () => {
    // Missing inputs mean "retry later" upstream; a skip would settle the
    // pass and consume the session's attempt on a wallet still loading.
    const derive = makeAccountKeyDeriver({
      BTC: { mnemonic: null, address: null },
      LTC: { mnemonic: MNEMONIC, address: null },
    });
    const { pushes, skipped } = await derive();
    expect(pushes).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("each chain derives from ITS OWN mnemonic — no cross-wallet mixing", async () => {
    const other =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const otherBtc = (() => {
      const node = HDKey.fromMasterSeed(mnemonicToSeedSync(other)).derive("m/84'/0'/0'/0/0");
      return bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(node.publicKey!),
        network: bitcoin.networks.bitcoin,
      }).address!;
    })();
    const derive = makeAccountKeyDeriver({
      BTC: { mnemonic: other, address: otherBtc },
      LTC: { mnemonic: MNEMONIC, address: "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh" },
    });
    const { pushes } = await derive();
    const btc = pushes.find((p) => p.ticker === "BTC")!;
    const ltc = pushes.find((p) => p.ticker === "LTC")!;
    expect(btc.accountKey).toBe(await deriveAccountNodeAtPath(other, "m/84'/0'/0'"));
    expect(ltc.accountKey).toBe(await deriveAccountNodeAtPath(MNEMONIC, "m/84'/2'/0'"));
  });
});

// ── BCH (2026-09-05) ────────────────────────────────────────────────────
// The engine has admitted BCH account keys since PATCH-18/19/24 and Rust's
// ELECTRUM_CAPABLE lists it, but this module's tables did not know the coin,
// so no key was ever pushed: the engine logged "BCH expects a host-wallet
// account key; none pushed yet" on every start and the console read NaN.
// The address below is the wallet's own m/44'/145'/0'/0/0 for the test seed
// (bch-account-send.test.ts), spelled as cashaddr with its prefix.
describe("BCH — BIP-44 coin type 145, p2pkh, cashaddr", () => {
  const BCH_ADDR = "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6";

  it("is adoptable at m/44'/145'/0'", () => {
    expect(isAdoptableCoin("bch")).toBe(true);
    expect(ADOPTABLE_ACCOUNTS.BCH).toBe("m/44'/145'/0'");
  });

  it("resolves the wallet's displayed cashaddr, with or without the prefix, as shareable p2pkh", async () => {
    const r = await resolveDerivation(MNEMONIC, "BCH", BCH_ADDR);
    expect(r).not.toBeNull();
    expect(r!.candidate.encoding).toBe("p2pkh");
    expect(r!.shareable).toBe(true);
    const bare = await resolveDerivation(MNEMONIC, "BCH", BCH_ADDR.replace(/^bitcoincash:/, ""));
    expect(bare?.shareable).toBe(true);
    expect(await resolveDerivation(MNEMONIC, "BCH", "bitcoincash:qp8sfdhgjlq68hlzka9lcsxtcnvuvnd0xqxugfzzc5")).toBeNull();
  });

  it("the batch deriver pushes BCH as p2pkh with the cashaddr as the expected address", async () => {
    const derive = makeAccountKeyDeriver({ BCH: { mnemonic: MNEMONIC, address: BCH_ADDR } });
    const out = await derive();
    expect(out.skipped).toEqual([]);
    expect(out.pushes).toHaveLength(1);
    expect(out.pushes[0].ticker).toBe("BCH");
    expect(out.pushes[0].addressType).toBe("p2pkh");
    expect(out.pushes[0].expectedAddress).toBe(BCH_ADDR);
    expect(out.pushes[0].accountKey).toHaveLength(ACCOUNT_NODE_BYTES * 2);
  });
});
