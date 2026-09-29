/**
 * The swap poll's two gates (RAM plan Phase 2.2). See pollGate.ts for why the
 * WebSocket doorbell needed them. The behaviours that matter, each pinned:
 * a frame burst must not fan out into overlapping polls, the first frame must
 * still poll immediately, and nothing may fire after cleanup.
 */
import { describe, it, expect } from "vitest";
import { singleFlight, throttleLeadingTrailing } from "./pollGate";

/** A promise the test resolves by hand, to hold a run "in flight". */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("singleFlight", () => {
  it("never runs two at once, however many calls arrive mid-run", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const gates: Array<ReturnType<typeof deferred>> = [];
    const gated = singleFlight(async () => {
      runs++;
      active++;
      maxActive = Math.max(maxActive, active);
      const g = deferred();
      gates.push(g);
      await g.promise;
      active--;
    });

    const first = gated();
    for (let i = 0; i < 50; i++) void gated(); // a 50-frame burst mid-run
    expect(runs).toBe(1);

    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The burst collapsed to exactly ONE trailing run, not fifty.
    expect(runs).toBe(2);
    gates[1].resolve();
    await first;
    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("does not re-run when nothing arrived during the run", async () => {
    let runs = 0;
    const once = singleFlight(async () => {
      runs++;
    });
    await once();
    expect(runs).toBe(1);
  });

  it("is reusable after a run finishes, and after a run throws", async () => {
    let runs = 0;
    let fail = true;
    const g = singleFlight(async () => {
      runs++;
      if (fail) throw new Error("boom");
    });
    await expect(g()).rejects.toThrow("boom");
    fail = false;
    await g(); // the guard must have been released by the failure
    expect(runs).toBe(2);
  });

  it("hands a mid-run caller the in-flight promise, not a fresh one", async () => {
    const gate = deferred();
    const g = singleFlight(async () => {
      await gate.promise;
    });
    const a = g();
    const b = g();
    expect(b).toBe(a);
    gate.resolve();
    await a;
  });
});

describe("throttleLeadingTrailing", () => {
  function fakeClock() {
    let t = 1_000;
    const timers = new Map<number, { at: number; cb: () => void }>();
    let id = 0;
    return {
      now: () => t,
      setTimer: (cb: () => void, ms: number) => {
        timers.set(++id, { at: t + ms, cb });
        return id;
      },
      clearTimer: (h: unknown) => void timers.delete(h as number),
      advance(ms: number) {
        t += ms;
        for (const [k, v] of [...timers]) {
          if (v.at <= t) {
            timers.delete(k);
            v.cb();
          }
        }
      },
      pending: () => timers.size,
    };
  }

  it("runs the first call immediately", () => {
    const clock = fakeClock();
    let n = 0;
    const th = throttleLeadingTrailing(() => n++, 2000, clock);
    th();
    expect(n).toBe(1);
  });

  it("collapses a burst inside the window into one trailing call", () => {
    const clock = fakeClock();
    let n = 0;
    const th = throttleLeadingTrailing(() => n++, 2000, clock);
    th(); // leading
    for (let i = 0; i < 100; i++) th(); // frame flood
    expect(n).toBe(1);
    expect(clock.pending()).toBe(1); // one timer, not a hundred
    clock.advance(1999);
    expect(n).toBe(1);
    clock.advance(1);
    expect(n).toBe(2); // exactly one trailing run
    expect(clock.pending()).toBe(0);
  });

  it("allows a fresh leading call once the window has passed", () => {
    const clock = fakeClock();
    let n = 0;
    const th = throttleLeadingTrailing(() => n++, 2000, clock);
    th();
    clock.advance(5000);
    th();
    expect(n).toBe(2);
    expect(clock.pending()).toBe(0);
  });

  it("cancel drops the pending trailing call", () => {
    const clock = fakeClock();
    let n = 0;
    const th = throttleLeadingTrailing(() => n++, 2000, clock);
    th();
    th(); // schedules the trailing call
    th.cancel();
    clock.advance(10_000);
    expect(n).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("the trailing run restarts the window, so a sustained flood stays at one per window", () => {
    const clock = fakeClock();
    let n = 0;
    const th = throttleLeadingTrailing(() => n++, 2000, clock);
    // 20 s of a frame every 100 ms = 200 frames.
    for (let i = 0; i < 200; i++) {
      th();
      clock.advance(100);
    }
    // ~1 per 2 s window over 20 s: ten-ish, nowhere near 200.
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(11);
  });
});
