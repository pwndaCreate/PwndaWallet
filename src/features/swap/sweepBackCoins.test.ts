import { describe, expect, it } from "vitest";
import type { ChainType } from "../../wallets/types";
import type { SidecarBalanceRow } from "../swap-sidecar";
import { SweepBackPanel, type SweepStage } from "./SweepBackSection";
import {
  SWEEPABLE_COIN_CHAINS,
  SWEEP_INTRO_NOTE,
  SWEEP_IN_FLIGHT_NOTE,
  sweepableCoins,
  type SweepCandidate,
} from "./sweepBackCoins";

/**
 * Sweep-back mount.
 *
 * No jsdom in this project (`vitest.config.ts` runs `environment: "node"`), so
 * the security assertion is made by calling the **pure** panel and walking the
 * React element tree it returns. That is not a source-text grep: elements are
 * `{type, props}` objects, and `createElement` does not invoke child
 * components, so `SweepBackConfirmCard` appears as a node carrying exactly the
 * props this mount hands it — which is the seam that matters.
 *
 * The property under test is contract §R13: **nothing in the renderer supplies
 * a destination.** The confirm card owns the one legitimate input (the
 * 6-character phrase); this mount must add none of its own in that stage.
 */

type Node = { type: unknown; props: Record<string, unknown> };

function walk(node: unknown, out: Node[] = []): Node[] {
  if (node == null || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, out);
    return out;
  }
  if (typeof node !== "object") return out;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!("type" in el)) return out;
  out.push({ type: el.type, props: el.props ?? {} });
  walk((el.props ?? {}).children, out);
  return out;
}

function textOf(node: unknown): string {
  const bits: string[] = [];
  const visit = (n: unknown) => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      bits.push(String(n));
      return;
    }
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n === "object" && "props" in (n as object)) {
      visit(((n as { props?: Record<string, unknown> }).props ?? {}).children);
    }
  };
  visit(node);
  return bits.join(" ");
}

/** Every editable field the tree would render. */
function editables(node: unknown): Node[] {
  return walk(node).filter(
    (n) =>
      n.type === "input" ||
      n.type === "textarea" ||
      n.props.contentEditable === true ||
      n.props.contentEditable === "true",
  );
}

function row(over: Partial<SidecarBalanceRow> = {}): SidecarBalanceRow {
  return {
    ticker: "LTC",
    balance: "3.20000000",
    pending: "0.0",
    depositAddress: "ltc1qexample",
    locked: false,
    error: null,
    blocks: 900000,
    syncedPercent: 100,
    knownBlockCount: 900000,
    bootstrapping: false,
    connectionType: "rpc",
    expectedSeed: true,
    ...over,
  };
}

const rowsOf = (...rs: SidecarBalanceRow[]): Record<string, SidecarBalanceRow> =>
  Object.fromEntries(rs.map((r) => [r.ticker, r]));

const ALL_WALLETS = () => true;

const PLAN = {
  token: "a".repeat(64),
  coin: "ltc",
  destination: "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh",
  amount: "3.20000000",
  sweepall: false,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
};

const candidate: SweepCandidate = {
  ticker: "LTC",
  coin: "ltc",
  balance: "3.20000000",
  chain: "litecoin",
};

function panel(over: Partial<Parameters<typeof SweepBackPanel>[0]> = {}) {
  return SweepBackPanel({
    visible: true,
    stage: "list" as SweepStage,
    candidates: [candidate],
    plan: null,
    busy: false,
    error: null,
    txid: null,
    password: "",
    onPassword: () => {},
    onPick: () => {},
    onUnlock: () => {},
    onConfirm: () => {},
    onCancel: () => {},
    onDismiss: () => {},
    ...over,
  });
}

describe("R13 — the renderer never supplies a destination", () => {
  it("renders NO editable field of its own on the confirm stage", () => {
    // The confirm card's own phrase input is inside the card and is not
    // reached by this walk — `createElement` does not invoke it. So the
    // expected count here is exactly zero: any input this mount adds is one it
    // invented, and the only thing it could plausibly hold is an address.
    const fields = editables(panel({ stage: "plan", plan: PLAN }));
    expect(fields).toHaveLength(0);
  });

  it("passes the plan to the confirm card and nothing address-shaped back", () => {
    const nodes = walk(panel({ stage: "plan", plan: PLAN }));
    const card = nodes.find(
      (n) => typeof n.type === "function" && n.type.name === "SweepBackConfirmCard",
    );
    expect(card, "the confirm card must be mounted on the plan stage").toBeTruthy();
    const keys = Object.keys(card!.props).sort();
    expect(keys).toEqual(["error", "onCancel", "onConfirm", "plan"]);
    // Named explicitly so adding one is a deliberate act with a red test.
    for (const banned of ["destination", "address", "toAddress", "to", "onDestination"]) {
      expect(Object.prototype.hasOwnProperty.call(card!.props, banned)).toBe(false);
    }
  });

  it("has exactly one field on the unlock stage, and it is a password", () => {
    const fields = editables(panel({ stage: "password" }));
    expect(fields).toHaveLength(1);
    expect(fields[0].props.type).toBe("password");
  });

  it("never renders an editable holding the destination on any stage", () => {
    for (const stage of ["list", "password", "plan", "done"] as SweepStage[]) {
      const fields = editables(panel({ stage, plan: PLAN, txid: "deadbeef" }));
      for (const f of fields) {
        expect(String(f.props.value ?? "")).not.toContain(PLAN.destination);
        expect(String(f.props.defaultValue ?? "")).not.toContain(PLAN.destination);
      }
    }
  });
});

