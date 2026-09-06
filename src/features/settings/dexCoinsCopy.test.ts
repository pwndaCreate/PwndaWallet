import { describe, expect, it } from "vitest";
import type { CoinEnableStatus } from "../../api/basicswap";
import { DexCoinsPanel } from "./DexCoinsSection";
import { DexCoinCard } from "../swap-sidecar/DexCoinCard";
import {
  DEX_COINS_COST_NOTE,
  DEX_COINS_COUNTERPARTY_NOTE,
  DEX_COINS_LIGHT_PRIVACY_NOTE,
  DEX_COINS_SHARED_WALLET_NOTE,
  DEX_COINS_ZERO_MOVE_NOTE,
  dexCoinsSectionVisible,
  dexCoinsSummary,
  lightPrivacyNoteApplies,
  sharedWalletNoteApplies,
  zeroMoveNoteApplies,
} from "./dexCoinsCopy";

/**
 * DEX-coins Settings mount.
 *
 * There is no jsdom and no testing-library in this project (vitest runs with
 * `environment: "node"`), so these tests call the **pure** panel function
 * directly and walk the React element tree it returns. React elements are
 * plain objects — `{type, props}` — so a tree walk is a real assertion about
 * what would be rendered, not a source-text grep. Child components are NOT
 * invoked by `createElement`, so `DexCoinCard` shows up in the tree as a node
 * carrying the props this mount passes it, which is exactly the seam under
 * test.
 */

type Node = { type: unknown; props: Record<string, unknown> };

/** Every element in the tree, depth first. */
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

/**
 * All text this tree would render, INCLUDING inside child function components.
 *
 * The first version walked `props.children` only. `createElement` does not
 * invoke a function component, so everything inside `CoinRow` — the per-coin
 * copy, which is most of what this card says — was invisible, and an assertion
 * for row text passed or failed on the card's intro paragraph instead. A test
 * that cannot see the thing it asserts about is the register's first rule.
 *
 * Function components are therefore called. Guarded: a component that needs
 * hooks or context throws, and a throw must skip that subtree rather than fail
 * the walk — the point is to read text, not to render faithfully.
 */
function textOf(node: unknown): string {
  const bits: string[] = [];
  const visit = (n: unknown, depth = 0) => {
    if (n == null || typeof n === "boolean" || depth > 40) return;
    if (typeof n === "string" || typeof n === "number") {
      bits.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach((c) => visit(c, depth + 1));
      return;
    }
    if (typeof n !== "object") return;
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    const props = el.props ?? {};
    if (typeof el.type === "function") {
      try {
        visit((el.type as (p: unknown) => unknown)(props), depth + 1);
      } catch {
        /* needs hooks/context — its own children are still walked below */
      }
    }
    visit(props.children, depth + 1);
  };
  visit(node);
  return bits.join(" ");
}

function status(over: Partial<CoinEnableStatus> = {}): CoinEnableStatus {
  return {
    coin: "litecoin",
    ticker: "LTC",
    enabled: true,
    binaryPresent: true,
    configured: true,
    adoption: "deposit",
    descriptorsImported: false,
    mode: "full",
    configuredMode: "full",
    canRunLean: false,
    canShareWallet: false,
    sharesWallet: false,
    xmrHostWalletActive: false,
    estDiskGb: 6,
    ...over,
  };
}

const PANEL = {
  // Expanded so the content assertions below see the cards + notes; the
  // collapsed default is covered by its own test.
  expanded: true,
  statuses: [status()],
  loading: false,
  error: null,
  busyCoin: null,
  onToggle: () => {},
  onSetMode: () => {},
  onRefresh: () => {},
};

/**
 * `textOf` deliberately does NOT invoke child components (see its note) — the
 * seam it tests is the props a mount passes down. The copy below lives inside
 * `DexCoinCard`'s own `CoinRow`, so these tests need a walk that DOES invoke
 * function components. Kept local so the shared helper's documented semantics
 * are unchanged.
 */
function deepTextOf(node: unknown): string {
  const bits: string[] = [];
  const visit = (n: unknown) => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      bits.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (typeof n !== "object") return;
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    const props = el.props ?? {};
    if (typeof el.type === "function") {
      try {
        visit((el.type as (p: unknown) => unknown)(props));
        return;
      } catch {
        /* needs hooks/context — fall through to its children */
      }
    }
    visit(props.children);
  };
  visit(node);
  return bits.join(" ");
}

