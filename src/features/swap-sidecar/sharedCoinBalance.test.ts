/**
 * C8's authority-switch merge logic. Every case here maps to a specific
 * wrong-number failure mode named in the module's own header — the stakes are
 * "shows a real balance as zero" or "invents a balance for an unshared coin",
 * not just a missing row.
 */
import { describe, it, expect } from "vitest";
import type { CoinEnableStatus } from "../../api/basicswap";
import {
  SHARED_COIN_CHAINS,
  applySharedCoinBalances,
  readSharedBalance,
  sharedChains,
  verifiedSharedTickers,
  type SharedCoinBalance,
} from "./sharedCoinBalance";

function status(over: Partial<CoinEnableStatus> & { ticker: string }): CoinEnableStatus {
  return {
    coin: over.ticker.toLowerCase(),
    enabled: true,
    binaryPresent: true,
    configured: true,
    adoption: "deposit",
    descriptorsImported: false,
    mode: "lean",
    configuredMode: "lean",
    canRunLean: true,
    canShareWallet: true,
    sharesWallet: false,
    xmrHostWalletActive: false,
    estDiskGb: 0,
    ...over,
  };
}

describe("sharedChains / SHARED_COIN_CHAINS", () => {
  it("is exactly BTC, LTC and BCH — the ELECTRUM_CAPABLE set C8 can share", () => {
    // Mirrors `ELECTRUM_CAPABLE` in swap_sidecar.rs by hand; BCH joined that
    // table 2026-09-03 (Phase C unit C-R0) and this one 2026-09-04.
    expect(Object.keys(SHARED_COIN_CHAINS).sort()).toEqual(["BCH", "BTC", "LTC"]);
    expect([...sharedChains()].sort()).toEqual(["bitcoin", "bitcoin-cash", "litecoin"]);
  });
});

describe("verifiedSharedTickers — consent is not enough", () => {
  it("requires adoption === accountkey, not shareWalletAck", () => {
    const consentedOnly = [
      status({ ticker: "BTC", adoption: "deposit", sharesWallet: true }),
    ];
    expect(verifiedSharedTickers(consentedOnly)).toEqual([]);

    const verified = [
      status({ ticker: "BTC", adoption: "accountkey", sharesWallet: true }),
    ];
    expect(verifiedSharedTickers(verified)).toEqual(["BTC"]);
  });

  it("verified-but-not-consented still counts — adoption is the stronger fact", () => {
    // Shouldn't normally happen (adoption is only ever set AFTER a push,
    // which requires consent), but the function must trust the field it
    // actually checks, not infer from a field it doesn't.
    const rec = [status({ ticker: "BTC", adoption: "accountkey", sharesWallet: false })];
    expect(verifiedSharedTickers(rec)).toEqual(["BTC"]);
  });

  it("only names coins in the closed SHARED_COIN_CHAINS table", () => {
    // A coin that somehow reported accountkey adoption outside {BTC,LTC}
    // (should be structurally impossible engine-side) must not leak through.
    const rec = [status({ ticker: "DOGE", adoption: "accountkey" })];
    expect(verifiedSharedTickers(rec)).toEqual([]);
  });

  it("multiple shared coins all appear", () => {
    const rec = [
      status({ ticker: "BTC", adoption: "accountkey" }),
      status({ ticker: "LTC", adoption: "accountkey" }),
      status({ ticker: "PART", adoption: "deposit" }),
    ];
    expect(verifiedSharedTickers(rec).sort()).toEqual(["BTC", "LTC"]);
  });

  it("null/empty input is empty output, not a throw", () => {
    expect(verifiedSharedTickers(null)).toEqual([]);
    expect(verifiedSharedTickers([])).toEqual([]);
  });
});

