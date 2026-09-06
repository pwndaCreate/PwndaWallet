/**
 * How the live order book is READ — the root cause of "why is the estimator
 * saying that the order book could not be read if my swap node is synced?"
 *
 * It was reading it fine. The read was a single unfiltered
 * `fetchOffers({sort_by:"rate"})`, which pages at `OFFERS_PAGE_LIMIT = 50`
 * with no offset — so it took the first 50 offers on the WHOLE NETWORK,
 * across every pair, and filtered them for XMR/LTC client-side. With ~160
 * live offers spread over 15 pairs, a rate-sorted page of 50 can contain no
 * XMR/LTC row at all, and the estimator then reported the book unreadable.
 *
 * `fetchSidecarQuote` had it right from the start: pass `coin_from`/`coin_to`
 * and let the engine filter server-side. This asserts the estimator's loader
 * does the same, because the failure is invisible — no error, no exception,
 * just an estimate that never appears on a healthy node.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OFFERS_PAGE_LIMIT } from "../../../api/basicswap";

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../useRouteEstimate.ts"),
  "utf8",
);

describe("the live book is fetched per pair, server-side filtered", () => {
  it("passes coin_from and coin_to so the page is all relevant rows", () => {
    expect(SRC).toMatch(/coin_from:\s*hop/);
    expect(SRC).toMatch(/coin_to:\s*ROUTE_SOURCE/);
  });

  it("does not take an unfiltered page and filter it locally", () => {
    // The exact call that caused the bug. `bucketByHop` still exists for the
    // PUBLIC snapshot, which arrives as one flat list and has no server to
    // filter it — but the live path must not use that shape.
    const liveFn = SRC.slice(
      SRC.indexOf("async function loadLiveBooks"),
      SRC.indexOf("async function loadSnapshotBooks"),
    );
    expect(liveFn).not.toContain("bucketByHop");
    expect(liveFn).toContain("fetchOffers");
  });

  it("asks in the OFFERER's frame, not the taker's", () => {
    // `coin_from` is what the offerer SENDS — what the taker receives. Getting
    // this backwards returns the opposite side of the book: offers that look
    // like better prices and cannot be taken from this side at all.
    const at = SRC.indexOf("coin_from: hop");
    const to = SRC.indexOf("coin_to: ROUTE_SOURCE");
    expect(at).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(at);
  });

  it("a page limit exists and is small enough to matter", () => {
    // If this ever became unbounded the per-pair filter would stop being
    // load-bearing — but it is 50, and the bug is one page away.
    expect(OFFERS_PAGE_LIMIT).toBeLessThanOrEqual(100);
  });
});

describe("failure semantics of the read", () => {
  it("only a failed read reports no-book", () => {
    const liveFn = SRC.slice(
      SRC.indexOf("async function loadLiveBooks"),
      SRC.indexOf("async function loadSnapshotBooks"),
    );
    // A successful read with nothing on the pair is `empty-book`; the two must
    // not collapse, because they mean different things to the user and the
    // operator hit exactly that confusion.
    expect(liveFn).toContain('anyRead ? null : anyFailed ? "no-book" : "empty-book"');
  });

  it("falls back to the public snapshot only when the read FAILED", () => {
    // A successful read of an empty pair is the node's real answer about a
    // real book. Substituting a third party's view of a different moment
    // would answer a different question.
    expect(SRC).toContain('if (live.failure !== "no-book") return live;');
    expect(SRC).toContain("fellBackFromLive: true");
  });
});
