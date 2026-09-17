/**
 * Date / polyseed birthday → Monero restore height (`utils/heightFromDate.ts`,
 * `polyseed.ts`). Lives here, not beside heightFromDate.ts: `src/utils` is not
 * in vitest's include list, so a test there silently never runs.
 *
 * 2026-09-13: both conversions assumed 120 s blocks since genesis, but Monero
 * ran 60 s blocks until the v2 fork at 1,009,827. Every post-2016 restore
 * started ~505,000 blocks early — hours of extra scanning (operator report:
 * "26 blk/s with an ETA of 4h"). The anchors are real blocks from xmrchain.net.
 */
import { describe, it, expect } from "vitest";
import {
  dateStringToMoneroHeight,
  dateStringToZephyrHeight,
  moneroHeightAtUnix,
} from "../utils/heightFromDate";
import { birthdayEncode, birthdayToRestoreHeight } from "./polyseed";

const FORK_H = 1009827;
const FORK_T = 1458748658;
const ANCHOR_H = 3000000;
const ANCHOR_T = 1697813342;

describe("moneroHeightAtUnix", () => {
  it("lands on the real blocks it is anchored to", () => {
    expect(moneroHeightAtUnix(1397818193)).toBe(0);
    expect(moneroHeightAtUnix(FORK_T)).toBe(FORK_H);
    expect(moneroHeightAtUnix(ANCHOR_T)).toBe(ANCHOR_H);
  });

  it("is continuous across the 60 s → 120 s fork", () => {
    const before = moneroHeightAtUnix(FORK_T - 1);
    const after = moneroHeightAtUnix(FORK_T + 1);
    expect(after - before).toBeLessThanOrEqual(1);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("extends at 120 s per block past the last anchor", () => {
    // 2026-09-13 00:00 UTC
    expect(moneroHeightAtUnix(1789257600)).toBe(3762035);
  });

  it("clamps before launch and rejects non-numbers", () => {
    expect(moneroHeightAtUnix(0)).toBe(0);
    expect(moneroHeightAtUnix(Number.NaN)).toBe(0);
  });
});

describe("dateStringToMoneroHeight", () => {
  it("a 2023 date is no longer ~505,000 blocks early", () => {
    // 30-day margin ≈ 21,600 blocks below the anchor. The pre-fix formula
    // returned 2,477,911 here.
    const h = dateStringToMoneroHeight("2023-10-20");
    expect(h).toBeGreaterThan(2_970_000);
    expect(h).toBeLessThan(ANCHOR_H);
  });

  it("never lands AFTER the date (a late height hides funds)", () => {
    expect(dateStringToMoneroHeight("2023-10-21")).toBeLessThan(
      moneroHeightAtUnix(Date.parse("2023-10-21T00:00:00Z") / 1000),
    );
  });

  it("blank or unparseable input scans from genesis", () => {
    expect(dateStringToMoneroHeight("")).toBe(0);
    expect(dateStringToMoneroHeight("not-a-date")).toBe(0);
    expect(dateStringToZephyrHeight("")).toBe(0);
  });
});

describe("birthdayToRestoreHeight (polyseed)", () => {
  it("a birthday one step after the anchor restores within a step before it", () => {
    const b = birthdayEncode(ANCHOR_T + 2629746);
    const h = birthdayToRestoreHeight(b);
    expect(h).toBeGreaterThan(2_975_000);
    expect(h).toBeLessThanOrEqual(ANCHOR_H);
  });
});
