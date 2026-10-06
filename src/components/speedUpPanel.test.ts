/**
 * The shared "Speed up" panel (operator request, 2026-10-01), rendered with
 * react-dom/server for each state it can be in (this repo has no DOM test
 * harness). What the review must show, per the brief: the current and the
 * new fee rate, the new fee in BTC and USD, and one confirm.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SpeedUpPanel, SpeedUpPanelView } from "./SpeedUpPanel";
import type { SpeedUpState } from "../lib/btcSpeedUp";
import type { BtcSpeedUpQuote } from "../wallets/btc-rbf";

const QUOTE: BtcSpeedUpQuote = {
  txid: "31".repeat(32),
  originalFeeSat: 282,
  originalVsize: 141,
  currentRate: 2,
  replacementVsize: 141,
  minimumFeeSat: 423,
  minimumRate: 3,
  targetRate: 14,
  newFeeSat: 1974,
  newRate: 14,
  extraFeeSat: 1692,
  atMinimum: false,
  change: { vout: 1, address: "bc1qchange", beforeSat: 999_718, afterSat: 998_026 },
  recipients: [{ vout: 0, address: "bc1qdeposit", valueSat: 1_000_000 }],
};

const noop = () => {};
const view = (state: SpeedUpState | null) =>
  renderToStaticMarkup(
    createElement(SpeedUpPanelView, { state, onSpeedUp: noop, onCancel: noop, onConfirm: noop, onRecheck: noop }),
  );
/** Text as it reads on screen, tags stripped, entities decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("SpeedUpPanelView", () => {
  it("nothing at all when not asked, or for a transaction that is not the wallet's to touch", () => {
    expect(view(null)).toBe("");
    expect(view({ phase: "unavailable", code: "not-own-tx", reason: "x", quiet: true })).toBe("");
  });

  it("ready: the rates in a sentence, and the Speed up button", () => {
    const t = text(view({ phase: "ready", quote: QUOTE, usdPrice: 95_400 }));
    expect(t).toMatch(/Still unconfirmed, paying 2\.0 sat\/vB\. A replacement can pay 14\.0 sat\/vB \(the network's fast rate\)/);
    expect(t).toContain("Speed up");
    expect(t).not.toContain("Confirm speed-up");
  });

  it("review: current rate, new rate, new fee in BTC and USD, the extra, the change — and one confirm", () => {
    const html = view({ phase: "review", quote: QUOTE, usdPrice: 95_400 });
    const t = text(html);
    expect(t).toMatch(/current rate 2\.0 sat\/vB/);
    expect(t).toMatch(/new rate 14\.0 sat\/vB/);
    expect(t).toMatch(/new fee 0\.00001974 BTC · \$1\.88/);
    expect(t).toMatch(/extra fee 0\.00001692 BTC · \$1\.61/);
    expect(t).toMatch(/your change 0\.00999718 BTC → 0\.00998026 BTC/);
    expect(t).toMatch(/pays every recipient exactly the same amount/);
    expect(html.match(/Confirm speed-up/g)).toHaveLength(1);
    expect(t).toContain("Cancel");
  });

  it("sending: both buttons disabled", () => {
    const html = view({ phase: "sending", quote: QUOTE, usdPrice: null });
    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(2);
    expect(text(html)).toContain("Sending…");
  });

  it("sent: the replacement's id; failed: 'Not sent' and a way to check again; unknown: check before trying again", () => {
    expect(text(view({ phase: "sent", quote: QUOTE, usdPrice: null, newTxid: "32".repeat(32) }))).toMatch(
      new RegExp(`Replacement sent, paying 14\\.0 sat/vB\\. ${"32".repeat(32)}`),
    );
    const failed = text(view({ phase: "failed", quote: QUOTE, usdPrice: null, reason: "insufficient fee" }));
    expect(failed).toMatch(/Not sent: insufficient fee/);
    expect(failed).toContain("Check again");
    expect(text(view({ phase: "unknown", reason: "It may have been sent.", newTxid: "33".repeat(32) }))).toMatch(
      new RegExp(`It may have been sent\\. Check ${"33".repeat(32)} on an explorer before trying again`),
    );
  });

  it("a refusal worth saying is said, e.g. no change output", () => {
    expect(
      text(view({ phase: "unavailable", code: "no-change", reason: "This transaction has no change output.", quiet: false })),
    ).toBe("speed up This transaction has no change output.");
  });
});

describe("SpeedUpPanel", () => {
  const wallet = {
    chain: "bitcoin" as const,
    address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    privateKey: "",
  };

  it("with a wallet that can sign: 'checking' from the first frame", () => {
    const html = renderToStaticMarkup(createElement(SpeedUpPanel, { txid: "31".repeat(32), wallet }));
    expect(html).toContain('data-speed-up="checking"');
  });

  it("without one (none, or watch-only): nothing", () => {
    expect(renderToStaticMarkup(createElement(SpeedUpPanel, { txid: "31".repeat(32), wallet: null }))).toBe("");
    expect(
      renderToStaticMarkup(createElement(SpeedUpPanel, { txid: "31".repeat(32), wallet: { ...wallet, watchOnly: true } })),
    ).toBe("");
  });
});
