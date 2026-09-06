/**
 * The auto-setup pass must be on a CLOCK, not only on React dependencies.
 *
 * The incident this pins (2026-08-21, operator's mainnet node): the pass ran
 * once per dependency change and un-latched when the node was not running —
 * but nothing ever re-fired it. The deps (vault mnemonic, addresses) settle
 * within seconds of unlock while the node takes a minute-plus to reach
 * Healthy, so the pass ran early, gave up politely, and never came back. The
 * manual Unlock button then unlocked the wallets WITHOUT pushing account
 * keys, so everything looked alive while BTC/LTC sat wallet-less behind the
 * fail-closed engine patch: zero balance, "Expected Seed: False", a Reseed
 * that fails.
 *
 * The hook owns state and a Tauri invoke chain, so these are SOURCE
 * assertions (the `unlockReachable.test.ts` shape): they pin that the
 * not-running path arms a timer, that the timer is cleaned up, and that the
 * manual path runs the same share pass — the three properties whose loss
 * recreates the incident with every other test green.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
}

describe("useSwapAutoSetup retries on a clock", () => {
  const hook = src("../useSwapAutoSetup.ts");

  it("positive control: reading the real hook", () => {
    expect(hook).toContain("export function useSwapAutoSetup(");
    expect(hook).toContain("AUTO_SETUP_RETRY_MS");
  });

  it("an unsettled pass arms a timer through AUTO_SETUP_RETRY_MS", () => {
    // The exact regression: a bare `return` in the not-running branch with no
    // re-arm. The finally block must schedule the next attempt.
    expect(hook).toMatch(
      /window\.setTimeout\(\(\) => \{\s*void attempt\(\);\s*\}, AUTO_SETUP_RETRY_MS\)/,
    );
  });

  it("the timer is cleared on unmount AND on effect teardown", () => {
    const clears = hook.match(/window\.clearTimeout\(timer\.current\)/g) ?? [];
    // Once in the unmount effect, once in the main effect's cleanup, once
    // defensively before re-arming. Fewer than two means a leak path exists.
    expect(clears.length).toBeGreaterThanOrEqual(2);
  });

  it("attempts cannot overlap", () => {
    // Two concurrent attempts double-push and can double-restart the node.
    expect(hook).toMatch(/if \(done\.current \|\| inFlight\.current/);
  });

  it("retry() re-enters through the CURRENT attempt runner", () => {
    // The ref is what lets a settled pass be revived by the manual path
    // without waiting for a dependency change that may never come.
    expect(hook).toMatch(/done\.current = false;\s*runRef\.current\?\.\(\)/);
  });
});

/**
 * Incident, 2026-08-23 (operator's mainnet node): `swap_sidecar_set_wallet_key`'s
 * own unlock is best-effort (Rust-side it only eprintln!s a failure and
 * still returns `Ok`), so the push always LOOKED successful even on the run
 * where the real unlock lost a race — nothing downstream noticed, `done`
 * latched, and the node stayed genuinely locked ("Wallet locked: Particl
 * wallet must be unlocked") for the rest of the session with no automatic
 * recovery. The fix calls the error-propagating `swap_sidecar_unlock_wallets`
 * explicitly and treats its failure as "not yet" (re-arm), not "the backend
 * answered" (latch) — these assertions pin that shape so it cannot regress
 * back to the same silent-latch failure mode.
 */
describe("the key push verifies its own unlock, and a failed verify does not latch", () => {
  const hook = src("../useSwapAutoSetup.ts");

  it("calls the error-propagating unlock command after the key push", () => {
    const keyPushAt = hook.indexOf("swapSidecarSetWalletKey(material.walletKey)");
    const unlockCheckAt = hook.indexOf("await swapSidecarUnlockWallets()");
    expect(keyPushAt).toBeGreaterThan(-1);
    expect(unlockCheckAt).toBeGreaterThan(-1);
    // Verification must happen AFTER the push, not before — it is checking
    // the effect of the push that just ran.
    expect(unlockCheckAt).toBeGreaterThan(keyPushAt);
  });

  it("a failed unlock verification returns (not-yet) rather than falling into the outer catch (final answer)", () => {
    const block = hook.slice(
      hook.indexOf("try {\n          await swapSidecarUnlockWallets()"),
      hook.indexOf("Then close the coin gap"),
    );
    expect(block).toMatch(/catch \(e\) \{[\s\S]*?return;[\s\S]*?\}/);
  });

  it("the unlock check itself is inside the function's main try block, so a swallowed failure still cannot reach the latching outer catch", () => {
    // The verification's own try/catch returns early — but it must be
    // nested INSIDE attempt()'s outer try, not sitting after it, or a
    // refactor could silently move it out from under the retry logic.
    const outerTryAt = hook.indexOf("let settled = false;\n      try {");
    const unlockCheckAt = hook.indexOf("await swapSidecarUnlockWallets()");
    const outerCatchAt = hook.indexOf("} catch (e) {\n        if (alive.current) setError(errMsg(e));");
    expect(outerTryAt).toBeGreaterThan(-1);
    expect(outerCatchAt).toBeGreaterThan(unlockCheckAt);
    expect(unlockCheckAt).toBeGreaterThan(outerTryAt);
  });
});

