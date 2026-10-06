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
 *  - that an automatic re-bid never lands it somewhere else;
 *  - and (2026-10-06) that it is sent only where the swap node can follow a
 *    payout to an outside address: on an electrum connection for BTC, LTC and
 *    BCH, never for DOGE and DASH, whatever the connection for XMR, ZEPH and
 *    ZANO, as the node itself reports it.
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
  const absent = (what: string) => async () => {
    throw new Error(`${what} is not part of this test`);
  };
  return {
    ...real,
    swapSidecarPlaceBid: vi.fn(),
    // The quote's reads (2026-10-06): the book and the node's wallets table
    // are the test's; the advisory ones fail, which the quote absorbs.
    fetchOffers: vi.fn(),
    fetchWallets: vi.fn(),
    fetchCoins: vi.fn(absent("the coin table")),
    fetchOfferFeeEstimate: vi.fn(absent("the fee estimate")),
  };
});

import * as api from "../../api/basicswap";
import type { BasicSwapOffer } from "../../api/basicswap";
import {
  nodeWalletPayoutNote,
  PAYOUT_ADDRESS_SHAPES,
  PAYOUT_CHECKS,
  PAYOUT_CONNECTION_REQUIRED,
  planPayout,
  type PayoutOffer,
  type PayoutPlan,
} from "./payoutDestination";
import {
  fetchSidecarQuote,
  resetSidecarCoinCache,
  submitSidecarBid,
  type SidecarQuote,
} from "./useSidecarSwap";
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

/**
 * An offer buying `receiveCoin`, on a node that reaches that coin's chain over
 * `receiveConnection`. The form tests run on electrum, which lets every coin
 * through (2026-10-06), so the address form is the only thing they test.
 */
