/**
 * `tronFetch`: TronGrid direct and spaced, TronStack through the Rust proxy
 * (2026-09-29).
 *
 * Seen in the sandbox that evening: TronGrid answered the dashboard's burst
 * with 429 (3 requests a second for a keyless client), and the fallback's
 * direct fetch to api.tronstack.io was "blocked by CORS policy" — TronStack
 * sends no CORS headers, so from the web view the fallback never worked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const proxyCalls: Array<{ method: string; url: string; body?: string }> = [];

vi.mock("./_proxy", () => ({
  httpProxyCall: async (opts: { method: string; url: string; body?: string }) => {
    proxyCalls.push(opts);
    return { status: 200, body: JSON.stringify({ via: "tronstack" }), headers: [] };
  },
  proxyGetJson: async () => ({ data: [] }),
}));

const { tronFetch, TRONGRID_RATE } = await import("./trx-wallet");

let fetchCalls: Array<{ url: string; at: number }>;
let trongridStatus: number;

beforeEach(() => {
  proxyCalls.length = 0;
  fetchCalls = [];
  trongridStatus = 200;
  TRONGRID_RATE.minSpacingMs = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetchCalls.push({ url, at: Date.now() });
      return new Response(JSON.stringify({ via: "trongrid" }), { status: trongridStatus });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tronFetch", () => {
  it("answers from TronGrid without touching the proxy when TronGrid answers", async () => {
    const r = await tronFetch("/wallet/getnowblock");
    expect(await r.json()).toEqual({ via: "trongrid" });
    expect(proxyCalls).toHaveLength(0);
  });

  it("falls back to TronStack THROUGH the Rust proxy, same method and body", async () => {
    trongridStatus = 429;
    const body = JSON.stringify({ value: "abc" });
    const r = await tronFetch("/wallet/gettransactioninfobyid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(await r.json()).toEqual({ via: "tronstack" });
    expect(proxyCalls).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "https://api.tronstack.io/wallet/gettransactioninfobyid",
        body,
      }),
    ]);
    // Never a direct fetch to TronStack: that is the call CORS blocks.
    expect(fetchCalls.map((c) => c.url)).not.toContain(
      "https://api.tronstack.io/wallet/gettransactioninfobyid",
    );
  });

  it("spaces TronGrid requests instead of bursting them", async () => {
    TRONGRID_RATE.minSpacingMs = 60;
    await Promise.all([tronFetch("/a"), tronFetch("/b"), tronFetch("/c")]);
    const at = fetchCalls.map((c) => c.at).sort((a, b) => a - b);
    // Each request starts no earlier than its slot (slots 60 ms apart; the
    // slot wait re-checks the wall clock after waking, since a timer can fire
    // a few ms early on Windows). A start can be LATE, so one gap may read
    // short while the next reads long — what must hold is no burst: three
    // requests span at least two slots, and none share a start.
    expect(at[2] - at[0]).toBeGreaterThanOrEqual(118);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(20);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(20);
  });
});