describe("the DIRECT daemon read is preferred over the timing-out balance row", () => {
  it("renders the daemon chain progress even when the balance row errored", () => {
    // The exact failure the user hit: /json/wallets timed out, so the balance
    // row carries an error and no blocks — but the direct chain read has them.
    const said = textOf(
      DexCoinCard({
        statuses: [status({ coin: "particl", ticker: "PART", configured: true })],
        syncRows: {
          PART: {
            ticker: "PART", balance: null, pending: null, depositAddress: null,
            locked: false, error: "Timeout", blocks: null, syncedPercent: null,
            knownBlockCount: null, bootstrapping: false, connectionType: null,
          } as never,
        },
        chainByTicker: {
          PART: { coin: "particl", ticker: "PART", blocks: 349745,
                  headers: 2226731, verifiedPct: 13.73, error: null },
        },
        onToggle: () => {}, onSetMode: () => {},
      }),
    );
    // The balance row alone would render nothing (kind "unknown"); the chain
    // read fills it in.
    expect(said).toContain("349,745");
    expect(said).toContain("2,226,731");
  });

  it("says synced once blocks catch headers", () => {
    const said = textOf(
      DexCoinCard({
        statuses: [status({ coin: "particl", ticker: "PART", configured: true })],
        chainByTicker: {
          PART: { coin: "particl", ticker: "PART", blocks: 2226731,
                  headers: 2226731, verifiedPct: 100, error: null },
        },
        onToggle: () => {}, onSetMode: () => {},
      }),
    );
    expect(said).toMatch(/synced/);
  });
});

describe("chain-sync progress is shown where the coins are", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    ticker: "PART", balance: "0", pending: "0", depositAddress: null,
    locked: false, error: null, blocks: 327346, syncedPercent: 12.9,
    knownBlockCount: 2226690, bootstrapping: false, connectionType: "rpc",
    ...over,
  }) as never;

  it("reports height AND target for a syncing chain, not a bare percent", () => {
    // The percent alone is `verificationprogress` — a chain with NO blocks
    // reports 100%. Height is what makes it honest.
    const said = textOf(
      DexCoinCard({
        statuses: [status({ coin: "particl", ticker: "PART", configured: true })],
        syncRows: { PART: row() },
        onToggle: () => {}, onSetMode: () => {},
      }),
    );
    expect(said).toContain("327,346");
    expect(said).toContain("2,226,690");
    expect(said).toMatch(/12\.90/);
  });

  it("says nothing about chains for a light-mode coin", () => {
    const said = textOf(
      DexCoinCard({
        statuses: [status({ coin: "bitcoin", ticker: "BTC", configured: true })],
        syncRows: { BTC: row({ connectionType: "electrum" }) },
        onToggle: () => {}, onSetMode: () => {},
      }),
    );
    expect(said).not.toContain("327,346");
  });

  it("renders without sync rows at all", () => {
    const said = textOf(
      DexCoinCard({
        statuses: [status({ coin: "particl", ticker: "PART" })],
        onToggle: () => {}, onSetMode: () => {},
      }),
    );
    expect(said).toContain("PART");
  });
});

describe("an enabled-but-unconfigured coin says how to finish it", () => {
  it("tells the user a keyed restart is what adds the coin", () => {
    // The state the user was actually in: BTC enabled, binary seeded, absent
    // from basicswap.json — so absent from the BasicSwap order book too, with
    // only "not configured yet" to explain it.
    const said = deepTextOf(
      DexCoinCard({
        statuses: [
          status({
            coin: "bitcoin",
            ticker: "BTC",
            enabled: true,
            binaryPresent: true,
            configured: false,
          }),
        ],
        onToggle: () => {},
        onSetMode: () => {},
      }),
    );
    expect(said).toContain("waiting to be added");
    expect(said).toMatch(/unlocked/);
  });

  it("says nothing of the sort once the coin is configured", () => {
    const said = deepTextOf(
      DexCoinCard({
        statuses: [
          status({
            coin: "particl",
            ticker: "PART",
            enabled: true,
            binaryPresent: true,
            configured: true,
          }),
        ],
        onToggle: () => {},
        onSetMode: () => {},
      }),
    );
    expect(said).not.toContain("waiting to be added");
  });

  it("says nothing for a coin with no binary — that is a different problem", () => {
    // A missing binary can never be fixed by restarting, so offering that
    // remedy would be advice that cannot work.
    const said = deepTextOf(
      DexCoinCard({
        statuses: [
          status({
            coin: "dogecoin",
            ticker: "DOGE",
            enabled: true,
            binaryPresent: false,
            configured: false,
          }),
        ],
        onToggle: () => {},
        onSetMode: () => {},
      }),
    );
    expect(said).not.toContain("waiting to be added");
  });
});

