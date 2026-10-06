/**
 * The payout address the user confirms is the one the engine pays
 * (operator decision, 2026-10-01).
 *
 * The bid used to carry it as `addr_to`, a key the deployed `js_bids` never
 * reads (it reads `destination_address`, `js_server.py:770-778`), so every
 * swap paid the swap node's own wallet while the confirm screen showed the
 * user's address. Rust now sends `destination_address`
 * (`swap_bid.rs::build_bid_body`, pinned by its own tests). These pin the
 * renderer's half:
 *  - which address forms are sent, per coin, from the engine's own handling
 *    (the trace is in `swap_bid.rs` above `PAYOUT_ADDRESS_SHAPES`);
 *  - that the TS and Rust tables, and their test vectors, are the same;
 *  - that `submitSidecarBid` sends the address only when the plan says so;
 *  - that the confirm screen says where the coin lands, before the click;
 *  - that an automatic re-bid never lands it somewhere else.
 *
 * Vectors: the world-public test seed ("abandon … about") for the bitcoin
 * family, invented CryptoNote keys (G and 2G) through the wallet's own
 * encoders, and BIP173/BIP86's published examples.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The opt-in flag `submitSidecarBid` checks first (its own plugin-store file).
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (k: string) => (k === "pwnda.swapSidecarOptedInAt" ? 1_790_000_000_000 : undefined),
    set: async () => undefined,
    save: async () => undefined,
    delete: async () => undefined,
  }),
}));

// The swap node: nothing here may reach a real one.
vi.mock("../../api/basicswap", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/basicswap")>();
  return { ...real, swapSidecarPlaceBid: vi.fn() };
});

import * as api from "../../api/basicswap";
import type { BasicSwapOffer } from "../../api/basicswap";
import {
  nodeWalletPayoutNote,
  PAYOUT_ADDRESS_SHAPES,
  planPayout,
  type PayoutPlan,
} from "./payoutDestination";
import { submitSidecarBid, type SidecarQuote } from "./useSidecarSwap";
import { SidecarConfirmModal } from "./SidecarConfirmModal";
import type { NormalizedQuote } from "../swap/useSwapQuote";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
const RUST = read("../../../src-tauri/src/swap_bid.rs");

/** A `const NAME: &[(&str, &str)] = &[ … ];` table from swap_bid.rs. */
function rustPairs(name: string): [string, string][] {
  const at = RUST.indexOf(`const ${name}: &[(&str, &str)] = &[`);
  expect(at, `${name} not found in swap_bid.rs`).toBeGreaterThan(-1);
  const body = RUST.slice(at, RUST.indexOf("];", at));
  return [...body.matchAll(/\("([^"]+)",\s*r?"([^"]+)"\)/g)].map((m) => [m[1], m[2]]);
}

const OFFER = "00000000" + "0f".repeat(24);
const BID = "00000000" + "b1".repeat(24);

