/**
 * `assessWalletSeedReadiness` — catches the 2026-08-22 incident before the
 * engine does: a real XMR<->LTC bid was refused with `'Litecoin has an
 * unexpected wallet seed and "restrict_unknown_seed_wallets" is enabled.'`
 * even though the wallet showed a real, positive LTC balance. See the
 * function's own doc comment in offers.ts for the full trace.
 */
import { describe, it, expect } from "vitest";
import { assessWalletSeedReadiness } from "./offers";

describe("assessWalletSeedReadiness", () => {
  it("ok when both legs report expectedSeed true", () => {
    const v = assessWalletSeedReadiness({
      sendTicker: "XMR",
      receiveTicker: "LTC",
      rows: {
        XMR: { expectedSeed: true },
        LTC: { expectedSeed: true },
      },
    });
    expect(v).toEqual({ state: "ok" });
  });

  it("the reported incident: LTC expectedSeed false blocks, names the coin", () => {
    const v = assessWalletSeedReadiness({
      sendTicker: "XMR",
      receiveTicker: "LTC",
      rows: {
        XMR: { expectedSeed: true },
        LTC: { expectedSeed: false },
      },
    });
    expect(v.state).toBe("not-ready");
    expect(v).toMatchObject({ coin: "LTC" });
  });

  it("checks BOTH legs — the scriptless (XMR) side blocks too, matching checkCoinsReady(coin_from, coin_to)", () => {
    const v = assessWalletSeedReadiness({
      sendTicker: "XMR",
      receiveTicker: "LTC",
      rows: {
        XMR: { expectedSeed: false },
        LTC: { expectedSeed: true },
      },
    });
    expect(v.state).toBe("not-ready");
    expect(v).toMatchObject({ coin: "XMR" });
  });

  it("never blocks on missing or unreadable data — only an explicit false blocks", () => {
    expect(
      assessWalletSeedReadiness({
        sendTicker: "XMR",
        receiveTicker: "LTC",
        rows: {},
      }),
    ).toEqual({ state: "ok" });
    expect(
      assessWalletSeedReadiness({
        sendTicker: "XMR",
        receiveTicker: "LTC",
        rows: { XMR: {}, LTC: { expectedSeed: null } },
      }),
    ).toEqual({ state: "ok" });
  });

  it("is case-insensitive on ticker lookup", () => {
    const v = assessWalletSeedReadiness({
      sendTicker: "xmr",
      receiveTicker: "ltc",
      rows: { LTC: { expectedSeed: false } },
    });
    expect(v.state).toBe("not-ready");
  });
});
