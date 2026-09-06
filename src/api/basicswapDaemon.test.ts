/**
 * C2 — the three faults these tests exist to catch.
 *
 * **1. A malformed fee reaching a wallet.** `blocks` and `satPerVb` are
 * mutually exclusive; both set leaves the daemon to pick and which one it picks
 * differs by fork. The test that matters is not "a good fee validates" — it is
 * that a bad one is refused **before any IPC**, asserted by checking the mocked
 * `invoke` was never called. A version that only asserted "the promise
 * rejected" would pass even if the send had already been half-built.
 *
 * **2. Float arithmetic on amounts.** `Math.round(parseFloat(x) * 1e8)` is the
 * obvious conversion and it silently loses precision past 2^53 — DOGE's supply
 * at 8 decimals is comfortably past it. {@link amountToSat} refuses rather than
 * rounds, and the refusal is what is tested.
 *
 * **3. Invoke-argument casing (contract §0.2).** Tauri maps camelCase JS args
 * to snake_case Rust params. A binding that sends `{request}` instead of
 * `{req}`, or snake_cases a field, compiles, ships, and fails at runtime with
 * an unhelpful deserialization error. The arg shape is therefore asserted
 * literally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/tauri", () => ({ invoke: vi.fn() }));

import { invoke } from "../lib/tauri";
import {
  amountToSat,
  canRouteDaemonDirect,
  capabilityFor,
  isRoutingDisabled,
  isWalletLocked,
  preferredFeeMode,
  satToAmount,
  supportedFeeModes,
  swapDaemonCapabilities,
  swapDaemonCaptureXpubs,
  swapDaemonSend,
  validateFeeControl,
  validateSendRequest,
  DAEMON_ROUTING_DISABLED,
  DAEMON_WALLET_LOCKED,
  type DaemonCapability,
  type DaemonSendRequest,
} from "./basicswapDaemon";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined as never);
});

const GOOD_REQ: DaemonSendRequest = {
  coin: "btc",
  toAddress: "bcrt1qexampledestinationxxxxxxxxxxxxxxxxxx",
  amountSat: 250_000,
  subtractFee: false,
  fee: { mode: "feeRate", satPerVb: 4.5 },
  dryRun: true,
};

describe("validateFeeControl — blocks XOR satPerVb", () => {
  it("accepts each mode on its own", () => {
    expect(validateFeeControl({ mode: "confTarget", blocks: 6 })).toBeNull();
    expect(
      validateFeeControl({ mode: "confTarget", blocks: 6, estimateMode: "economical" }),
    ).toBeNull();
    expect(validateFeeControl({ mode: "feeRate", satPerVb: 1 })).toBeNull();
  });

  it("refuses BOTH knobs set, from either direction", () => {
    // The exclusivity is the whole rule. If this stops refusing, the daemon
    // decides which one wins and the answer differs per fork.
    expect(
      validateFeeControl({ mode: "confTarget", blocks: 6, satPerVb: 4 }),
    ).toMatch(/exclusive/);
    expect(
      validateFeeControl({ mode: "feeRate", satPerVb: 4, blocks: 6 }),
    ).toMatch(/exclusive/);
  });

  it("refuses NEITHER knob set", () => {
    expect(validateFeeControl({ mode: "confTarget" })).toMatch(/requires blocks/);
    expect(validateFeeControl({ mode: "feeRate" })).toMatch(/requires satPerVb/);
  });

  it("refuses out-of-range and non-integer values", () => {
    expect(validateFeeControl({ mode: "confTarget", blocks: 0 })).toMatch(/between 1/);
    expect(validateFeeControl({ mode: "confTarget", blocks: 1.5 })).toMatch(/whole number/);
    expect(validateFeeControl({ mode: "confTarget", blocks: 70_000 })).toMatch(/between 1/);
    expect(validateFeeControl({ mode: "feeRate", satPerVb: 0 })).toMatch(/positive/);
    expect(validateFeeControl({ mode: "feeRate", satPerVb: -1 })).toMatch(/positive/);
    expect(validateFeeControl({ mode: "feeRate", satPerVb: Number.NaN })).toMatch(/positive/);
  });

  it("refuses an unknown mode, and a missing control entirely", () => {
    expect(
      validateFeeControl({ mode: "whatever" as unknown as "feeRate", satPerVb: 1 }),
    ).toMatch(/fee mode/);
    expect(validateFeeControl(null)).toMatch(/fee mode/);
    expect(validateFeeControl(undefined)).toMatch(/fee mode/);
  });

  it("refuses an estimateMode outside the two Core accepts", () => {
    expect(
      validateFeeControl({
        mode: "confTarget",
        blocks: 6,
        estimateMode: "unset" as unknown as "economical",
      }),
    ).toMatch(/economical or conservative/);
  });
});

describe("validateSendRequest", () => {
  it("accepts a well-formed request", () => {
    expect(validateSendRequest(GOOD_REQ)).toBeNull();
  });

  it("refuses an empty coin or destination", () => {
    expect(validateSendRequest({ ...GOOD_REQ, coin: "  " })).toMatch(/coin is required/);
    expect(validateSendRequest({ ...GOOD_REQ, toAddress: "" })).toMatch(
      /destination address is required/,
    );
  });

  it("refuses a zero, negative, or fractional amountSat", () => {
    // amountSat is an integer of the smallest unit. A fractional value here
    // means someone passed a decimal amount straight through.
    for (const bad of [0, -1, 0.5, 1.0000001, Number.NaN]) {
      expect(validateSendRequest({ ...GOOD_REQ, amountSat: bad })).toMatch(/amountSat/);
    }
  });

  it("refuses an implicit subtractFee or dryRun", () => {
    // Both are required booleans in the type; the runtime check is what stops
    // a JS caller (or a mock) from omitting them and getting a broadcast.
    expect(
      validateSendRequest({
        ...GOOD_REQ,
        dryRun: undefined as unknown as boolean,
      }),
    ).toMatch(/dryRun/);
    expect(
      validateSendRequest({
        ...GOOD_REQ,
        subtractFee: undefined as unknown as boolean,
      }),
    ).toMatch(/subtractFee/);
  });

  it("carries the fee-control refusal through", () => {
    expect(
      validateSendRequest({ ...GOOD_REQ, fee: { mode: "feeRate", blocks: 6 } }),
    ).toMatch(/exclusive/);
  });
});

describe("swapDaemonSend — refusal happens BEFORE the wire", () => {
  it("sends {req} verbatim for a valid request", async () => {
    mockInvoke.mockResolvedValue({
      txid: null,
      feeSat: 141,
      vsize: 141,
      inputs: 1,
      lockedUtxos: 0,
      broadcast: false,
    } as never);
    await swapDaemonSend(GOOD_REQ);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // Contract §1.3: the argument name is `req`, and the payload is camelCase.
    expect(mockInvoke).toHaveBeenCalledWith("swap_daemon_send", { req: GOOD_REQ });
    const [, args] = mockInvoke.mock.calls[0] as [string, { req: DaemonSendRequest }];
    expect(Object.keys(args)).toEqual(["req"]);
    expect(Object.keys(args.req).sort()).toEqual(
      ["amountSat", "coin", "dryRun", "fee", "subtractFee", "toAddress"].sort(),
    );
  });

  it("issues NO invoke when the fee is malformed", async () => {
    // The assertion that matters. "The promise rejected" would also be true if
    // the command had run and the backend refused — by then a wallet has been
    // asked to fund something.
    await expect(
      swapDaemonSend({ ...GOOD_REQ, fee: { mode: "confTarget", blocks: 6, satPerVb: 4 } }),
    ).rejects.toThrow(/exclusive/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("issues NO invoke for a bad amount", async () => {
    await expect(
      swapDaemonSend({ ...GOOD_REQ, amountSat: -5 }),
    ).rejects.toThrow(/amountSat/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("capability commands take no arguments", () => {
  it("swapDaemonCapabilities", async () => {
    mockInvoke.mockResolvedValue([] as never);
    await swapDaemonCapabilities();
    expect(mockInvoke).toHaveBeenCalledWith("swap_daemon_capabilities");
  });

  it("swapDaemonCaptureXpubs", async () => {
    mockInvoke.mockResolvedValue([] as never);
    await swapDaemonCaptureXpubs();
    expect(mockInvoke).toHaveBeenCalledWith("swap_daemon_capture_xpubs");
  });
});

describe("refusal-string mirrors", () => {
  it("matches the Rust strings wrapped or bare", () => {
    expect(isRoutingDisabled(DAEMON_ROUTING_DISABLED)).toBe(true);
    expect(isRoutingDisabled(`invoke error: ${DAEMON_ROUTING_DISABLED}`)).toBe(true);
    expect(isWalletLocked(DAEMON_WALLET_LOCKED)).toBe(true);
    expect(isWalletLocked(`rpc -13: ${DAEMON_WALLET_LOCKED}`)).toBe(true);
  });

  it("does not swallow a different failure", () => {
    // Broadening either predicate turns a real fault into a quiet no-op.
    expect(isRoutingDisabled("the swap node is not running")).toBe(false);
    expect(isWalletLocked("the swap node is not running")).toBe(false);
    expect(isWalletLocked("")).toBe(false);
  });
});

describe("capability lookup treats unknown as cannot-route", () => {
  const CAPS: DaemonCapability[] = [
    {
      coin: "btc",
      wallet: "wallet.dat",
      descriptors: true,
      feeRate: true,
      confTarget: true,
      xpubAvailable: true,
    },
    {
      coin: "doge",
      wallet: "wallet.dat",
      descriptors: true,
      feeRate: false,
      confTarget: true,
      xpubAvailable: false,
    },
    {
      coin: "bch",
      wallet: "wallet.dat",
      descriptors: false,
      feeRate: false,
      confTarget: false,
      xpubAvailable: false,
    },
  ];

  it("finds a coin case-insensitively", () => {
    expect(capabilityFor(CAPS, "BTC")?.coin).toBe("btc");
    expect(capabilityFor(CAPS, " doge ")?.coin).toBe("doge");
  });

  it("returns null for a coin the probe never reported", () => {
    // Unknown is not "supported". Every predicate below folds null to false.
    expect(capabilityFor(CAPS, "ltc")).toBeNull();
    expect(capabilityFor(null, "btc")).toBeNull();
    expect(capabilityFor(CAPS, "")).toBeNull();
  });

  it("prefers an explicit rate over an estimate", () => {
    expect(supportedFeeModes(capabilityFor(CAPS, "btc"))).toEqual([
      "feeRate",
      "confTarget",
    ]);
    expect(preferredFeeMode(capabilityFor(CAPS, "btc"))).toBe("feeRate");
    expect(preferredFeeMode(capabilityFor(CAPS, "doge"))).toBe("confTarget");
  });

  it("refuses to route a coin with NO fee control at all", () => {
    // §4.3 item 5: with neither knob the bypass buys nothing. BCH here is the
    // shape of that case, not a claim about the real binary.
    expect(canRouteDaemonDirect(capabilityFor(CAPS, "bch"))).toBe(false);
    expect(preferredFeeMode(capabilityFor(CAPS, "bch"))).toBeNull();
    expect(canRouteDaemonDirect(null)).toBe(false);
    expect(canRouteDaemonDirect(capabilityFor(CAPS, "btc"))).toBe(true);
  });
});

describe("amountToSat / satToAmount — exact, or refuse", () => {
  it("scales without touching a float", () => {
    expect(amountToSat("1", 8)).toBe(100_000_000);
    expect(amountToSat("0.07", 8)).toBe(7_000_000);
    expect(amountToSat("0.00000001", 8)).toBe(1);
    expect(amountToSat("21000000.00000001", 8)).toBe(2_100_000_000_000_001);
    expect(amountToSat(".5", 8)).toBe(50_000_000);
    expect(amountToSat("  1.5  ", 8)).toBe(150_000_000);
    expect(amountToSat("7", 0)).toBe(7);
  });

  it("refuses more fraction digits than the coin has", () => {
    // Rounding here would silently send a different amount than the user typed.
    expect(() => amountToSat("0.000000001", 8)).toThrow(/more than 8 decimal places/);
  });

  it("refuses anything that is not a plain decimal", () => {
    for (const bad of ["-1", "1e3", "0x10", "", ".", "1.2.3", "abc", "1 000"]) {
      expect(() => amountToSat(bad, 8)).toThrow();
    }
    expect(() => amountToSat(1 as unknown as string, 8)).toThrow(TypeError);
  });

  it("refuses a value past MAX_SAFE_INTEGER instead of losing precision", () => {
    // 100_000_000 coins at 8 decimals is 1e16 > 2^53-1. This is not
    // hypothetical: DOGE's supply is well past it.
    expect(() => amountToSat("100000000", 8)).toThrow(/safe integer/);
    expect(amountToSat("90000000", 8)).toBe(9_000_000_000_000_000);
  });

  it("round-trips through a single canonical spelling", () => {
    expect(satToAmount(150_000_000, 8)).toBe("1.50000000");
    expect(satToAmount(1, 8)).toBe("0.00000001");
    expect(satToAmount(0, 8)).toBe("0.00000000");
    expect(satToAmount(7, 0)).toBe("7");
    expect(amountToSat(satToAmount(123_456_789, 8), 8)).toBe(123_456_789);
  });

  it("refuses impossible arguments", () => {
    expect(() => satToAmount(-1, 8)).toThrow(/non-negative/);
    expect(() => satToAmount(1.5, 8)).toThrow(/safe integer/);
    expect(() => satToAmount(1, 19)).toThrow(/0\.\.18/);
    expect(() => amountToSat("1", -1)).toThrow(/0\.\.18/);
  });
});
