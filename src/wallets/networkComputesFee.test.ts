/**
 * Chains whose wallet-rpc computes the fee itself must not have Send gated on a
 * fee ESTIMATE — `SendModal` blocks Send when an estimate is missing unless the
 * adapter declares `networkComputesFee`.
 *
 * Both Monero and Zephyr estimated with `get_fee_estimate`, a daemon method their
 * wallet-rpcs answer with `-32601 Method not found`, so for them the estimate was
 * always missing. (Zephyr no longer calls it: since 2026-09-15 each send is
 * priced with a dry-run `transfer`, `zphAdapter.quoteSend`. The flag still
 * matters, because the fee stays the network's to set.)
 * - 2026-08-29: Monero was unsendable; the flag went on `xmrAdapter` only.
 * - 2026-09-15: Zephyr was unsendable for the same reason
 *   ("RPC error -32601: Method not found Send is disabled until a fee is
 *   available.").
 */
import { describe, it, expect } from "vitest";
import { xmrAdapter } from "./xmr-wallet";
import { zphAdapter } from "./zph-wallet";

describe("networkComputesFee", () => {
  it("Monero's wallet-rpc sets the fee from priority", () => {
    expect(xmrAdapter.networkComputesFee).toBe(true);
  });

  it("Zephyr's does too — same wallet-rpc surface, same unanswerable estimate", () => {
    expect(zphAdapter.networkComputesFee).toBe(true);
  });
});
