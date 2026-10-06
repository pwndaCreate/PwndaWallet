/**
 * A Monero or Zephyr send's fee, end to end through the code the Send modal
 * runs: the real adapters against a mocked wallet-rpc, the real pricing
 * controller, and the route `useSend` takes on Confirm (operator request,
 * 2026-10-01).
 *
 * The leak this pins: the Send modal priced a Zephyr send by BUILDING it, 600
 * ms after every edit and again every 60 s (`useSendQuote` → `quoteController`
 * "auto" → `zphAdapter.quoteSend` → `transfer` with `do_not_relay`). Every
 * build asks the node for the coins it spends with a fresh set of decoys, so a
 * node watching several builds of one spend sees the real coin in all of them
 * while the decoys change. Counted here as wallet-rpc `transfer` calls.
 *
 * `useSendQuote` is a React hook and this repo has no DOM test harness, so the
 * hook's wiring is reproduced with its own rule (`quoteModeFor`), spelled out
 * inline in the counting test so that the same test also runs against the code
 * from before the change, and pinned against the hook's source below.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("../../wallets/xmr-nodes", () => ({
  getSelectedNode: vi.fn(async () => null),
  raceBestNode: vi.fn(async () => "http://node.sandbox.test:18081"),
  getBestNodeUrl: vi.fn(() => null),
  startHealthLoop: vi.fn(),
  stopHealthLoop: vi.fn(),
  onHealthUpdate: vi.fn(() => () => {}),
  getHealthSnapshot: vi.fn(() => []),
  getActivePool: vi.fn(async () => []),
  HOT_SWAP_SPEEDUP_THRESHOLD: 1.75,
}));
vi.mock("../../wallets/xmr-keys", () => ({
  generateXmrSeed: vi.fn(),
  xmrAddressFromSeed: vi.fn(async () => "4ownSandboxAddress"),
  validateXmrSeed: vi.fn(async () => ({ ok: true })),
  normalizeXmrSeed: (s: string) => s.trim().split(/\s+/).join(" "),
  xmrKeysFromRawSecret: vi.fn(),
  bytesToHex: vi.fn(),
}));
vi.mock("../../wallets/zph-nodes", () => ({
  getSelectedNode: vi.fn(async () => null),
  raceBestNode: vi.fn(async () => "http://node.sandbox.test:17767"),
  getHealthSnapshot: vi.fn(() => []),
  startHealthLoop: vi.fn(),
  stopHealthLoop: vi.fn(),
  onHealthUpdate: vi.fn(() => () => {}),
  HOT_SWAP_SPEEDUP_THRESHOLD: 1.75,
}));
vi.mock("../../wallets/zph-keys", () => ({
  generateZephyrSeed: vi.fn(),
  validateZephyrSeed: vi.fn(async () => ({ ok: true })),
  normalizeZephyrSeed: (s: string) => s.trim().split(/\s+/).join(" "),
  zephyrAddressFromSeed: vi.fn(async () => "ZEPHYR2ownSandboxAddress"),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { invoke } from "../../lib/tauri";
import { initXmrSession, xmrAdapter } from "../../wallets/xmr-wallet";
import { initZphSession, zphAdapter } from "../../wallets/zph-wallet";
import { routeQuotedSend } from "../../wallets/send-quote";
import type { ChainAdapter } from "../../wallets/types";
import { createQuoteController, quotableInputs, type QuoteSnapshot } from "./quoteController";
import { quoteModeFor } from "./useSendQuote";
import { SendModal } from "./SendModal";

const invokeMock = vi.mocked(invoke);
const XMR_TO =
  "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
const ZPH_TO = "ZEPHYR2qjmpfgEjnpvUnmcW84J5q3uvP5Z5oc8h6F9zsTrhpFkPgRecipient";
const seed = (w: string) => Array.from({ length: 25 }, (_, i) => `${w}${i}`).join(" ");

/** Signed blobs, distinct per build, as a real wallet's are. */
let blobs = 0;
const walletRpc = (method: string, p: any): unknown => {
  switch (method) {
    case "get_address":
      throw "RPC error -13: No wallet file"; // skips the address self-heal
    case "get_height":
      return { height: 3_000_000 };
    case "validate_address":
      return { valid: true, integrated: false, subaddress: false, nettype: "mainnet", openalias_address: "" };
    case "create_address":
      return { address: "8sandboxSubaddress", address_index: 1 };
    case "transfer":
      return {
        tx_hash: "ab".repeat(32),
        tx_key: "k",
        amount: p.destinations[0].amount,
        fee: 30_720_000,
        ...(p.do_not_relay && p.get_tx_metadata ? { tx_metadata: `blob${String(++blobs).padStart(4, "0")}` } : {}),
      };
    case "relay_tx":
      return { tx_hash: "ab".repeat(32) };
    default:
      return {};
  }
};

