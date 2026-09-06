/**
 * The unlock control must be reachable in the ONE state that needs it.
 *
 * This exists because the fix shipped unreachable. The first cut wired
 * `swap_sidecar_unlock_wallets` into the Start handler — and Start is
 * `disabled={... || running ...}`, so on an autostarted node (the only kind
 * that runs LOCKED, since autostart is always keyless) the single control that
 * could unlock the wallets was permanently greyed out. Type-check passed, 1023
 * tests passed, and the user hit the dead-end "Unlock BasicSwap" page again.
 *
 * # Why this reads the source instead of rendering
 *
 * The obvious version of this test rebuilds the button block in the test file
 * and asserts on that. It passes forever regardless of what the component
 * does — a mirror agreeing with itself. The property that actually matters
 * lives in one JSX attribute, so that attribute is what gets read.
 *
 * It is honest about being a source check: it proves the control is not gated
 * on the condition it remedies. It cannot prove the click works.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const CARD = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../SidecarStatusCard.tsx",
);

/** The `<Btn>` element whose label contains `label`, comments stripped. */
function btnBlockFor(src: string, label: string): string {
  const stripped = src
    .split("\n")
    .map((l) => (l.trim().startsWith("//") ? "" : l))
    .join("\n");
  const at = stripped.indexOf(label);
  expect(at, `no button labelled ${label}`).toBeGreaterThan(-1);
  // Walk back to the opening <Btn of this element.
  const open = stripped.lastIndexOf("<Btn", at);
  expect(open, `no <Btn> above ${label}`).toBeGreaterThan(-1);
  return stripped.slice(open, at);
}

describe("unlocking is backend-managed and reachable on every path that needs it", () => {
  const src = readFileSync(CARD, "utf8");

  // 2026-08-22: the manual unlock button was removed as part of the Settings
  // simplification. That is only safe if BOTH automatic paths still unlock —
  // the historical bug this file exists for was an unlock the user could not
  // reach. So the guard moved from "the button is enabled when it matters"
  // to "no path that leaves the node running skips the unlock".
  it("has no manual unlock control any more", () => {
    expect(src).not.toContain("Unlock swap wallets");
  });

  it("the start path unlocks right after the key push, while the node is up", () => {
    const at = src.indexOf("const start = async");
    expect(at, "start handler must exist").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n  };", at));
    const started = body.indexOf("swapSidecarStart(");
    const unlocked = body.indexOf("swapSidecarUnlockWallets(");
    expect(started, "start must call swapSidecarStart").toBeGreaterThan(-1);
    expect(unlocked, "start must unlock the wallets").toBeGreaterThan(-1);
    expect(
      unlocked > started,
      "the unlock must come AFTER the start — an autostarted node is the one\n" +
        "that runs locked, and it is only unlockable once it is running",
    ).toBe(true);
  });

  /**
   * Rewritten 2026-08-28, and the reason is the point.
   *
   * This used to assert one `<Btn onClick={running ? stop : start}>` — a proxy
   * for the property that matters: **exactly one run-state control is offered
   * at a time**. The frame-1h redesign moved STOP into the running strip, so
   * the proxy went false while the property held (Start renders only when
   * stopped, Stop only when running). Rewriting to the property rather than
   * deleting the test keeps the guard worth having: the original bug was a
   * control gated on the very condition it was there to remedy.
   */
  it("one run-state control: Start only when stopped, Stop only when running", () => {
    const block = btnBlockFor(src, "► Start node");
    expect(
      /onClick=\{start\}/.test(block),
      `the Start button must call start:\n${block}`,
    ).toBe(true);
    expect(
      src.includes("{!running && ("),
      "Start must be gated on NOT running, so it cannot sit greyed out " +
        "beside the strip's own Stop",
    ).toBe(true);
    expect(
      /onStop=\{\(\) => void stop\(\)\}/.test(src),
      "the running strip must wire Stop to the same stop handler — a second " +
        "stop path is how two controls for one action appear",
    ).toBe(true);
    expect(
      src.includes("running ? stop : start"),
      "the old combined control must be gone, not merely shadowed",
    ).toBe(false);
  });

  it("opening the console unlocks the wallets first", () => {
    // The other half of the user-visible fix: the console must not hand the
    // user a wallet-unlock page it could have cleared itself.
    //
    // Rewritten 2026-08-21 when the console gained a second door. The unlock
    // moved into a shared `prepareConsole` helper, which broke the original
    // single-function scan — correctly, since a scan of `openConsole` alone
    // would now pass while saying nothing about the browser path. So this
    // asserts the invariant where it actually lives: the helper unlocks, and
    // EVERY path calls it before opening anything.
    const bodyOf = (decl: string): string => {
      const at = src.indexOf(decl);
      expect(at, `${decl} must exist`).toBeGreaterThan(-1);
      // Slice to the next top-level declaration after this one — enough to
      // contain one arrow function, without depending on a brace sequence
      // that reformatting could move.
      const rest = src.slice(at + decl.length);
      const end = rest.search(/\n  (?:const |\/\*\*)/);
      return end === -1 ? rest : rest.slice(0, end);
    };

    expect(
      bodyOf("const prepareConsole").indexOf("swapSidecarUnlockWallets"),
      "prepareConsole must unlock the wallets",
    ).toBeGreaterThan(-1);

    // The one door (the browser fallback was removed 2026-08-22 — it put the
    // API password on the clipboard, which the window path never does):
    // prepareConsole first, THEN the opener.
    for (const [fn, opener] of [
      ["const openConsole ", "swapSidecarOpenConsole"],
    ] as const) {
      const body = bodyOf(fn);
      const prepAt = body.indexOf("prepareConsole(");
      const openAt = body.indexOf(opener);
      expect(prepAt, `${fn} must call prepareConsole`).toBeGreaterThan(-1);
      expect(openAt, `${fn} must call ${opener}`).toBeGreaterThan(-1);
      expect(
        prepAt < openAt,
        `${fn}: the unlock must happen BEFORE the console opens, or the user reaches the wallet-unlock page before pwnda has cleared it`,
      ).toBe(true);
    }
  });
});
