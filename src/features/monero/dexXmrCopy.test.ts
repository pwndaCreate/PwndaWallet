import { describe, expect, it } from "vitest";
import type { SidecarBalanceRow } from "../swap-sidecar";
import { DexXmrWalletPanel } from "./DexXmrWalletSection";
import {
  DEX_XMR_DISTINCT_NOTE,
  DEX_XMR_HOST_WALLET_OFFER,
  DEX_XMR_HOST_WALLET_RECORDED,
  DEX_XMR_SEND_CAVEAT,
  dexXmrVisible,
  walletInfoFromRow,
  xmrHostWalletCopy,
} from "./dexXmrCopy";

/**
 * DEX Monero wallet mount.
 *
 * Element-tree assertions, not source greps: `vitest` runs with
 * `environment: "node"` and no jsdom, so the pure panel is called directly and
 * the returned `{type, props}` tree is walked. `DexXmrWalletCard` appears as a
 * node carrying the props this mount passes it, which is the seam under test.
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

function row(over: Partial<SidecarBalanceRow> = {}): SidecarBalanceRow {
  return {
    ticker: "XMR",
    balance: "0.850000000000",
    pending: "0.000000000000",
    depositAddress: "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQ",
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

const panel = (over: Partial<Parameters<typeof DexXmrWalletPanel>[0]> = {}) =>
  DexXmrWalletPanel({
    visible: true,
    info: walletInfoFromRow(row()),
    error: null,
    onRotate: () => {},
    ...over,
  });

describe("the DEX wallet is a distinct entry, gated on opt-in", () => {
  it("is invisible until the opt-in flag reads true", () => {
    expect(dexXmrVisible(null, row())).toBe(false);
    expect(dexXmrVisible(undefined, row())).toBe(false);
    expect(dexXmrVisible(false, row())).toBe(false);
    expect(dexXmrVisible(true, row())).toBe(true);
  });

  it("is invisible when the node reported no XMR wallet", () => {
    // `useSidecarBalances` clears its rows on SIDECAR_NOT_RUNNING, so an
    // absent row is also how "the node is stopped" arrives here.
    expect(dexXmrVisible(true, null)).toBe(false);
    expect(dexXmrVisible(true, undefined)).toBe(false);
  });

  it("emits no elements at all when not visible", () => {
    const tree = panel({ visible: false });
    expect(tree).toBeNull();
    expect(walk(tree)).toHaveLength(0);
  });

  it("mounts the card and labels it as a separate wallet", () => {
    const tree = panel();
    const names = walk(tree).map((n) =>
      typeof n.type === "function" ? n.type.name : n.type,
    );
    expect(names).toContain("DexXmrWalletCard");
    expect(textOf(tree).toLowerCase()).toContain("separate wallet");
  });
});

describe("the mandatory caveats", () => {
  it("says it can only SEND while the swap node is running", () => {
    expect(DEX_XMR_SEND_CAVEAT).toMatch(/only send/i);
    expect(DEX_XMR_SEND_CAVEAT).toMatch(/running/i);
    // The asymmetry is the point — deposits are not node-dependent.
    expect(DEX_XMR_SEND_CAVEAT).toMatch(/deposits still arrive/i);
    expect(textOf(panel())).toContain(DEX_XMR_SEND_CAVEAT);
  });

  it("says it is not the vault's Monero wallet", () => {
    expect(DEX_XMR_DISTINCT_NOTE).toMatch(/not the one in your vault/i);
    expect(DEX_XMR_DISTINCT_NOTE).toMatch(/not part of your\s+wallet's XMR total/i);
    expect(textOf(panel())).toContain(DEX_XMR_DISTINCT_NOTE);
  });
});

describe("no invented numbers", () => {
  it("passes reservedXmr as null — no endpoint reports it", () => {
    const card = walk(panel()).find(
      (n) => typeof n.type === "function" && n.type.name === "DexXmrWalletCard",
    );
    expect(card).toBeTruthy();
    expect(card!.props.reservedXmr).toBeNull();
  });
});

describe("C9 consent control", () => {
  const cardIn = (tree: unknown) =>
    walk(tree).find(
      (n) => typeof n.type === "function" && n.type.name === "DexXmrWalletCard",
    );

  it("is entirely absent when the mount has not wired a setter", () => {
    // Mirrors onRotate's own omit-to-hide contract: an offered-then-dead
    // toggle is worse than an absent one.
    const card = cardIn(panel());
    expect(card!.props.onSetHostWalletAck).toBeUndefined();
    expect(card!.props.hostWalletLine).toBeUndefined();
  });

  it("threads ack, the setter, and busy through to the card untouched", () => {
    const onSet = () => {};
    const card = cardIn(
      panel({ hostWalletAck: true, onSetHostWalletAck: onSet, hostWalletBusy: true }),
    );
    expect(card!.props.hostWalletAck).toBe(true);
    expect(card!.props.onSetHostWalletAck).toBe(onSet);
    expect(card!.props.hostWalletBusy).toBe(true);
  });

  it("computes hostWalletLine from ack via xmrHostWalletCopy — never a raw boolean", () => {
    // The card cannot compute this copy itself (BOUNDARIES.md: swap-sidecar
    // may not import monero), so the panel must hand it a finished string,
    // and that string must be the SAME one xmrHostWalletCopy would produce —
    // not a re-derived duplicate that could drift from it.
    const notAcked = cardIn(panel({ onSetHostWalletAck: () => {}, hostWalletAck: false }));
    expect(notAcked!.props.hostWalletLine).toBe(xmrHostWalletCopy(false));

    const acked = cardIn(panel({ onSetHostWalletAck: () => {}, hostWalletAck: true }));
    expect(acked!.props.hostWalletLine).toBe(xmrHostWalletCopy(true));
  });

  it("hostWalletLine is present only when the setter is present, even if ack is true", () => {
    // ack=true with no setter would be a read-only mount; the LINE would then
    // be dead copy with no control beside it. Absence of the setter must hide
    // the whole block, line included.
    const card = cardIn(panel({ hostWalletAck: true }));
    expect(card!.props.onSetHostWalletAck).toBeUndefined();
    expect(card!.props.hostWalletLine).toBeUndefined();
  });
});

describe("walletInfoFromRow", () => {
  it("keeps the engine's snake_case deposit_address", () => {
    // camelCasing an engine-JSON field (contract §0.1) would leave the card
    // reading `info.deposit_address` as undefined and printing "not available
    // yet" forever, with no error anywhere.
    const info = walletInfoFromRow(row())!;
    expect(info.deposit_address).toBe(row().depositAddress);
    expect(Object.keys(info)).toContain("deposit_address");
    expect(Object.keys(info)).not.toContain("depositAddress");
  });

  it("keeps amounts as strings", () => {
    const info = walletInfoFromRow(row())!;
    expect(typeof info.balance).toBe("string");
    expect(info.balance).toBe("0.850000000000");
  });

  it("does not resurrect a placeholder address that was normalized to null", () => {
    // §R18: upstream returns human-readable placeholders in the address field
    // and the balances layer maps them to null. A copy button must never be
    // offered an unpayable string.
    const info = walletInfoFromRow(row({ depositAddress: null }))!;
    expect(info.deposit_address).toBeUndefined();
  });

  it("lets a rotated address win, so the rotate button changes the screen", () => {
    // The card renders `displayAddress(null, info)` and never sees the hook's
    // own `rotated` value; without this the button would succeed silently and
    // look dead.
    const info = walletInfoFromRow(row(), "88rotatedSubaddressXXXXXXXXXXXXXXXX")!;
    expect(info.deposit_address).toBe("88rotatedSubaddressXXXXXXXXXXXXXXXX");
  });

  it("returns null for an absent row", () => {
    expect(walletInfoFromRow(null)).toBeNull();
    expect(walletInfoFromRow(undefined)).toBeNull();
  });
});

describe("xmrHostWalletCopy — C9's honesty constraint", () => {
  it("switches on the ack flag, not on any other state", () => {
    expect(xmrHostWalletCopy(false)).toBe(DEX_XMR_HOST_WALLET_OFFER);
    expect(xmrHostWalletCopy(true)).toBe(DEX_XMR_HOST_WALLET_RECORDED);
  });

  it("neither string claims the wallet is ALREADY shared, right now", () => {
    // Updated 2026-08-21: the orchestration push (maybe_activate_xmr_host_wallet)
    // IS now wired into swap_sidecar_start, before the config write — the same
    // "next start" pattern C8's lean-coin copy already used, and now honest
    // for the same reason C8's was: the push runs on every start. What the
    // copy must still not claim is PRESENT-TENSE activation — the node might
    // not even be running right now, so "will use" is the honest tense,
    // "is using" is not.
    for (const s of [DEX_XMR_HOST_WALLET_OFFER, DEX_XMR_HOST_WALLET_RECORDED]) {
      expect(s).not.toMatch(/is using your/i);
      expect(s).not.toMatch(/now uses/i);
    }
  });

  it("both strings correctly promise activation on the next start", () => {
    // The mirror image of the check above: this is what makes the promise
    // TRUE rather than merely non-false — a copy that said nothing at all
    // about timing would dodge the honesty question rather than answer it.
    for (const s of [DEX_XMR_HOST_WALLET_OFFER, DEX_XMR_HOST_WALLET_RECORDED]) {
      expect(s).toMatch(/next (swap-node )?start|next starts/i);
    }
  });

  it("the recorded state is honest about what has NOT changed yet", () => {
    expect(DEX_XMR_HOST_WALLET_RECORDED).toMatch(/keeps its own separate wallet/i);
  });

  it("the offer state states the concrete benefit, not just a preference toggle", () => {
    expect(DEX_XMR_HOST_WALLET_OFFER).toMatch(/no deposit/i);
  });
});
