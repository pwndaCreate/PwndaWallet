/**
 * What the browser sandbox shows of the Monero / Zephyr fee estimate and the
 * Review → Confirm step (operator request, 2026-10-01), pinned against the real
 * mock dispatcher (`getMock`, as `suiSandbox.test.ts` does).
 *
 * Before this, the sandbox's Monero `transfer` answered `{}` (a send stopped at
 * "returned no transaction to broadcast"), Zephyr's builds cost a flat
 * 0.0000254 — a twentieth of what mainnet charged on 2026-10-06 — and nothing
 * answered the node fee-rate commands the estimate reads.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MONERO_TYPICAL_SEND_WEIGHT,
  ZEPHYR_TYPICAL_SEND_WEIGHT,
  daemonFeeRateFrom,
  typicalFee,
} from "./cryptonote-fee";

let getMock: (cmd: string, args?: unknown) => unknown;
const XMR_TO = "4" + "A".repeat(94);
const ZPH_TO = "ZEPHYR2qjmpfgEjnpvUnmcW84J5q3uvP5Z5oc8h6F9zsTrhpFkPgRecipient";

beforeAll(async () => {
  vi.stubEnv("VITE_MOCK_STATE", "wallet_populated");
  getMock = (await import("../lib/tauri-mocks")).getMock;
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const build = (command: string, params: Record<string, unknown>) =>
  getMock(command, {
    method: "transfer",
    params: { do_not_relay: true, get_tx_metadata: true, priority: 0, ...params },
  }) as { tx_hash: string; fee: number; tx_metadata?: string };

describe("the sandbox's fee rate and builds (2026-10-01)", () => {
  it("answers the node fee-rate commands in the Rust command's shape", () => {
    expect(daemonFeeRateFrom(getMock("xmr_fee_estimate")).perByte[0]).toBe(20_000n);
    expect(daemonFeeRateFrom(getMock("zph_fee_estimate")).perByte[0]).toBe(210_000n);
  });

  it("degraded: the node does not answer, so the modal shows no number", () => {
    vi.stubEnv("VITE_MOCK_STATE", "degraded");
    try {
      expect(() => getMock("xmr_fee_estimate")).toThrow();
      expect(() => getMock("zph_fee_estimate")).toThrow();
    } finally {
      vi.stubEnv("VITE_MOCK_STATE", "wallet_populated");
    }
  });

  it("Monero: a dry run returns the signed blob and its fee; relay_tx reports that id", () => {
    const r = build("xmr_rpc_call", { destinations: [{ address: XMR_TO, amount: 100_000_000_000 }] });
    expect(r.fee).toBe(30_720_000);
    expect(r.tx_metadata).toMatch(new RegExp(`^${r.tx_hash}`));
    expect(getMock("xmr_rpc_call", { method: "relay_tx", params: { hex: r.tx_metadata } })).toEqual({
      tx_hash: r.tx_hash,
    });
  });

  it("a review's exact fee sits under the estimate, as on mainnet (one input against two)", () => {
    const xmrEstimate = typicalFee(daemonFeeRateFrom(getMock("xmr_fee_estimate")), MONERO_TYPICAL_SEND_WEIGHT);
    const xmr = build("xmr_rpc_call", { destinations: [{ address: XMR_TO, amount: 1 }] });
    expect(BigInt(xmr.fee)).toBeLessThan(xmrEstimate.usual);
    const zphEstimate = typicalFee(daemonFeeRateFrom(getMock("zph_fee_estimate")), ZEPHYR_TYPICAL_SEND_WEIGHT);
    const zph = build("zph_rpc_call", {
      destinations: [{ address: ZPH_TO, amount: 1_000_000_000_000 }],
      source_asset: "ZPH",
      destination_asset: "ZPH",
    });
    expect(zph.fee).toBe(323_820_000); // 1,542 × 210,000
    expect(BigInt(zph.fee)).toBeLessThan(zphEstimate.usual);
  });

  it("a conversion from ZEPHUSD pays its fee converted into ZEPHUSD", () => {
    const r = build("zph_rpc_call", {
      destinations: [{ address: ZPH_TO, amount: 1_000_000_000_000 }],
      source_asset: "ZSD",
      destination_asset: "ZYS",
    });
    expect(r.fee).toBe(Math.round(481_320_000 / 2.9334));
  });
});
