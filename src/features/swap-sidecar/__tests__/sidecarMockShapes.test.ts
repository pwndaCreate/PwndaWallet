/**
 * The sandbox mock must not be MORE forgiving than production (R19).
 *
 * Until 2026-08-19 `tauri-mocks.ts` answered both `/json/wallets` and
 * `/json/walletbalances` with the same ticker-keyed object. A balances card
 * built on `walletbalances` therefore rendered perfectly under
 * `npm run dev:sandbox` and empty against a real node — the mock was hiding
 * the bug it existed to expose.
 *
 * These tests pin the two shapes apart at the mock boundary, so the defect
 * cannot come back by someone "simplifying" the two arms into one helper.
 * They run against `getMock` (the real dispatcher the sandbox uses), not
 * against the private helpers, so a regression in the dispatch wiring shows
 * up here too.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getMock: <T = unknown>(cmd: string, args?: unknown) => T;

beforeAll(async () => {
  // `swap_sidecar_active` seeds the mock's phase as `healthy`; `sidecarApi`
  // refuses every read below that, exactly as Rust's `api_context` does.
  vi.stubEnv("VITE_MOCK_STATE", "swap_sidecar_active");
  ({ getMock } = await import("../../../lib/tauri-mocks"));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const get = <T,>(path: string): T =>
  getMock<T>("swap_sidecar_api_get", { path });

describe("/json/wallets — ticker-keyed OBJECT", () => {
  it("is an object, not an array", () => {
    const body = get<Record<string, unknown>>("wallets");
    expect(Array.isArray(body)).toBe(false);
    expect(typeof body).toBe("object");
  });

  it("carries deposit_address — the field that makes it the balances source", () => {
    const body = get<Record<string, Record<string, unknown>>>("wallets");
    for (const [ticker, w] of Object.entries(body)) {
      expect(typeof w.deposit_address, `${ticker}.deposit_address`).toBe("string");
    }
  });

  it("carries the C5 lock/encryption booleans and separate unconfirmed", () => {
    const w = get<Record<string, Record<string, unknown>>>("wallets").XMR;
    expect(typeof w.encrypted).toBe("boolean");
    expect(typeof w.locked).toBe("boolean");
    expect(typeof w.expected_seed).toBe("boolean");
    expect(typeof w.unconfirmed).toBe("string");
  });

  it("feeds balanceRowsFrom without throwing", async () => {
    const { balanceRowsFrom } = await import("../useSidecarBalances");
    const rows = balanceRowsFrom(get("wallets"));
    expect(Object.keys(rows).length).toBeGreaterThan(0);
    expect(rows.XMR.depositAddress).not.toBeNull();
  });
});

describe("/json/walletbalances — ARRAY", () => {
  it("is an array, not the ticker-keyed object (THE regression test)", () => {
    const body = get<unknown[]>("walletbalances");
    expect(Array.isArray(body)).toBe(true);
  });

  it("has no deposit_address on any entry", () => {
    for (const e of get<Record<string, unknown>[]>("walletbalances")) {
      expect(e).not.toHaveProperty("deposit_address");
    }
  });

  it("does NOT have unique tickers — variant rows reuse the parent ticker", () => {
    // js_server.py:266-274 (PART_ANON / PART_BLIND) and :298-306 (LTC_MWEB).
    // This is why keying this endpoint by ticker drops rows: assert the
    // duplication is present rather than trusting a comment about it.
    const tickers = get<{ ticker: string }[]>("walletbalances").map((e) => e.ticker);
    expect(tickers.length).toBeGreaterThan(new Set(tickers).size);
    expect(tickers.filter((t) => t === "PART").length).toBeGreaterThan(1);
  });

  it("uses the flat js_walletbalances field set (id/name/ticker/balance/pending)", () => {
    for (const e of get<Record<string, unknown>[]>("walletbalances")) {
      expect(typeof e.id).toBe("number");
      expect(typeof e.name).toBe("string");
      expect(typeof e.ticker).toBe("string");
      expect(typeof e.balance).toBe("string");
      expect(typeof e.pending).toBe("string");
    }
  });

  it("would be REFUSED by balanceRowsFrom rather than yielding an empty card", async () => {
    const { balanceRowsFrom, SidecarBalanceShapeError } = await import(
      "../useSidecarBalances"
    );
    expect(() => balanceRowsFrom(get("walletbalances"))).toThrow(
      SidecarBalanceShapeError,
    );
  });
});

describe("the two endpoints are not the same object", () => {
  it("wallets and walletbalances disagree, as upstream does", () => {
    const a = get<unknown>("wallets");
    const b = get<unknown>("walletbalances");
    expect(Array.isArray(a)).not.toBe(Array.isArray(b));
  });
});
