/**
 * The swap details modal, the hash field, the backdrop rule and the history
 * change feed (2026-09-30, the operator's report on a live LTC -> USDC-POL
 * swap):
 *
 *   "I can't click on the source tx in the swap screen but it looks like I can
 *    click it as a hyperlink, also why is it truncated?"
 *   "When I try to move the app the swap screen unfocuses and disappears. Can
 *    you make it so I can click on the recent swaps and have the swap screen
 *    re-appear, so I can read what is happening?"
 *   "I want to be able to click on current and past swaps and see the data on
 *    them."
 *
 * This repo has no DOM test harness. Components are rendered with
 * react-dom/server (effects do not run there, so a render shows the state the
 * modal OPENS in), the backdrop's handlers are driven directly (it has no
 * hooks, on purpose), and the poll loop is driven with injected fakes. Which
 * views mount the modal is pinned in `landscapeRouterParity.test.ts`.
 *
 * Fixtures are synthetic. The operator's real hash and deposit address stay
 * out of the source tree, which is published.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ── I/O boundaries ──────────────────────────────────────────────────────
const openExternalMock = vi.fn(async (_url: string) => undefined);
vi.mock("../../utils/openExternal", () => ({
  openExternal: (url: string) => openExternalMock(url),
}));

// In-memory stand-in for tauri-plugin-store (the same one
// swap-history-store.test.ts uses).
const mem = new Map<string, unknown>();
let failNextSave = false;
vi.mock("../../store", () => ({
  getStore: async () => ({
    get: async (k: string) => mem.get(k),
    set: async (k: string, v: unknown) => {
      mem.set(k, v);
    },
    save: async () => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("simulated store failure");
      }
    },
  }),
}));

// The shared mapping, wrapped so a test can see it is the one being used.
vi.mock("./swap-execute", async (importOriginal) => {
  const real = await importOriginal<typeof import("./swap-execute")>();
  return { ...real, intentsStatusToHistory: vi.fn(real.intentsStatusToHistory) };
});

import { intentsStatusToHistory } from "./swap-execute";
import {
  appendSwapHistory,
  loadSwapHistory,
  onSwapHistoryChange,
  updateSwapHistoryEntry,
  type SwapHistoryEntry,
} from "./swap-history-store";
import {
  Backdrop,
  BACKDROP_DRAG_SLOP_PX,
  BACKDROP_TITLEBAR_STRIP_PX,
} from "./modal-parts";
import { ExplorerButton, TxHashField, openExplorer } from "./TxHashField";
import { SwapDetailsModal, swapRowOpenProps } from "./SwapDetailsModal";
import {
  DoneFooter,
  ExecutingFooter,
  swapModalBackdropCloses,
} from "./SwapConfirmModal";
import {
  historyPatchFromIntentsStatus,
  readIntentsLiveDetails,
  swapStatusView,
  watchIntentsSwap,
  type WatchIntentsDeps,
} from "./swap-details";
import { resumePendingIntentsSwaps } from "./intents-status-resume";
import { SWAP_COIN_META } from "./swap-data";
import type { IntentsStatusResponse } from "../../lib/proxy-types";

// ── Fixtures ────────────────────────────────────────────────────────────
const SOURCE_HASH = "7d2a9f3c1b8e4d6a0f5c2e9b7a1d3f8c6e4b2a0d9f7c5e3a1b8d6f4c2a0e9b7d";
const DEST_HASH = "0x4e1f7a2c9d3b8e6f0a5c1d7e3b9f2a8c6d4e0b7f3a9c5e1d8b2f6a4c0e7d9b3a";
const DEPOSIT_ADDRESS = "LSyntheticDepositAddressFor1Click9";
const LTC_EXPLORER = SWAP_COIN_META.LTC.explorerTxUrl(SOURCE_HASH);

/** The shape of the operator's row: an LTC -> USDC-POL NEAR Intents swap,
 *  pending, deposit broadcast, address and deadline recorded. */
