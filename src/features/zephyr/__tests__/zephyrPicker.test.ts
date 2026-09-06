/**
 * The Zephyr asset selector must be a selector.
 *
 * Reported twice. First: "the asset selector looks like a drop down but when I
 * click it the top sub-headers light up and switch between assets like a
 * toggle button." Then again after the routing topology landed without the UI:
 * "the zeph assets on the zeph swap tab still do the button toggle thing
 * instead of the drop down selection."
 *
 * The `▾` glyph was a `CoinSelectButton` whose handler was
 * `setFromAsset(cycle(fromAsset, toAsset))` — a next-button wearing a caret.
 * A user wanting the third asset had to click three times and could never see
 * what the options were.
 *
 * Source-read, and honest about the limit: it proves a real `<select>` is
 * mounted and the cycling handler is gone, not that the dropdown opens.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CARD = code(read("../ZephyrEcosystemSwapCard.tsx"));
const SELECT = code(read("../ZephyrAssetSelect.tsx"));

describe("both sides use a real dropdown", () => {
  it("mounts ZephyrAssetSelect for send and receive", () => {
    expect(CARD).toContain('side="from"');
    expect(CARD).toContain('side="to"');
    expect((CARD.match(/<ZephyrAssetSelect/g) ?? []).length).toBe(2);
  });

  it("no longer cycles the asset from the amount card's caret", () => {
    // The exact handlers that made the caret a lie.
    expect(CARD).not.toContain("onPickCoin={() => setFromAsset(cycle(");
    expect(CARD).not.toContain("onPickCoin={() => setToAsset(cycle(");
  });

  it("renders an actual select element", () => {
    expect(SELECT).toContain("<select");
    expect(SELECT).toContain("onChange");
  });

  it("labels both selects for assistive tech", () => {
    expect(SELECT).toContain("aria-label");
  });
});

describe("the balance strip is no longer a hidden picker", () => {
  it("its tiles are not buttons any more", () => {
    // Clicking a tile used to set the source, which is why the strip looked
    // like a segmented control while the caret looked like a dropdown — and
    // neither was what it looked like.
    const strip = CARD.slice(
      CARD.indexOf("Four-asset balance strip"),
      CARD.indexOf("you send"),
    );
    expect(strip).not.toContain("<button");
    expect(strip).not.toContain("setFromAsset(asset)");
  });
});

describe("multi-leg routes are stated, not hidden", () => {
  it("the panel carries a route row", () => {
    expect(CARD).toContain('label: "route"');
  });

  it("a hint renders for pairs that need more than one transaction", () => {
    expect(CARD).toContain("zephHint");
    expect(CARD).toContain("routeHint(zephRoute)");
  });

  it("the dropdown annotates option leg counts", () => {
    // So a three-transaction pick is visible before it is chosen.
    expect(SELECT).toContain("legs > 1");
    expect(SELECT).toContain("tx");
  });

  it("multi-leg pairs stay selectable", () => {
    // Refusing them would strand ZRS holders from yield entirely — they are
    // legitimate conversions, just longer.
    expect(SELECT).toContain("disabled={isCounterpart}");
  });
});
