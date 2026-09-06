/**
 * C3.5 — the faults these tests exist to catch.
 *
 * **LTC's missing `listdescriptors` read as a failed import.** Measured on
 * regtest against the real binaries: LTC *accepts* `importdescriptors` and has
 * *no* `listdescriptors`. The obvious way to verify an import — read the
 * descriptors back — therefore reports a perfectly good LTC import as broken.
 * The rule lives in exactly two predicates and both are pinned here.
 *
 * **A coin without a measured plan silently getting BTC's.** BTC is purpose 84
 * / `wpkh`; DOGE, DASH and BCH are purpose 44 / `pkh`. Running the wrong one
 * imports descriptors for addresses the user does not own, and the failure
 * presents as a zero balance rather than as an error — there is nothing to see.
 *
 * **A future `birthdayUnix` skipping the user's whole history.** The rescan
 * starts at the timestamp; a future one starts after every block that could
 * hold the funds. The import then reports success and finds nothing — the same
 * silent-zero outcome §R12 is about, arriving by a second route.
 *
 * **Key material in a report that gets rendered.** `imported` carries branch
 * labels by contract. A descriptor built from an account xprv *is* a spending
 * key, and this struct is serialized straight to the webview (§R16).
 */
import { describe, it, expect } from "vitest";
import {
  ADOPTION_MEASURED_ON,
  DEFAULT_RANGE_END,
  MAX_RANGE_END,
  adoptionPlanFor,
  coinsWithAdoptionPlan,
  coveredBothBranches,
  defaultAdoptionFor,
  expectedBranchLabels,
  importOptionsFor,
  precheckImport,
  readBackAbsenceIsFailure,
  reportContainsKeyMaterial,
  shouldAttemptReadBack,
} from "../descriptorAdoption";
import type { BasicSwapWalletInfo, CoinOptIn, DescriptorImportReport } from "../../../api/basicswap";

const optIn = (o: Partial<CoinOptIn> = {}): CoinOptIn => ({
  enabled: true,
  at: null,
  adoption: "descriptor",
  descriptorsImportedAt: null,
  firstSyncStarted: false,
  mode: "full",
  ...o,
});

/** The state C3.5 requires: encrypted at rest AND currently unlocked. */
const READY: BasicSwapWalletInfo = { encrypted: true, locked: false, balance: "0.0" };

describe("the measured capability table", () => {
  it("covers exactly the five seedable UTXO coins", () => {
    expect(coinsWithAdoptionPlan()).toEqual(["bch", "btc", "dash", "doge", "ltc"]);
    expect(ADOPTION_MEASURED_ON).toBe("2026-08-19");
  });

  it("uses importmulti for BCH and importdescriptors for the other four", () => {
    // Measured: BCH has no importdescriptors at all.
    expect(adoptionPlanFor("bch")?.method).toBe("importmulti");
    for (const c of ["btc", "ltc", "doge", "dash"]) {
      expect(adoptionPlanFor(c)?.method).toBe("importdescriptors");
    }
  });

  it("maps purpose 84 to wpkh (BTC, LTC) and purpose 44 to pkh (DOGE, DASH, BCH)", () => {
    // Contract §1.5 item 3. Getting this backwards imports descriptors for
    // addresses the user does not own; the symptom is a zero balance.
    expect(adoptionPlanFor("btc")).toMatchObject({ purpose: 84, descriptorFn: "wpkh" });
    expect(adoptionPlanFor("ltc")).toMatchObject({ purpose: 84, descriptorFn: "wpkh" });
    for (const c of ["doge", "dash", "bch"]) {
      expect(adoptionPlanFor(c)).toMatchObject({ purpose: 44, descriptorFn: "pkh" });
    }
  });

  it("labels what was probed and what was not", () => {
    // DOGE/DASH `listdescriptors` was NOT probed. Recording that honestly is
    // what stops the next agent from reading `tolerate` as a measurement.
    expect(adoptionPlanFor("btc")?.provenance).toEqual({
      method: "measured",
      readBack: "measured",
    });
    expect(adoptionPlanFor("ltc")?.provenance).toEqual({
      method: "measured",
      readBack: "measured",
    });
    for (const c of ["doge", "dash", "bch"]) {
      expect(adoptionPlanFor(c)?.provenance.readBack).toBe("not-probed");
    }
  });

  it("refuses an unknown coin instead of falling back to BTC's plan", () => {
    for (const bad of ["xmr", "eth", "", "  ", null, undefined, 7 as unknown as string]) {
      expect(adoptionPlanFor(bad)).toBeNull();
    }
  });

  it("resolves case-insensitively and trimmed", () => {
    expect(adoptionPlanFor(" BTC ")?.coin).toBe("btc");
  });
});