describe("P1 — a user who does not swap sees no change at all", () => {
  it("renders nothing until the opt-in flag reads true", () => {
    // `null` is the in-flight read. Treating it as enabled would fire
    // `swap_sidecar_coin_status` on a fresh install, which is exactly what the
    // fresh-install contract forbids.
    expect(dexCoinsSectionVisible(null)).toBe(false);
    expect(dexCoinsSectionVisible(undefined)).toBe(false);
    expect(dexCoinsSectionVisible(false)).toBe(false);
    expect(dexCoinsSectionVisible(true)).toBe(true);
  });

  it("emits NO elements at all when not visible — not an empty card", () => {
    const tree = DexCoinsPanel({ ...PANEL, visible: false });
    expect(tree).toBeNull();
    expect(walk(tree)).toHaveLength(0);
  });

  it("emits the card once visible", () => {
    const tree = DexCoinsPanel({ ...PANEL, visible: true });
    const names = walk(tree).map((n) =>
      typeof n.type === "function" ? n.type.name : n.type,
    );
    expect(names).toContain("DexCoinCard");
  });

  it("is collapsed by default — summary only, no cards, no notes", () => {
    // 2026-08-22: the section was the largest block of text on Settings. The
    // default view is the one line a user needs ("6 of 7 enabled"); the
    // cards and the honesty notes are one click away, not gone.
    const tree = DexCoinsPanel({ ...PANEL, visible: true, expanded: false });
    const names = walk(tree).map((n) =>
      typeof n.type === "function" ? n.type.name : n.type,
    );
    expect(names).not.toContain("DexCoinCard");
    const text = textOf(tree);
    expect(text).toMatch(/DEX coins/);
    expect(text).not.toContain(DEX_COINS_COST_NOTE);
  });
});

describe("the honest cost is stated before the toggle", () => {
  it("names the pruned-node disk range AND the initial sync", () => {
    // Both halves, because only the disk figure is visible on the row and the
    // sync is what makes 'enabled' not mean 'usable'.
    expect(DEX_COINS_COST_NOTE).toMatch(/5–7 GB/);
    expect(DEX_COINS_COST_NOTE).toMatch(/initial sync/i);
    expect(DEX_COINS_COST_NOTE).toMatch(/pruned node/i);
  });

  it("renders that note in the visible tree", () => {
    const text = textOf(DexCoinsPanel({ ...PANEL, visible: true }));
    expect(text).toContain(DEX_COINS_COST_NOTE);
    expect(text).toContain(DEX_COINS_COUNTERPARTY_NOTE);
  });

  it("never claims pwnda is the counterparty or invents demand", () => {
    const text = textOf(DexCoinsPanel({ ...PANEL, visible: true }));
    expect(DEX_COINS_COUNTERPARTY_NOTE).toMatch(/never the\s+counterparty/i);
    // No endpoint supplies fill rates, demand, or viewer counts — so no copy
    // on this surface may imply them.
    expect(text).not.toMatch(/others viewing|fill rate|high demand|popular/i);
  });
});