const buying = (
  receiveCoin: string,
  swapType: number | null | undefined,
  receiveConnection: string | null = "electrum",
): PayoutOffer => ({ receiveCoin, swapType, receiveConnection });

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
      expect(planPayout(buying(coin, 5), address), `${coin} ${address}`).toEqual({
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
      const plan = planPayout(buying(coin, 5), address);
      // A bare CashAddr is the one form that is CONVERTED rather than kept:
      // the engine needs the prefix, so the plan adds it (below). Rust, which
      // checks what the renderer sends, refuses it bare.
      if (coin === "Bitcoin Cash" && !address.includes(":")) continue;
      expect(plan, `${coin} ${address}`).toMatchObject({ to: "node-wallet", reason: "form" });
    }
  });

  it("names the coins by the engine's names and by ticker", () => {
    const ltc = "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh";
    expect(planPayout(buying("Litecoin", 5), ltc).to).toBe("address");
    expect(planPayout(buying("LTC", 5), ltc).to).toBe("address");
    expect(planPayout(buying("Bitcoin Cash", 5), "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6")).toMatchObject({
      to: "address",
      ticker: "BCH",
    });
  });

  it("gives a bare CashAddr the prefix the engine requires", () => {
    // `Address.from_string` refuses one without: "Cash address is missing prefix".
    expect(planPayout(buying("Bitcoin Cash", 5), "qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6")).toEqual({
      to: "address",
      ticker: "BCH",
      address: "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6",
    });
  });

  it("an offer on another protocol, a coin with no rule, or no address: the node's wallet", () => {
    const ltc = "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh";
    expect(planPayout(buying("Litecoin", 1), ltc)).toMatchObject({ to: "node-wallet", reason: "protocol" });
    expect(planPayout(buying("Litecoin", undefined), ltc)).toMatchObject({ to: "node-wallet", reason: "protocol" });
    expect(planPayout(buying("Particl", 5), "Pinvented00000000000000000000000000")).toMatchObject({
      to: "node-wallet",
      reason: "coin",
    });
    expect(planPayout(buying("Litecoin", 5), "  ")).toMatchObject({ to: "node-wallet", reason: "no-address" });
  });

  it("says where the coin lands, and why, only when it is not the address", () => {
    const ok = planPayout(buying("Litecoin", 5), "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh");
    expect(nodeWalletPayoutNote(ok)).toBeNull();
    const legacy = planPayout(buying("Litecoin", 5), "LUWPbpM43E2p7ZSh8cyTBEkvpHmr3cB8Ez");
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

function sidecarQuote(
  receiveCoin = "Litecoin",
  swapType = 5,
  receiveConnection: string | null = "electrum",
): SidecarQuote {
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
    receiveConnection,
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

/** The confirm screen for `quote`, showing `payoutAddress` as the address. */
const renderModal = (payoutAddress: string, quote: SidecarQuote = sidecarQuote()) =>
  renderToStaticMarkup(
    createElement(SidecarConfirmModal, {
      open: true,
      quote: { basicswapQuote: quote } as unknown as NormalizedQuote,
      fromAsset: "XMR",
      toAsset: "LTC",
      payoutAddress,
      onSubmitted: () => {},
      onClose: () => {},
    }),
  );

describe("the confirm screen says where the coin lands", () => {
  const render = (payoutAddress: string) => renderModal(payoutAddress);

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

// ═══════════════════════════════════════════════════════════════════════
// Only where the node can follow it (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════

/**
 * The address is sent only when the swap node can confirm a payment to an
 * address outside its wallet. BTC, LTC and BCH: their payout is this node's
 * chain-A redeem, which PWNDA-PATCH-27 reads again to settle a bid that
 * errored after publishing it, and an RPC node without txindex cannot find a
 * confirmed transaction that is not its wallet's. DOGE and DASH have no
 * electrum connection in this engine. XMR, ZEPH and ZANO: the engine completes
 * the bid as soon as a redeem to an outside address is submitted. The trace is
 * in `swap_bid.rs` above `PAYOUT_CONNECTION_REQUIRED`.
 */
describe("only where the node can follow a payout to an outside address (2026-10-06)", () => {
  const LTC = "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh";
  /** Rust's vectors of forms sent as written, for these coins. */
  const vectors = (coins: string[]) =>
    rustPairs("PAYS_AS_WRITTEN").filter(([coin]) => coins.includes(coin));

  it("the connection table is the Rust table, for the same coins as the forms", () => {
    const rust = rustPairs("PAYOUT_CONNECTION_REQUIRED");
    expect(rust).toHaveLength(8);
    expect(Object.fromEntries(rust)).toEqual(PAYOUT_CONNECTION_REQUIRED);
    expect(Object.keys(PAYOUT_CONNECTION_REQUIRED).sort()).toEqual(
      Object.keys(PAYOUT_ADDRESS_SHAPES).sort(),
    );
  });

  it("the checks run in Rust's order, so a new rule is one entry on each side", () => {
    const at = RUST.indexOf("const PAYOUT_CHECKS: &[PayoutCheck] = &[");
    expect(at, "PAYOUT_CHECKS not found in swap_bid.rs").toBeGreaterThan(-1);
    const list = RUST.slice(at, RUST.indexOf("];", at));
    const rust = [...list.matchAll(/check_(\w+)/g)].map((m) => m[1]);
    expect(rust).toEqual(PAYOUT_CHECKS.map((c) => c.name));
    expect(rust).toEqual(["protocol", "coin", "form", "connection"]);
  });

  it("an electrum coin still sends the address", () => {
    const sent = vectors(["Bitcoin", "Litecoin", "Bitcoin Cash"]);
    expect(sent).toHaveLength(3);
    for (const [coin, address] of sent) {
      expect(planPayout(buying(coin, 5, "electrum"), address), coin).toMatchObject({
        to: "address",
        address,
      });
    }
  });

  it("a coin on a full node is not sent, and the note says the node's wallet", () => {
    const held = vectors(["Bitcoin", "Litecoin", "Bitcoin Cash", "Dogecoin", "Dash"]);
    expect(held).toHaveLength(5);
    for (const [coin, address] of held) {
      const plan = planPayout(buying(coin, 5, "rpc"), address);
      expect(plan, coin).toMatchObject({ to: "node-wallet", reason: "connection", address });
      const note = nodeWalletPayoutNote(plan)!;
      expect(note).toContain(`swap node's ${plan.ticker} wallet`);
      expect(note).toContain("through a full node");
      expect(note).toContain("this address is not sent");
    }
  });

  it("a connection the node did not report is not electrum", () => {
    const unknown = planPayout(buying("Litecoin", 5, null), LTC);
    expect(unknown).toMatchObject({ to: "node-wallet", reason: "connection-unknown" });
    expect(nodeWalletPayoutNote(unknown)).toContain("could not read how your swap node connects to LTC");
    expect(planPayout(buying("Litecoin", 5, "none"), LTC)).toMatchObject({
      to: "node-wallet",
      reason: "connection",
    });
  });

  it("XMR, ZEPH and ZANO do not depend on the connection", () => {
    const sent = vectors(["Monero", "Zephyr", "Zano"]);
    expect(sent).toHaveLength(5);
    for (const [coin, address] of sent) {
      for (const connection of ["rpc", "electrum", "none", null]) {
        expect(planPayout(buying(coin, 5, connection), address), `${coin} on ${connection}`).toMatchObject({
          to: "address",
          address,
        });
      }
    }
  });

  /** A `/json/offers` row: a maker selling LTC for XMR (invented ids). */
  const bookRow = (): BasicSwapOffer => ({
    offer_id: OFFER,
    swap_type: 5,
    addr_from: "pInventedMakerAddrXXXXXXXXXXXXXXXXX",
    addr_to: "pInventedNetworkAddrXXXXXXXXXXXXXXX",
    created_at: NOW - 60,
    expire_at: NOW + 3600,
    coin_from: "Litecoin",
    coin_to: "Monero",
    amount_from: "10.00000000",
    amount_to: "7.144000000000",
    rate: "0.714400000000",
    min_bid_amount: "0.01000000",
    is_expired: false,
    is_own_offer: false,
    is_revoked: false,
    is_public: true,
    amount_negotiable: true,
    rate_negotiable: false,
  });
  const wallets = (v: unknown) => v as Awaited<ReturnType<typeof api.fetchWallets>>;
  const quoteXmrToLtc = () =>
    fetchSidecarQuote({ from: "XMR", to: "LTC", amount: "0.5", prices: { XMR: 162.3, LTC: 117 } });

  it("the quote carries the node's own report for the coin bought, from the read it already makes", async () => {
    resetSidecarCoinCache();
    vi.mocked(api.fetchOffers).mockReset().mockResolvedValue([bookRow()]);
    vi.mocked(api.fetchWallets)
      .mockReset()
      .mockResolvedValue(
        wallets({
          LTC: { balance: "0.0", connection_type: "rpc" },
          XMR: { balance: "1.0", connection_type: "rpc" },
        }),
      );
    expect((await quoteXmrToLtc()).receiveConnection).toBe("rpc");
    // The funding read, not a second one.
    expect(api.fetchWallets).toHaveBeenCalledTimes(1);

    vi.mocked(api.fetchWallets)
      .mockReset()
      .mockResolvedValue(wallets({ LTC: { balance: "0.0", connection_type: "electrum" } }));
    expect((await quoteXmrToLtc()).receiveConnection).toBe("electrum");

    // A coin that failed in the node's table, and a node that did not answer.
    vi.mocked(api.fetchWallets)
      .mockReset()
      .mockResolvedValue(wallets({ LTC: { name: "Litecoin", error: "Timeout" } }));
    expect((await quoteXmrToLtc()).receiveConnection).toBeNull();
    vi.mocked(api.fetchWallets).mockReset().mockRejectedValue(new Error("the swap node is not running"));
    expect((await quoteXmrToLtc()).receiveConnection).toBeNull();
  });

  it("a bid on an LTC full node carries no address; on electrum it does", async () => {
    vi.mocked(api.swapSidecarPlaceBid).mockReset().mockResolvedValue(BID);
    const held = await submitSidecarBid({ quote: sidecarQuote("Litecoin", 5, "rpc"), addrTo: LTC });
    expect(held).toMatchObject({ ok: true, payout: { to: "node-wallet", reason: "connection" } });
    expect(vi.mocked(api.swapSidecarPlaceBid).mock.calls[0][0].addrTo).toBeUndefined();

    const sent = await submitSidecarBid({ quote: sidecarQuote("Litecoin", 5, "electrum"), addrTo: LTC });
    expect(sent).toMatchObject({ ok: true, payout: { to: "address", address: LTC } });
    expect(vi.mocked(api.swapSidecarPlaceBid).mock.calls[1][0].addrTo).toBe(LTC);
  });

  it("the confirm screen says the node's wallet, and why, before the click", () => {
    const html = renderModal(LTC, sidecarQuote("Litecoin", 5, "rpc"));
    expect(html).toContain("data-payout-node-wallet");
    expect(html).toContain("your swap node&#x27;s wallet");
    expect(html).toContain("through a full node");
    expect(html).not.toContain(LTC);
    expect(renderModal(LTC, sidecarQuote("Litecoin", 5, "electrum"))).not.toContain(
      "data-payout-node-wallet",
    );
  });
});

// A plan is a value the screen, the bid and the history all read: its shape is
// part of the contract.
const _shape: PayoutPlan[] = [
  { to: "address", ticker: "LTC", address: "ltc1q" },
  { to: "node-wallet", ticker: "LTC", reason: "form", address: null },
];
void _shape;