describe("read-back policy — the LTC rule", () => {
  it("does NOT call listdescriptors for LTC", () => {
    // Not "call it and forgive the error" — do not call it. A fork that answers
    // a missing method with something other than a clean method-not-found
    // cannot then produce a failure at all.
    expect(shouldAttemptReadBack(adoptionPlanFor("ltc"))).toBe(false);
  });

  it("never treats LTC's missing read-back as an import failure", () => {
    // This is the single assertion that separates a working LTC import from a
    // reported fault.
    expect(readBackAbsenceIsFailure(adoptionPlanFor("ltc"))).toBe(false);
  });

  it("DOES treat a missing read-back as failure on BTC, where it was measured present", () => {
    expect(shouldAttemptReadBack(adoptionPlanFor("btc"))).toBe(true);
    expect(readBackAbsenceIsFailure(adoptionPlanFor("btc"))).toBe(true);
  });

  it("probes but believes nothing on the un-probed coins", () => {
    for (const c of ["doge", "dash", "bch"]) {
      expect(shouldAttemptReadBack(adoptionPlanFor(c))).toBe(true);
      expect(readBackAbsenceIsFailure(adoptionPlanFor(c))).toBe(false);
    }
  });

  it("treats a coin with no plan as neither", () => {
    expect(shouldAttemptReadBack(null)).toBe(false);
    expect(readBackAbsenceIsFailure(null)).toBe(false);
  });
});

describe("default adoption", () => {
  it("is descriptor for every coin with a plan — BCH included", () => {
    // BCH reaches the same zero-move outcome through ranged importmulti.
    for (const c of ["btc", "ltc", "doge", "dash", "bch"]) {
      expect(defaultAdoptionFor(c)).toBe("descriptor");
    }
  });

  it("is deposit for anything else, because deposit always works", () => {
    expect(defaultAdoptionFor("xmr")).toBe("deposit");
    expect(defaultAdoptionFor(null)).toBe("deposit");
  });
});

describe("branch labels", () => {
  it("names both branches at the plan's purpose", () => {
    expect(expectedBranchLabels(adoptionPlanFor("btc"))).toEqual([
      "bip84-external",
      "bip84-internal",
    ]);
    expect(expectedBranchLabels(adoptionPlanFor("doge"))).toEqual([
      "bip44-external",
      "bip44-internal",
    ]);
    expect(expectedBranchLabels(null)).toEqual([]);
  });

  it("a one-branch import does not count as covered", () => {
    // Importing only the external branch leaves change unspendable, which
    // presents as "the balance is wrong", not as an error.
    const plan = adoptionPlanFor("btc");
    const rep = (imported: string[]): DescriptorImportReport => ({
      coin: "btc",
      walletName: "wallet.dat",
      imported,
      method: "importdescriptors",
      warnings: [],
    });
    expect(coveredBothBranches(plan, rep(["bip84-external"]))).toBe(false);
    expect(coveredBothBranches(plan, rep(["bip84-external", "bip84-internal"]))).toBe(true);
    expect(coveredBothBranches(plan, rep(["BIP84-EXTERNAL", "BIP84-INTERNAL"]))).toBe(true);
    expect(coveredBothBranches(plan, rep(["bip44-external", "bip44-internal"]))).toBe(false);
    expect(coveredBothBranches(plan, null)).toBe(false);
    expect(coveredBothBranches(null, rep([]))).toBe(false);
  });
});

describe("reportContainsKeyMaterial — the render guard", () => {
  const base: DescriptorImportReport = {
    coin: "btc",
    walletName: "wallet.dat",
    imported: ["bip84-external", "bip84-internal"],
    method: "importdescriptors",
    warnings: ["rescan may take a while"],
  };

  it("passes a report carrying branch labels only", () => {
    expect(reportContainsKeyMaterial(base)).toBe(false);
    expect(reportContainsKeyMaterial(null)).toBe(false);
  });

  it("catches an xprv or a raw descriptor anywhere in the report", () => {
    expect(
      reportContainsKeyMaterial({ ...base, imported: ["wpkh([f0/84h/0h/0h]xprv9s21.../0/*)"] }),
    ).toBe(true);
    expect(
      reportContainsKeyMaterial({ ...base, warnings: ["zprvAWgYBB… was rejected"] }),
    ).toBe(true);
    expect(reportContainsKeyMaterial({ ...base, warnings: ["desc checksum mismatch"] })).toBe(
      true,
    );
  });
});