describe("the zero-move sentence is conditional, because the claim is per-coin", () => {
  it("applies only when some coin reports descriptor adoption", () => {
    expect(zeroMoveNoteApplies([status({ adoption: "deposit" })])).toBe(false);
    expect(zeroMoveNoteApplies([status({ adoption: "consolidate" })])).toBe(false);
    expect(zeroMoveNoteApplies([status({ adoption: "descriptor" })])).toBe(true);
    expect(zeroMoveNoteApplies([])).toBe(false);
    expect(zeroMoveNoteApplies(null)).toBe(false);
  });

  it("says the balance becomes spendable by the node AND that encryption comes first", () => {
    expect(DEX_COINS_ZERO_MOVE_NOTE).toMatch(/existing balance/i);
    expect(DEX_COINS_ZERO_MOVE_NOTE).toMatch(/spend it/i);
    expect(DEX_COINS_ZERO_MOVE_NOTE).toMatch(/encryption/i);
  });

  it("is absent from the tree when no coin can do it, present when one can", () => {
    const without = textOf(
      DexCoinsPanel({
        ...PANEL,
        visible: true,
        statuses: [status({ adoption: "deposit" })],
      }),
    );
    expect(without).not.toContain(DEX_COINS_ZERO_MOVE_NOTE);

    const withDescriptor = textOf(
      DexCoinsPanel({
        ...PANEL,
        visible: true,
        statuses: [status({ adoption: "descriptor" })],
      }),
    );
    expect(withDescriptor).toContain(DEX_COINS_ZERO_MOVE_NOTE);
  });
});

describe("C8 — shared wallets, and the privacy they cost", () => {
  it("claims one wallet only for a coin the backend VERIFIED as shared", () => {
    // `accountkey` is written by the backend only after the engine's derived
    // deposit address matched this wallet's. A coin whose push failed that
    // check reads as `deposit`, and telling that user "same wallet" would
    // point them at funds the node cannot reach.
    expect(sharedWalletNoteApplies([status({ adoption: "accountkey" })])).toBe(true);
    for (const adoption of ["deposit", "descriptor", "consolidate"] as const) {
      expect(sharedWalletNoteApplies([status({ adoption })])).toBe(false);
    }
    expect(sharedWalletNoteApplies([])).toBe(false);
    expect(sharedWalletNoteApplies(null)).toBe(false);
  });

  it("shows the privacy note on CAPABILITY, before the choice is made", () => {
    // The opposite gate to the one above, deliberately: this note is an input
    // to a decision the user has not taken yet, so waiting for them to take it
    // would be showing the warning after the risk.
    expect(lightPrivacyNoteApplies([status({ canRunLean: true })])).toBe(true);
    expect(lightPrivacyNoteApplies([status({ canRunLean: false })])).toBe(false);
    expect(lightPrivacyNoteApplies(null)).toBe(false);
  });

  it("names what the servers see, what they cannot do, and both mitigations", () => {
    expect(DEX_COINS_LIGHT_PRIVACY_NOTE).toMatch(/electrum servers/i);
    expect(DEX_COINS_LIGHT_PRIVACY_NOTE).toMatch(/addresses, balance and history/i);
    // The limit matters as much as the exposure: a note that only alarms is
    // one a user cannot act on.
    expect(DEX_COINS_LIGHT_PRIVACY_NOTE).toMatch(/not your keys/i);
    expect(DEX_COINS_LIGHT_PRIVACY_NOTE).toMatch(/never spend/i);
    expect(DEX_COINS_LIGHT_PRIVACY_NOTE).toMatch(/tor/i);
    expect(DEX_COINS_LIGHT_PRIVACY_NOTE).toMatch(/your own electrum server/i);
  });

  it("the cost note no longer says Light abandons your existing funds", () => {
    // It said exactly that until C8, and it would now talk a user out of the
    // cheapest CORRECT configuration. Same defect class as the "each coin runs
    // its own pruned node" line this note already had to fix once.
    expect(DEX_COINS_COST_NOTE).not.toMatch(/not adopted/i);
    expect(DEX_COINS_COST_NOTE).toMatch(/use your existing wallet/i);
  });

  it("renders both notes in the tree, each under its own condition", () => {
    const shared = textOf(
      DexCoinsPanel({
        ...PANEL,
        visible: true,
        statuses: [status({ adoption: "accountkey", canRunLean: true })],
      }),
    );
    expect(shared).toContain(DEX_COINS_SHARED_WALLET_NOTE);
    expect(shared).toContain(DEX_COINS_LIGHT_PRIVACY_NOTE);

    // Capable but not sharing: the warning stays, the claim goes.
    const capable = textOf(
      DexCoinsPanel({
        ...PANEL,
        visible: true,
        statuses: [status({ adoption: "deposit", canRunLean: true })],
      }),
    );
    expect(capable).not.toContain(DEX_COINS_SHARED_WALLET_NOTE);
    expect(capable).toContain(DEX_COINS_LIGHT_PRIVACY_NOTE);

    // A coin that cannot run Light at all gets neither.
    const neither = textOf(
      DexCoinsPanel({
        ...PANEL,
        visible: true,
        statuses: [status({ adoption: "descriptor", canRunLean: false })],
      }),
    );
    expect(neither).not.toContain(DEX_COINS_SHARED_WALLET_NOTE);
    expect(neither).not.toContain(DEX_COINS_LIGHT_PRIVACY_NOTE);
  });
});

