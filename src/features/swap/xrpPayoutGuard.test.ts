/**
 * The NEAR → XRP payout guard (2026-09-29). See `xrpPayoutGuard.ts`.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { xrpPayoutBlockReason } from "./xrpPayoutGuard";

const DEST = "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3";
const NEW_ACCOUNT = { activated: false, reserveBaseXrp: 1 };

describe("xrpPayoutBlockReason", () => {
  it("blocks a guaranteed payout under the reserve to an account that does not exist", () => {
    const why = xrpPayoutBlockReason({ activation: NEW_ACCOUNT, minReceived: "0.98", destination: DEST });
    expect(why).toMatch(/not activated yet.*at least 1 XRP.*guarantees only 0\.98 XRP/);
  });

  it("allows it once the guaranteed amount reaches the reserve", () => {
    expect(xrpPayoutBlockReason({ activation: NEW_ACCOUNT, minReceived: "1", destination: DEST })).toBeNull();
    expect(xrpPayoutBlockReason({ activation: NEW_ACCOUNT, minReceived: "1.03", destination: DEST })).toBeNull();
  });

  it("never blocks an account that exists", () => {
    expect(
      xrpPayoutBlockReason({
        activation: { activated: true, reserveBaseXrp: 1 },
        minReceived: "0.01",
        destination: DEST,
      }),
    ).toBeNull();
  });

  it("never blocks on an unknown answer", () => {
    // The ledger could not be asked. Unknown is not "not activated".
    expect(xrpPayoutBlockReason({ activation: null, minReceived: "0.5", destination: DEST })).toBeNull();
  });

  it("is wired into the shared confirm modal, before Sign & Send", () => {
    // Both layouts mount `SwapConfirmModal`; a guard anywhere else would be a
    // guard one of them skips.
    const src = readFileSync(new URL("./SwapConfirmModal.tsx", import.meta.url), "utf8");
    expect(src).toContain("xrpPayoutBlockReason(");
    expect(src).toContain("blockedReason={xrpBlock}");
  });
});
