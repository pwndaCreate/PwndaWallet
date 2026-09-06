/**
 * The opt-in wizard is the ONLY place wallet sharing is disclosed.
 *
 * Until 2026-08-20 the disclosure rode a per-coin "Use my wallet" button: you
 * could not turn sharing on without reading why. That button was friction on
 * top of a decision the user had already made by opting into the DEX, so it
 * became an opt-OUT and sharing now defaults on — which moves the entire
 * disclosure burden onto the wizard.
 *
 * That makes this a load-bearing test rather than a copy nicety. If the
 * wizard's list is refactored and this bullet is dropped, sharing becomes
 * undisclosed everywhere, silently, with every other test still green: the
 * consent state would be correct, the routing would be correct, and users
 * would simply never be told.
 *
 * Asserted on SOURCE, not a render: the wizard owns hooks and a Tauri event
 * subscription, so calling it outside React throws (the same reason
 * `unlockReachable.test.ts` reads source). Comments are stripped first so a
 * commented-out bullet cannot pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The wizard's rendered copy, with comments removed and line endings flat. */
function wizardCopy(): string {
  const raw = readFileSync(
    resolve(__dirname, "../SidecarSetupWizard.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const blockComments = new RegExp("/\\*[\\s\\S]*?\\*/", "g");
  const lineComments = new RegExp("^\\s*//.*$", "gm");
  return raw.replace(blockComments, " ").replace(lineComments, " ");
}

/**
 * Just the sharing bullet, not the whole wizard.
 *
 * Scoping is load-bearing, and it was found by MUTATION rather than by
 * design: the first version of this file asserted `/Electrum/` against the
 * entire wizard, and an unrelated bullet already says "Litecoin runs in light
 * (Electrum) mode". Deleting the whole privacy sentence out of the sharing
 * bullet therefore left this suite green — a check that could not fail for
 * the reason it was run.
 */
function sharingBullet(): string {
  const copy = wizardCopy();
  const start = copy.indexOf("The node uses your existing wallet");
  if (start === -1) return "";
  const rest = copy.slice(start);
  const end = rest.indexOf("<li");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the opt-in wizard discloses wallet sharing", () => {
  const copy = wizardCopy();
  const bullet = sharingBullet();

  it("positive control: the scan is reading the wizard's real copy", () => {
    expect(copy).toMatch(/You swap with another user, on an open network/);
    expect(copy).toMatch(/A refund is a normal outcome/);
  });

  it("positive control: the sharing bullet was actually located", () => {
    // Every assertion below reads `bullet`. An empty slice would make all of
    // them pass vacuously — the exact failure this file already had once.
    expect(bullet.length).toBeGreaterThan(120);
    expect(bullet).toMatch(/uses your existing wallet/i);
  });

  it("says the node uses the wallet the user already has", () => {
    // The user-visible payoff, and the reason sharing is on by default.
    expect(bullet).toMatch(/nothing to deposit/i);
  });

  it("names the Electrum address-visibility cost IN the sharing bullet", () => {
    // Scoped to the bullet: the wizard mentions Electrum elsewhere, so a
    // file-wide match here would survive deleting this disclosure entirely.
    expect(bullet).toMatch(/Electrum/);
    expect(bullet).toMatch(/addresses/i);
  });

  it("names the mid-swap lock refusal IN the sharing bullet", () => {
    // The consequence of C9's wallet-rpc sharing, and the one that surprises
    // OUTSIDE the swap feature — the user meets it at the Lock button.
    expect(bullet).toMatch(/locking the wallet|lock the wallet/i);
    expect(bullet).toMatch(/refused|refuses/i);
  });

  it("tells the user where to turn it off", () => {
    // A default-on behaviour with no stated off-ramp is not a disclosure.
    expect(bullet).toMatch(/Settings/);
    expect(bullet).toMatch(/DEX coins/i);
  });
});
