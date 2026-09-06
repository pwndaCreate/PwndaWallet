/**
 * Tests for account-wide UTXO scanning.
 *
 * The centrepiece is §"the operator's invisible 4.03 LTC" — the real 2026-08-22
 * incident, reproduced from its actual shape: internal chain, indices 0–19
 * never used, 402888049 sat sitting at index 20. Every other case here exists
 * because it is a way the walk could stop one address too early.
 */
import { describe, it, expect } from "vitest";
import { HDKey } from "@scure/bip32";
import {
  deriveUtxoAddresses,
  scanUtxoAccount,
  analyzeRecoveryRisk,
  assessGapHeadroom,
  childPath,
  satsToDecimal,
  DEFAULT_GAP_LIMIT,
  STANDARD_GAP_LIMIT,
  type UtxoAccountSpec,
  type UtxoAddressEntry,
  type UtxoChainIndex,
} from "./utxo-account";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Deterministic fake address encoding — no bitcoinjs needed to test the walk. */
function fakeAddress(node: HDKey): string {
  return Array.from(node.publicKey!.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a spec whose `probe` answers from a fixture keyed by full path, so a
 * test can say "index 20 of the change chain holds X" without knowing what
 * address that derives to.
 */
function specWithFunds(
  funds: Record<string, { sat?: number; used?: boolean }>,
  opts?: { failOn?: (address: string) => boolean },
): { spec: UtxoAccountSpec; probes: string[] } {
  const accountPath = "m/84'/2'/0'";
  const byAddress = new Map<string, { sat: number; used: boolean }>();
  for (const [path, v] of Object.entries(funds)) {
    const m = /\/(\d+)\/(\d+)$/.exec(path);
    if (!m) throw new Error(`bad fixture path ${path}`);
    const chainIndex = Number(m[1]) as UtxoChainIndex;
    const index = Number(m[2]);
    const [d] = deriveUtxoAddresses(
      MNEMONIC,
      { accountPath, deriveAddress: fakeAddress } as UtxoAccountSpec,
      chainIndex,
      index,
      1,
    );
    byAddress.set(d.address, { sat: v.sat ?? 0, used: v.used ?? (v.sat ?? 0) > 0 });
  }
  const probes: string[] = [];
  const spec: UtxoAccountSpec = {
    chain: "litecoin",
    accountPath,
    label: "BIP-84 native SegWit",
    deriveAddress: fakeAddress,
    async probe(address: string) {
      probes.push(address);
      if (opts?.failOn?.(address)) throw new Error("source unavailable");
      const hit = byAddress.get(address);
      return { balanceSat: hit?.sat ?? 0, used: hit?.used ?? false };
    },
  };
  return { spec, probes };
}

function entry(
  chainIndex: UtxoChainIndex,
  index: number,
  balanceSat: number,
  used = true,
): UtxoAddressEntry {
  return {
    path: childPath("m/84'/2'/0'", chainIndex, index),
    address: `addr-${chainIndex}-${index}`,
    chainIndex,
    index,
    balanceSat,
    used,
  };
}

describe("derivation", () => {
  it("builds BIP-44 style paths with the chain and index tail", () => {
    expect(childPath("m/84'/2'/0'", 1, 20)).toBe("m/84'/2'/0'/1/20");
  });

  it("derives distinct addresses per index and is deterministic", () => {
    const spec = specWithFunds({}).spec;
    const a = deriveUtxoAddresses(MNEMONIC, spec, 0, 0, 3);
    const b = deriveUtxoAddresses(MNEMONIC, spec, 0, 0, 3);
    expect(a.map((x) => x.address)).toEqual(b.map((x) => x.address));
    expect(new Set(a.map((x) => x.address)).size).toBe(3);
    expect(a[2].path).toBe("m/84'/2'/0'/0/2");
  });

  it("separates the receive and change chains", () => {
    const spec = specWithFunds({}).spec;
    const recv = deriveUtxoAddresses(MNEMONIC, spec, 0, 0, 1)[0];
    const chg = deriveUtxoAddresses(MNEMONIC, spec, 1, 0, 1)[0];
    expect(recv.address).not.toBe(chg.address);
  });
});

describe("the operator's invisible 4.03 LTC (2026-08-22)", () => {
  // The real shape: receive/0 used and now empty, change/20 holding the money,
  // change 0..19 never touched.
  const REAL = {
    "m/84'/2'/0'/0/0": { sat: 0, used: true },
    "m/84'/2'/0'/1/20": { sat: 402888049, used: true },
  };

  it("the default gap limit FINDS the funds the old single-address model missed", async () => {
    const { spec } = specWithFunds(REAL);
    const scan = await scanUtxoAccount(MNEMONIC, spec);
    expect(scan.complete).toBe(true);
    expect(scan.totalSat).toBe(402888049);
    expect(satsToDecimal(scan.totalSat)).toBe("4.02888049");
    expect(scan.entries.some((e) => e.path === "m/84'/2'/0'/1/20")).toBe(true);
    expect(scan.maxUsed.change).toBe(20);
  });

  it("a standard gap limit of 20 would NOT — which is why the default is wider", async () => {
    const { spec } = specWithFunds(REAL);
    const scan = await scanUtxoAccount(MNEMONIC, spec, { gapLimit: STANDARD_GAP_LIMIT });
    expect(scan.totalSat).toBe(0);
    expect(scan.entries.some((e) => e.index === 20)).toBe(false);
  });

  it("DEFAULT_GAP_LIMIT clears the known-bad allocator with margin", () => {
    expect(DEFAULT_GAP_LIMIT).toBeGreaterThan(20);
  });

  it("reports the funds a stock seed restore would strand, and the limit that fixes it", () => {
    const risk = analyzeRecoveryRisk({
      entries: [entry(0, 0, 0), entry(1, 20, 402888049)],
    });
    expect(risk.strandedSat).toBe(402888049);
    expect(risk.strandedEntries.map((e) => e.path)).toEqual(["m/84'/2'/0'/1/20"]);
    // Nothing used before it on the change chain, so a scanner starting at -1
    // needs to reach index 20 → exactly 21.
    expect(risk.requiredGapLimit).toBe(21);
  });

  it("reports no risk once the funds sit inside a standard limit", () => {
    const risk = analyzeRecoveryRisk({ entries: [entry(1, 3, 402888049)] });
    expect(risk.strandedSat).toBe(0);
    expect(risk.strandedEntries).toEqual([]);
    expect(risk.requiredGapLimit).toBe(STANDARD_GAP_LIMIT);
  });
});

describe("the walk cannot stop early", () => {
  it("a used-but-emptied address does not truncate the run", async () => {
    // change/0 was spent to zero. If `used` were ignored and only balance
    // counted, the trailing-unused run would include it and the walk could
    // stop before index 25.
    const { spec } = specWithFunds({
      "m/84'/2'/0'/1/0": { sat: 0, used: true },
      "m/84'/2'/0'/1/25": { sat: 500 },
    });
    const scan = await scanUtxoAccount(MNEMONIC, spec);
    expect(scan.totalSat).toBe(500);
    expect(scan.maxUsed.change).toBe(25);
  });

  it("counts the unused run ACROSS block boundaries, not per block", async () => {
    // Nothing funded anywhere: the walk must still terminate, having probed at
    // least a full gap on each chain and no more than a bounded overshoot.
    const { spec, probes } = specWithFunds({});
    const scan = await scanUtxoAccount(MNEMONIC, spec, { gapLimit: 20 });
    expect(scan.complete).toBe(true);
    expect(scan.totalSat).toBe(0);
    expect(scan.entries).toEqual([]);
    expect(probes.length).toBeGreaterThanOrEqual(40);
    expect(probes.length).toBeLessThan(100);
  });

  it("a funded address deep in the tail keeps the walk going past it", async () => {
    const { spec } = specWithFunds({
      "m/84'/2'/0'/0/0": { sat: 100 },
      "m/84'/2'/0'/0/35": { sat: 700 },
    });
    const scan = await scanUtxoAccount(MNEMONIC, spec);
    expect(scan.totalSat).toBe(800);
    expect(scan.maxUsed.receive).toBe(35);
  });
});

describe("honest failure", () => {
  it("a probe failure marks the scan incomplete instead of reporting a short total", async () => {
    let n = 0;
    const { spec } = specWithFunds(
      { "m/84'/2'/0'/1/20": { sat: 402888049 } },
      { failOn: () => ++n > 5 },
    );
    const scan = await scanUtxoAccount(MNEMONIC, spec);
    expect(scan.complete).toBe(false);
    // The total is NOT authoritative here; the flag is the whole point.
    expect(scan.totalSat).toBeLessThan(402888049);
  });

  it("never coerces an unreachable source into a zero balance claim", async () => {
    const { spec } = specWithFunds({}, { failOn: () => true });
    const scan = await scanUtxoAccount(MNEMONIC, spec);
    expect(scan.complete).toBe(false);
  });
});

describe("satsToDecimal", () => {
  it("matches the 8-dp string shape the adapters return", () => {
    expect(satsToDecimal(0)).toBe("0.00000000");
    expect(satsToDecimal(402888049)).toBe("4.02888049");
    expect(satsToDecimal(432888299)).toBe("4.32888299");
  });
});

/**
 * The PROACTIVE half — see `assessGapHeadroom`'s own doc for why it exists
 * separately from `analyzeRecoveryRisk`. The distinction under test: the risk
 * analysis fires when money is ALREADY unreachable; this fires while the user
 * can still do something about it.
 */
describe("assessGapHeadroom — warning before funds strand, not after", () => {
  it("a fresh, tightly-packed account is ok with full headroom", () => {
    const r = assessGapHeadroom({
      entries: [entry(0, 0, 100_000), entry(1, 0, 50_000), entry(1, 1, 25_000)],
    });
    expect(r.state).toBe("ok");
    expect(r.widestGap).toBe(0);
    expect(r.headroom).toBe(STANDARD_GAP_LIMIT);
  });

  it("warns while still safe — a 16-wide run leaves 4 of 20, under the default threshold", () => {
    // Nothing is stranded here: index 16 is reachable from index 0 (a scanner
    // sitting at 0 probes through 20). But one more skipped allocation is not.
    const r = assessGapHeadroom({
      entries: [entry(1, 0, 10_000), entry(1, 16, 402_888_049)],
    });
    expect(r.state, "must warn BEFORE anything is stranded").toBe("approaching");
    expect(r.widestGap).toBe(15);
    expect(r.headroom).toBe(5);
    expect(r.chainIndex).toBe(1);
    // The reactive check must still be quiet — that is the whole point.
    expect(analyzeRecoveryRisk({ entries: [entry(1, 0, 10_000), entry(1, 16, 402_888_049)] }).strandedSat).toBe(0);
  });

  it("the operator's real 2026-08-22 shape reports `stranded`, not merely approaching", () => {
    // Internal 0-19 never used, 4.02888049 LTC at index 20 — reachable by no
    // stock restore. `stranded` outranks `approaching` because the user's
    // action is different: note the required gap limit, do not just watch it.
    const entries = [entry(0, 0, 0, true), entry(1, 20, 402_888_049)];
    const r = assessGapHeadroom({ entries });
    expect(r.state).toBe("stranded");
    expect(analyzeRecoveryRisk({ entries }).strandedSat).toBe(402_888_049);
  });

  it("measures the WIDEST gap across both chains, and names the chain", () => {
    const r = assessGapHeadroom({
      entries: [
        entry(0, 0, 1), entry(0, 2, 1),   // receive: a 1-wide gap
        entry(1, 0, 1), entry(1, 18, 1),  // change: a 17-wide gap
      ],
    });
    expect(r.widestGap).toBe(17);
    expect(r.chainIndex).toBe(1);
  });

  it("counts the run BEFORE the first used index — a scanner starts at 0", () => {
    // Nothing used until index 18: the scanner burns 18 of its 20 getting
    // there, which is exactly as dangerous as an 18-wide gap in the middle.
    const r = assessGapHeadroom({ entries: [entry(0, 18, 500_000)] });
    expect(r.widestGap).toBe(18);
    expect(r.headroom).toBe(2);
    expect(r.state).toBe("approaching");
  });

  it("an empty account is ok, not a divide-by-nothing", () => {
    const r = assessGapHeadroom({ entries: [] });
    expect(r.state).toBe("ok");
    expect(r.chainIndex).toBeNull();
  });

  it("the threshold is configurable, and the default is 5", () => {
    const entries = [entry(1, 0, 1), entry(1, 14, 1)]; // gap 13, headroom 7
    expect(assessGapHeadroom({ entries }).state).toBe("ok");
    expect(assessGapHeadroom({ entries }, { warnWithin: 8 }).state).toBe("approaching");
  });
});

// =========================================================================
// 2026-09-04 — batch probing and the change-address rule
// =========================================================================

import {
  nextChangeIndex,
  firstUnusedChangeAddress,
  probeAddresses,
  gatherAccountSpend,
  P2WPKH_SIZING,
  DEFAULT_BATCH_SIZE,
} from "./utxo-account";

/**
 * A spec that answers a whole block per call. `batches` records the size of
 * every `probeMany` call so a test can assert on REQUEST COUNT — the thing
 * that actually failed on 2026-09-04 (98 per-address requests, rate-limited
 * at ~10, so the walk never completed and BCH read 0).
 */
function batchSpec(
  funds: Record<string, { sat?: number; used?: boolean }>,
  opts: { batchSize?: number; failBatches?: boolean } = {},
): { spec: UtxoAccountSpec; batches: number[]; singles: string[] } {
  const base = specWithFunds(funds);
  const batches: number[] = [];
  const singles: string[] = [];
  const spec: UtxoAccountSpec = {
    ...base.spec,
    async probe(address: string) {
      singles.push(address);
      return base.spec.probe(address);
    },
    async probeMany(addresses: string[]) {
      batches.push(addresses.length);
      if (opts.failBatches) throw new Error("batch source down");
      return Promise.all(addresses.map((a) => base.spec.probe(a)));
    },
    batchSize: opts.batchSize,
  };
  return { spec, batches, singles };
}

describe("batch probing — the walk that used to cost ~90 requests", () => {
  it("an untouched account is settled in ONE request per chain", async () => {
    const { spec, batches, singles } = batchSpec({});
    const scan = await scanUtxoAccount(MNEMONIC, spec);
    expect(scan.complete).toBe(true);
    expect(singles).toHaveLength(0);
    // gap 40 ≤ default batch 50, so one block per chain covers the whole run.
    expect(batches).toEqual([40, 40]);
  });

  it("the operator's 2026-08-22 shape (change at internal/20) costs a handful, not ~90", async () => {
    const { spec, batches, singles } = batchSpec({
      "m/84'/2'/0'/0/0": { sat: 0, used: true },
      "m/84'/2'/0'/1/20": { sat: 402_888_049 },
    });
    const scan = await scanUtxoAccount(MNEMONIC, spec);
    expect(scan.complete).toBe(true);
    expect(scan.totalSat).toBe(402_888_049);
    expect(singles).toHaveLength(0);
    expect(batches.length).toBeLessThanOrEqual(4);
  });

  it("respects a smaller batchSize", async () => {
    const { spec, batches } = batchSpec({}, { batchSize: 10 });
    await scanUtxoAccount(MNEMONIC, spec);
    expect(batches.every((n) => n <= 10)).toBe(true);
    expect(batches.length).toBeGreaterThanOrEqual(8); // 40 per chain / 10
  });

  it("a batch outage FALLS BACK to per-address probes — the scan still completes", async () => {
    const { spec, batches, singles } = batchSpec(
      { "m/84'/2'/0'/1/20": { sat: 402_888_049 } },
      { failBatches: true },
    );
    const scan = await scanUtxoAccount(MNEMONIC, spec);
    expect(batches.length).toBeGreaterThan(0);
    expect(singles.length).toBeGreaterThan(0);
    expect(scan.complete).toBe(true);
    expect(scan.totalSat).toBe(402_888_049);
  });

  it("a SHORT batch reply (fewer rows than addresses) is treated as a failure, never as zeros", async () => {
    const base = specWithFunds({ "m/84'/2'/0'/0/1": { sat: 5_000 } });
    const singles: string[] = [];
    const spec: UtxoAccountSpec = {
      ...base.spec,
      async probe(a) {
        singles.push(a);
        return base.spec.probe(a);
      },
      async probeMany(addresses) {
        // Drops the last row — a source that silently omits an address.
        const rows = await Promise.all(addresses.slice(0, -1).map((a) => base.spec.probe(a)));
        return rows;
      },
    };
    const r = await probeAddresses(spec, deriveUtxoAddresses(MNEMONIC, spec, 0, 0, 5).map((d) => ({ ...d, chainIndex: 0 as const })));
    expect(r.complete).toBe(true);
    expect(singles).toHaveLength(5); // fell back for the whole block
    expect(r.entries.find((e) => e.index === 1)?.balanceSat).toBe(5_000);
  });

  it("DEFAULT_BATCH_SIZE stays inside what haskoin answers in one call (100 measured live)", () => {
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThanOrEqual(DEFAULT_GAP_LIMIT);
    expect(DEFAULT_BATCH_SIZE).toBeLessThanOrEqual(100);
  });
});

describe("nextChangeIndex — where a send's change goes", () => {
  it("an untouched change chain starts at internal/0", () => {
    expect(nextChangeIndex([])).toBe(0);
    expect(nextChangeIndex([entry(0, 0, 100), entry(0, 7, 5)])).toBe(0); // receive entries do not count
  });

  it("is the LOWEST unused internal index, not MAX+1 — keeps the chain dense (PWNDA-PATCH-9's rule)", () => {
    // The 2026-08-22 shape: the engine skipped 0–19 and used 20.
    expect(nextChangeIndex([entry(1, 20, 402_888_049)])).toBe(0);
    expect(nextChangeIndex([entry(1, 0, 1), entry(1, 1, 1), entry(1, 3, 1)])).toBe(2);
  });

  it("a used-but-emptied change address is NOT reused", () => {
    expect(nextChangeIndex([entry(1, 0, 0, true)])).toBe(1);
  });

  it("firstUnusedChangeAddress refuses without a COMPLETE scan", () => {
    const { spec } = specWithFunds({});
    expect(firstUnusedChangeAddress(MNEMONIC, spec, null)).toBeNull();
    expect(firstUnusedChangeAddress(MNEMONIC, spec, { entries: [], complete: false })).toBeNull();
    const hit = firstUnusedChangeAddress(MNEMONIC, spec, { entries: [entry(1, 0, 1)], complete: true });
    expect(hit?.index).toBe(1);
    expect(hit?.path).toBe("m/84'/2'/0'/1/1");
  });

  it("gatherAccountSpend derives the change address from the same scan the inputs came from", async () => {
    const { spec } = specWithFunds({
      "m/84'/2'/0'/0/0": { sat: 1_000_000 },
      "m/84'/2'/0'/1/0": { sat: 0, used: true }, // internal/0 already used → change goes to /1/1
    });
    const { change, plan } = await gatherAccountSpend({
      mnemonic: MNEMONIC,
      spec,
      sendSat: 100_000,
      feePerVB: 1,
      sizing: P2WPKH_SIZING,
      dustSat: 546,
      fetchUtxos: async () => [{ txid: "ab".repeat(32), vout: 0, valueSat: 1_000_000 }],
    });
    expect(plan.covered).toBe(true);
    expect(change.index).toBe(1);
    expect(change.path).toBe("m/84'/2'/0'/1/1");
    expect(change.address).toBe(deriveUtxoAddresses(MNEMONIC, spec, 1, 1, 1)[0].address);
  });
});