describe("precheckImport — advisory, ordered, and closed by default", () => {
  it("refuses a coin with no measured plan first of all", () => {
    const r = precheckImport({ coin: "xmr", wallet: READY, optIn: optIn() });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no-plan");
  });

  it("refuses when the wallet is not encrypted (§R10)", () => {
    // After the import this wallet file can spend the user's existing funds.
    // The encryption password is the only thing protecting it.
    expect(
      precheckImport({ coin: "btc", wallet: { encrypted: false }, optIn: optIn() }).code,
    ).toBe("not-encrypted");
    expect(precheckImport({ coin: "btc", wallet: {}, optIn: optIn() }).code).toBe(
      "not-encrypted",
    );
  });

  it("refuses when the wallet info has not been read yet", () => {
    // `null` cannot show encryption is on. Unknown blocks.
    expect(precheckImport({ coin: "btc", wallet: null, optIn: optIn() }).ok).toBe(false);
  });

  it("refuses a locked wallet", () => {
    expect(
      precheckImport({
        coin: "btc",
        wallet: { encrypted: true, locked: true },
        optIn: optIn(),
      }).code,
    ).toBe("locked");
  });

  it("refuses after first sync, naming BOTH remedies (§R12)", () => {
    const r = precheckImport({
      coin: "btc",
      wallet: READY,
      optIn: optIn({ firstSyncStarted: true }),
    });
    // The boolean is the assertion that matters; the text is asserted too only
    // because the contract requires both remedies to be named — a message that
    // offers one leaves the user with no way out of the other.
    expect(r.ok).toBe(false);
    expect(r.code).toBe("first-sync-started");
    expect(r.reason).toMatch(/resync/i);
    expect(r.reason).toMatch(/consolidat/i);
  });

  it("shows the most fundamental refusal when several apply", () => {
    // A user who wipes and resyncs a chain, only to be told encryption was
    // never configured, was sent down the wrong path by the error message.
    const r = precheckImport({
      coin: "btc",
      wallet: { encrypted: false },
      optIn: optIn({ firstSyncStarted: true }),
    });
    expect(r.code).toBe("not-encrypted");
  });

  it("passes only when everything holds", () => {
    const r = precheckImport({ coin: "btc", wallet: READY, optIn: optIn() });
    expect(r).toEqual({ ok: true, code: null, reason: null });
  });

  it("treats an absent opt-in record as the fresh case, not as a block", () => {
    expect(precheckImport({ coin: "btc", wallet: READY, optIn: null }).ok).toBe(true);
  });
});

describe("importOptionsFor", () => {
  const NOW = Date.UTC(2026, 7, 19) as number;

  it("defaults the range and omits an unstated birthday", () => {
    expect(importOptionsFor("btc")).toEqual({ rangeEnd: DEFAULT_RANGE_END });
    expect(importOptionsFor("bch")).toEqual({ rangeEnd: DEFAULT_RANGE_END });
  });

  it("passes an explicit range and birthday through", () => {
    expect(
      importOptionsFor("btc", { rangeEnd: 42, birthdayUnix: 1_600_000_000, nowMs: NOW }),
    ).toEqual({ rangeEnd: 42, birthdayUnix: 1_600_000_000 });
  });

  it("refuses a coin with no plan", () => {
    expect(() => importOptionsFor("xmr")).toThrow(/no descriptor-import plan/);
  });

  it("refuses a range that is negative, fractional, or absurd", () => {
    for (const bad of [-1, 1.5, MAX_RANGE_END + 1, Number.NaN]) {
      expect(() => importOptionsFor("btc", { rangeEnd: bad })).toThrow(/rangeEnd/);
    }
    expect(importOptionsFor("btc", { rangeEnd: 0 }).rangeEnd).toBe(0);
    expect(importOptionsFor("btc", { rangeEnd: MAX_RANGE_END }).rangeEnd).toBe(MAX_RANGE_END);
  });

  it("refuses a FUTURE birthday", () => {
    // The rescan starts at this timestamp. A future one starts after every
    // block that could hold the user's funds; the import then succeeds and
    // finds nothing.
    const future = Math.floor(NOW / 1000) + 86_400;
    expect(() => importOptionsFor("btc", { birthdayUnix: future, nowMs: NOW })).toThrow(
      /future/,
    );
    // The boundary itself is fine.
    expect(
      importOptionsFor("btc", { birthdayUnix: Math.floor(NOW / 1000), nowMs: NOW })
        .birthdayUnix,
    ).toBe(Math.floor(NOW / 1000));
  });

  it("refuses a negative or fractional birthday", () => {
    expect(() => importOptionsFor("btc", { birthdayUnix: -1, nowMs: NOW })).toThrow(
      /birthdayUnix/,
    );
    expect(() => importOptionsFor("btc", { birthdayUnix: 1.5, nowMs: NOW })).toThrow(
      /birthdayUnix/,
    );
  });

  it("never invents a birthday when none was given", () => {
    // Omitted means Rust sends 0 (rescan from genesis). Defaulting to `now`
    // here would skip exactly the history the import exists to find.
    expect("birthdayUnix" in importOptionsFor("btc")).toBe(false);
  });
});