describe("the CARD's own copy, which the panel walk cannot see", () => {
  /**
   * `textOf` walks elements without invoking child function components, so
   * `DexCoinCard` appears as a node carrying props and everything it renders
   * — including its heading paragraph — is invisible to every test above.
   *
   * That blind spot shipped a contradiction: the C8 pass corrected
   * `DEX_COINS_COST_NOTE` and `MODE_COPY.lean`, both asserted here, while the
   * card's own intro went on claiming Light coins do not adopt existing funds.
   * A Playwright pass caught it in one screenshot. Invoking the card closes
   * the gap.
   */
  function cardText(statuses: CoinEnableStatus[]): string {
    const out: string[] = [];
    const visit = (node: unknown): void => {
      if (node == null || typeof node === "boolean") return;
      if (typeof node === "string" || typeof node === "number") {
        out.push(String(node));
        return;
      }
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node !== "object") return;
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      const props = el.props ?? {};
      if (typeof el.type === "function") {
        try {
          // Returning after a successful invoke is deliberate: the rendered
          // tree SUBSUMES props.children, so walking both double-counts.
          visit((el.type as (p: unknown) => unknown)(props));
          return;
        } catch {
          /* hooks-dependent child — fall through to its raw children */
        }
      }
      visit(props.children);
    };
    visit(
      DexCoinCard({
        statuses,
        onToggle: () => {},
        onSetMode: () => {},
        syncRows: {},
        chainByTicker: {},
      } as never),
    );
    return out.join(" ");
  }

  it("the heading no longer claims Light abandons existing funds", () => {
    const text = cardText([
      status({ canRunLean: true, configuredMode: "lean", adoption: "accountkey" }),
    ]);
    expect(text).not.toMatch(/not adopting funds/i);
    expect(text).toMatch(/can also run/i);
  });

  it("offers the consent control only where there is something to consent to", () => {
    const controls = (over: Partial<CoinEnableStatus>) => {
      const found: string[] = [];
      const visit = (n: unknown): void => {
        if (n == null || typeof n === "boolean") return;
        if (Array.isArray(n)) return n.forEach(visit);
        if (typeof n !== "object") return;
        const el = n as { type?: unknown; props?: Record<string, unknown> };
        const props = el.props ?? {};
        if (typeof props.children === "string") found.push(props.children);
        if (typeof el.type === "function") {
          try {
            visit((el.type as (p: unknown) => unknown)(props));
            return;
          } catch {
            /* hooks-dependent */
          }
        }
        visit(props.children);
      };
      visit(
        DexCoinCard({
          statuses: [status(over)],
          onToggle: () => {},
          onSetMode: () => {},
          onSetShareWallet: () => {},
        } as never),
      );
      return found.join(" | ");
    };

    // The gate is `canShareWallet` — the backend's own answer to "is there a
    // sharing choice on this row" — NOT the card re-deriving it from
    // canRunLean/mode. That re-derivation is exactly what kept XMR from ever
    // showing a control: monero is not electrum-capable, so a canRunLean gate
    // structurally could not offer it, and the user reasonably read that
    // absence as "XMR must be automatic".
    expect(controls({ canShareWallet: true, sharesWallet: false })).toMatch(
      /Use my wallet/,
    );
    expect(controls({ canShareWallet: true, sharesWallet: true })).toMatch(
      /Using my wallet/,
    );

    // XMR: not electrum-capable, still shareable (C9 shares the wallet-rpc
    // process instead of account keys). The regression this pins is a row
    // with no control at all.
    expect(
      controls({
        coin: "monero",
        ticker: "XMR",
        canRunLean: false,
        configuredMode: "full",
        canShareWallet: true,
        sharesWallet: true,
      }),
    ).toMatch(/Using my wallet/);

    // A coin with no sharing mechanism gets no control — a full-mode coin
    // adopts by descriptor import, which has its own gate, so offering this
    // would imply a choice that does not exist.
    expect(
      controls({ canRunLean: true, configuredMode: "full", canShareWallet: false }),
    ).not.toMatch(/my wallet/i);
    expect(
      controls({ canRunLean: false, configuredMode: "full", canShareWallet: false }),
    ).not.toMatch(/my wallet/i);
  });

  it("never tells one row to deposit and to use your own wallet at once", () => {
    // Third occurrence of this shape on this surface. A consented-but-unshared
    // coin used to print the deposit instruction (its adoption is still
    // `deposit` until the engine verifies) directly above "will use your own
    // wallet" — both true in isolation, contradictory side by side.
    for (const adoption of ["deposit", "consolidate", "descriptor"] as const) {
      const text = cardText([
        status({
          ticker: "BTC",
          canRunLean: true,
          mode: "lean",
          configuredMode: "lean",
          adoption,
          sharesWallet: true,
        }),
      ]);
      expect(text).not.toMatch(/sending to its deposit address/i);
      expect(text).toMatch(/will use your existing wallet/i);
    }

    // Un-consented, the deposit instruction is correct and must stay.
    const unconsented = cardText([
      status({
        ticker: "BTC",
        canRunLean: true,
        mode: "lean",
        configuredMode: "lean",
        adoption: "deposit",
        sharesWallet: false,
      }),
    ]);
    expect(unconsented).toMatch(/sending to its deposit address/i);
  });

  it("XMR gets the same pending-share promise as every other coin, now that it's true", () => {
    // Was the inverse of this assertion: C9's orchestration was recorded as
    // the user's choice before it was wired, so this line used to have to
    // NOT promise "next start". Fixed 2026-08-21 (orchestration landed, then
    // two compounding config bugs found on the operator's own first restart
    // were fixed the same day — see PwndaWalletVault/log.md, "C9's first
    // live restart") — the promise is genuine now, so XMR no longer needs
    // its own, more pessimistic line.
    const xmr = cardText([
      status({
        coin: "monero",
        ticker: "XMR",
        canRunLean: false,
        mode: "full",
        configuredMode: "full",
        adoption: "deposit",
        canShareWallet: true,
        sharesWallet: true,
      }),
    ]);
    expect(xmr).not.toMatch(/still runs its own Monero wallet/i);
    expect(xmr).toMatch(/once the swap node next starts/i);
  });

  it("distinguishes consented-but-not-yet-shared from shared", () => {
    // The in-between is ordinary — consent is recorded, the node has not
    // started since. Saying nothing would make the control look inert.
    const pending = cardText([
      status({
        ticker: "BTC",
        canRunLean: true,
        mode: "lean",
        configuredMode: "lean",
        adoption: "deposit",
        sharesWallet: true,
      }),
    ]);
    expect(pending).toMatch(/from the next swap-node start/i);
    // It must NOT yet claim the wallet is shared.
    expect(pending).not.toMatch(/nothing to deposit/i);
  });

  it("states sharing per row, and only for a coin that shares", () => {
    const shared = cardText([
      status({
        ticker: "BTC",
        canRunLean: true,
        mode: "lean",
        // The CONFIGURED mode is what the row renders (`effective_mode`): a
        // requested-but-unapplied Light coin still shows its full-node cost.
        configuredMode: "lean",
        adoption: "accountkey",
      }),
    ]);
    expect(shared).toMatch(/uses your own wallet/i);
    expect(shared).toMatch(/nothing to deposit/i);

    const notShared = cardText([
      status({
        ticker: "BTC",
        canRunLean: true,
        mode: "lean",
        configuredMode: "lean",
        adoption: "deposit",
      }),
    ]);
    expect(notShared).not.toMatch(/uses your own wallet/i);
    expect(notShared).toMatch(/deposit address/i);
  });
});

describe("a refused toggle is surfaced, not swallowed", () => {
  it("renders the error string the mount was handed", () => {
    const text = textOf(
      DexCoinsPanel({ ...PANEL, visible: true, error: "the node is not running" }),
    );
    expect(text).toContain("the node is not running");
  });
});

describe("dexCoinsSummary", () => {
  it("counts enabled coins, and says nothing when there is nothing to count", () => {
    expect(dexCoinsSummary([])).toBeNull();
    expect(dexCoinsSummary(null)).toBeNull();
    expect(
      dexCoinsSummary([status({ enabled: true }), status({ enabled: false })]),
    ).toBe("1 of 2 enabled");
  });
});
