/**
 * The AMM script Grove ships must be the pinned upstream tag's.
 *
 * PATCH-38 (2026-09-17) carries upstream's `scripts/createoffers.py` as an
 * applier asset, because upstream keeps it outside the Python package and
 * `ui/page_amm.py` could not find it on a Grove datadir. A copy is a second
 * place the truth lives: after a pin move the engine and its AMM script would
 * drift silently. This compares the asset with the pinned clone.
 *
 * The clone (`upstream/basicswap`) is gitignored; where it is absent the test
 * is skipped rather than passed, and says so.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ASSET = join(ROOT, "upstream", "patches", "assets", "basicswap", "scripts", "createoffers.py");
const PINNED = join(ROOT, "upstream", "basicswap", "scripts", "createoffers.py");
const FETCH = join(ROOT, "scripts", "fetch-swap-runtime.mjs");

describe("bundled AMM script", () => {
  it("exists as an applier asset", () => {
    expect(existsSync(ASSET)).toBe(true);
  });

  it.skipIf(!existsSync(PINNED))("matches the pinned upstream clone byte for byte", () => {
    const norm = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    expect(
      norm(ASSET) === norm(PINNED),
      "upstream/patches/assets/basicswap/scripts/createoffers.py differs from the pinned " +
        "clone. After moving the pin, copy upstream/basicswap/scripts/createoffers.py over it.",
    ).toBe(true);
  });

  it("the clone this compares against is at the pinned tag", () => {
    // The comparison above is only meaningful if the clone is the pin.
    const tag = readFileSync(FETCH, "utf8").match(/const PIN_BASICSWAP_TAG = "([^"]+)"/)?.[1];
    expect(tag).toBeTruthy();
    const init = join(ROOT, "upstream", "basicswap", "basicswap", "__init__.py");
    if (!existsSync(init)) return;
    const version = readFileSync(init, "utf8").match(/__version__ = "([^"]+)"/)?.[1];
    expect(`v${version}`).toBe(tag);
  });
});
