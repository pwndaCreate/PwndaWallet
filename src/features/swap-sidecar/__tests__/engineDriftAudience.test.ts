/**
 * There is NO engine-update surface, and there must not be one.
 *
 * The operator's ruling, 2026-09-08: *"That UI shouldn't exist or name any
 * kind of command. Development for updating the backend engine is more than
 * just a command and requires engineering work to make sure the intersection
 * between pwnda grove and basicswap stays functional."*
 *
 * That is the accurate description of the work. Moving Grove from pN to pN+1
 * is a patch-series rebase against a new upstream, then the invariant suites
 * (`scripts/swap/verify-*.py`) against the assembled runtime, then a runtime
 * deploy. No button can honestly stand for that. On a user's machine it is
 * not their job at all: `reconcile_bundled_engine` installs the bundled
 * engine at the next node start, because engine updates ship WITH wallet
 * releases and the only thing a user is prompted about is the wallet.
 *
 * What was there before, and why its absence is worth a test: an amber
 * `EngineDriftNote` (2026-09-04 to 2026-09-08) that said "It will be replaced
 * automatically the next time the node starts" — true on an install, false on
 * a development checkout, where `reconcile_bundled_engine` returns `Ok(None)`
 * for want of a payload — above an "Update engine now" button which on that
 * same checkout could only ever return the backend's refusal. The operator
 * had already staged p29 by hand and the card went on demanding an update the
 * button in front of them was incapable of performing.
 *
 * Drift is still reported, in the two places that can act on it: the
 * supervisor log (`grove::describe`, as `GROVE-STAMP-DRIFT`) and
 * `node scripts/apply-engine-patches.mjs --check`.
 *
 * Asserted on SOURCE rather than a render: `SidecarStatusCard` owns hooks, a
 * poll timer and Tauri invokes, so calling it outside React throws. Same
 * reasoning as `sharingDisclosure.test.ts` and `unlockReachable.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Rendered source of the settings card, comments stripped. A commented-out
 *  component must not keep this test green, and the file's own doc comments
 *  discuss the removed UI by name on purpose. */
function cardCode(): string {
  const raw = readFileSync(
    resolve(__dirname, "../SidecarStatusCard.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  return raw
    .split("\n")
    .filter((ln) => {
      const t = ln.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("the wallet offers no way to update the swap engine", () => {
  const code = cardCode();

  it("has no drift note component or mount", () => {
    expect(code).not.toContain("EngineDriftNote");
    expect(code).not.toContain("data-engine-drift");
  });

  it("names no engine-update command anywhere on screen", () => {
    // The specific thing the operator objected to: a UI naming an operator
    // script as though running it were the whole job.
    expect(code).not.toContain("Swap-EngineRuntime");
    expect(code).not.toContain("apply-engine-patches");
    expect(code).not.toContain("Update engine now");
  });

  it("does not call the engine-update invoke", () => {
    // The Tauri command still exists for a shipped build to repair itself
    // without waiting for a restart; nothing in the UI may reach it.
    expect(code).not.toContain("swapSidecarUpdateEngine");
    expect(code).not.toContain("swap_sidecar_update_engine");
  });

  it("keeps the engine field on the payload type, unrendered", () => {
    // Removing the UI must not remove the FACT: the supervisor log and
    // --check both still report drift, and a future developer-only surface
    // would read this field rather than re-deriving it.
    const raw = readFileSync(
      resolve(__dirname, "../SidecarStatusCard.tsx"),
      "utf8",
    );
    expect(raw).toContain("engine?: EngineIdentity;");
  });
});
