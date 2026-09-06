/**
 * The Mine tab's SIMPLE hero: the projection maths, and the claims the hero is
 * allowed to make about it.
 *
 * # Why this is a render test and not a screenshot
 *
 * The hero's POPULATED state cannot be reached in the browser-only sandbox.
 * It multiplies a **mined XMR balance** by a convert rate, and Monero uses an
 * independent seed that needs a wallet-RPC unlock the dev bypass cannot
 * perform — CONTRIBUTING.md states this outright ("Monero and Zephyr … require
 * sidecar RPC unlock — those panels render their 'not loaded' branches under
 * the bypass"). So `dev:sandbox` can only ever screenshot the `—` branch, and
 * the `mining_projected` fixture, real as it is for mining + prices, cannot
 * fix that.
 *
 * Rather than declare the populated hero verified because a mock exists, it is
 * verified HERE by invoking the component and reading what it says. The walk
 * helper is the one `syncState.test.ts` established for the same reason.
 *
 * # Why the rate maths is not in this file
 *
 * `scripts/check-boundaries.mjs` scans EVERY file under
 * `src/features/mining/`, tests included, and `features/mining` may not
 * import `features/swap`. The first cut of this suite imported
 * `ratePerXmr` here and the rule caught it — correctly: a test that reaches
 * across the boundary makes the folder non-self-contained, which is the
 * exact property PwndaLite depends on. The rate maths is tested next to the
 * function, in `features/swap/__tests__/miningProjection.test.ts`.
 *
 * # What is actually being protected
 *
 * Every assertion below is about a claim the hero makes about the user's
 * money:
 *
 *   - an unknown rate must render `—`, never `0` ("your mining is worth
 *     nothing" is a measurement nobody took);
 *   - a projection must carry the `projected · not converted yet` chip;
 *   - showing XMR in XMR is NOT a projection — no chip, no `≈`, and no fees
 *     deducted, or the Mine tab and the wallet disagree about the balance;
 *   - a non-XMR session must not borrow XMR's name.
 */
import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { SelectMenu } from "../../../design/primitives/SelectMenu";
import {
  ALWAYS_AVAILABLE_DISPLAY_COINS,
  BalanceHero,
  DISPLAY_COIN_CHOICES,
  DisplayCoinChips,
} from "../components/mine-simple";
import type { MiningProjection } from "../../../types/mining";

function walk(node: unknown, out: string[]): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out));
    return;
  }
  if (typeof node !== "object") return;
  const el = node as ReactElement & { type?: unknown; props?: Record<string, unknown> };
  const props = (el.props ?? {}) as Record<string, unknown>;
  if (typeof el.type === "function") {
    try {
      walk((el.type as (p: unknown) => unknown)(props), out);
      return;
    } catch {
      /* hook-dependent child — fall through to its declared children */
    }
  }
  walk(props.children, out);
}

function say(props: Parameters<typeof BalanceHero>[0]): string {
  const out: string[] = [];
  walk(BalanceHero(props), out);
  return out.join(" ");
}

const projection = (over: Partial<MiningProjection> = {}): MiningProjection => ({
  targetTicker: "ETH",
  ratePerXmr: 0.0449,
  xmrPriceUsd: 145.8,
  fromEarnTarget: false,
  ...over,
});

const base = {
  minedAmount: 0.4213,
  mining: true,
  hashrateLabel: "4.21 KH/s",
  perPeriod: { day: 0.00125, week: 0.00875, month: 0.0375 },
  nextPayout: null,
  onSelectDisplayCoin: () => {},
};