beforeAll(async () => {
  invokeMock.mockImplementation(async (cmd: string, args?: any) => {
    switch (cmd) {
      case "xmr_check_wallet_rpc":
      case "zph_check_wallet_rpc":
        return true;
      case "xmr_probe_node":
      case "zph_probe_node":
        return { url: args.url, ok: true, latency_ms: 5, height: 3_000_000, error: null };
      case "xmr_fee_estimate":
        return { fees: [20_000, 80_000, 320_000, 4_000_000], quantization_mask: 10_000 };
      case "zph_fee_estimate":
        return { fees: [210_000, 820_000, 3_300_000, 41_000_000], quantization_mask: 10_000 };
      case "xmr_rpc_call":
      case "zph_rpc_call":
        return walletRpc(args.method, args.params);
      default:
        return null;
    }
  });
  await initXmrSession(seed("word"), "master-password");
  await initZphSession(seed("word"), "master-password");
});

beforeEach(() => {
  invokeMock.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const calls = (command: string) =>
  invokeMock.mock.calls
    .filter(([cmd]) => cmd === command)
    .map(([, a]) => a as { method: string; params: any });

const CASES: Array<[string, ChainAdapter, string, string]> = [
  ["Zephyr", zphAdapter, "zph_rpc_call", ZPH_TO],
  ["Monero", xmrAdapter, "xmr_rpc_call", XMR_TO],
];

describe("the Send modal builds a Monero / Zephyr send once, on Review (2026-10-01)", () => {
  for (const [name, adapter, command, to] of CASES) {
    it(`${name}: typing and ten minutes open build nothing; Review builds once; Confirm relays exactly that`, async () => {
      const builds = () => calls(command).filter((c) => c.method === "transfer");
      const relays = () => calls(command).filter((c) => c.method === "relay_tx");
      // The rule `useSendQuote` applies (`quoteModeFor`), spelled out so this
      // test also runs against the code from before it existed.
      const mode = adapter.quoteBuildsSpend === true ? "on-request" : "auto";
      const snaps: QuoteSnapshot[] = [];
      const ctrl = createQuoteController({
        quote: (i) => adapter.quoteSend!(i),
        onChange: (s) => snaps.push(s),
        mode,
      });

      ctrl.setInputs(quotableInputs(to, "1"));
      await vi.advanceTimersByTimeAsync(5_000);
      ctrl.setInputs(quotableInputs(to, "1.5"));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // Before 2026-10-01, Zephyr: one build after each pause in typing, then
      // one a minute — 11 builds in this test, 10 of them of the same spend.
      expect(builds()).toHaveLength(0);

      ctrl.request(); // ► Review
      await vi.advanceTimersByTimeAsync(0);
      expect(builds()).toHaveLength(1);
      expect(builds()[0].params).toMatchObject({ do_not_relay: true, get_tx_metadata: true });
      expect(relays()).toHaveLength(0);
      const quote = ctrl.snapshot().quote!;
      expect(quote).toMatchObject({ to, amount: "1.5", fee: "0.00003072" });

      await vi.advanceTimersByTimeAsync(10 * 60_000); // the user reads it, slowly
      expect(builds()).toHaveLength(1);

      // ► Confirm: the route `useSend` takes, then the adapter's relay.
      const route = routeQuotedSend(adapter, quote, { to, amount: "1.5" }, Date.now());
      expect(route.kind).toBe("relay");
      await adapter.sendQuoted!(quote);
      expect(builds()).toHaveLength(1);
      expect(relays()).toEqual([
        { method: "relay_tx", params: { hex: (quote.ticket as { txMetadata: string }).txMetadata } },
      ]);
      ctrl.dispose();
    });
  }

  it("the estimate shown meanwhile reads the node's rate and calls the wallet-rpc for nothing", async () => {
    await xmrAdapter.getFeeEstimate();
    await zphAdapter.getFeeEstimate("ZRS");
    expect(invokeMock.mock.calls.map(([cmd]) => cmd)).toEqual(["xmr_fee_estimate", "zph_fee_estimate"]);
  });
});

describe("useSend's route for a reviewed send (routeQuotedSend)", () => {
  const send = { to: ZPH_TO, amount: "1.5" };
  const reviewedQuote = {
    to: ZPH_TO,
    amount: "1.5",
    fee: "0.0005",
    feeTicker: "ZEPH",
    quotedAt: 1_000,
    ticket: { txMetadata: "blob", txHash: "ab", epoch: 1 },
  };

  it("relays the reviewed build whatever its age", () => {
    expect(routeQuotedSend(zphAdapter, reviewedQuote, send, 1_000 + 3_600_000).kind).toBe("relay");
  });

  it("refuses — never builds and broadcasts — a send without a matching review", () => {
    for (const quote of [undefined, { type: "click" }, { ...reviewedQuote, amount: "2" }]) {
      const route = routeQuotedSend(zphAdapter, quote, send, 2_000);
      expect(route.kind).toBe("refuse");
      expect(route.kind === "refuse" && route.message).toMatch(/Nothing was sent/);
    }
    expect(routeQuotedSend(xmrAdapter, undefined, { to: XMR_TO, amount: "1" }, 2_000).kind).toBe("refuse");
  });

  it("other quoting adapters keep the 90 s rule and the fresh build", () => {
    const other = { sendQuoted: async () => ({ hash: "x" }) } as Pick<ChainAdapter, "sendQuoted" | "quoteBuildsSpend">;
    expect(routeQuotedSend(other, reviewedQuote, send, 1_000 + 89_999).kind).toBe("relay");
    expect(routeQuotedSend(other, reviewedQuote, send, 1_000 + 90_000).kind).toBe("build");
    expect(routeQuotedSend({}, reviewedQuote, send, 1_000).kind).toBe("build");
  });
});

describe("the Send modal's first paint for a reviewed send", () => {
  // react-dom/server: effects do not run, so this is the modal before the
  // estimate arrives and before any input reaches the pricing controller.
  const render = (adapter: ChainAdapter) =>
    renderToStaticMarkup(
      createElement(SendModal, {
        adapter,
        sendTo: XMR_TO,
        setSendTo: () => {},
        sendAmount: "1.5",
        setSendAmount: () => {},
        sending: false,
        onSend: () => {},
        onClose: () => {},
      }),
    );

  for (const adapter of [xmrAdapter, zphAdapter]) {
    it(`${adapter.ticker}: Review, not Send, and no fee number it was not given`, () => {
      const html = render(adapter);
      expect(html).toContain('data-send-step="review"');
      expect(html).toContain("► Review");
      expect(html).not.toContain("► Send");
      expect(html).toContain('data-fee-estimate="reading"');
      expect(html).not.toMatch(/data-fee-total/);
    });
  }
});

describe("useSendQuote's mode", () => {
  it("is on-request exactly where the quote builds the spend", () => {
    expect(quoteModeFor(xmrAdapter)).toBe("on-request");
    expect(quoteModeFor(zphAdapter)).toBe("on-request");
    expect(quoteModeFor({})).toBe("auto");
  });

  it("is what the hook hands its controller (pinned by source: the hook cannot run here)", () => {
    const src = readFileSync(join(__dirname, "useSendQuote.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(src).toMatch(/createQuoteController\(\{[\s\S]*?mode: quoteModeFor\(adapter\)/);
  });

  it("the Send modal fetches the estimate for a reviewed adapter and builds only on its button", () => {
    const src = readFileSync(join(__dirname, "SendModal.tsx"), "utf8").replace(/\r\n/g, "\n");
    expect(src).toMatch(/const fetchesEstimate = !quoteDriven \|\| reviewed;/);
    expect(src).toMatch(/adapter\.getFeeEstimate\(assetType\)/);
    // The only call that can build: Review's press.
    expect(src.match(/priced\.request\(\)/g)).toHaveLength(1);
  });
});
