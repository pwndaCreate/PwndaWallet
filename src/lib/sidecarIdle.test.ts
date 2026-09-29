/**
 * RAM plan 3.1 (2026-09-25): idle-stop + periodic wake for the chain sidecars.
 * The operator's spec, rule by rule: synced + 15 min unused -> sleep; use ->
 * wake; every 60 min -> wake, sync, let the balance be read, sleep again; the
 * swap node's hold always wins.
 */
import { describe, expect, it } from "vitest";
import {
  IDLE_AFTER_MS,
  PERIODIC_SETTLE_MS,
  PERIODIC_WAKE_MS,
  decideIdle,
  holdsBalance,
  initialIdleState,
  type IdleChainState,
  type IdleInputs,
} from "./sidecarIdle";

const MIN = 60_000;
const idle: IdleInputs = { synced: true, inUse: false, swapHold: false };

/** Run the scheduler every 30 s from `t0` to `t1`, applying every action. */
function run(st: IdleChainState, t0: number, t1: number, inp: (t: number) => IdleInputs) {
  const actions: { t: number; action: string }[] = [];
  for (let t = t0; t <= t1; t += 30_000) {
    const r = decideIdle(t, st, inp(t));
    st = r.next;
    if (r.action) actions.push({ t, action: r.action });
  }
  return { st, actions };
}

describe("decideIdle - sleeping", () => {
  it("a synced chain nobody uses sleeps once the idle window has passed, not before", () => {
    const st = initialIdleState(0);
    expect(decideIdle(IDLE_AFTER_MS - 1, st, idle).action).toBeNull();
    const r = decideIdle(IDLE_AFTER_MS, st, idle);
    expect(r.action).toBe("sleep");
    expect(r.next.dormantSince).toBe(IDLE_AFTER_MS);
  });

  it("never sleeps a chain that is still syncing, however long it has been", () => {
    expect(decideIdle(10 * IDLE_AFTER_MS, initialIdleState(0), { ...idle, synced: false }).action).toBeNull();
  });

  it("use resets the idle clock", () => {
    const { actions } = run(initialIdleState(0), 0, 30 * MIN, (t) => ({ ...idle, inUse: t <= 10 * MIN }));
    expect(actions).toEqual([{ t: 25 * MIN, action: "sleep" }]);
  });

  it("never sleeps a chain the swap node may be holding", () => {
    expect(decideIdle(10 * IDLE_AFTER_MS, initialIdleState(0), { ...idle, swapHold: true }).action).toBeNull();
  });
});

describe("decideIdle - waking", () => {
  const asleep: IdleChainState = { lastUsedAt: 0, dormantSince: IDLE_AFTER_MS, wake: null, syncedAt: null };

  it("use wakes a sleeping chain at once", () => {
    const r = decideIdle(IDLE_AFTER_MS + 1, asleep, { ...idle, synced: false, inUse: true });
    expect(r.action).toBe("wake");
    expect(r.next.wake?.reason).toBe("use");
    expect(r.next.dormantSince).toBeNull();
  });

  it("the swap node starting wakes it - Zano's engine needs the wallet running", () => {
    const r = decideIdle(IDLE_AFTER_MS + 1, asleep, { ...idle, synced: false, swapHold: true });
    expect(r.action).toBe("wake");
    expect(r.next.wake?.reason).toBe("swap");
  });

  it("wakes on its own after the periodic interval, and not before", () => {
    const t = IDLE_AFTER_MS + PERIODIC_WAKE_MS;
    expect(decideIdle(t - 1, asleep, { ...idle, synced: false }).action).toBeNull();
    const r = decideIdle(t, asleep, { ...idle, synced: false });
    expect(r.action).toBe("wake");
    expect(r.next.wake?.reason).toBe("periodic");
  });
});

describe("decideIdle - the periodic cycle", () => {
  it("sleeps again soon after the periodic wake has synced, not after another 15 min", () => {
    const slept = IDLE_AFTER_MS;
    const woke = slept + PERIODIC_WAKE_MS;
    const syncedAt = woke + 3 * MIN;
    const start: IdleChainState = { lastUsedAt: 0, dormantSince: slept, wake: null, syncedAt: null };
    const { actions } = run(start, slept, syncedAt + 5 * MIN, (t) => ({ ...idle, synced: t >= syncedAt }));
    expect(actions).toEqual([
      { t: woke, action: "wake" },
      { t: syncedAt + PERIODIC_SETTLE_MS, action: "sleep" },
    ]);
  });

  it("a periodic wake that never syncs stays awake - it is not put back to sleep blind", () => {
    const start: IdleChainState = { lastUsedAt: 0, dormantSince: 0, wake: null, syncedAt: null };
    const { actions } = run(start, 0, 3 * PERIODIC_WAKE_MS, () => ({ ...idle, synced: false }));
    expect(actions).toEqual([{ t: PERIODIC_WAKE_MS, action: "wake" }]);
  });

  it("use during a periodic wake turns it into an ordinary awake chain (15 min rule)", () => {
    const woke = PERIODIC_WAKE_MS;
    const start: IdleChainState = { lastUsedAt: 0, dormantSince: 0, wake: null, syncedAt: null };
    const useAt = woke + 30_000;
    const { actions } = run(start, 0, woke + 30 * MIN, (t) => ({ ...idle, inUse: t === useAt }));
    expect(actions).toEqual([
      { t: woke, action: "wake" },
      { t: useAt + IDLE_AFTER_MS, action: "sleep" },
    ]);
  });
});

describe("holdsBalance", () => {
  it("holds a sleeping chain's last value", () => {
    expect(holdsBalance({ lastUsedAt: 0, dormantSince: 1, wake: null, syncedAt: null }, false)).toBe(true);
  });
  it("holds through a periodic wake until it has synced, then lets the sweep read it", () => {
    const st: IdleChainState = { lastUsedAt: 0, dormantSince: null, wake: { reason: "periodic", at: 10 }, syncedAt: null };
    expect(holdsBalance(st, false)).toBe(true);
    expect(holdsBalance(st, true)).toBe(false);
  });
  it("never holds an awake chain the user woke - it shows live state as before", () => {
    const st: IdleChainState = { lastUsedAt: 10, dormantSince: null, wake: { reason: "use", at: 10 }, syncedAt: null };
    expect(holdsBalance(st, false)).toBe(false);
    expect(holdsBalance(undefined, false)).toBe(false);
  });
});