describe("BalanceHero — what it is allowed to claim", () => {
  it("converts the mined balance and labels it a projection", () => {
    const said = say({ ...base, projection: projection() });
    // 0.4213 XMR * 0.0449 = 0.018916…
    expect(said).toContain("0.01892");
    expect(said).toContain("ETH");
    expect(said.toLowerCase()).toContain("projected · not converted yet");
    expect(said).toContain("≈");
  });

  it("still says what was actually mined", () => {
    const said = say({ ...base, projection: projection() });
    expect(said).toContain("0.4213");
    expect(said).toContain("XMR");
  });

  it("renders — and not 0 when the rate is unknown", () => {
    const said = say({
      ...base,
      projection: projection({ ratePerXmr: null }),
    });
    // The pixel hero swaps the em dash for a hyphen (Press Start 2P renders
    // `—` as a solid bar); either is acceptable, a zero is not.
    expect(said).toMatch(/[—-]/);
    expect(said).not.toMatch(/\b0\.0000\b/);
  });

  it("renders — and not 0 when nothing has been mined yet", () => {
    const said = say({
      ...base,
      minedAmount: null,
      projection: projection(),
    });
    expect(said).not.toMatch(/\b0\.00000\b/);
  });

  /**
   * The identity case. This is the one most likely to regress, because
   * "always show the projection chip" reads like a simplification.
   */
  it("makes no projection claim when showing XMR in XMR", () => {
    const said = say({
      ...base,
      projection: projection({ targetTicker: "XMR", ratePerXmr: 1 }),
    });
    expect(said).toContain("0.4213");
    expect(said.toLowerCase()).not.toContain("projected · not converted yet");
    expect(said).not.toContain("≈");
  });

  it("speaks the mined coin's name on a non-XMR session", () => {
    // A ZEPH/ERG session has no convert route, so the hero falls back to
    // native. It must not print "XMR" at a user mining something else.
    const said = say({
      ...base,
      minedTicker: "ERG",
      minedAmount: 12.5,
      projection: projection({ targetTicker: "ERG", ratePerXmr: 1 }),
      onSelectDisplayCoin: null,
    });
    expect(said).toContain("ERG");
    expect(said).not.toContain("XMR");
    expect(said.toLowerCase()).not.toContain("projected · not converted yet");
  });

  it("projects the per-period estimates into the same coin", () => {
    const said = say({ ...base, projection: projection() });
    // 0.00125 XMR/day * 0.0449 = 0.0000561…
    expect(said).toContain("0.000056");
    expect(said.toLowerCase()).toContain("per day");
    expect(said.toLowerCase()).toContain("per month");
  });

  it("shows the idle state without inventing a hashrate", () => {
    const said = say({
      ...base,
      mining: false,
      hashrateLabel: null,
      projection: projection(),
    });
    expect(said).toContain("IDLE");
    expect(said).not.toContain("MINING");
  });
});