/**
 * Incident, 2026-08-23 (operator's mainnet node, second report — the
 * confirm modal's "swap node wallet not ready" gate stayed red indefinitely,
 * clearing only when the operator opened the BasicSwap console by hand).
 * Traced to the engine's own source: `checkWalletSeed()` is the only
 * function that ever sets `expected_seed`, and for a C8 lean coin the ONLY
 * place it runs automatically is inside `unlockWallets()`, on every POST
 * /json/unlock. The account-key push (`shareWallets()` below, C8) does NOT
 * itself re-trigger it. The FIRST unlock call (pinned above) always fires
 * BEFORE the key push, so by the time it ran the wallet was not yet
 * initialized and `expected_seed` cached `false` — permanently, since
 * nothing else ever re-checked it. Both console-open paths happen to call
 * `swapSidecarUnlockWallets()` before opening their window, which is the
 * entire reason opening the console appeared to fix it. These assertions
 * pin a SECOND unlock call, after the key push settles, so the gate clears
 * automatically and no console action is required.
 */
describe("wallet-seed readiness is re-checked after the account-key push, not only before it", () => {
  const hook = src("../useSwapAutoSetup.ts");

  it("calls unlock again after shareWallets(), not only before it", () => {
    const shareWalletsCallAt = hook.indexOf("settled = await shareWallets();");
    const unlockCalls = [
      ...hook.matchAll(/await swapSidecarUnlockWallets\(\)/g),
    ].map((m) => m.index ?? -1);
    expect(shareWalletsCallAt).toBeGreaterThan(-1);
    // At least one unlock call must come AFTER the share pass, in addition
    // to the pre-share one pinned in the describe block above.
    expect(unlockCalls.some((i) => i > shareWalletsCallAt)).toBe(true);
  });

  it("the post-share unlock is gated on shareWallets() itself having settled", () => {
    const block = hook.slice(
      hook.indexOf("settled = await shareWallets();"),
      hook.indexOf("} catch (e) {\n        if (alive.current) setError(errMsg(e));"),
    );
    expect(block).toMatch(/if \(alive\.current && settled\)/);
  });

  it("a failed post-share unlock re-arms the retry instead of being swallowed", () => {
    const block = hook.slice(
      hook.indexOf("settled = await shareWallets();"),
      hook.indexOf("} catch (e) {\n        if (alive.current) setError(errMsg(e));"),
    );
    // Must explicitly flip `settled` back to false on failure — silently
    // catching and doing nothing would let the outer `settled` (still true
    // from shareWallets()) latch `done`, recreating the exact incident this
    // block exists to close.
    expect(block).toMatch(/catch \(e\) \{[\s\S]*?settled = false;[\s\S]*?\}/);
  });
});

describe("the share pass has ONE owner, and the card shows its outcome", () => {
  const card = src("../SidecarStatusCard.tsx");
  const hookSrc = src("../useSwapAutoSetup.ts");

  // 2026-08-22: the manual "Unlock swap wallets" button was removed in the
  // Settings simplification (unlocking is backend-managed — the start path
  // unlocks after the key push, the console path unlocks before opening).
  // With it went the card's own call to runSharePass. The incident this file
  // pins was "a path unlocked WITHOUT pushing account keys"; the guard is
  // therefore now: no second copy of the pass may exist in the card, the
  // automatic hook is the single owner, and the card still renders what it
  // concluded.
  it("the card carries no manual unlock and no private share-pass copy", () => {
    expect(card).not.toContain("Unlock swap wallets");
    expect(card).not.toMatch(/runSharePass\(/);
  });

  it("the automatic pass is the one place the share pass runs", () => {
    expect(hookSrc).toMatch(/runSharePass\(/);
  });

  /**
   * REWRITTEN 2026-09-05, because the previous version of this test was green
   * for two days while the thing it names was broken.
   *
   * It asserted the card's JSX mentions `shareInfo` — and it did, in a block
   * reading a `useState` whose setter had not been called since the manual
   * Unlock button was deleted on 2026-08-22 (the deletion this very describe
   * block documents two tests above). Permanently null state renders nothing,
   * so the card showed no share outcome at all; BCH's refusal reached
   * `console.error` and nobody. A check that cannot fail for the reason it is
   * run, in the file that exists to stop exactly this.
   *
   * So the assertions now follow the whole path — the pass RECORDS, the card
   * SUBSCRIBES, and the value it renders is the one it subscribed to. Any
   * link removed breaks a named assertion rather than quietly rendering a
   * variable that is always empty.
   */
  it("renders the outcome instead of only logging it", () => {
    const log = src("../sharePassLog.ts");
    // 1. the pass publishes.
    expect(hookSrc).toMatch(/recordSharePass\(\{ shared, errors \}\)/);
    // 2. the store keeps it for a card that mounts later — the automatic pass
    //    finishes at app start, the Settings view opens whenever the user
    //    gets there.
    expect(log).toMatch(/export function lastSharePass\(\)/);
    // 3. the card subscribes AND seeds from the last pass.
    expect(card).toMatch(/useState\(lastSharePass\)/);
    expect(card).toMatch(/subscribeSharePass\(setShareReport\)/);
    // 4. and renders that value — both halves, success and refusal.
    expect(card).toMatch(/shareReport\.shared\.join/);
    expect(card).toMatch(/shareReport\.errors\.map/);
    // 5. the dead state is gone. Its presence is what made the old assertion
    //    pass while the card displayed nothing.
    expect(card).not.toMatch(/setShareInfo/);
  });
});
