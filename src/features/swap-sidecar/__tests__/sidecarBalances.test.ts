/**
 * Balances normalisation — the two faults this file exists to catch.
 *
 * **R19 — wrong endpoint shape silently yielding an empty card.**
 * `/json/wallets` is a ticker-keyed object; `/json/walletbalances` is an
 * array. The sandbox mock answered the *object* for both until 2026-08-19, so
 * a consumer built against the wrong endpoint rendered correctly in
 * `dev:sandbox` and empty in production. The test that matters is therefore not
 * "the object maps" — it is "the ARRAY does not silently map to `{}`", because
 * `{}` is exactly what the defect produced and is indistinguishable from a
 * node with no coins.
 *
 * **R18 — unpayable deposit addresses offered with a copy button.**
 * Upstream puts human-readable status text in the address field
 * (`ui/util.py:840-864`, `page_wallet.py:525`). A copy button on
 * `"Refresh necessary"` hands the user a string that cannot receive coins,
 * and a QR encoder will encode it without complaint.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  balanceRowsFrom,
  isNodeNotRunning,
  isZeroAmount,
  SidecarBalanceShapeError,
} from "../useSidecarBalances";
import {
  normalizeDepositAddress,
  DEPOSIT_ADDRESS_PLACEHOLDERS,
} from "../../../api/basicswap";

/** A faithful `/json/wallets` body: ticker-keyed, `getWalletInfo` fields. */
const WALLETS_OBJECT = {
  XMR: {
    name: "Monero",
    balance: "0.850000000000",
    unconfirmed: "0.000000000000",
    deposit_address: "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A",
    encrypted: false,
    locked: false,
    expected_seed: true,
    connection_type: "rpc",
    blocks: 3_000_000,
    synced: "100.00",
  },
  LTC: {
    name: "Litecoin",
    balance: "3.20000000",
    unconfirmed: "0.10000000",
    deposit_address: "ltc1qsandboxdepositaddrxxxxxxxxxxxxxxxxxxx",
    locked: true,
    connection_type: "rpc",
  },
};

/**
 * The `/json/walletbalances` body for the SAME node — array, no
 * `deposit_address`, and the PART/LTC variant rows reuse their parent's
 * ticker (js_server.py:266-274, :298-306).
 */
const WALLETBALANCES_ARRAY = [
  { id: 6, name: "Monero", ticker: "XMR", balance: "0.850000000000", pending: "0.0", connection_type: "rpc" },
  { id: 3, name: "Litecoin", ticker: "LTC", balance: "3.20000000", pending: "0.1", connection_type: "rpc" },
  { id: 4, name: "Litecoin MWEB", ticker: "LTC", balance: "0.0", pending: "0.0" },
];

describe("balanceRowsFrom — endpoint shape (R19)", () => {
  it("maps_ticker_keyed_object", () => {
    const rows = balanceRowsFrom(WALLETS_OBJECT);
    expect(Object.keys(rows).sort()).toEqual(["LTC", "XMR"]);
    expect(rows.XMR.balance).toBe("0.850000000000");
    expect(rows.XMR.error).toBeNull();
    expect(rows.LTC.pending).toBe("0.10000000");
    expect(rows.LTC.locked).toBe(true);
  });

  it("keeps amounts as decimal STRINGS, never numbers", () => {
    const rows = balanceRowsFrom(WALLETS_OBJECT);
    // A float round-trip of 0.850000000000 is where XMR precision dies.
    expect(typeof rows.XMR.balance).toBe("string");
    expect(rows.XMR.balance).toBe("0.850000000000");
  });

  it("uppercases the ticker key so consumers can index consistently", () => {
    expect(Object.keys(balanceRowsFrom({ btc: { balance: "1" } }))).toEqual(["BTC"]);
  });

  // ── THE falsifier. This is the test the R19 defect would have failed. ──
  it("array_shape_does_not_silently_yield_empty", () => {
    let threw: unknown = null;
    try {
      balanceRowsFrom(WALLETBALANCES_ARRAY);
    } catch (e) {
      threw = e;
    }
    // The point is not merely "it threw" — it is that it did NOT return `{}`,
    // because `{}` reads as "node has no coins" and hides the bug.
    expect(threw).toBeInstanceOf(SidecarBalanceShapeError);
    expect(String((threw as Error).message)).toContain("array");
  });

  it("refuses a scalar or null body rather than returning no rows", () => {
    expect(() => balanceRowsFrom(null)).toThrow(SidecarBalanceShapeError);
    expect(() => balanceRowsFrom("nope")).toThrow(SidecarBalanceShapeError);
    expect(() => balanceRowsFrom(42)).toThrow(SidecarBalanceShapeError);
  });
});

describe("balanceRowsFrom — per-coin error isolation", () => {
  it("a {name,error} entry fails ONE row and leaves the rest intact", () => {
    const rows = balanceRowsFrom({
      ...WALLETS_OBJECT,
      DOGE: { name: "Dogecoin", error: "Timeout" },
    });
    expect(rows.DOGE.error).toBe("Timeout");
    expect(rows.DOGE.balance).toBeNull();
    // The whole point: the healthy coins survive.
    expect(rows.XMR.balance).toBe("0.850000000000");
    expect(rows.LTC.error).toBeNull();
  });

  it("an errored row carries no stale balance or address", () => {
    const rows = balanceRowsFrom({
      BTC: { name: "Bitcoin", balance: "9.9", deposit_address: "bc1qreal", error: "boom" },
    });
    expect(rows.BTC.balance).toBeNull();
    expect(rows.BTC.depositAddress).toBeNull();
  });

  it("a malformed entry becomes an error row, not a crash", () => {
    const rows = balanceRowsFrom({ BTC: "not-an-object" });
    expect(rows.BTC.error).toBe("malformed wallet entry");
  });
});

