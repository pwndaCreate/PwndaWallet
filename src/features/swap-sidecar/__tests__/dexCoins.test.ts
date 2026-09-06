/**
 * C3 — the two faults these tests exist to catch.
 *
 * **The selection gate opening when it should not (§R9).** Spending a UTXO the
 * DEX has reserved aborts a live swap and can forfeit the leg. The gate is
 * supposed to fail closed, and "closed" has to survive every not-yet-answered
 * shape: `null`, a transport failure, a stale-from-disk answer, and a
 * malformed body whose `allowed` is truthy-but-not-`true`. Note what is
 * deliberately NOT asserted anywhere here: `SelectionGate.reason`. It is
 * display copy, it will be reworded, and a test that keys off it passes for the
 * wrong reason.
 *
 * **A corrupted mirror reading as consent.** The plaintext store key is
 * writable by anything that can write `wallet.dat`. `normalizeDexCoins` must
 * default every field to the *safe* value — a garbage record must not read as
 * "enabled, descriptor adoption", which would claim a key import already
 * happened.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The store is the module's only I/O. Mocking it lets the read/write ordering
// and the normalisation-on-read be exercised for real.
const store = {
  data: new Map<string, unknown>(),
  get: vi.fn(async (k: string) => store.data.get(k)),
  set: vi.fn(async (k: string, v: unknown) => {
    store.data.set(k, v);
  }),
  save: vi.fn(async () => {}),
  delete: vi.fn(async (k: string) => {
    store.data.delete(k);
  }),
};
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => store),
}));

import {
  DEX_COINS_STORE_KEY,
  dexCoinsDrift,
  dexCoinsOrphans,
  gateBlocks,
  gateSentence,
  liveEnabledTickersFrom,
  normalizeDexCoins,
  readDexCoins,
  writeDexCoin,
  type CoinEnableStatus,
  type DexCoinState,
  type SelectionGate,
} from "../dexCoins";

beforeEach(() => {
  store.data.clear();
  store.get.mockClear();
  store.set.mockClear();
  store.save.mockClear();
});

const gate = (o: Partial<SelectionGate>): SelectionGate => ({
  allowed: false,
  reason: "",
  lockedUtxos: 0,
  activeBids: 0,
  stale: false,
  asOf: "2026-08-19T00:00:00Z",
  ...o,
});

const status = (o: Partial<CoinEnableStatus> & { coin: string }): CoinEnableStatus => ({
  ticker: o.coin.toUpperCase(),
  enabled: false,
  binaryPresent: true,
  configured: true,
  adoption: "deposit",
  descriptorsImported: false,
  mode: "full",
  configuredMode: "full",
  canRunLean: false,
  canShareWallet: false,
  sharesWallet: false,
  xmrHostWalletActive: false,
  estDiskGb: 1,
  ...o,
});

describe("gateBlocks — fails closed", () => {
  it("blocks before an answer exists", () => {
    expect(gateBlocks(null)).toBe(true);
    expect(gateBlocks(undefined)).toBe(true);
  });

  it("blocks on a stale (from-disk) answer", () => {
    // An unreachable daemon can never prove the absence of locks. This is the
    // row that must not be "optimised" into allowing a send.
    expect(gateBlocks(gate({ allowed: false, stale: true }))).toBe(true);
  });

  it("blocks when locks or bids are reported", () => {
    expect(gateBlocks(gate({ allowed: false, lockedUtxos: 2 }))).toBe(true);
    expect(gateBlocks(gate({ allowed: false, activeBids: 1 }))).toBe(true);
  });

  it("blocks on a truthy-but-not-true `allowed`", () => {
    // `!gate.allowed` would let a mock or a malformed body through here. The
    // comparison is `!== true` precisely so this case stays blocked.
    const weird = gate({}) as unknown as { allowed: unknown };
    weird.allowed = "yes";
    expect(gateBlocks(weird as SelectionGate)).toBe(true);
    weird.allowed = 1;
    expect(gateBlocks(weird as SelectionGate)).toBe(true);
  });

  it("allows ONLY a fresh, explicit yes", () => {
    expect(gateBlocks(gate({ allowed: true }))).toBe(false);
  });
});

describe("gateSentence", () => {
  it("says 'stale' out loud rather than flattening it into a plain refusal", () => {
    // A last-known reading and a fresh "there are locks" are different facts.
    // Rendering them identically teaches the user to ignore both.
    const s = gateSentence(gate({ allowed: false, stale: true }));
    expect(s).toMatch(/could not be reached/);
    expect(s).toContain("2026-08-19T00:00:00Z");
  });

  it("counts what is actually reserved", () => {
    expect(gateSentence(gate({ lockedUtxos: 1, activeBids: 0 }))).toMatch(
      /1 reserved output\b/,
    );
    expect(gateSentence(gate({ lockedUtxos: 3, activeBids: 2 }))).toMatch(
      /3 reserved outputs and 2 swaps in flight/,
    );
  });

  it("still says something when the gate refuses without a count", () => {
    expect(gateSentence(gate({ allowed: false }))).not.toBe("");
    expect(gateSentence(null)).not.toBe("");
  });
});

describe("normalizeDexCoins — defaults to the safe value, never the convenient one", () => {
  it("reads a well-formed map", () => {
    expect(
      normalizeDexCoins({
        btc: { enabled: true, at: 1234, adoption: "descriptor" },
      }),
    ).toEqual({ btc: { enabled: true, at: 1234, adoption: "descriptor" } });
  });

  it("treats a missing/garbage `enabled` as DISABLED", () => {
    // Reading corruption as "enabled" is the direction that does damage.
    expect(normalizeDexCoins({ btc: {} }).btc.enabled).toBe(false);
    expect(normalizeDexCoins({ btc: { enabled: "true" } }).btc.enabled).toBe(false);
    expect(normalizeDexCoins({ btc: { enabled: 1 } }).btc.enabled).toBe(false);
  });

  it("treats an unknown adoption as `deposit`, matching Rust's #[default]", () => {
    // "descriptor" claims the node already holds spending keys for this coin.
    // A corrupted record must never be able to claim that.
    expect(normalizeDexCoins({ btc: { adoption: "descriptorish" } }).btc.adoption).toBe(
      "deposit",
    );
    expect(normalizeDexCoins({ btc: {} }).btc.adoption).toBe("deposit");
  });

  it("lowercases and trims coin keys, and drops entries that are not objects", () => {
    const out = normalizeDexCoins({
      " BTC ": { enabled: true },
      ltc: "nope",
      doge: null,
      dash: [],
      "": { enabled: true },
    });
    expect(Object.keys(out)).toEqual(["btc"]);
  });

  it("returns {} for a non-map body instead of throwing", () => {
    for (const bad of [null, undefined, [], "x", 3]) {
      expect(normalizeDexCoins(bad)).toEqual({});
    }
  });

  it("coerces a non-finite `at` to 0", () => {
    expect(normalizeDexCoins({ btc: { at: Number.NaN } }).btc.at).toBe(0);
    expect(normalizeDexCoins({ btc: { at: "yesterday" } }).btc.at).toBe(0);
  });
});

describe("the plaintext mirror", () => {
  it("reads through normalisation, not raw", () => {
    store.data.set(DEX_COINS_STORE_KEY, { BTC: { enabled: true, adoption: "bogus" } });
    return readDexCoins().then((c) => {
      expect(c).toEqual({ btc: { enabled: true, at: 0, adoption: "deposit" } });
    });
  });

  it("merges rather than replacing, and saves", async () => {
    store.data.set(DEX_COINS_STORE_KEY, {
      btc: { enabled: true, at: 1, adoption: "descriptor" },
    });
    const next = await writeDexCoin("LTC", true, "descriptor");
    expect(Object.keys(next).sort()).toEqual(["btc", "ltc"]);
    expect(next.btc.enabled).toBe(true);
    expect(next.ltc.enabled).toBe(true);
    // A write that did not persist leaves the UI and the disk disagreeing after
    // the next reload.
    expect(store.set).toHaveBeenCalledWith(DEX_COINS_STORE_KEY, next);
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("writes under the key that mirrors the opt-in flag", () => {
    expect(DEX_COINS_STORE_KEY).toBe("pwnda.dexCoinsEnabled");
  });
});

describe("drift between the mirror and the backend", () => {
  const statuses = [
    status({ coin: "btc", enabled: true }),
    status({ coin: "ltc", enabled: false }),
    // Enabled on the backend and ABSENT from the mirror — the sparse case a
    // fresh install is entirely made of.
    status({ coin: "doge", enabled: true }),
  ];
  const local: Record<string, DexCoinState> = {
    btc: { enabled: false, at: 0, adoption: "deposit" },
    ltc: { enabled: false, at: 0, adoption: "deposit" },
    xmr: { enabled: true, at: 0, adoption: "deposit" },
  };

  it("reports only coins present in BOTH that disagree", () => {
    // Not `["btc", "doge"]`: the mirror having no opinion about DOGE is not a
    // disagreement about DOGE. Folding "absent" into "disabled" would light up
    // every coin on a fresh install.
    expect(dexCoinsDrift(statuses, local)).toEqual(["btc"]);
  });

  it("does not call an unread mirror a disagreement", () => {
    // `null` means "not read yet". Reporting that as drift would put a warning
    // on every cold start.
    expect(dexCoinsDrift(statuses, null)).toEqual([]);
    expect(dexCoinsDrift(null, local)).toEqual([]);
    // An empty-but-read mirror is the same story by a different route.
    expect(dexCoinsDrift(statuses, {})).toEqual([]);
  });

  it("reports a local opinion about a coin the backend never mentioned", () => {
    expect(dexCoinsOrphans(statuses, local)).toEqual(["xmr"]);
    expect(dexCoinsOrphans(statuses, null)).toEqual([]);
  });

  it("compares case-insensitively", () => {
    expect(
      dexCoinsDrift([status({ coin: "BTC", enabled: true })], {
        btc: { enabled: false, at: 0, adoption: "deposit" },
      }),
    ).toEqual(["btc"]);
  });
});

// =========================================================================
// 2026-09-04 — the P2P picker's live gate
// =========================================================================

function row(coin: string, ticker: string, o: Partial<CoinEnableStatus> = {}): CoinEnableStatus {
  return {
    coin,
    ticker,
    enabled: true,
    binaryPresent: true,
    configured: true,
    adoption: "deposit",
    descriptorsImported: false,
    mode: "full",
    configuredMode: "full",
    canRunLean: false,
    canShareWallet: false,
    sharesWallet: false,
    xmrHostWalletActive: false,
    estDiskGb: 0,
    ...o,
  };
}

describe("liveEnabledTickersFrom — what the node is actually running", () => {
  it("is null until the first status read lands — an empty set would empty the picker", () => {
    expect(liveEnabledTickersFrom(null)).toBeNull();
    expect(liveEnabledTickersFrom(undefined)).toBeNull();
    expect(liveEnabledTickersFrom([])).toBeNull();
  });

  it("includes enabled, configured, unparked coins only — uppercase tickers", () => {
    const set = liveEnabledTickersFrom([
      row("bitcoin", "btc"),
      row("litecoin", "LTC", { enabled: false }),
      row("zephyr", "ZEPH", { configured: false }), // waiting to be added
      row("zano", "ZANO", { active: false }), // PARKED this session
      row("monero", "XMR", { active: true }),
      row("bitcoincash", "BCH", { active: null }), // pre-2026-09-04 backend: no field
    ]);
    expect([...set!].sort()).toEqual(["BCH", "BTC", "XMR"]);
  });

  it("a parked host-wallet coin is NOT offered even though it is enabled and configured", () => {
    // The engine deliberately runs a ZEPH whose wallet process was closed at
    // node start as `connection_type: none`; offering it builds a pair the
    // engine cannot settle.
    const set = liveEnabledTickersFrom([row("zephyr", "ZEPH", { active: false })]);
    expect(set!.has("ZEPH")).toBe(false);
    const on = liveEnabledTickersFrom([row("zephyr", "ZEPH", { active: true })]);
    expect(on!.has("ZEPH")).toBe(true);
  });
});
