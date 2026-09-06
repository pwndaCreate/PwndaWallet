/**
 * The invoke-argument contract for C3 / C3.5 / C4 / C6.
 *
 * These assertions look pedantic and are not. Tauri maps camelCase JS args to
 * snake_case Rust parameters (contract §0.2); a binding that sends `{coinName}`
 * where Rust declares `coin`, or that snake_cases a field our struct declares
 * camelCase, **compiles, ships, and fails only at runtime** with a
 * deserialization message that names neither side. TypeScript cannot catch it —
 * the args object is `Record<string, unknown>` by the time it reaches `invoke`.
 * So the key names are asserted literally, and the command names with them.
 *
 * # The one that is a security property, not a convention
 *
 * `swap_bridge_execute_sweep` must carry **exactly** `token` and
 * `confirmPhrase`. The entire C4 argument is that no code path accepts a
 * destination address from the renderer (§R13); Rust enforces it at the
 * signature, and this is the TypeScript half of the same claim. If someone adds
 * an address field "to make the confirm screen simpler", this goes red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/tauri", () => ({ invoke: vi.fn() }));

import { invoke } from "../lib/tauri";
import {
  coinOptInsFrom,
  executeSweep,
  nextDepositAddr,
  prepareSweep,
  swapSidecarCoinStatus,
  swapSidecarImportDescriptors,
  swapSidecarSelectionGate,
  swapSidecarSetCoin,
  type CoinOptIn,
  type OptInRecord,
} from "./basicswap";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined as never);
});

/** The exact key set of the single args object the binding passed. */
function argKeys(): string[] {
  const call = mockInvoke.mock.calls[0];
  expect(call, "no invoke was issued").toBeDefined();
  const args = call[1] as Record<string, unknown> | undefined;
  return args ? Object.keys(args).sort() : [];
}

describe("C3 — per-coin DEX enable", () => {
  it("swapSidecarSetCoin sends {coin, enabled}", async () => {
    await swapSidecarSetCoin("btc", true);
    expect(mockInvoke).toHaveBeenCalledWith("swap_sidecar_set_coin", {
      coin: "btc",
      enabled: true,
    });
    expect(argKeys()).toEqual(["coin", "enabled"]);
  });

  it("passes `false` through as a real value, not as an omission", async () => {
    // Disabling is a decision. A binding that dropped falsy args would turn
    // "disable this coin" into "no-op" and the UI would silently disagree with
    // the node.
    await swapSidecarSetCoin("doge", false);
    expect(mockInvoke).toHaveBeenCalledWith("swap_sidecar_set_coin", {
      coin: "doge",
      enabled: false,
    });
  });

  it("swapSidecarCoinStatus takes no arguments", async () => {
    await swapSidecarCoinStatus();
    expect(mockInvoke).toHaveBeenCalledWith("swap_sidecar_coin_status");
  });

  it("swapSidecarSelectionGate sends {coin}", async () => {
    await swapSidecarSelectionGate("ltc");
    expect(mockInvoke).toHaveBeenCalledWith("swap_sidecar_selection_gate", {
      coin: "ltc",
    });
    expect(argKeys()).toEqual(["coin"]);
  });
});

describe("coinOptInsFrom — the migration default", () => {
  const rec = (coins: unknown): OptInRecord =>
    ({ optedIn: true, at: null, autostart: false, coins } as OptInRecord);

  it("returns the map when there is one", () => {
    const coins: Record<string, CoinOptIn> = {
      btc: {
        enabled: true,
        at: "2026-08-19T00:00:00Z",
        adoption: "descriptor",
        descriptorsImportedAt: null,
        firstSyncStarted: false,
        mode: "full",
      },
    };
    expect(coinOptInsFrom(rec(coins))).toBe(coins);
  });

  it("returns {} — never throws — for a pre-C3 or malformed record", () => {
    // A record written before C3 has no `coins` at all. Throwing here would
    // make an old install unable to read its own opt-in.
    expect(coinOptInsFrom(rec(undefined))).toEqual({});
    expect(coinOptInsFrom(rec(null))).toEqual({});
    expect(coinOptInsFrom(rec([]))).toEqual({});
    expect(coinOptInsFrom(rec("nope"))).toEqual({});
    expect(coinOptInsFrom(null)).toEqual({});
    expect(coinOptInsFrom(undefined)).toEqual({});
  });
});