function intentsRow(over: Partial<SwapHistoryEntry> = {}): SwapHistoryEntry {
  return {
    id: "swap-ltc-usdc",
    fromAsset: "LTC",
    toAsset: "USDC-POL",
    fromAmount: "0.5",
    toAmount: "41.2",
    status: "pending",
    sourceTxHash: SOURCE_HASH,
    sourceExplorerUrl: LTC_EXPLORER,
    provider: "NEAR Intents · solver-relay",
    createdAt: "2026-09-30T08:00:00.000Z",
    depositAddress: DEPOSIT_ADDRESS,
    depositDeadline: "2026-09-30T09:00:00.000Z",
    ...over,
  };
}

const render = (entry: SwapHistoryEntry | null) =>
  renderToStaticMarkup(createElement(SwapDetailsModal, { entry, onClose: () => {} }));

/** `truncate()` from modal-parts: 8 characters, an ellipsis, the last 6. */
const truncated = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

/**
 * The value as TEXT on screen. A bare `toContain(hash)` cannot fail for the
 * reason it is there: the old footer passed it, because the full hash was
 * inside the anchor's href while the text read `7d2a9f3c…0e9b7d`. Attributes
 * (href, data-explorer-url, title) must never satisfy "the user can read it".
 */
const shownAsText = (html: string, value: string) => html.includes(`>${value}<`);

const status = (s: string, extra: Record<string, unknown> = {}) =>
  ({ status: s, ...extra }) as unknown as IntentsStatusResponse;

beforeEach(() => {
  mem.clear();
  failNextSave = false;
  openExternalMock.mockClear();
  vi.mocked(intentsStatusToHistory).mockClear();
});

// ─────────────────────────────────────────────────────────────────────────
// Item 3: the hash is whole and its explorer button works
// ─────────────────────────────────────────────────────────────────────────

