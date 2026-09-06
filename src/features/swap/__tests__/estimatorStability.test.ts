/**
 * The estimator must not re-render the app in a loop.
 *
 * Reported 2026-08-29: "something in its functionality makes the wallet ui
 * freeze, when I switched assets I was no longer able to click any other
 * buttons or move the application window panel ... WebView2 Manager now using
 * 4% cpu and 600 MB", followed by "the pwnda wallet is now leaking memory and
 * increasing since the estimator update too".
 *
 * Cause: `addressForAsset` was an inline arrow in App's argument object, so it
 * had a fresh identity on every render. It sits in the hop-2 quote effect's
 * dependency array, so the cycle was: effect fires -> quote resolves ->
 * setState -> render -> new identity -> effect fires. Unbounded.
 *
 * # Why source assertions rather than a render test
 *
 * This repo has no React renderer in its test setup — the existing component
 * tests call components as plain functions and walk the returned tree, which
 * cannot observe effects or re-render counts at all. So the property is
 * asserted where it is decided: at the definitions. Honest about its limit —
 * it proves the callbacks are memoised, not that no loop exists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), "utf8");

const APP = read("../../../App.tsx");
const HOOK = read("../useRouteEstimate.ts");

describe("callbacks fed to the estimator have stable identities", () => {
  it("App memoises addressForAsset instead of passing an inline arrow", () => {
    expect(APP).toContain("const addressForAssetStable = useCallback(");
    expect(APP).toContain("addressForAsset: addressForAssetStable,");
    // The exact shape that caused the loop.
    expect(APP).not.toMatch(/addressForAsset:\s*\(assetId: string\)\s*=>/);
  });

  it("App memoises the derived wallet address set", () => {
    // Also a correctness-adjacent perf fix: this used to re-derive every
    // chain's address on every single asset-id lookup.
    expect(APP).toContain("const swapWalletAddresses = useMemo(");
  });

  it("the hook's refresh is memoised", () => {
    // It is a dependency of useMiningProjection's memo, so an inline arrow
    // rebuilt the projection object every render and re-rendered every
    // consumer of it.
    expect(HOOK).toContain("const refresh = useCallback(");
    expect(HOOK).not.toContain("refresh: () => void load(true),");
  });
});

describe("the quote effect cannot loop even if a dependency churns", () => {
  it("dedupes requests it has already issued", () => {
    expect(HOOK).toContain("requested.current.has(askKey)");
    expect(HOOK).toContain("requested.current.add(askKey)");
  });

  it("does not allocate new state when the value is unchanged", () => {
    // `{...prev, k: v}` is a new object even when nothing changed, and a new
    // state object is a re-render — the fuel a loop runs on.
    expect(HOOK).toContain("if (prev[stateKey] === out) return prev;");
  });

  it("keys the dedupe by the same bucket the quote cache uses", () => {
    // Otherwise "already asked at this size" means different things on the
    // two sides and the dedupe silently stops working as the balance drifts.
    expect(HOOK).toContain("bucketAmount(h1.receiveAmount)");
  });
});
