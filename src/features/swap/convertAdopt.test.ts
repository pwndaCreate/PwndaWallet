/**
 * EARN's convert pipeline never adopted its first hop (operator request,
 * 2026-10-01: verify the suspected bug, fix it if real). It was real.
 *
 * `App.tsx::adoptSidecarSwap` decided whether a bid the user had just placed
 * was the conversion's hop 1 by comparing `handle.sendCoin.toUpperCase()`
 * with "XMR" and `handle.receiveCoin.toUpperCase()` with "LTC". The handle is
 * built by `SidecarConfirmModal` from `book.offer`, a `TakerOffer`, and a
 * `TakerOffer` names coins the way the swap node's `/json/offers` does:
 * `coin_name()`, so "Monero" and "Litecoin" (deployed engine:
 * `js_server.py:543-544`, `interface/base.py:109-113`, `name: "monero"` in
 * `interface/xmr/chainparams.py`). "MONERO" is not "XMR", so the check could
 * never pass. After the user confirmed hop 1 the pipeline stayed `idle`
 * (not `hop1-running`, as the suspicion and App's own comment put it: nothing
 * else ever sets that stage), logged no conversion, and never reached
 * `hop2-ready`, so hop 2 was unreachable.
 *
 * Pinned here:
 *  - the premise: the handle the modal builds from an engine-shaped offer
 *    names coins, so a ticker comparison of it is the bug, not a style;
 *  - the hop-1 decision, by tickers in either spelling, and its other gates,
 *    including the one-hop-1-per-CONVERT-click rule that became live with it;
 *  - App's wiring asks that decision instead of comparing strings;
 *  - the conversion log records tickers;
 *  - the CONVERSIONS panel lists what the log holds. It rendered a prop no
 *    parent passes, so once a hop 1 was adopted it would have read
 *    "1 total" over "no conversions yet".
 *
 * Offer ids, bid ids and addresses are invented, in the engine's layouts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { BasicSwapOffer } from "../../api/basicswap";
import { toTakerOffers, type SidecarSwapHandle } from "../swap-sidecar";
import {
  CONVERT_ROUTE_HOP,
  CONVERT_SOURCE,
  hop1ConversionRecord,
  isConvertHop1Leg,
  shouldAdoptAsHop1,
  type ConvertPipelineState,
  type ConvertStage,
} from "./useConvertPipeline";
import { loadConversions, recordConversionStarted } from "./convert-history";
import { EarnConvertBody } from "./EarnConvertBody";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

// Invented ids with the engine's layout: 28-byte object ids.
const objId = (fill: string) => "00000000" + fill.repeat(24);
const OFFER = objId("0f");
const BID = objId("b1");
const BID_2 = objId("b2");

/**
 * One `/json/offers` row as `js_offers` builds it: coin NAMES, decimal
 * strings. The offerer sends Litecoin and wants Monero, so a TAKER sends XMR
 * and receives LTC: the conversion's first hop.
 */
function engineOffer(over: Partial<BasicSwapOffer> = {}): BasicSwapOffer {
  return {
    offer_id: OFFER,
    swap_type: 5, // SwapTypes.XMR_SWAP
    addr_from: "pInventedMakerAddrXXXXXXXXXXXXXXXXX",
    addr_to: "pInventedNetworkAddrXXXXXXXXXXXXXXX",
    created_at: 1_790_100_000,
    expire_at: 1_790_103_600,
    coin_from: "Litecoin",
    coin_to: "Monero",
    amount_from: "4.00000000",
    amount_to: "2.857600000000",
    rate: "0.714400000000",
    min_bid_amount: "0.25000000",
    is_expired: false,
    is_own_offer: false,
    is_revoked: false,
    is_public: true,
    amount_negotiable: true,
    rate_negotiable: false,
    ...over,
  };
}

