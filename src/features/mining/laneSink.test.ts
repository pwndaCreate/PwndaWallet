/**
 * The hashrate poll's commit gate (RAM plan Phase 2M.3). See laneSink.ts.
 *
 * What matters, each pinned: with the Mine view on screen nothing changes; off
 * screen the SAME samples arrive with the SAME timestamps (the buffer-
 * contiguity requirement from hashrate-history.md) but in few commits; focus
 * delivers the backlog at once; and a stopped lane leaves nothing behind.
 */
import { describe, it, expect } from "vitest";
import { appendCapped, createLaneSink, type HashrateSample } from "./laneSink";

function fakeClock() {
  let t = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  let id = 0;
  return {
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

function harness(live: { value: boolean }, flushMs = 15_000) {
  const clock = fakeClock();
  const commits: Array<{ batch: HashrateSample[]; session: string }> = [];
  const sink = createLaneSink<string>({
    isLive: () => live.value,
    apply: (batch, session) => commits.push({ batch, session }),
    flushMs,
    clock,
  });
  return { clock, commits, sink };
}

const s = (t: number, value = 100): HashrateSample => ({ t, value });

describe("createLaneSink - Mine view on screen", () => {
  it("commits every push at once, one sample per commit (behaviour unchanged)", () => {
    const { commits, sink, clock } = harness({ value: true });
    sink.push(s(1), "a");
    sink.push(s(2), "b");
    sink.push(s(3), "c");
    expect(commits.map((c) => c.batch.length)).toEqual([1, 1, 1]);
    expect(commits.map((c) => c.session)).toEqual(["a", "b", "c"]);
    expect(clock.pending()).toBe(0);
  });
});

describe("createLaneSink - Mine view off screen", () => {
  it("parks samples and commits them as ONE batch, in order, with real timestamps", () => {
    const { commits, sink, clock } = harness({ value: false });
    for (let i = 0; i < 7; i++) sink.push(s(1000 + i * 2000, 50 + i), `s${i}`);
    expect(commits).toHaveLength(0);
    expect(clock.pending()).toBe(1); // one timer, not seven
    clock.advance(15_000);
    expect(commits).toHaveLength(1);
    expect(commits[0].batch.map((x) => x.t)).toEqual([
      1000, 3000, 5000, 7000, 9000, 11000, 13000,
    ]);
    expect(commits[0].batch.map((x) => x.value)).toEqual([50, 51, 52, 53, 54, 55, 56]);
    // Only the NEWEST session is committed - the display shows the latest.
    expect(commits[0].session).toBe("s6");
  });

  it("cuts commits by an order of magnitude over a minute of 2 s polls", () => {
    const { commits, sink, clock } = harness({ value: false });
    for (let i = 0; i < 30; i++) {
      sink.push(s(i * 2000), "x");
      clock.advance(2000);
    }
    // 30 polls in 60 s; a 15 s window means ~4 commits, not 30.
    expect(commits.length).toBeGreaterThanOrEqual(3);
    expect(commits.length).toBeLessThanOrEqual(5);
    // ...and not one sample was lost or reordered.
    const all = commits.flatMap((c) => c.batch.map((x) => x.t));
    const trailing = 30 - all.length; // samples still parked at the end
    expect(all).toEqual([...Array(all.length).keys()].map((i) => i * 2000));
    expect(trailing).toBeGreaterThanOrEqual(0);
    expect(trailing).toBeLessThan(8);
  });

  it("flush() delivers the backlog immediately - what focusing the Mine tab does", () => {
    const { commits, sink, clock } = harness({ value: false });
    sink.push(s(1), "a");
    sink.push(s(2), "b");
    sink.flush();
    expect(commits).toHaveLength(1);
    expect(commits[0].batch.map((x) => x.t)).toEqual([1, 2]);
    expect(clock.pending()).toBe(0); // the timer was cancelled, not left to double-fire
    clock.advance(60_000);
    expect(commits).toHaveLength(1);
  });

  it("flush() with nothing parked is a quiet no-op", () => {
    const { commits, sink } = harness({ value: false });
    sink.flush();
    expect(commits).toHaveLength(0);
  });

  it("when the view gains focus, the next push carries the whole backlog with it", () => {
    const live = { value: false };
    const { commits, sink } = harness(live);
    sink.push(s(1), "a");
    sink.push(s(2), "b");
    live.value = true;
    sink.push(s(3), "c");
    expect(commits).toHaveLength(1);
    expect(commits[0].batch.map((x) => x.t)).toEqual([1, 2, 3]);
    expect(commits[0].session).toBe("c");
  });

  it("dispose() drops parked samples and cancels the timer - a stopped lane leaves nothing", () => {
    const { commits, sink, clock } = harness({ value: false });
    sink.push(s(1), "a");
    sink.dispose();
    expect(clock.pending()).toBe(0);
    clock.advance(60_000);
    expect(commits).toHaveLength(0);
    sink.flush();
    expect(commits).toHaveLength(0);
  });
});

describe("createLaneSink - stop then restart", () => {
  it("a lane restarted after dispose() never inherits the dead session's samples", () => {
    const live = { value: false };
    const { commits, sink } = harness(live);
    sink.push(s(1), "old-a");
    sink.push(s(2), "old-b");
    sink.dispose(); // the user stopped mining
    live.value = true;
    sink.push(s(100), "new"); // ...and started again
    expect(commits).toHaveLength(1);
    expect(commits[0].batch.map((x) => x.t)).toEqual([100]);
    expect(commits[0].session).toBe("new");
  });
});

describe("appendCapped", () => {
  it("appends a batch and keeps only the newest `max`", () => {
    const prev = [s(1), s(2), s(3)];
    expect(appendCapped(prev, [s(4), s(5)], 4).map((x) => x.t)).toEqual([2, 3, 4, 5]);
  });

  it("does not copy-truncate when under the cap and does not mutate its inputs", () => {
    const prev = [s(1)];
    const out = appendCapped(prev, [s(2)], 10);
    expect(out.map((x) => x.t)).toEqual([1, 2]);
    expect(prev).toHaveLength(1);
  });
});
