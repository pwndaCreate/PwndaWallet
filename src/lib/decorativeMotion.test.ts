/**
 * Pins `decorativeMotion` — the 2026-09-29 fix for animations that kept a
 * CPU-composited WebView2 busy while nobody was using the window (the header's
 * status-dot pulse alone: ~60% of a core on the operator's display).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOLD_SWEEP_MS,
  MOTION_IDLE_AFTER_MS,
  holdAmbientAnimationsWhileIdle,
  watchDecorativeMotion,
  type AnimationHost,
  type MotionEnv,
} from "./decorativeMotion";

type Listener = (e: Event) => void;
function target() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    addEventListener: (t: string, l: Listener) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(l);
    },
    removeEventListener: (t: string, l: Listener) => {
      listeners.get(t)?.delete(l);
    },
    fire: (t: string) => {
      for (const l of listeners.get(t) ?? []) l(new Event(t));
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function fakePage(opts: { focused?: boolean; visible?: boolean } = {}) {
  const doc = Object.assign(target(), {
    visibilityState: (opts.visible ?? true ? "visible" : "hidden") as DocumentVisibilityState,
    focused: opts.focused ?? true,
    hasFocus() {
      return this.focused;
    },
  });
  const win = target();
  let timeouts = 0;
  const env: MotionEnv = {
    doc,
    win: {
      addEventListener: win.addEventListener,
      removeEventListener: win.removeEventListener,
      setTimeout: (h, ms) => {
        timeouts++;
        return setTimeout(h, ms) as unknown as number;
      },
      clearTimeout: (id) => clearTimeout(id),
    },
    now: () => Date.now(),
  };
  return { doc, win, env, timeouts: () => timeouts };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("watchDecorativeMotion", () => {
  it("is active while the page is visible, focused and recently used", () => {
    const { env } = fakePage();
    const seen: boolean[] = [];
    watchDecorativeMotion((a) => seen.push(a), MOTION_IDLE_AFTER_MS, env);
    expect(seen).toEqual([true]);
  });

  it("stops on blur and on hide, and starts again when the window comes back", () => {
    const { doc, win, env } = fakePage();
    const seen: boolean[] = [];
    watchDecorativeMotion((a) => seen.push(a), MOTION_IDLE_AFTER_MS, env);
    doc.focused = false;
    win.fire("blur");
    doc.focused = true;
    win.fire("focus");
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    expect(seen).toEqual([true, false, true, false, true]);
  });

  it("starts inactive in a window that does not have focus", () => {
    const { env } = fakePage({ focused: false });
    const seen: boolean[] = [];
    watchDecorativeMotion((a) => seen.push(a), MOTION_IDLE_AFTER_MS, env);
    expect(seen).toEqual([false]);
  });

  it("goes idle a minute after the last input, and input wakes it", () => {
    const { win, env } = fakePage();
    const seen: boolean[] = [];
    watchDecorativeMotion((a) => seen.push(a), MOTION_IDLE_AFTER_MS, env);
    vi.advanceTimersByTime(MOTION_IDLE_AFTER_MS + 100);
    expect(seen).toEqual([true, false]);
    win.fire("pointermove");
    expect(seen).toEqual([true, false, true]);
  });

  it("measures idleness from the LAST input, not from when the timer was armed", () => {
    const { win, env } = fakePage();
    const seen: boolean[] = [];
    watchDecorativeMotion((a) => seen.push(a), MOTION_IDLE_AFTER_MS, env);
    vi.advanceTimersByTime(MOTION_IDLE_AFTER_MS - 1_000);
    win.fire("keydown"); // input just before the armed timer fires
    vi.advanceTimersByTime(2_000); // the armed timer fires here and must NOT go idle
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(MOTION_IDLE_AFTER_MS);
    expect(seen).toEqual([true, false]);
  });

  it("a moving pointer does not churn timers", () => {
    const { win, env, timeouts } = fakePage();
    watchDecorativeMotion(() => {}, MOTION_IDLE_AFTER_MS, env);
    const before = timeouts();
    for (let i = 0; i < 500; i++) win.fire("pointermove");
    expect(timeouts()).toBe(before);
  });

  it("unsubscribing removes every listener and the timer", () => {
    const { doc, win, env } = fakePage();
    const seen: boolean[] = [];
    const stop = watchDecorativeMotion((a) => seen.push(a), MOTION_IDLE_AFTER_MS, env);
    stop();
    expect(doc.count() + win.count()).toBe(0);
    vi.advanceTimersByTime(MOTION_IDLE_AFTER_MS * 2);
    expect(seen).toEqual([true]);
  });
});

function fakeAnimation(iterations: number, playState: AnimationPlayState = "running") {
  const a = {
    playState,
    effect: { getTiming: () => ({ iterations }) } as unknown as AnimationEffect,
    pause: vi.fn(() => {
      a.playState = "paused";
    }),
    play: vi.fn(() => {
      a.playState = "running";
    }),
  };
  return a;
}

describe("holdAmbientAnimationsWhileIdle", () => {
  function setup() {
    const list = [fakeAnimation(Infinity), fakeAnimation(1), fakeAnimation(Infinity, "paused")];
    const host: AnimationHost = { getAnimations: () => list };
    let emit: (active: boolean) => void = () => {};
    const watch = (cb: (active: boolean) => void) => {
      emit = cb;
      return () => {};
    };
    const timers = { setInterval: (h: () => void, ms: number) => setInterval(h, ms) as unknown as number, clearInterval: (id: number | undefined) => clearInterval(id) };
    const uninstall = holdAmbientAnimationsWhileIdle(host, watch, timers);
    return { list, emit: (a: boolean) => emit(a), uninstall };
  }

  it("pauses only running, infinite animations while idle", () => {
    const { list, emit } = setup();
    emit(false);
    expect(list[0].pause).toHaveBeenCalledTimes(1); // infinite + running
    expect(list[1].pause).not.toHaveBeenCalled(); // finite: a fade-in must finish
    expect(list[2].pause).not.toHaveBeenCalled(); // already paused by someone else
  });

  it("resumes exactly the ones it paused", () => {
    const { list, emit } = setup();
    emit(false);
    emit(true);
    expect(list[0].play).toHaveBeenCalledTimes(1);
    expect(list[2].play).not.toHaveBeenCalled(); // it did not pause this one
  });

  it("catches an infinite animation that starts while idle", () => {
    const { list, emit } = setup();
    emit(false);
    const late = fakeAnimation(Infinity);
    list.push(late);
    vi.advanceTimersByTime(HOLD_SWEEP_MS + 10);
    expect(late.pause).toHaveBeenCalledTimes(1);
  });

  it("stops sweeping once someone is back, and uninstall resumes what it held", () => {
    const { list, emit, uninstall } = setup();
    emit(false);
    emit(true);
    const late = fakeAnimation(Infinity);
    list.push(late);
    vi.advanceTimersByTime(HOLD_SWEEP_MS * 3);
    expect(late.pause).not.toHaveBeenCalled();
    emit(false);
    uninstall();
    expect(list[0].playState).toBe("running");
    expect(late.playState).toBe("running");
  });
});

describe("wiring", () => {
  it("both products install the hold in every build (not only DEV)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const entry of [path.join(here, "..", "main.tsx"), path.join(here, "..", "..", "src-lite", "main.tsx")]) {
      const src = readFileSync(entry, "utf8");
      const call = src.indexOf("holdAmbientAnimationsWhileIdle();");
      expect(call, entry).toBeGreaterThan(-1);
      // Not inside the DEV-only guard block above it.
      const devBlock = src.lastIndexOf("if (import.meta.env.DEV", call);
      const devBlockEnd = devBlock >= 0 ? src.indexOf("}", devBlock) : -1;
      expect(devBlock < 0 || devBlockEnd < call, `${entry}: called outside the DEV block`).toBe(true);
    }
  });
});
