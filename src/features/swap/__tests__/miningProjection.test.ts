/**
 * SUPERSEDED 2026-08-28 by `routeEstimate.test.ts`.
 *
 * This file covered `ratePerXmr`, which priced the XMR->target route through
 * a USD cross with flat fees. That function is gone: the operator specified
 * that the projection must come from the actual order book — the public
 * snapshot before opt-in, the live node after — so the rate is now produced
 * by `estimateRoute` and the arithmetic is tested there against real offer
 * fixtures.
 *
 * Kept as a marker rather than deleted silently, because the assertions it
 * made (no fees on the XMR->XMR identity, `null` not `0` for a missing price)
 * are still requirements. They live on in `routeEstimate.test.ts` and in
 * `mining/__tests__/mineProjection.test.ts`, and that continuity is the thing
 * worth being able to find later.
 */
import { describe, it, expect } from "vitest";
import { CONVERT_SOURCE } from "../useConvertPipeline";

describe("mining projection rate — moved to routeEstimate.test.ts", () => {
  it("still starts from the coin mining produces", () => {
    expect(CONVERT_SOURCE).toBe("XMR");
  });
});