describe("hash display: whole, copyable, and the explorer opens (2026-09-30 operator report)", () => {
  it("the details modal prints the full source hash, never the truncated form", () => {
    expect(SOURCE_HASH).toHaveLength(64);
    const html = render(intentsRow());
    expect(shownAsText(html, SOURCE_HASH)).toBe(true);
    expect(html).not.toContain(truncated(SOURCE_HASH));
  });

  it("control: shownAsText is not satisfied by a hash that only sits in an attribute", () => {
    const oldFooter = `<a href="${LTC_EXPLORER}" target="_blank">${truncated(SOURCE_HASH)}</a>`;
    expect(oldFooter).toContain(SOURCE_HASH); // why a bare toContain was not enough
    expect(shownAsText(oldFooter, SOURCE_HASH)).toBe(false);
  });

  it("the details modal's explorer button carries the row's own explorer URL, and no anchor does", () => {
    const html = render(intentsRow());
    expect(html).toContain(`data-explorer-url="${LTC_EXPLORER}"`);
    // An <a target="_blank"> inside a modal never opened (see TxHashField.tsx).
    expect(html).not.toMatch(/<a\s/);
  });

  it("the explorer button calls openExternal with exactly its URL", async () => {
    const el = ExplorerButton({ url: LTC_EXPLORER });
    (el.props as { onClick: () => void }).onClick();
    await Promise.resolve();
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    expect(openExternalMock).toHaveBeenCalledWith(LTC_EXPLORER);
  });

  it("never hands a non-http(s) URL to the OS opener", async () => {
    await openExplorer("javascript:alert(1)");
    await openExplorer("file:///C:/Windows");
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it("a hash field without an explorer URL still shows the whole value, with Copy only", () => {
    const html = renderToStaticMarkup(
      createElement(TxHashField, { label: "deposit address", value: DEPOSIT_ADDRESS }),
    );
    expect(shownAsText(html, DEPOSIT_ADDRESS)).toBe(true);
    expect(html).toContain(">copy<");
    expect(html).not.toContain("data-explorer-url");
  });

  it("the confirm modal's executing footer shows the whole hash with a working explorer button", () => {
    // This is the screen in the report: pending, "source tx: 7d2a9f3c…0e9b7d".
    const html = renderToStaticMarkup(
      createElement(ExecutingFooter, {
        exec: { phase: "pending", sourceTxHash: SOURCE_HASH },
        sourceExplorer: LTC_EXPLORER,
      }),
    );
    expect(shownAsText(html, SOURCE_HASH)).toBe(true);
    expect(html).not.toContain(truncated(SOURCE_HASH));
    expect(html).toContain(`data-explorer-url="${LTC_EXPLORER}"`);
    expect(html).not.toMatch(/<a\s/);
    // ...and says that closing it does not stop the swap.
    expect(html).toContain("Closing this window does not stop the swap");
  });

  it("the confirm modal's done footer shows both hashes whole, each with an explorer button", () => {
    const destUrl = SWAP_COIN_META["USDC-POL"].explorerTxUrl(DEST_HASH);
    const html = renderToStaticMarkup(
      createElement(DoneFooter, {
        exec: { phase: "done", sourceTxHash: SOURCE_HASH, destTxHash: DEST_HASH, trackStatus: "completed" },
        sourceExplorer: LTC_EXPLORER,
        destExplorer: destUrl,
        onClose: () => {},
      }),
    );
    expect(shownAsText(html, SOURCE_HASH)).toBe(true);
    expect(shownAsText(html, DEST_HASH)).toBe(true);
    expect(html).toContain(`data-explorer-url="${LTC_EXPLORER}"`);
    expect(html).toContain(`data-explorer-url="${destUrl}"`);
    expect(html).not.toMatch(/<a\s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 4: the backdrop rule
// ─────────────────────────────────────────────────────────────────────────

describe("the swap modal backdrop: moving the window never closes it (2026-09-30 operator report)", () => {
  /** A backdrop element and whatever sits on it, as event targets. */
  const backdropNode = { name: "backdrop" };
  const headerNode = { name: "modal header" };
  const press = (target: object, x = 100, y = 20) => ({
    target,
    currentTarget: backdropNode,
    button: 0,
    clientX: x,
    clientY: y,
  });

  function drive(onClick: () => void) {
    const el = Backdrop({ children: null, onClick });
    const props = el.props as {
      onMouseDown?: (e: unknown) => void;
      onClick: (e: unknown) => void;
    };
    return {
      down: (e: ReturnType<typeof press>) => props.onMouseDown?.(e),
      click: (e: ReturnType<typeof press>) => props.onClick(e),
    };
  }

  it("a press on the modal header released over the backdrop does not close", () => {
    const close = vi.fn();
    const b = drive(close);
    b.down(press(headerNode));
    // A click whose press and release differ is dispatched to the common
    // ancestor: the backdrop itself is the target.
    b.click(press(backdropNode));
    expect(close).not.toHaveBeenCalled();
  });

  it("a real click on the backdrop closes", () => {
    const close = vi.fn();
    const b = drive(close);
    b.down(press(backdropNode));
    b.click(press(backdropNode));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a press on the backdrop that is dragged before release does not close", () => {
    const close = vi.fn();
    const b = drive(close);
    b.down(press(backdropNode, 100, 20));
    b.click(press(backdropNode, 100 + BACKDROP_DRAG_SLOP_PX + 40, 20));
    expect(close).not.toHaveBeenCalled();
  });

  it("a click with no press recorded (a press that began outside the modal) does not close", () => {
    const close = vi.fn();
    drive(close).click(press(backdropNode));
    expect(close).not.toHaveBeenCalled();
  });

  it("one press closes at most once", () => {
    const close = vi.fn();
    const b = drive(close);
    b.down(press(backdropNode));
    b.click(press(backdropNode));
    b.click(press(backdropNode));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("carries a title-bar drag strip, so pressing where the title bar shows through moves the window", () => {
    const html = renderToStaticMarkup(createElement(Backdrop, { children: null }));
    expect(html).toMatch(/data-tauri-drag-region="true"/);
    expect(html).toContain(`height:${BACKDROP_TITLEBAR_STRIP_PX}px`);
    // Taller than both title bars: portrait 34 px, landscape 36 px.
    expect(BACKDROP_TITLEBAR_STRIP_PX).toBeGreaterThanOrEqual(36);
  });

  it("the confirm modal's backdrop closes it only before anything is signed", () => {
    expect(swapModalBackdropCloses("review")).toBe(true);
    expect(swapModalBackdropCloses("password")).toBe(true);
    for (const stage of ["executing", "done", "unknown", "used", "error", "mockStop"]) {
      expect(swapModalBackdropCloses(stage), stage).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 1: the details modal's content
// ─────────────────────────────────────────────────────────────────────────

describe("the details modal shows what the wallet knows (2026-09-30 operator report)", () => {
  it("the operator's row: deposit address, deadline, provider, amounts, and a live lookup under way", () => {
    const html = render(intentsRow());
    expect(shownAsText(html, DEPOSIT_ADDRESS)).toBe(true);
    expect(html).toContain("deposit deadline");
    expect(html).toContain("NEAR Intents · solver-relay");
    expect(html).toContain("0.5");
    expect(html).toContain("~41.2");
    expect(html).toContain('data-swap-status="pending"');
    expect(html).toContain("Asking NEAR Intents");
    expect(html).not.toContain("Live status not available");
  });

  it("renders nothing when closed", () => {
    expect(render(null)).toBe("");
  });

  it("a row without a deposit address says live status is not available for its route", () => {
    const html = render(
      intentsRow({
        id: "sk-1",
        provider: "SwapKit · THORChain",
        depositAddress: undefined,
        depositDeadline: undefined,
      }),
    );
    expect(html).toContain("Live status not available for this route.");
    expect(shownAsText(html, SOURCE_HASH)).toBe(true);
  });

  it("an unknown outcome with no hash says it may have been sent, and what to check", () => {
    const html = render(
      intentsRow({ sourceTxHash: "", sourceExplorerUrl: "", outcomeUnknown: true }),
    );
    expect(html).toContain('data-swap-status="may-have-been-sent"');
    expect(html).toContain("No transaction id came back");
  });

  it("shows a deposit memo when the row has one, and nothing when it does not", () => {
    const withMemo = { ...intentsRow(), depositMemo: "4213377" } as SwapHistoryEntry;
    expect(shownAsText(render(withMemo), "4213377")).toBe(true);
    expect(render(intentsRow())).not.toContain("deposit memo");
  });

  it("a completed row shows the delivered amount and the destination hash", () => {
    const destUrl = SWAP_COIN_META["USDC-POL"].explorerTxUrl(DEST_HASH);
    const html = render(
      intentsRow({
        status: "success",
        completedAt: "2026-09-30T08:20:00.000Z",
        actualReceived: "41150000", // atomic, USDC has 6 decimals
        destTxHash: DEST_HASH,
        destExplorerUrl: destUrl,
      }),
    );
    expect(html).toContain('data-swap-status="completed"');
    expect(html).toContain("41.15");
    expect(shownAsText(html, DEST_HASH)).toBe(true);
    expect(html).toContain(`data-explorer-url="${destUrl}"`);
  });

  it("a refunded NEAR Intents row says where the refund went", () => {
    const html = render(intentsRow({ status: "refunded", completedAt: "2026-09-30T09:05:00.000Z" }));
    expect(html).toContain('data-swap-status="refunded"');
    expect(html).toContain("Refunded to your LTC address");
  });
});

describe("statuses in plain words, over the shared mapping (2026-09-30 operator report)", () => {
  it("PENDING_DEPOSIT with a broadcast deposit reads 'Waiting for deposit' — the operator's case", () => {
    const v = swapStatusView(intentsRow(), "PENDING_DEPOSIT");
    expect(v.key).toBe("waiting-deposit");
    expect(v.label).toBe("Waiting for deposit");
    expect(v.detail).toMatch(/has not registered the deposit yet/);
  });

  it.each([
    ["KNOWN_DEPOSIT_TX", "deposit-seen", "Deposit seen"],
    ["PROCESSING", "processing", "Processing"],
    ["INCOMPLETE_DEPOSIT", "incomplete-deposit", "Deposit incomplete"],
    ["SUCCESS", "completed", "Completed"],
    ["REFUNDED", "refunded", "Refunded"],
    ["FAILED", "failed", "Failed"],
  ])("%s on a pending row reads %s", (live, key, label) => {
    const v = swapStatusView(intentsRow(), live);
    expect(v.key).toBe(key);
    expect(v.label).toBe(label);
  });

  it("INCOMPLETE_DEPOSIT is never 'failed' (F5), because the shared mapping says pending", () => {
    expect(intentsStatusToHistory("INCOMPLETE_DEPOSIT")).toBe("pending");
    expect(swapStatusView(intentsRow(), "INCOMPLETE_DEPOSIT").tone).toBe("warn");
  });

  it("a terminal row keeps its recorded status whatever the live answer says", () => {
    expect(swapStatusView(intentsRow({ status: "success" }), "PENDING_DEPOSIT").key).toBe("completed");
    expect(swapStatusView(intentsRow({ status: "refunded" }), "SUCCESS").key).toBe("refunded");
  });

  it("an unknown outcome stays 'may have been sent' until 1Click has seen the deposit", () => {
    const row = intentsRow({ outcomeUnknown: true });
    expect(swapStatusView(row).key).toBe("may-have-been-sent");
    expect(swapStatusView(row, "PENDING_DEPOSIT").key).toBe("may-have-been-sent");
    expect(swapStatusView(row, "PROCESSING").key).toBe("processing");
  });

  it("a desk row's 'refunded' makes no claim that money is on its way (CC-5 lossy projection)", () => {
    const v = swapStatusView(
      intentsRow({ provider: "Pwnda Desk - atomic", depositAddress: undefined, status: "refunded" }),
    );
    expect(v.detail).toBe("Recorded as refunded.");
  });

  it("maps terminal statuses through intentsStatusToHistory, not a copy of it", () => {
    swapStatusView(intentsRow(), "SUCCESS");
    expect(intentsStatusToHistory).toHaveBeenCalledWith("SUCCESS");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 1: live polling and write-back
// ─────────────────────────────────────────────────────────────────────────

/** A scheduler the test advances by hand. */
function manualClock() {
  let queued: Array<() => void> = [];
  let now = Date.parse("2026-09-30T08:10:00.000Z");
  return {
    deps: {
      now: () => now,
      schedule: (fn: () => void) => {
        queued.push(fn);
        return () => {
          queued = queued.filter((f) => f !== fn);
        };
      },
    } satisfies Pick<WatchIntentsDeps, "now" | "schedule">,
    pending: () => queued.length,
    /** Run the next scheduled tick and let its promises settle. */
    async step(ms = 12_000) {
      now += ms;
      const fn = queued.shift();
      fn?.();
      await flush();
    },
  };
}
/** Let every pending promise settle (the fakes never touch a real timer). */
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe("watchIntentsSwap: polls while open, maps through the shared mapping, writes back (2026-09-30)", () => {
  it("follows PENDING_DEPOSIT -> PROCESSING -> SUCCESS, then writes the terminal patch and stops", async () => {
    const row = intentsRow();
    await appendSwapHistory(row);
    const answers = [
      status("PENDING_DEPOSIT"),
      status("PROCESSING"),
      // `swap` is the container the reused `extractActualReceivedFromIntents`
      // reads the delivered amount from.
      status("SUCCESS", {
        swap: {
          amountOut: "41150000",
          amountOutFormatted: "41.15",
          destinationChainTxHashes: [{ hash: DEST_HASH, explorerUrl: "https://evil.example/tx" }],
        },
      }),
    ];
    const getStatus = vi.fn(async () => answers.shift()!);
    const clock = manualClock();
    const seen: string[] = [];
    const patched = vi.fn();

    watchIntentsSwap({
      row,
      onLive: (d) => seen.push(d.status ?? "?"),
      onPatched: patched,
      toExplorer: (h) => SWAP_COIN_META["USDC-POL"].explorerTxUrl(h),
      deps: {
        ...clock.deps,
        getStatus,
        update: updateSwapHistoryEntry,
        loadRow: async (id) => (await loadSwapHistory()).find((r) => r.id === id),
      },
    });
    await flush();
    await clock.step();
    await clock.step();

    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(getStatus).toHaveBeenCalledWith(DEPOSIT_ADDRESS);
    expect(seen).toEqual(["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"]);
    // The shared mapping decided it.
    expect(intentsStatusToHistory).toHaveBeenCalledWith("SUCCESS");

    const stored = (await loadSwapHistory()).find((r) => r.id === row.id)!;
    expect(stored.status).toBe("success");
    expect(stored.outcomeUnknown).toBe(false);
    expect(stored.completedAt).toBeDefined();
    expect(stored.actualReceived).toBe("41150000");
    expect(stored.destTxHash).toBe(DEST_HASH);
    // The wallet's own explorer, never the URL the response carried.
    expect(stored.destExplorerUrl).toBe(SWAP_COIN_META["USDC-POL"].explorerTxUrl(DEST_HASH));
    expect(patched).toHaveBeenCalledTimes(1);
    // Terminal: nothing more is scheduled.
    expect(clock.pending()).toBe(0);
  });

  it("INCOMPLETE_DEPOSIT keeps polling and writes nothing (pending, F5)", async () => {
    const row = intentsRow();
    await appendSwapHistory(row);
    const update = vi.fn(async () => undefined);
    const clock = manualClock();
    watchIntentsSwap({
      row,
      onLive: () => {},
      deps: {
        ...clock.deps,
        getStatus: async () => status("INCOMPLETE_DEPOSIT"),
        update,
        loadRow: async () => row,
      },
    });
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(1);
  });

  it("stop() ends it: an answer that arrives after close is not reported or written", async () => {
    const row = intentsRow();
    let answer!: (r: IntentsStatusResponse) => void;
    const onLive = vi.fn();
    const update = vi.fn(async () => undefined);
    const clock = manualClock();
    const stop = watchIntentsSwap({
      row,
      onLive,
      deps: {
        ...clock.deps,
        getStatus: () => new Promise((res) => (answer = res)),
        update,
        loadRow: async () => row,
      },
    });
    stop();
    answer(status("SUCCESS"));
    await flush();
    expect(onLive).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it("an unreachable relay is reported and retried, and the row stays pending", async () => {
    const row = intentsRow();
    const onError = vi.fn();
    const update = vi.fn(async () => undefined);
    const clock = manualClock();
    watchIntentsSwap({
      row,
      onLive: () => {},
      onError,
      deps: {
        ...clock.deps,
        getStatus: async () => {
          throw new Error("relay 503");
        },
        update,
        loadRow: async () => row,
      },
    });
    await flush();
    expect(onError).toHaveBeenCalledWith("relay 503");
    expect(update).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(1);
  });

  it("a row another poller already finished is not overwritten: it re-reads the stored row first", async () => {
    const opened = intentsRow();
    const stored = intentsRow({ status: "refunded", completedAt: "2026-09-30T09:01:00.000Z" });
    const update = vi.fn(async () => undefined);
    const clock = manualClock();
    watchIntentsSwap({
      row: opened,
      onLive: () => {},
      deps: {
        ...clock.deps,
        getStatus: async () => status("REFUNDED"),
        update,
        loadRow: async () => stored,
      },
    });
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it("a terminal row is asked once, for display, and never polled again", async () => {
    const row = intentsRow({ status: "success", completedAt: "2026-09-30T08:20:00.000Z" });
    const getStatus = vi.fn(async () =>
      status("SUCCESS", { swapDetails: { destinationChainTxHashes: [{ hash: DEST_HASH }] } }),
    );
    const update = vi.fn(async () => undefined);
    const clock = manualClock();
    watchIntentsSwap({
      row,
      onLive: () => {},
      toExplorer: () => null,
      deps: { ...clock.deps, getStatus, update, loadRow: async () => row },
    });
    await flush();
    expect(getStatus).toHaveBeenCalledTimes(1);
    // Only the payout hash it lacked; the status is left alone.
    expect(update).toHaveBeenCalledWith(row.id, { destTxHash: DEST_HASH });
    expect(clock.pending()).toBe(0);
  });

  it("writes the same terminal patch the resume pass writes", async () => {
    const row = intentsRow();
    const nowMs = Date.parse("2026-09-30T08:30:00.000Z");
    const resp = status("SUCCESS", { swap: { amountOut: "41150000" } });
    const ours = historyPatchFromIntentsStatus(row, resp, nowMs);

    let theirs: Partial<SwapHistoryEntry> | undefined;
    await resumePendingIntentsSwaps({
      load: async () => [row],
      update: async (_id, p) => {
        theirs = p;
      },
      poll: async () => resp,
      isActive: () => false,
      now: () => nowMs,
    });
    expect(ours).toEqual(theirs);
  });

  it("never records a payout hash on a refund", () => {
    const patch = historyPatchFromIntentsStatus(
      intentsRow(),
      status("REFUNDED", { swapDetails: { destinationChainTxHashes: [{ hash: DEST_HASH }] } }),
      Date.now(),
      () => "https://polygonscan.com/tx/x",
    );
    expect(patch.status).toBe("refunded");
    expect(patch.destTxHash).toBeUndefined();
  });

  it("reads the 1Click details defensively and drops unsafe hashes", () => {
    const d = readIntentsLiveDetails({
      status: "PROCESSING",
      swapDetails: {
        originChainTxHashes: [{ hash: SOURCE_HASH }, { hash: "<img src=x>" }, "not a hash with spaces"],
        amountInFormatted: "0.5",
      },
      quoteResponse: { quote: { minAmountOut: "40800000" } },
    });
    expect(d.status).toBe("PROCESSING");
    expect(d.originTxHashes).toEqual([SOURCE_HASH]);
    expect(d.amountInFormatted).toBe("0.5");
    expect(d.minAmountOutAtomic).toBe("40800000");
    expect(readIntentsLiveDetails(null).destinationTxHashes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 1: "so the list updates too"
// ─────────────────────────────────────────────────────────────────────────

describe("onSwapHistoryChange: lists hear about committed writes (2026-09-30)", () => {
  it("fires after append and update, not after a write that failed, and stops when unsubscribed", async () => {
    const heard = vi.fn();
    const off = onSwapHistoryChange(heard);
    await appendSwapHistory(intentsRow());
    expect(heard).toHaveBeenCalledTimes(1);
    await updateSwapHistoryEntry("swap-ltc-usdc", { status: "success" });
    expect(heard).toHaveBeenCalledTimes(2);

    failNextSave = true;
    await expect(updateSwapHistoryEntry("swap-ltc-usdc", { status: "failed" })).rejects.toThrow();
    expect(heard).toHaveBeenCalledTimes(2);

    off();
    await updateSwapHistoryEntry("swap-ltc-usdc", { status: "refunded" });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("a listener that throws does not fail the write", async () => {
    const off = onSwapHistoryChange(() => {
      throw new Error("listener bug");
    });
    await expect(appendSwapHistory(intentsRow())).resolves.toBeUndefined();
    off();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 2: the rows
// ─────────────────────────────────────────────────────────────────────────

describe("swap rows open the details by click, Enter or Space (2026-09-30)", () => {
  const key = (k: string, target: unknown = "row") => {
    const e = { key: k, target, currentTarget: "row", preventDefault: vi.fn() };
    return e;
  };

  it("is a focusable button", () => {
    const p = swapRowOpenProps(() => {});
    expect(p.role).toBe("button");
    expect(p.tabIndex).toBe(0);
  });

  it("click, Enter and Space open; other keys do not", () => {
    const open = vi.fn();
    const p = swapRowOpenProps(open);
    p.onClick();
    const enter = key("Enter");
    p.onKeyDown(enter);
    const space = key(" ");
    p.onKeyDown(space);
    p.onKeyDown(key("Tab"));
    p.onKeyDown(key("a"));
    expect(open).toHaveBeenCalledTimes(3);
    // Space would otherwise scroll the list.
    expect(space.preventDefault).toHaveBeenCalled();
  });

  it("keys pressed on a control inside the row are not the row's", () => {
    const open = vi.fn();
    swapRowOpenProps(open).onKeyDown(key("Enter", "a button inside"));
    expect(open).not.toHaveBeenCalled();
  });

  it("restores the row's own background when the pointer leaves", () => {
    const p = swapRowOpenProps(() => {}, "rgba(0,204,102,0.02)");
    const el = { currentTarget: { style: { background: "rgba(0,204,102,0.02)" } } };
    p.onMouseEnter(el);
    expect(el.currentTarget.style.background).not.toBe("rgba(0,204,102,0.02)");
    p.onMouseLeave(el);
    expect(el.currentTarget.style.background).toBe("rgba(0,204,102,0.02)");
  });
});