describe("which address forms the engine pays as written", () => {
  it("the TS table is the Rust table, coin for coin and pattern for pattern", () => {
    const rust = rustPairs("PAYOUT_ADDRESS_SHAPES");
    expect(rust.length).toBeGreaterThan(0);
    expect(Object.fromEntries(rust)).toEqual(
      Object.fromEntries(Object.entries(PAYOUT_ADDRESS_SHAPES).map(([t, re]) => [t, re.source])),
    );
  });

  it("every form Rust's tests send is sent here", () => {
    const vectors = rustPairs("PAYS_AS_WRITTEN");
    expect(vectors.length).toBeGreaterThanOrEqual(10);
    for (const [coin, address] of vectors) {
      expect(planPayout({ receiveCoin: coin, swapType: 5 }, address), `${coin} ${address}`).toEqual({
        to: "address",
        ticker: expect.any(String),
        address,
      });
    }
  });

  it("every form Rust's tests refuse lands in the node's wallet here, and is said so", () => {
    const vectors = rustPairs("PAID_ELSEWHERE_OR_REFUSED");
    expect(vectors.length).toBeGreaterThanOrEqual(15);
    for (const [coin, address] of vectors) {
      const plan = planPayout({ receiveCoin: coin, swapType: 5 }, address);
      // A bare CashAddr is the one form that is CONVERTED rather than kept:
      // the engine needs the prefix, so the plan adds it (below). Rust, which
      // checks what the renderer sends, refuses it bare.
      if (coin === "Bitcoin Cash" && !address.includes(":")) continue;
      expect(plan, `${coin} ${address}`).toMatchObject({ to: "node-wallet", reason: "form" });
    }
  });

  it("names the coins by the engine's names and by ticker", () => {
    const ltc = "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh";
    expect(planPayout({ receiveCoin: "Litecoin", swapType: 5 }, ltc).to).toBe("address");
    expect(planPayout({ receiveCoin: "LTC", swapType: 5 }, ltc).to).toBe("address");
    expect(planPayout({ receiveCoin: "Bitcoin Cash", swapType: 5 }, "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6")).toMatchObject({
      to: "address",
      ticker: "BCH",
    });
  });

  it("gives a bare CashAddr the prefix the engine requires", () => {
    // `Address.from_string` refuses one without: "Cash address is missing prefix".
    expect(planPayout({ receiveCoin: "Bitcoin Cash", swapType: 5 }, "qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6")).toEqual({
      to: "address",
      ticker: "BCH",
      address: "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6",
    });
  });

  it("an offer on another protocol, a coin with no rule, or no address: the node's wallet", () => {
    const ltc = "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh";
    expect(planPayout({ receiveCoin: "Litecoin", swapType: 1 }, ltc)).toMatchObject({ to: "node-wallet", reason: "protocol" });
    expect(planPayout({ receiveCoin: "Litecoin", swapType: undefined }, ltc)).toMatchObject({ to: "node-wallet", reason: "protocol" });
    expect(planPayout({ receiveCoin: "Particl", swapType: 5 }, "Pinvented00000000000000000000000000")).toMatchObject({
      to: "node-wallet",
      reason: "coin",
    });
    expect(planPayout({ receiveCoin: "Litecoin", swapType: 5 }, "  ")).toMatchObject({ to: "node-wallet", reason: "no-address" });
  });

  it("says where the coin lands, and why, only when it is not the address", () => {
    const ok = planPayout({ receiveCoin: "Litecoin", swapType: 5 }, "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh");
    expect(nodeWalletPayoutNote(ok)).toBeNull();
    const legacy = planPayout({ receiveCoin: "Litecoin", swapType: 5 }, "LUWPbpM43E2p7ZSh8cyTBEkvpHmr3cB8Ez");
    const note = nodeWalletPayoutNote(legacy)!;
    expect(note).toContain("swap node's LTC wallet");
    expect(note).toContain("not at this address");
    expect(note).toContain("ltc1q…");
    expect(nodeWalletPayoutNote({ to: "node-wallet", ticker: "LTC", reason: "protocol", address: "x" })).toContain(
      "swap protocol",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The bid, and the screen before it
// ═══════════════════════════════════════════════════════════════════════

const NOW = Math.floor(Date.now() / 1000);

function sidecarQuote(receiveCoin = "Litecoin", swapType = 5): SidecarQuote {
  const offer = {
    offerId: OFFER,
    sendCoin: "Monero",
    receiveCoin,
    maxReceive: 1,
    maxSend: 0.1,
    minReceive: 0.01,
    effectiveRate: 0.1,
    receivePerSend: 10,
    amountNegotiable: true,
    rateNegotiable: false,
    isExpired: false,
    isOwnOffer: false,
    isRevoked: false,
    tradable: true,
    bidReversed: false,
    makerAddress: "pInventedMakerAddrXXXXXXXXXXXXXXXXX",
    createdAt: NOW - 60,
    expireAt: NOW + 3600,
    raw: { swap_type: swapType, coin_from: receiveCoin, coin_to: "Monero" } as unknown as BasicSwapOffer,
  };
  return {
    legs: { sendTicker: "XMR", receiveTicker: "LTC" },
    offer,
    rankedOffers: [offer],
    validation: { ok: true } as unknown as SidecarQuote["validation"],
    spread: {
      band: "green",
      verified: true,
      spreadPct: 0.4,
      offerRate: 0.1,
      marketRate: 0.0996,
      reason: "within-tolerance",
      blocked: false,
      sentence: "This swap is 0.4% worse than market.",
    },
    sendAmount: 0.01,
    receiveAmount: 0.1,
    sendDecimals: 12,
    receiveDecimals: 8,
    chainCost: null,
    coins: null,
    expiresAt: NOW + 600,
    funding: { state: "ok" },
    walletReadiness: { state: "ok" },
    warnings: [],
  } as SidecarQuote;
}

describe("submitSidecarBid sends the address only where the engine pays it", () => {
  it("a P2WPKH LTC address goes in the bid, and the result says so", async () => {
    vi.mocked(api.swapSidecarPlaceBid).mockReset().mockResolvedValue(BID);
    const ltc = "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh";
    const r = await submitSidecarBid({ quote: sidecarQuote(), addrTo: ltc });
    expect(r).toMatchObject({ ok: true, bidId: BID, payout: { to: "address", address: ltc } });
    expect(vi.mocked(api.swapSidecarPlaceBid).mock.calls[0][0].addrTo).toBe(ltc);
  });

  it("a legacy LTC address is not sent: the engine would pay a different address", async () => {
    vi.mocked(api.swapSidecarPlaceBid).mockReset().mockResolvedValue(BID);
    const r = await submitSidecarBid({ quote: sidecarQuote(), addrTo: "LUWPbpM43E2p7ZSh8cyTBEkvpHmr3cB8Ez" });
    expect(r).toMatchObject({ ok: true, payout: { to: "node-wallet", reason: "form" } });
    expect(vi.mocked(api.swapSidecarPlaceBid).mock.calls[0][0].addrTo).toBeUndefined();
  });

  it("an offer on another protocol: nothing is sent, whatever the address", async () => {
    vi.mocked(api.swapSidecarPlaceBid).mockReset().mockResolvedValue(BID);
    await submitSidecarBid({ quote: sidecarQuote("Litecoin", 1), addrTo: "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh" });
    expect(vi.mocked(api.swapSidecarPlaceBid).mock.calls[0][0].addrTo).toBeUndefined();
  });
});

describe("the confirm screen says where the coin lands", () => {
  const render = (payoutAddress: string) =>
    renderToStaticMarkup(
      createElement(SidecarConfirmModal, {
        open: true,
        quote: { basicswapQuote: sidecarQuote() } as unknown as NormalizedQuote,
        fromAsset: "XMR",
        toAsset: "LTC",
        payoutAddress,
        onSubmitted: () => {},
        onClose: () => {},
      }),
    );

  it("an address the engine pays: the payout row is that address", () => {
    const html = render("ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh");
    expect(html).toContain("Payout (LTC)");
    expect(html).not.toContain("data-payout-node-wallet");
  });

  it("an address it would pay elsewhere: the row says the swap node's wallet, and why", () => {
    const html = render("LUWPbpM43E2p7ZSh8cyTBEkvpHmr3cB8Ez");
    expect(html).toContain("data-payout-node-wallet");
    expect(html).toContain("your swap node&#x27;s wallet");
    expect(html).toContain("not at this address");
    // The legacy address itself is not offered as the payout.
    expect(html).not.toContain("LUWPbpM43E2p7ZSh8cyTBEkvpHmr3cB8Ez");
  });

  it("the handle records where the bid asked to be paid", () => {
    const modal = read("./SidecarConfirmModal.tsx");
    expect(modal).toContain("payoutTo: result.payout.to");
    expect(modal).toContain("const payoutPlan = payoutPlanForQuote(book, payoutAddress);");
  });
});

describe("an automatic re-bid never lands the coin somewhere else", () => {
  it("compares the new offer's plan with the confirmed one before it bids", () => {
    const hook = read("./useSidecarSwap.ts");
    const retry = hook.slice(hook.indexOf("const attemptAutoRetry"), hook.indexOf("const openTracker = useCallback"));
    const plan = retry.indexOf("const plan = payoutPlanForQuote(quote, payout);");
    const check = retry.indexOf("if (dead.payoutTo && plan.to !== dead.payoutTo)");
    const submit = retry.indexOf("await submitSidecarBid(");
    expect(plan).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(plan);
    expect(submit).toBeGreaterThan(check);
    expect(retry).toContain("payoutTo: result.payout.to");
  });
});

// A plan is a value the screen, the bid and the history all read: its shape is
// part of the contract.
const _shape: PayoutPlan[] = [
  { to: "address", ticker: "LTC", address: "ltc1q" },
  { to: "node-wallet", ticker: "LTC", reason: "form", address: null },
];
void _shape;