describe("applySharedCoinBalances — the merge", () => {
  it("no overrides is a no-op, and returns a NEW object (no shared mutation)", () => {
    const existing = { bitcoin: "0.5", ethereum: "1.2" };
    const merged = applySharedCoinBalances(existing, []);
    expect(merged).toEqual(existing);
    expect(merged).not.toBe(existing);
  });

  it("overrides only the named chain — every other chain is untouched", () => {
    const existing = {
      bitcoin: "0.001", // the adapter's stale single-address subset
      litecoin: "4.3",
      ethereum: "2.0",
      solana: "10",
    };
    const overrides: SharedCoinBalance[] = [
      { ticker: "BTC", chain: "bitcoin", balance: "0.5" },
    ];
    const merged = applySharedCoinBalances(existing, overrides);
    expect(merged.bitcoin).toBe("0.5");
    // Unrelated chains — including LTC, which is shareable but NOT in this
    // override list — must be byte-identical to the input.
    expect(merged.litecoin).toBe("4.3");
    expect(merged.ethereum).toBe("2.0");
    expect(merged.solana).toBe("10");
  });

  it("a null engine balance KEEPS the adapter's numeric reading (2026-08-22 reversal)", () => {
    // Reversed from "null overrides with —". Live use showed the engine is
    // unreachable or not-yet-ready far more often than it is authoritative
    // and wrong: a 4 s engine timeout was blanking a correct LTC balance on
    // every refresh. Stale-but-real beats blank.
    const existing = { bitcoin: "0.001" };
    const overrides: SharedCoinBalance[] = [
      { ticker: "BTC", chain: "bitcoin", balance: null },
    ];
    expect(applySharedCoinBalances(existing, overrides).bitcoin).toBe("0.001");
  });

  it("a null engine balance is '—' only when there was never a numeric reading", () => {
    expect(
      applySharedCoinBalances({}, [{ ticker: "BTC", chain: "bitcoin", balance: null }]).bitcoin,
    ).toBe("—");
    expect(
      applySharedCoinBalances({ bitcoin: "—" }, [{ ticker: "BTC", chain: "bitcoin", balance: null }]).bitcoin,
    ).toBe("—");
  });

  it("an engine ZERO over a positive adapter reading is 'not scanned yet' — adapter kept", () => {
    // The operator's exact symptom: engine LTC wallet freshly initialised from
    // the account key reports 0.0 for its first minutes; the adapter had 4.03.
    const merged = applySharedCoinBalances({ litecoin: "4.03" }, [
      { ticker: "LTC", chain: "litecoin", balance: "0.0" },
    ]);
    expect(merged.litecoin).toBe("4.03");
    // …and an engine zero over an adapter zero/blank is just zero.
    expect(
      applySharedCoinBalances({ litecoin: "—" }, [
        { ticker: "LTC", chain: "litecoin", balance: "0.0" },
      ]).litecoin,
    ).toBe("0.0");
  });

  // 2026-08-23 — REVERSED from "the engine wins whenever nonzero". That
  // assumed the engine's view could only ever be MORE complete than the
  // adapter's, which stopped being true the moment the adapter started
  // account-scanning too (utxo-account-scanning.md). See the module header
  // for the real incident and the source trace into `wallet_manager.py`
  // that confirmed the engine's own bookkeeping can under-count real funds.
  it("takes whichever of engine/adapter is numerically LARGER, not 'engine wins whenever nonzero'", () => {
    // The exact incident: engine reports the receive-address subset only;
    // the adapter's account scan independently found the same seed's change
    // address too. The adapter is not stale here — it is MORE complete.
    expect(
      applySharedCoinBalances({ litecoin: "4.03711096" }, [
        { ticker: "LTC", chain: "litecoin", balance: "0.00823047" },
      ]).litecoin,
    ).toBe("4.03711096");
    // The mirror case still holds: once the engine has genuinely seen more
    // than the adapter (e.g. a very recent spend the adapter hasn't
    // re-probed yet), the engine's larger reading still wins — this is not
    // "adapter always wins", it is "the more informed side wins either way".
    expect(
      applySharedCoinBalances({ litecoin: "0.5" }, [
        { ticker: "LTC", chain: "litecoin", balance: "4.28500000" },
      ]).litecoin,
    ).toBe("4.28500000");
  });

  it("both shared coins override independently", () => {
    const existing = { bitcoin: "0.001", litecoin: "0.002" };
    const overrides: SharedCoinBalance[] = [
      { ticker: "BTC", chain: "bitcoin", balance: "0.5" },
      { ticker: "LTC", chain: "litecoin", balance: "4.3" },
    ];
    const merged = applySharedCoinBalances(existing, overrides);
    expect(merged).toEqual({ bitcoin: "0.5", litecoin: "4.3" });
  });

  it("a chain absent from `existing` can still be introduced by an override", () => {
    // The wallet may not have populated bitcoin yet (e.g. still loading) —
    // the engine's reading must not be dropped waiting for that.
    const merged = applySharedCoinBalances({}, [
      { ticker: "BTC", chain: "bitcoin", balance: "0.5" },
    ]);
    expect(merged).toEqual({ bitcoin: "0.5" });
  });
});