describe("C3.5 — descriptor import", () => {
  const ENC = { salt: "c2FsdA==", iv: "aXY=", ciphertext: "Y2lwaGVy" };

  it("sends every field the Rust command declares, camelCased", async () => {
    await swapSidecarImportDescriptors({
      coin: "btc",
      encrypted: ENC,
      password: "fixture-password-not-a-secret",
      birthdayUnix: 1_600_000_000,
      rangeEnd: 999,
    });
    expect(mockInvoke).toHaveBeenCalledWith("swap_sidecar_import_descriptors", {
      coin: "btc",
      encrypted: ENC,
      password: "fixture-password-not-a-secret",
      birthdayUnix: 1_600_000_000,
      rangeEnd: 999,
    });
    // `birthday_unix` / `range_end` would deserialize as absent Rust-side and
    // the import would silently rescan from genesis with the default range.
    expect(argKeys()).toEqual([
      "birthdayUnix",
      "coin",
      "encrypted",
      "password",
      "rangeEnd",
    ]);
  });

  it("keeps the optional keys present-but-undefined rather than renaming them", async () => {
    await swapSidecarImportDescriptors({
      coin: "bch",
      encrypted: ENC,
      password: "fixture-password-not-a-secret",
    });
    const args = mockInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(args.birthdayUnix).toBeUndefined();
    expect(args.rangeEnd).toBeUndefined();
    expect(args.coin).toBe("bch");
  });
});

describe("C4 / C6 — sweep-back", () => {
  it("prepareSweep sends {sessionId, coin}", async () => {
    await prepareSweep({ sessionId: "sess-123", coin: "btc" });
    expect(mockInvoke).toHaveBeenCalledWith("swap_bridge_prepare_sweep", {
      sessionId: "sess-123",
      coin: "btc",
    });
    expect(argKeys()).toEqual(["coin", "sessionId"]);
  });

  it("executeSweep sends EXACTLY {token, confirmPhrase} — no destination", async () => {
    // §R13. The absence of an address field is the feature. Adding one here (or
    // in the Rust signature) is the regression this test exists to catch.
    await executeSweep({ token: "deadbeef", confirmPhrase: "abc123" });
    expect(mockInvoke).toHaveBeenCalledWith("swap_bridge_execute_sweep", {
      token: "deadbeef",
      confirmPhrase: "abc123",
    });
    const keys = argKeys();
    expect(keys).toEqual(["confirmPhrase", "token"]);
    for (const forbidden of ["address", "destination", "to", "toAddress", "dest"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("nextDepositAddr sends {ticker}", async () => {
    await nextDepositAddr("XMR");
    expect(mockInvoke).toHaveBeenCalledWith("swap_bridge_next_deposit_addr", {
      ticker: "XMR",
    });
    expect(argKeys()).toEqual(["ticker"]);
  });
});

describe("command names are spelled the way Rust registers them", () => {
  it("uses the swap_sidecar_* / swap_bridge_* prefixes exactly", async () => {
    const seen: string[] = [];
    mockInvoke.mockImplementation(((cmd: string) => {
      seen.push(cmd);
      return Promise.resolve(undefined);
    }) as never);

    await swapSidecarSetCoin("btc", true);
    await swapSidecarCoinStatus();
    await swapSidecarSelectionGate("btc");
    await swapSidecarImportDescriptors({
      coin: "btc",
      encrypted: { salt: "s", iv: "i", ciphertext: "c" },
      password: "fixture-password-not-a-secret",
    });
    await prepareSweep({ sessionId: "s", coin: "btc" });
    await executeSweep({ token: "t", confirmPhrase: "p" });
    await nextDepositAddr("XMR");

    expect(seen).toEqual([
      "swap_sidecar_set_coin",
      "swap_sidecar_coin_status",
      "swap_sidecar_selection_gate",
      "swap_sidecar_import_descriptors",
      "swap_bridge_prepare_sweep",
      "swap_bridge_execute_sweep",
      "swap_bridge_next_deposit_addr",
    ]);
  });
});