describe("the display-coin picker", () => {
  /**
   * The menu's OFFER list, read from the SelectMenu it renders.
   *
   * These cases used to walk the rendered tree for option text. That worked
   * against a native `<select>`, whose `<option>`s are always in the tree —
   * and stopped working when the picker became a custom dropdown, because a
   * CLOSED menu renders only its trigger. The old assertions were passing for
   * a reason that no longer holds.
   *
   * The property they were reaching for is "which assets does this offer",
   * which lives in the items prop and does not depend on open state. Reading
   * it directly is both more honest and more stable than opening the menu.
   */
  function offeredValues(props: Parameters<typeof DisplayCoinChips>[0]): string[] {
    const found: string[] = [];
    const visit = (node: unknown): void => {
      if (node == null || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      const p = (el.props ?? {}) as Record<string, unknown>;
      if (el.type === SelectMenu && Array.isArray(p.items)) {
        for (const it of p.items as Array<{ value?: unknown }>) {
          if (typeof it?.value === "string") found.push(it.value);
        }
      }
      if (typeof el.type === "function") {
        try {
          visit((el.type as (x: unknown) => unknown)(p));
        } catch {
          /* a hook-using child cannot render here; its own tests cover it */
        }
        return;
      }
      visit(p.children);
    };
    visit(DisplayCoinChips(props));
    return found;
  }
  function chips(props: Parameters<typeof DisplayCoinChips>[0]): string {
    const out: string[] = [];
    walk(DisplayCoinChips(props), out);
    return out.join(" ");
  }

  /**
   * Reported 2026-08-28: picking `$ USD` rendered a blank hero while the line
   * beneath it read `$21.77`. USD was being routed through the order book,
   * which correctly answered 'no route' — there is no XMR->LTC->USD trade.
   * USD is a unit of account, so it is a VALUATION, not a conversion.
   */
  it("USD is not a quick chip, because it is not a swap target", () => {
    expect(DISPLAY_COIN_CHOICES).not.toContain("USD");
    expect(DISPLAY_COIN_CHOICES).toEqual(["XMR", "ETH", "BTC", "SOL"]);
  });

  it("USD is always offered in the dropdown even if no route lists it", () => {
    expect(ALWAYS_AVAILABLE_DISPLAY_COINS).toContain("USD");
    expect(offeredValues({ selected: "ETH", onSelect: () => {}, reachableTickers: [] }))
      .toContain("USD");
  });

  it("the dropdown offers only assets reachable from mining", () => {
    // The hero's number is XMR -> LTC/BCH -> target. An asset the wallet
    // holds but NEAR cannot deliver is unreachable, and offering it produces
    // a pick that can only answer 'no route'.
    const offered = offeredValues({
      selected: "ETH",
      onSelect: () => {},
      reachableTickers: ["ADA", "SUI"],
    });
    expect(offered).toContain("ADA");
    expect(offered).toContain("SUI");
    expect(offered).not.toContain("DOGE");
  });

  it("does not repeat the quick chips inside the dropdown", () => {
    const said = chips({
      selected: "ETH",
      onSelect: () => {},
      reachableTickers: ["ETH", "BTC", "ADA"],
    });
    // ETH/BTC appear once each — as chips. Counting occurrences catches a
    // dropdown that duplicates them.
    expect(said.split("ETH").length - 1).toBe(1);
    expect(said.split("BTC").length - 1).toBe(1);
  });

  it("keeps the current selection visible even when it is not in the roster", () => {
    // A coin persisted before the roster changed, or inherited from the EARN
    // target, must still show as selected rather than silently displaying
    // some other coin's name.
    expect(
      offeredValues({ selected: "WOW", onSelect: () => {}, reachableTickers: ["ADA"] }),
    ).toContain("WOW");
  });
});

describe("a missing number always comes with a reason", () => {
  /**
   * Reported 2026-08-28: "sol asset wont come up when I click on it. Why is
   * that?" The estimate had failed, the reason was known, and the hero
   * printed a bare dash. A wallet that knows why and shows nothing is worse
   * than one that does not know: the user goes looking for a fault in their
   * own setup.
   */
  it("prints the failure reason when there is no amount", () => {
    const said = say({
      ...base,
      projection: projection({ ratePerXmr: null }),
      routeFailureText: "Amount is below this offer's minimum of 0.5 XMR.",
    });
    expect(said).toContain("below this offer's minimum");
  });

  it("says it is working rather than showing a dash while fetching", () => {
    const said = say({
      ...base,
      projection: projection({ ratePerXmr: null }),
      routeLoading: true,
    });
    expect(said.toLowerCase()).toContain("pricing the route");
  });

  it("shows neither once a number exists", () => {
    const said = say({
      ...base,
      projection: projection(),
      routeFailureText: "stale reason that must not survive a success",
    });
    expect(said).not.toContain("stale reason");
  });

  it("stays silent on the native case, which needs no route", () => {
    // XMR-in-XMR is not a conversion, so a route failure is irrelevant to it
    // and must not be reported as though the balance were unavailable.
    const said = say({
      ...base,
      projection: projection({ targetTicker: "XMR", ratePerXmr: 1 }),
      routeFailureText: "should not appear",
    });
    expect(said).not.toContain("should not appear");
  });
});