describe("deposit addresses (R18)", () => {
  it("placeholder_addresses_are_not_addresses", () => {
    for (const placeholder of DEPOSIT_ADDRESS_PLACEHOLDERS) {
      const rows = balanceRowsFrom({ BTC: { balance: "1.0", deposit_address: placeholder } });
      expect(rows.BTC.depositAddress).toBeNull();
      expect(normalizeDepositAddress(placeholder)).toBeNull();
    }
    // Named explicitly so a future edit to the constant cannot quietly drop
    // one of the three and still pass the loop above.
    expect(normalizeDepositAddress("Refresh necessary")).toBeNull();
    expect(normalizeDepositAddress("WARNING: Unknown wallet seed")).toBeNull();
    expect(normalizeDepositAddress("Error: unowned address")).toBeNull();
  });

  it("a placeholder does not become an error — it resolves on the next poll", () => {
    const rows = balanceRowsFrom({ BTC: { balance: "1.0", deposit_address: "Refresh necessary" } });
    expect(rows.BTC.error).toBeNull();
    expect(rows.BTC.balance).toBe("1.0");
  });

  it("real addresses pass through byte-for-byte", () => {
    const addr = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    expect(normalizeDepositAddress(addr)).toBe(addr);
    expect(balanceRowsFrom({ BTC: { deposit_address: addr } }).BTC.depositAddress).toBe(addr);
  });

  it("absent, blank, '?' and non-string all become null", () => {
    expect(normalizeDepositAddress(undefined)).toBeNull();
    expect(normalizeDepositAddress("")).toBeNull();
    expect(normalizeDepositAddress("   ")).toBeNull();
    expect(normalizeDepositAddress("?")).toBeNull();
    expect(normalizeDepositAddress(12345)).toBeNull();
  });
});

describe("offline degradation", () => {
  it("matches the supervisor's verbatim refusal, wrapped or bare", () => {
    // swap_sidecar.rs:3746 — the string the hook treats as "quiet".
    expect(isNodeNotRunning("the swap node is not running")).toBe(true);
    expect(
      isNodeNotRunning("invoke error: the swap node is not running"),
    ).toBe(true);
  });

  it("does NOT swallow anything else", () => {
    // If this predicate broadens, a real fault stops reaching the user.
    expect(isNodeNotRunning("the swap node is unhealthy")).toBe(false);
    expect(isNodeNotRunning("endpoint 'wallets/XMR/withdraw' is not reachable")).toBe(false);
    expect(isNodeNotRunning("")).toBe(false);
  });
});

describe("isZeroAmount", () => {
  it("treats upstream's zero spellings as nothing to render", () => {
    for (const z of ["0", "0.0", "0.00000000", " 0.0 "]) {
      expect(isZeroAmount(z)).toBe(true);
    }
    expect(isZeroAmount(null)).toBe(true);
  });

  it("does not swallow a real pending amount", () => {
    expect(isZeroAmount("0.00000001")).toBe(false);
    expect(isZeroAmount("1.0")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// One request at a time (2026-08-21). Source assertions, because both
// hooks own React state and a Tauri invoke chain.
//
// The incident: under a slow ElectrumX server a single `/json/wallets`
// call can hold the engine's electrum lock for ~25s across its
// retry-and-reconnect path. A fixed-interval poll with no in-flight guard
// stacks another waiter every tick, and the engine reports the result as
// "Electrum ... timed out waiting for lock" — which reads like a network
// fault and is partly self-inflicted congestion. It starved the balance
// read for the operator's own shared BTC address.
// ─────────────────────────────────────────────────────────────────────
describe("the sidecar pollers do not stack requests", () => {
  const read = (rel: string) =>
    readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

  for (const [label, file] of [
    ["balances", "../useSidecarBalances.ts"],
    ["chain sync", "../useChainSync.ts"],
  ] as const) {
    it(`${label}: skips a tick while one is already in flight`, () => {
      const src = read(file);
      // Positive control — reading the real polling hook.
      expect(src).toMatch(/const load = useCallback\(async \(\) => \{/);
      // The guard, and its release. A guard that is never released would
      // wedge the poll permanently after one failure, so both halves matter.
      expect(src).toMatch(/if \(inFlight\.current\) return;\s*\n\s*inFlight\.current = true;/);
      expect(src).toMatch(/finally \{[\s\S]{0,120}inFlight\.current = false;/);
    });
  }

  it("the seq guard is kept as well — it solves a different problem", () => {
    // seq discards a STALE RESULT (a slow reply landing after a newer one);
    // inFlight stops a new REQUEST. Removing either re-opens a real bug.
    const src = read("../useSidecarBalances.ts");
    expect(src).toMatch(/mine !== seq\.current/);
  });
});