describe("readSharedBalance — one coin out of a fetchWallets() body", () => {
  it("reads a well-formed row", () => {
    expect(readSharedBalance({ BTC: { balance: "0.5" } }, "BTC")).toBe("0.5");
  });

  it("a row-level error is null, not a throw — one bad coin must not sink the other", () => {
    expect(
      readSharedBalance({ BTC: { balance: "0.5", error: "timeout" } }, "BTC"),
    ).toBeNull();
  });

  it("a missing ticker is null", () => {
    expect(readSharedBalance({ LTC: { balance: "4.3" } }, "BTC")).toBeNull();
  });

  it("an empty or missing balance string is null, not an empty string rendered as zero", () => {
    expect(readSharedBalance({ BTC: { balance: "" } }, "BTC")).toBeNull();
    expect(readSharedBalance({ BTC: {} }, "BTC")).toBeNull();
  });

  it("a LOCKED row or one not on the user's seed is null — not ready, not authoritative", () => {
    // `expected_seed: false` is the engine's own lean wallet before the
    // account-key push landed — a true balance for the WRONG keys.
    expect(readSharedBalance({ LTC: { balance: "0.0", expected_seed: false } }, "LTC")).toBeNull();
    expect(readSharedBalance({ LTC: { balance: "4.03", locked: true } }, "LTC")).toBeNull();
    // Ready rows read normally; an absent field stays permissive.
    expect(readSharedBalance({ LTC: { balance: "4.03", expected_seed: true, locked: false } }, "LTC")).toBe("4.03");
    expect(readSharedBalance({ LTC: { balance: "4.03" } }, "LTC")).toBe("4.03");
  });

  it("a null wallets body (engine unreachable) is null for every ticker", () => {
    expect(readSharedBalance(null, "BTC")).toBeNull();
  });
});

describe("the operator's `0 LTC` flicker, end to end", () => {
  // The exact live sequence (2026-08-22). On every node start PWNDA-PATCH-3
  // refuses to build BTC/LTC from the engine's own seed until pwnda pushes
  // the account key, so for that window /json/wallets reports the coin with
  // `expected_seed: false` and `balance: "0"`. The wallet then displayed that
  // zero over its own correct reading, and "healed" when runSharePass landed.
  //
  // This walks the WHOLE chain — engine row → readSharedBalance →
  // applySharedCoinBalances — rather than asserting on the merge alone,
  // because the bug lived in the seam between them: each half was defensible
  // and the composition was wrong.
  const ADAPTER = { litecoin: "4.03000000" };

  it("engine not yet initialised from the account key: the wallet keeps its own number", () => {
    const engineRow = { LTC: { balance: "0", expected_seed: false, locked: false } };
    const balance = readSharedBalance(engineRow, "LTC");
    expect(balance, "a not-yet-seeded row must read as unusable").toBeNull();
    const merged = applySharedCoinBalances(ADAPTER, [
      { ticker: "LTC", chain: "litecoin", balance },
    ]);
    expect(merged.litecoin).toBe("4.03000000");
  });

  it("engine seeded but still scanning (0 over a positive reading): still keeps it", () => {
    // The second half of the window: the key landed, so expected_seed flips
    // true, but the electrum wallet has not finished its first scan.
    const engineRow = { LTC: { balance: "0", expected_seed: true, locked: false } };
    const merged = applySharedCoinBalances(ADAPTER, [
      { ticker: "LTC", chain: "litecoin", balance: readSharedBalance(engineRow, "LTC") },
    ]);
    expect(merged.litecoin).toBe("4.03000000");
  });

  it("once the engine has really scanned, it WINS — the switch still does its job", () => {
    // Not a regression guard against the fix: this is the case C8 exists for.
    // The engine sees every address it has spent to; the adapter sees one.
    const engineRow = { LTC: { balance: "4.28500000", expected_seed: true, locked: false } };
    const merged = applySharedCoinBalances(ADAPTER, [
      { ticker: "LTC", chain: "litecoin", balance: readSharedBalance(engineRow, "LTC") },
    ]);
    expect(merged.litecoin).toBe("4.28500000");
  });

  it("a genuinely empty shared wallet still reads zero when the adapter agrees", () => {
    const engineRow = { LTC: { balance: "0", expected_seed: true, locked: false } };
    const merged = applySharedCoinBalances({ litecoin: "0" }, [
      { ticker: "LTC", chain: "litecoin", balance: readSharedBalance(engineRow, "LTC") },
    ]);
    expect(merged.litecoin).toBe("0");
  });
});
