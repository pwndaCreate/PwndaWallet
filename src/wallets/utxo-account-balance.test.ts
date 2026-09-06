/**
 * `resolveUtxoAccountBalance`'s CHEAP path — the lookahead window and the
 * escalation rule (2026-09-04).
 *
 * # The blind spot these pin
 *
 * Between deep scans (six hours apart) the cheap path used to re-probe ONLY
 * the addresses the last deep scan had found. Anything that landed on a new
 * index in between — the swap engine's change after a swap, a deposit to a
 * rotated receive address, this wallet's own change now that it goes to the
 * internal chain — was invisible until the next deep scan, while the
 * dashboard showed a confident total that was missing real money. That is
 * the 2026-08-22 LTC incident (funds at internal/20, dashboard `0`) on a
 * timer, and nothing could have said so: the number was arithmetically right
 * for the addresses it knew about.
 *
 * Every Electrum-family wallet watches `gap_limit` unused addresses past the
 * last used one on both chains; these tests pin the polling equivalent.
 *
 * The store is mocked in memory so a "previous deep scan" can be planted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const memory = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: async () => ({
      get: async (k: string) => memory.get(k) ?? null,
      set: async (k: string, v: unknown) => {
        memory.set(k, v);
      },
      save: async () => {},
      entries: async () => [...memory.entries()],
    }),
  },
}));

import {
  resolveUtxoAccountBalance,
  cheapCandidates,
  CHEAP_LOOKAHEAD_BATCH,
  CHEAP_LOOKAHEAD_SERIAL,
} from "./utxo-account-balance";
import {
  childPath,
  deriveUtxoAddresses,
  type UtxoAccountSpec,
  type UtxoChainIndex,
} from "./utxo-account";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ACCOUNT = "m/84'/2'/0'";

/** Deterministic fake address encoder — the probe keys on it. */
function fakeAddress(node: { publicKey: Uint8Array | null }): string {
  return Array.from(node.publicKey!.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function addrAt(chainIndex: UtxoChainIndex, index: number): string {
  return deriveUtxoAddresses(
    MNEMONIC,
    { accountPath: ACCOUNT, deriveAddress: fakeAddress } as unknown as UtxoAccountSpec,
    chainIndex,
    index,
    1,
  )[0].address;
}

/**
 * A spec whose truth is a map of path → sats, with optional batch probing.
 * Records every probe so the tests can count REQUESTS, not just answers.
 */
function makeSpec(
  funds: Record<string, number>,
  opts: { batch?: boolean } = {},
): { spec: UtxoAccountSpec; requests: string[][]; setFunds(f: Record<string, number>): void } {
  let byAddress = new Map<string, number>();
  const load = (f: Record<string, number>) => {
    byAddress = new Map();
    for (const [path, sat] of Object.entries(f)) {
      const m = /\/(\d+)\/(\d+)$/.exec(path)!;
      byAddress.set(addrAt(Number(m[1]) as UtxoChainIndex, Number(m[2])), sat);
    }
  };
  load(funds);
  const requests: string[][] = [];
  const answer = (a: string) => {
    const sat = byAddress.get(a);
    return { balanceSat: sat ?? 0, used: sat !== undefined };
  };
  const spec: UtxoAccountSpec = {
    chain: "litecoin",
    accountPath: ACCOUNT,
    label: "test",
    deriveAddress: fakeAddress,
    async probe(a) {
      requests.push([a]);
      return answer(a);
    },
    ...(opts.batch
      ? {
          async probeMany(addrs: string[]) {
            requests.push([...addrs]);
            return addrs.map(answer);
          },
          batchSize: 50,
        }
      : {}),
  };
  return { spec, requests, setFunds: load };
}

/** Plant a completed deep scan in the store, as `writeAccountState` would. */
function plantDeepScan(chain: string, fingerprint: string, paths: string[]) {
  memory.set(chain, {
    fingerprint,
    deepScannedAt: Date.now(),
    entries: paths.map((p) => {
      const m = /\/(\d+)\/(\d+)$/.exec(p)!;
      const chainIndex = Number(m[1]) as UtxoChainIndex;
      const index = Number(m[2]);
      return { path: p, address: addrAt(chainIndex, index), chainIndex, index };
    }),
  });
}

beforeEach(() => memory.clear());

describe("cheapCandidates — the window the cheap path re-probes", () => {
  it("an account with NO history costs ONE probe — the lookahead is for active accounts", () => {
    // DOGE/DASH share BlockCypher's ~100/hour keyless cap; every empty account
    // refreshing nine addresses a minute would blow it for nothing.
    for (const batch of [false, true]) {
      const { spec } = makeSpec({}, { batch });
      const c = cheapCandidates(MNEMONIC, spec, []);
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({ chainIndex: 0, index: 0, address: addrAt(0, 0) });
    }
  });

  it("serial specs: touched entries + receive/0 + a short lookahead past the highest used index", () => {
    const { spec } = makeSpec({});
    const known = [
      { path: childPath(ACCOUNT, 0, 3), address: addrAt(0, 3), chainIndex: 0 as const, index: 3 },
      { path: childPath(ACCOUNT, 1, 20), address: addrAt(1, 20), chainIndex: 1 as const, index: 20 },
    ];
    const c = cheapCandidates(MNEMONIC, spec, known);
    const idx = (ci: UtxoChainIndex) => c.filter((e) => e.chainIndex === ci).map((e) => e.index).sort((a, b) => a - b);
    // receive: 0 (always), 3 (known), then 4..3+L
    expect(idx(0)).toEqual([0, 3, ...Array.from({ length: CHEAP_LOOKAHEAD_SERIAL }, (_, i) => 4 + i)]);
    // change: 20 (known), then 21..20+L — NOT 0..19, that is what makes it cheap
    expect(idx(1)).toEqual([20, ...Array.from({ length: CHEAP_LOOKAHEAD_SERIAL }, (_, i) => 21 + i)]);
  });

  it("batch specs: the WHOLE range 0..maxUsed+lookahead, densely, on both chains", () => {
    const { spec } = makeSpec({}, { batch: true });
    const known = [
      { path: childPath(ACCOUNT, 1, 5), address: addrAt(1, 5), chainIndex: 1 as const, index: 5 },
    ];
    const c = cheapCandidates(MNEMONIC, spec, known);
    const idx = (ci: UtxoChainIndex) => c.filter((e) => e.chainIndex === ci).map((e) => e.index);
    expect(idx(0)).toEqual(Array.from({ length: CHEAP_LOOKAHEAD_BATCH }, (_, i) => i)); // nothing used: 0..L-1
    expect(idx(1)).toEqual(Array.from({ length: 6 + CHEAP_LOOKAHEAD_BATCH }, (_, i) => i)); // 0..5+L
  });
});

describe("the cheap path sees what the last deep scan could not", () => {
  it("swap-engine change landing on a NEW internal index is found on the very next refresh (batch)", async () => {
    // Deep scan knew: receive/0 funded. Then the engine spent and put change
    // at internal/3 — an address no persisted entry names.
    const { spec, requests, setFunds } = makeSpec({ [childPath(ACCOUNT, 0, 0)]: 1_000_000 }, { batch: true });
    plantDeepScan("litecoin", addrAt(0, 0), [childPath(ACCOUNT, 0, 0)]);
    setFunds({ [childPath(ACCOUNT, 0, 0)]: 0, [childPath(ACCOUNT, 1, 3)]: 402_888_049 });
    // receive/0 is now spent-empty but still USED; make the fixture say so.
    // (used = "has a funds entry", so keep the key with 0 sats.)

    const s = await resolveUtxoAccountBalance("litecoin", [spec], MNEMONIC, addrAt(0, 0));

    expect(s.complete).toBe(true);
    expect(s.totalSat).toBe(402_888_049);
    expect(s.entries.map((e) => e.path)).toContain(childPath(ACCOUNT, 1, 3));
    // The surprise escalated to a deep walk (deep: true), which re-persisted.
    expect(s.deep).toBe(true);
    const stored = memory.get("litecoin") as { entries: Array<{ path: string }> };
    expect(stored.entries.map((e) => e.path)).toContain(childPath(ACCOUNT, 1, 3));
    // And it was CHEAP: with a batch probe the cheap window is 2 requests,
    // the deep walk that followed a handful more — nowhere near ~90.
    expect(requests.length).toBeLessThan(12);
  });

  it("no surprise ⇒ stays on the cheap path (deep: false) and does not re-persist", async () => {
    const { spec, requests } = makeSpec({ [childPath(ACCOUNT, 0, 0)]: 1_000_000 }, { batch: true });
    plantDeepScan("litecoin", addrAt(0, 0), [childPath(ACCOUNT, 0, 0)]);
    const before = JSON.stringify(memory.get("litecoin"));

    const s = await resolveUtxoAccountBalance("litecoin", [spec], MNEMONIC, addrAt(0, 0));

    expect(s.complete).toBe(true);
    expect(s.deep).toBe(false);
    expect(s.totalSat).toBe(1_000_000);
    // Both chains' windows (20 + 20 addresses) fit one 50-address batch, so
    // the whole refresh is ONE request. The point is the order of magnitude:
    // this used to be a request per known address every minute.
    expect(requests).toHaveLength(1);
    // receive: 0..(0 + L) inclusive = L + 1 (index 0 is used); change: 0..L-1.
    expect(requests[0]).toHaveLength(1 + CHEAP_LOOKAHEAD_BATCH + CHEAP_LOOKAHEAD_BATCH);
    expect(JSON.stringify(memory.get("litecoin"))).toBe(before);
  });

  it("serial specs: the lookahead catches change at maxUsed+1 (our own change policy) in a few requests", async () => {
    // Our own send puts change at the LOWEST unused internal index; with
    // nothing on the change chain yet that is internal/0 — inside the window.
    const { spec, requests, setFunds } = makeSpec({ [childPath(ACCOUNT, 0, 0)]: 5_000_000 });
    plantDeepScan("litecoin", addrAt(0, 0), [childPath(ACCOUNT, 0, 0)]);
    setFunds({ [childPath(ACCOUNT, 0, 0)]: 0, [childPath(ACCOUNT, 1, 0)]: 4_900_000 });

    const s = await resolveUtxoAccountBalance("litecoin", [spec], MNEMONIC, addrAt(0, 0));

    expect(s.complete).toBe(true);
    expect(s.totalSat).toBe(4_900_000);
    expect(s.entries.map((e) => e.path)).toContain(childPath(ACCOUNT, 1, 0));
    // Cheap window (1 + L on receive, L on change) plus the escalated walk.
    expect(requests.length).toBeLessThan(120);
  });

  it("a deposit to an OLD emptied receive address is seen by a batch spec (dense window)", async () => {
    const { spec, setFunds } = makeSpec(
      { [childPath(ACCOUNT, 0, 0)]: 0, [childPath(ACCOUNT, 0, 4)]: 10_000 },
      { batch: true },
    );
    plantDeepScan("litecoin", addrAt(0, 0), [childPath(ACCOUNT, 0, 0), childPath(ACCOUNT, 0, 4)]);
    // Someone pays the long-emptied receive/0 again.
    setFunds({ [childPath(ACCOUNT, 0, 0)]: 777, [childPath(ACCOUNT, 0, 4)]: 10_000 });

    const s = await resolveUtxoAccountBalance("litecoin", [spec], MNEMONIC, addrAt(0, 0));
    expect(s.totalSat).toBe(10_777);
  });

  it("a source failure inside the window reports INCOMPLETE rather than a lower bound", async () => {
    const { spec } = makeSpec({ [childPath(ACCOUNT, 0, 0)]: 1_000_000 });
    plantDeepScan("litecoin", addrAt(0, 0), [childPath(ACCOUNT, 0, 0)]);
    const failing: UtxoAccountSpec = {
      ...spec,
      async probe(a) {
        if (a === addrAt(1, 0)) throw new Error("explorer down");
        return spec.probe(a);
      },
    };
    const s = await resolveUtxoAccountBalance("litecoin", [failing], MNEMONIC, addrAt(0, 0));
    expect(s.complete).toBe(false);
  });
});
