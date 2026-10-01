/**
 * Portrait's CONVERT NOW opens the swap form it fills (sandbox, 2026-10-01).
 *
 * `SwapView` applied a convert seed (router, coins, amount) without leaving its
 * CONVERT mode, and CONVERT NOW is pressed from inside that mode, so in
 * portrait the form was filled out of sight and the button seemed to do
 * nothing. Landscape opens its Swap tab instead, so it never showed there.
 * Found while verifying the convert pipeline's hop-1 adoption in the browser
 * sandbox (`swap_sidecar_active`, 400x520).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("a convert seed shows the swap form in portrait", () => {
  it("the effect that applies a seed switches portrait back to its SWAP mode", () => {
    const src = readFileSync(resolve(__dirname, "SwapView.tsx"), "utf8");
    const start = src.indexOf("if (appliedSeedRef.current === convertSeed.nonce) return;");
    // Positive control: the seed effect was located.
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("}, [convertSeed", start));
    expect(body).toContain("setPreferredRouter(convertSeed.router");
    expect(body).toContain('setPortraitMode("swap")');
  });
});
