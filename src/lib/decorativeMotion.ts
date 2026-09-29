/**
 * Decorative motion only while someone is using the window.
 *
 * 2026-09-29: this app's WebView2 runs with GPU compositing off
 * (`--disable-gpu-compositing`, tauri.conf.json: the Round 14 GPU-crash
 * guard), so every animation frame is composited on the CPU. Measured in the
 * Tauri sandbox: with every animation paused WebView2 idled at 0.1% renderer
 * + 0.2% GPU process; the header's 6 px status-dot pulse alone cost 2.2% +
 * 10.2%, and on the operator's display ~12% + ~51% of one core, all day, on
 * every screen. See PwndaWalletVault/log.md 2026-09-29.
 *
 * "Using" means: the page is visible, the window has focus, and there was
 * input within the last minute. Two consumers:
 * - {@link holdAmbientAnimationsWhileIdle}, installed once per app, pauses
 *   every infinite CSS animation (pulses, blinking cursors, loaders, scan
 *   lines) while nobody is using the window. Finite ones (fade-ins,
 *   transitions) are left alone, so content never waits invisible for
 *   someone to come back.
 * - {@link useDecorativeMotion}, for JS-driven effects (`DitherCanvas`).
 */
import { useEffect, useState } from "react";

/** No input for this long and the motion stops, even with the window focused. */
export const MOTION_IDLE_AFTER_MS = 60_000;

/** While idle, how often newly started infinite animations are caught and held. */
export const HOLD_SWEEP_MS = 5_000;

const INPUT_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;

type Listener = (event: Event) => void;
interface Target {
  addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: Listener, options?: EventListenerOptions): void;
}

/** What the watcher reads from the page; injectable so it can be tested without a DOM. */
export interface MotionEnv {
  doc: Target & { visibilityState: DocumentVisibilityState; hasFocus(): boolean };
  win: Target & {
    setTimeout(handler: () => void, ms: number): number;
    clearTimeout(id: number | undefined): void;
  };
  now(): number;
}

function browserEnv(): MotionEnv {
  return {
    doc: document,
    win: {
      addEventListener: (t, l, o) => window.addEventListener(t, l, o),
      removeEventListener: (t, l, o) => window.removeEventListener(t, l, o),
      setTimeout: (h, ms) => window.setTimeout(h, ms),
      clearTimeout: (id) => window.clearTimeout(id),
    },
    now: () => Date.now(),
  };
}

/**
 * Calls `onChange` with the current answer, then again whenever it flips.
 * Returns the unsubscribe function.
 *
 * Input only moves a timestamp; the idle timer is armed once and re-armed from
 * that timestamp when it fires, so a moving pointer costs no timer churn.
 */
export function watchDecorativeMotion(
  onChange: (active: boolean) => void,
  idleAfterMs: number = MOTION_IDLE_AFTER_MS,
  env: MotionEnv = browserEnv(),
): () => void {
  const { doc, win, now } = env;
  let lastInput = now();
  let active: boolean | null = null;
  let timer: number | undefined;

  const evaluate = () => {
    const next = doc.visibilityState === "visible" && doc.hasFocus() && now() - lastInput < idleAfterMs;
    if (next !== active) {
      active = next;
      onChange(next);
    }
  };
  const schedule = (ms: number) => {
    win.clearTimeout(timer);
    timer = win.setTimeout(tick, ms);
  };
  const tick = () => {
    timer = undefined;
    const left = idleAfterMs - (now() - lastInput);
    if (left > 0) schedule(left + 50);
    else evaluate();
  };
  const onInput = () => {
    lastInput = now();
    if (active === false) evaluate();
    if (timer === undefined) schedule(idleAfterMs + 50);
  };
  // Coming back to the window counts as input; leaving it stops the motion.
  const onFocusOrVisibility = () => {
    if (doc.visibilityState === "visible" && doc.hasFocus()) onInput();
    else evaluate();
  };

  const opts: AddEventListenerOptions = { passive: true, capture: true };
  for (const type of INPUT_EVENTS) win.addEventListener(type, onInput, opts);
  win.addEventListener("focus", onFocusOrVisibility);
  win.addEventListener("blur", onFocusOrVisibility);
  doc.addEventListener("visibilitychange", onFocusOrVisibility);
  evaluate();
  schedule(idleAfterMs + 50);

  return () => {
    for (const type of INPUT_EVENTS) win.removeEventListener(type, onInput, opts);
    win.removeEventListener("focus", onFocusOrVisibility);
    win.removeEventListener("blur", onFocusOrVisibility);
    doc.removeEventListener("visibilitychange", onFocusOrVisibility);
    win.clearTimeout(timer);
    timer = undefined;
  };
}

/** The slice of the Web Animations API the hold uses. */
export interface AnimationHost {
  getAnimations(): Pick<Animation, "playState" | "effect" | "pause" | "play">[];
}

/**
 * Pauses every running, infinite animation in `host` while `watch` reports
 * the window idle, re-sweeping every {@link HOLD_SWEEP_MS} to catch ones that
 * start meanwhile, and resumes exactly the ones it paused when someone comes
 * back. Returns the uninstall function (which also resumes them).
 */
export function holdAmbientAnimationsWhileIdle(
  host: AnimationHost = document,
  watch: (onChange: (active: boolean) => void) => () => void = watchDecorativeMotion,
  timers: { setInterval(h: () => void, ms: number): number; clearInterval(id: number | undefined): void } = {
    setInterval: (h, ms) => window.setInterval(h, ms),
    clearInterval: (id) => window.clearInterval(id),
  },
): () => void {
  const held = new Set<ReturnType<AnimationHost["getAnimations"]>[number]>();
  let sweep: number | undefined;
  const hold = () => {
    for (const a of host.getAnimations()) {
      if (a.playState === "running" && a.effect?.getTiming().iterations === Infinity) {
        a.pause();
        held.add(a);
      }
    }
  };
  const release = () => {
    for (const a of held) if (a.playState === "paused") a.play();
    held.clear();
  };
  const stop = watch((active) => {
    timers.clearInterval(sweep);
    sweep = undefined;
    if (active) {
      release();
    } else {
      hold();
      sweep = timers.setInterval(hold, HOLD_SWEEP_MS);
    }
  });
  return () => {
    stop();
    timers.clearInterval(sweep);
    sweep = undefined;
    release();
  };
}

/** React binding for {@link watchDecorativeMotion}. */
export function useDecorativeMotion(): boolean {
  const [active, setActive] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus(),
  );
  useEffect(() => watchDecorativeMotion(setActive), []);
  return active;
}

/** The OS asks for less motion ("Show animations" off on Windows). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