/** The handle exactly as `SidecarConfirmModal` builds it for `onSubmitted`. */
function handleFromModal(offer: BasicSwapOffer, bidId = BID): SidecarSwapHandle {
  const book = { offer: toTakerOffers([offer])[0] };
  return {
    bidId,
    offerId: book.offer.offerId,
    sendCoin: book.offer.sendCoin,
    receiveCoin: book.offer.receiveCoin,
    sendAmount: "0.500000000000",
    receiveAmount: "0.69988801",
    createdAt: 1_790_100_060,
    payoutAddress: "ltc1qinventedpayout000000000000000000000",
    makerAddress: book.offer.makerAddress ?? null,
  };
}

const CONVERT_SEED = { router: "basicswap", nonce: 1_790_100_000_123 };

// ═══════════════════════════════════════════════════════════════════════
// The premise
// ═══════════════════════════════════════════════════════════════════════

describe("the handle the confirm modal passes up", () => {
  it("names the coins as the swap node does, not as tickers", () => {
    const h = handleFromModal(engineOffer());
    // If these ever become tickers, the bug's premise changed; the decision
    // below must keep working either way.
    expect(h.sendCoin).toBe("Monero");
    expect(h.receiveCoin).toBe("Litecoin");
    // The old check, verbatim in effect: it could never accept this handle.
    expect(h.sendCoin.toUpperCase() === "XMR").toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Which swap is hop 1
// ═══════════════════════════════════════════════════════════════════════

describe("isConvertHop1Leg compares tickers", () => {
  it("accepts the modal's handle (node names)", () => {
    expect(isConvertHop1Leg(handleFromModal(engineOffer()))).toBe(true);
  });

  it("accepts tickers too, in any case (a handle rebuilt from swap history)", () => {
    expect(isConvertHop1Leg({ sendCoin: CONVERT_SOURCE, receiveCoin: CONVERT_ROUTE_HOP })).toBe(true);
    expect(isConvertHop1Leg({ sendCoin: "xmr", receiveCoin: "ltc" })).toBe(true);
    expect(isConvertHop1Leg({ sendCoin: "MONERO", receiveCoin: "litecoin" })).toBe(true);
  });

  it("refuses every other pair", () => {
    // The opposite direction: LTC sent, XMR received.
    const reverse = handleFromModal(engineOffer({ coin_from: "Monero", coin_to: "Litecoin" }));
    expect(reverse.sendCoin).toBe("Litecoin");
    expect(isConvertHop1Leg(reverse)).toBe(false);
    // XMR for another coin.
    expect(isConvertHop1Leg({ sendCoin: "Monero", receiveCoin: "Bitcoin" })).toBe(false);
    // LTC over MWEB is a different coin (LTC_MWEB) with its own wallet.
    expect(isConvertHop1Leg({ sendCoin: "Monero", receiveCoin: "Litecoin MWEB" })).toBe(false);
    // Nothing to go on.
    expect(isConvertHop1Leg({ sendCoin: "", receiveCoin: "" })).toBe(false);
    expect(isConvertHop1Leg({})).toBe(false);
  });
});

describe("shouldAdoptAsHop1", () => {
  const handle = handleFromModal(engineOffer());
  const ask = (over: Partial<Parameters<typeof shouldAdoptAsHop1>[0]> = {}) =>
    shouldAdoptAsHop1({
      stage: "idle",
      handle,
      seed: CONVERT_SEED,
      adoptedSeedNonce: null,
      ...over,
    });

  it("adopts the bid a CONVERT click led to (the case that never passed)", () => {
    expect(ask()).toBe(true);
    expect(ask({ stage: "hop1-running" })).toBe(true);
  });

  it("not when the pipeline is past hop 1", () => {
    for (const stage of ["hop2-ready", "hop2-running", "failed"] as ConvertStage[]) {
      expect(ask({ stage }), stage).toBe(false);
    }
  });

  it("not a plain P2P swap: the form was not seeded by CONVERT", () => {
    expect(ask({ seed: null })).toBe(false);
    expect(ask({ seed: undefined })).toBe(false);
    // An asset's SWAP tile seeds router "auto"; hop 2 seeds "intents".
    expect(ask({ seed: { router: "auto", nonce: 7 } })).toBe(false);
    expect(ask({ seed: { router: "intents", nonce: 8 } })).toBe(false);
  });

  it("one CONVERT click adopts one bid: a used seed adopts nothing more", () => {
    expect(ask({ adoptedSeedNonce: CONVERT_SEED.nonce })).toBe(false);
    // A later bid of the session while hop 1 runs would have replaced it.
    expect(
      ask({ stage: "hop1-running", handle: handleFromModal(engineOffer(), BID_2), adoptedSeedNonce: CONVERT_SEED.nonce }),
    ).toBe(false);
    // A new click is a new seed.
    expect(ask({ seed: { router: "basicswap", nonce: CONVERT_SEED.nonce + 1 }, adoptedSeedNonce: CONVERT_SEED.nonce })).toBe(true);
  });

  it("not the wrong pair, even from a CONVERT seed", () => {
    expect(ask({ handle: handleFromModal(engineOffer({ coin_from: "Monero", coin_to: "Litecoin" })) })).toBe(false);
    expect(ask({ handle: { sendCoin: "Monero", receiveCoin: "Bitcoin" } })).toBe(false);
  });
});

describe("App's adoptSidecarSwap asks shouldAdoptAsHop1", () => {
  const app = read("../../App.tsx");
  const body = app.slice(
    app.indexOf("const adoptSidecarSwap = useCallback"),
    app.indexOf("const earnSourceBalance = useMemo"),
  );

  it("decides through the shared function and marks the seed used", () => {
    expect(body.length).toBeGreaterThan(0);
    expect(app).toMatch(
      /import \{[^}]*\bshouldAdoptAsHop1\b[^}]*\} from "\.\/features\/swap\/useConvertPipeline";/,
    );
    expect(body).toMatch(
      /shouldAdoptAsHop1\(\{\s*stage: convertPipeline\.stage,\s*handle,\s*seed: convertSeed,\s*adoptedSeedNonce: adoptedSeedNonceRef\.current,\s*\}\)/,
    );
    expect(body).toContain("adoptedSeedNonceRef.current = convertSeed?.nonce ?? null;");
    expect(body).toContain(".adoptHop1(handle)");
  });

  it("compares no raw coin string with a ticker", () => {
    expect(body).not.toMatch(/(send|receive)Coin\??\.toUpperCase\(\)\s*===/);
    expect(body).not.toContain('=== "XMR"');
    expect(body).not.toContain('=== "LTC"');
  });

  it("still adopts every bid into the tracker first", () => {
    expect(body.indexOf("sidecarTracker?.adopt(handle)")).toBeGreaterThan(-1);
    expect(body.indexOf("sidecarTracker?.adopt(handle)")).toBeLessThan(body.indexOf("shouldAdoptAsHop1({"));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The conversion log and the CONVERSIONS panel
// ═══════════════════════════════════════════════════════════════════════

describe("hop1ConversionRecord", () => {
  it("records tickers, not the node's coin names", () => {
    const rec = hop1ConversionRecord(handleFromModal(engineOffer()), "BTC", 1_790_100_060_000);
    expect(rec).toEqual({
      id: BID,
      fromTicker: "XMR",
      viaTicker: "LTC",
      toTicker: "BTC",
      fromAmount: "0.500000000000",
      viaAmount: "",
      toAmount: "",
      startedAt: 1_790_100_060_000,
      status: "running",
    });
  });

  it("is what adoptHop1 writes", () => {
    const hook = read("./useConvertPipeline.ts");
    const adopt = hook.slice(hook.indexOf("const adoptHop1 = useCallback"), hook.indexOf("return useMemo("));
    expect(adopt).toContain("recordConversionStarted(hop1ConversionRecord(handle, targetCoin, Date.now()));");
    expect(adopt).not.toContain("fromTicker: handle.sendCoin");
  });
});

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
}

function pipeline(stage: ConvertStage): ConvertPipelineState {
  const noop = () => {};
  return {
    targetCoin: "BTC",
    setTargetCoin: noop,
    stage,
    hop1: null,
    hop2InputAmount: null,
    hop2PaidTo: null,
    hop1Unwound: false,
    beginHop1: noop,
    beginHop2: noop,
    reset: noop,
  };
}

describe("the CONVERSIONS panel lists the log", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the conversion an adopted hop 1 logged (App passes no `conversions`)", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    recordConversionStarted(hop1ConversionRecord(handleFromModal(engineOffer()), "BTC", Date.now()));
    expect(loadConversions()).toHaveLength(1);

    const html = renderToStaticMarkup(
      createElement(EarnConvertBody, {
        variant: "landscape",
        pipeline: pipeline("hop1-running"),
        sourceBalance: 0.5,
        pricesByTicker: { XMR: 162.3, LTC: 117, BTC: 62_000 },
        mining: { active: false },
        // What LandscapeRoot and SwapView pass when their parent gives
        // nothing, which App never does.
        conversions: [],
      }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    expect(text).toContain("1 total");
    expect(text).not.toContain("no conversions yet");
    expect(text).toContain("0.500000000000 XMR");
    // The in-progress CTA, for the record of what the stage renders.
    expect(text).toContain("SWAP IN PROGRESS");
  });

  it("says so when there is nothing logged", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    const html = renderToStaticMarkup(
      createElement(EarnConvertBody, {
        variant: "portrait",
        pipeline: pipeline("idle"),
        sourceBalance: null,
        pricesByTicker: {},
        mining: { active: false },
        conversions: [],
      }),
    );
    expect(html).toContain("no conversions yet");
    expect(html).not.toMatch(/\d+ total/);
  });
});

/**
 * Where hop 1 paid its LTC (2026-10-01). Hop 1's bid now carries the payout
 * address in the field the engine reads, so a completed hop 1 pays this
 * wallet's own LTC address, the one hop 2 spends from. Unless that address is
 * in a form the engine does not pay as written (a legacy `L…`), when the bid
 * leaves the payout to the swap node and the LTC is in the node's wallet.
 * "Hop 1 settled: … is in your wallet" was true in neither case before (the
 * node paid its own wallet whatever the screen said), and is false in the
 * second now, so the line says which.
 */
describe("hop 2's line says where hop 1 paid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const render = (paidTo: ConvertPipelineState["hop2PaidTo"]) => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    return renderToStaticMarkup(
      createElement(EarnConvertBody, {
        variant: "landscape",
        pipeline: { ...pipeline("hop2-ready"), hop2InputAmount: "0.09990000", hop2PaidTo: paidTo },
        sourceBalance: 0.5,
        pricesByTicker: { XMR: 162.3, LTC: 117, BTC: 62_000 },
        mining: { active: false },
        conversions: [],
      }),
    ).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  };

  it("the swap node's wallet, when the bid left the payout to it", () => {
    const text = render("node-wallet");
    expect(text).toContain(`0.09990000 ${CONVERT_ROUTE_HOP} is in your swap node`);
    expect(text).toContain(`not at this wallet`);
  });

  it("this wallet, when the bid paid its address", () => {
    expect(render("address")).toContain(`0.09990000 ${CONVERT_ROUTE_HOP} is in your wallet.`);
    expect(render(null)).toContain(`0.09990000 ${CONVERT_ROUTE_HOP} is in your wallet.`);
  });

  it("the pipeline keeps where hop 1 paid with its amount", () => {
    const hook = read("useConvertPipeline.ts");
    const settled = hook.slice(hook.indexOf('case "settled":'), hook.indexOf('case "follow":'));
    expect(settled).toContain("setHop2PaidTo(hop1?.payoutTo ?? null);");
  });
});