describe("which coins are offered", () => {
  it("offers nothing until the opt-in flag reads true", () => {
    const rows = rowsOf(row());
    expect(sweepableCoins({ optedIn: null, rows, hasWallet: ALL_WALLETS })).toEqual([]);
    expect(sweepableCoins({ optedIn: false, rows, hasWallet: ALL_WALLETS })).toEqual([]);
    expect(
      sweepableCoins({ optedIn: true, rows, hasWallet: ALL_WALLETS }).map((c) => c.ticker),
    ).toEqual(["LTC"]);
  });

  it("never offers PART — the vault holds no Particl account to sweep to", () => {
    // The swap node ALWAYS holds PART (it is the engine's own chain), so this
    // is not a hypothetical row: without the filter, every user with a running
    // node is shown a button whose only possible outcome is a refusal.
    const out = sweepableCoins({
      optedIn: true,
      rows: rowsOf(row({ ticker: "PART", balance: "12.4" })),
      hasWallet: ALL_WALLETS,
    });
    expect(out).toEqual([]);
    expect(Object.keys(SWEEPABLE_COIN_CHAINS)).not.toContain("PART");
  });

  it("never offers ZEPH — Rust derives no sweep destination for it", () => {
    const out = sweepableCoins({
      optedIn: true,
      rows: rowsOf(row({ ticker: "ZEPH", balance: "14.0" })),
      hasWallet: ALL_WALLETS,
    });
    expect(out).toEqual([]);
  });

  it("skips a zero or absent balance", () => {
    for (const balance of ["0", "0.00000000", "0.0", null]) {
      const out = sweepableCoins({
        optedIn: true,
        rows: rowsOf(row({ balance })),
        hasWallet: ALL_WALLETS,
      });
      expect(out, `balance ${String(balance)} should not be offered`).toEqual([]);
    }
  });

  it("skips a coin whose destination chain has no wallet loaded", () => {
    // XMR's destination comes from the Monero wallet-rpc. With no Monero
    // wallet, `prepare` refuses — so the button would be a guaranteed failure.
    const rows = rowsOf(row({ ticker: "XMR", balance: "0.85" }));
    const hasWallet = (c: ChainType) => c !== "monero";
    expect(sweepableCoins({ optedIn: true, rows, hasWallet })).toEqual([]);
    expect(
      sweepableCoins({ optedIn: true, rows, hasWallet: ALL_WALLETS }).map((c) => c.coin),
    ).toEqual(["xmr"]);
  });

  it("passes the lowercase ticker as the coin argument", () => {
    // `pinned_destination(seed, "btc")` — contract §R13's own vector.
    const out = sweepableCoins({
      optedIn: true,
      rows: rowsOf(row({ ticker: "BTC", balance: "0.1" })),
      hasWallet: ALL_WALLETS,
    });
    expect(out[0].coin).toBe("btc");
  });
});

describe("a coin that IS the user's wallet is never offered (2026-09-05)", () => {
  it("drops shared tickers and keeps the node-owned ones", () => {
    const rows = rowsOf(
      row({ ticker: "BCH", balance: "0.63891881" }),
      row({ ticker: "BTC", balance: "0.00013469" }),
      row({ ticker: "LTC", balance: "4.05726856" }),
      row({ ticker: "XMR", balance: "0.046180440795" }),
      row({ ticker: "DOGE", balance: "12.5" }),
    );
    // The operator's node on 2026-09-05: four shared coins and one that is
    // not. The old list offered all four shared ones as "sweep back" — each a
    // fee-paying transfer from the user's wallet to the user's wallet.
    const shared = new Set(["BCH", "BTC", "LTC", "XMR"]);
    const offered = sweepableCoins({
      optedIn: true,
      rows,
      hasWallet: ALL_WALLETS,
      sharedTickers: shared,
    }).map((c) => c.ticker);
    expect(offered).toEqual(["DOGE"]);
  });

  it("without the set, behaves as before (every funded wallet coin)", () => {
    const rows = rowsOf(row({ ticker: "BCH", balance: "1" }), row({ ticker: "LTC", balance: "1" }));
    expect(
      sweepableCoins({ optedIn: true, rows, hasWallet: ALL_WALLETS }).map((c) => c.ticker),
    ).toEqual(["BCH", "LTC"]);
  });
});

describe("copy", () => {
  it("says on the list stage that the destination is not typed in", () => {
    const text = textOf(panel({ stage: "list" }));
    expect(text).toContain(SWEEP_INTRO_NOTE);
    expect(SWEEP_INTRO_NOTE).toMatch(/not\s+typed in/i);
  });

  it("does not promise safety it has not earned about in-flight swaps", () => {
    // Engine-lock / user-withdraw interleaving is on the contract's
    // funded-drive list (§4.3 item 12). The copy must say "not verified", not
    // "the node protects it".
    expect(SWEEP_IN_FLIGHT_NOTE).toMatch(/not been verified/i);
    expect(SWEEP_IN_FLIGHT_NOTE).not.toMatch(/safe|protected|stay put/i);
    expect(textOf(panel({ stage: "list" }))).toContain(SWEEP_IN_FLIGHT_NOTE);
  });

  it("renders nothing at all when the sidecar is off", () => {
    expect(panel({ visible: false })).toBeNull();
  });

  it("renders nothing when there is no sweepable coin", () => {
    expect(panel({ stage: "list", candidates: [] })).toBeNull();
  });
});
