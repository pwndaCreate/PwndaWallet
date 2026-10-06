/**
 * Prices a send while the Send modal is open: debounced while the user types,
 * refreshed while the inputs stand, one wallet call at a time, and never shown
 * against inputs it was not built for.
 *
 * # Why a controller (2026-09-15)
 *
 * The quote is a real `transfer` build on the wallet-rpc (see
 * `wallets/send-quote.ts`), which costs decoy fetches and a signature. Firing
 * one per keystroke, or letting a slow answer for "1" land after the user typed
 * "12", would both be wrong in ways a screenshot does not show. The timing rules
 * live here, free of React, so they are unit-tested with fake timers
 * (`quoteController.test.ts`); `useSendQuote` only wires this to state.
 *
 * # Two modes (operator request, 2026-10-01)
 *
 * That debounce and that 60 s refresh were themselves the problem for Monero
 * and Zephyr: each build asks the node for the coins it spends together with a
 * fresh set of decoys, and a node that sees several builds of one spend sees
 * the real coin in every one while the decoys change. So a controller is
 * "auto" (above: Xelis, whose quote is `estimate_fees` and builds nothing) or
 * "on-request": nothing is built until `request()` — the Send modal's Review —
 * and then once; an identical request reuses that build, and nothing refreshes
 * it. The adapter flag that picks the mode is `quoteBuildsSpend`.
 */
import type { SendQuote, SendQuoteErrorKind } from "../../wallets/types";
import { errorText } from "../../lib/errorText";
import { isDefinitiveQuoteError, quoteErrorKind } from "../../wallets/send-quote";

/** Wait this long after the last edit before asking the wallet ("auto" only). */
export const QUOTE_DEBOUNCE_MS = 600;
/** Re-price this often while the modal is open and the inputs are unchanged ("auto" only). */
export const QUOTE_REFRESH_MS = 60_000;

/**
 * When a controller asks the wallet:
 *  - `"auto"`: 600 ms after the last edit, then every 60 s while the inputs stand.
 *  - `"on-request"`: only when `request()` (or `retry()`) is called, once per
 *    set of inputs, never on a timer.
 */
export type QuoteMode = "auto" | "on-request";

export interface QuoteInputs {
  to: string;
  amount: string;
  assetType?: string;
}

export interface QuoteFailure {
  kind: SendQuoteErrorKind;
  message: string;
  /** True only for failures that refuse the Send button (`isDefinitiveQuoteError`). */
  definitive: boolean;
}

export interface QuoteSnapshot {
  /** The inputs this snapshot describes, or null when nothing is quotable. */
  inputs: QuoteInputs | null;
  /** Latest successful quote for `inputs`. */
  quote: SendQuote | null;
  /** Latest failure for `inputs` (cleared by a success). */
  failure: QuoteFailure | null;
  /** True while a quote for `inputs` is waiting or in flight. */
  pending: boolean;
}

export const EMPTY_QUOTE: QuoteSnapshot = {
  inputs: null,
  quote: null,
  failure: null,
  pending: false,
};

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Worth asking the wallet? A cheap, chain-agnostic gate: a recipient long
 * enough to be an address with no whitespace inside, and a positive plain
 * decimal amount. The wallet remains the authority on both; this only keeps
 * half-typed input from turning into wallet calls.
 */
export function quotableInputs(
  to: string,
  amount: string,
  assetType?: string,
): QuoteInputs | null {
  const t = to.trim();
  const a = amount.trim();
  if (t.length < 26 || /\s/.test(t)) return null;
  if (!DECIMAL.test(a) || !/[1-9]/.test(a)) return null;
  return assetType === undefined ? { to: t, amount: a } : { to: t, amount: a, assetType };
}

function sameInputs(a: QuoteInputs | null, b: QuoteInputs | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.to === b.to &&
    a.amount === b.amount &&
    (a.assetType ?? undefined) === (b.assetType ?? undefined)
  );
}

export function describeQuoteFailure(e: unknown): QuoteFailure {
  return {
    kind: quoteErrorKind(e),
    message: errorText(e, "The wallet could not price this send."),
    definitive: isDefinitiveQuoteError(e),
  };
}

export interface QuoteTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface QuoteController {
  /**
   * New inputs (or null: nothing quotable). Unchanged inputs are a no-op.
   * "auto" prices them after the debounce; "on-request" never builds here.
   */
  setInputs(next: QuoteInputs | null): void;
  /**
   * Re-price now, discarding any answer still in flight. "on-request": the
   * same as `request()` — an explicit retry after a failure builds again.
   */
  retry(): void;
  /**
   * "on-request": build the current inputs' transaction, ONCE. If the last
   * build was for exactly these inputs it is shown again and nothing is
   * built; a build already running for them is not doubled; a build running
   * for other inputs is waited for. "auto": the same as `retry()`.
   */
  request(): void;
  /**
   * Forget every build ("on-request": the shown one has been handed to a send;
   * if that send fails, the next review builds afresh instead of offering a
   * transaction that may no longer be relayable).
   */
  discard(): void;
  /** Stop every timer and emission. */
  dispose(): void;
  snapshot(): QuoteSnapshot;
}

export function createQuoteController(opts: {
  quote: (inputs: QuoteInputs) => Promise<SendQuote>;
  onChange: (snapshot: QuoteSnapshot) => void;
  /** Default "auto", the behaviour before 2026-10-01. */
  mode?: QuoteMode;
  debounceMs?: number;
  refreshMs?: number;
  timers?: QuoteTimers;
}): QuoteController {
  const mode: QuoteMode = opts.mode ?? "auto";
  const debounceMs = opts.debounceMs ?? QUOTE_DEBOUNCE_MS;
  const refreshMs = opts.refreshMs ?? QUOTE_REFRESH_MS;
  const timers: QuoteTimers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };

  let snap: QuoteSnapshot = EMPTY_QUOTE;
  let timer: unknown = null;
  // Bumped whenever the inputs change, on retry and on dispose. An answer
  // carrying an older generation describes inputs the modal no longer shows.
  let generation = 0;
  let inFlight = false;
  let inFlightInputs: QuoteInputs | null = null;
  let rerun = false;
  let disposed = false;
  // "on-request" only: the last successful build and the inputs it is for, so
  // reviewing the same send again shows it instead of building it again.
  let lastBuild: { inputs: QuoteInputs; quote: SendQuote } | null = null;
  // Bumped by `discard()`: a build that finishes after it is not remembered.
  let forgetCount = 0;

  const emit = (next: QuoteSnapshot) => {
    snap = next;
    if (!disposed) opts.onChange(next);
  };
  const clear = () => {
    if (timer != null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (ms: number) => {
    clear();
    timer = timers.setTimeout(() => {
      timer = null;
      void run();
    }, ms);
  };

  async function run(): Promise<void> {
    if (disposed || !snap.inputs) return;
    // One wallet call at a time: a build requested while another is running
    // waits for it and then runs with whatever the inputs are by then.
    if (inFlight) {
      // A second request for the build already running is not a second build.
      if (mode === "on-request" && sameInputs(inFlightInputs, snap.inputs)) return;
      rerun = true;
      if (mode === "on-request" && !snap.pending) emit({ ...snap, pending: true });
      return;
    }
    if (mode === "on-request" && lastBuild && sameInputs(lastBuild.inputs, snap.inputs)) {
      emit({ inputs: snap.inputs, quote: lastBuild.quote, failure: null, pending: false });
      return;
    }
    inFlight = true;
    rerun = false;
    const inputs = snap.inputs;
    inFlightInputs = inputs;
    const gen = generation;
    const forgets = forgetCount;
    if (!snap.pending) emit({ ...snap, pending: true });

    let settled: QuoteSnapshot;
    try {
      const q = await opts.quote(inputs);
      settled = { inputs, quote: q, failure: null, pending: false };
      if (mode === "on-request" && forgets === forgetCount) lastBuild = { inputs, quote: q };
    } catch (e) {
      settled = { inputs, quote: null, failure: describeQuoteFailure(e), pending: false };
    } finally {
      inFlight = false;
      inFlightInputs = null;
    }

    if (disposed) return;
    if (rerun) {
      rerun = false;
      void run();
      return;
    }
    // Inputs changed while this build ran: its answer is for the old inputs,
    // and the debounce timer `setInputs` armed will price the new ones ("auto";
    // "on-request" keeps it in `lastBuild` for a review of those inputs).
    if (gen !== generation) return;
    emit(settled);
    if (mode === "auto") schedule(refreshMs);
  }

  const request = () => {
    if (disposed || !snap.inputs) return;
    // Already showing this send's build: confirming it needs nothing new.
    if (snap.quote) return;
    void run();
  };

  return {
    setInputs(next) {
      if (disposed || sameInputs(next, snap.inputs)) return;
      generation++;
      clear();
      if (!next) {
        emit(EMPTY_QUOTE);
        return;
      }
      if (mode === "on-request") {
        // A review queued for the previous inputs is not one for these.
        rerun = false;
        emit({ inputs: next, quote: null, failure: null, pending: false });
        return;
      }
      emit({ inputs: next, quote: null, failure: null, pending: true });
      schedule(debounceMs);
    },
    retry() {
      if (disposed || !snap.inputs) return;
      if (mode === "on-request") {
        request();
        return;
      }
      generation++;
      clear();
      void run();
    },
    request() {
      if (mode === "auto") {
        if (disposed || !snap.inputs) return;
        generation++;
        clear();
        void run();
        return;
      }
      request();
    },
    discard() {
      if (disposed) return;
      lastBuild = null;
      forgetCount++;
      generation++;
      clear();
      if (snap.quote || snap.failure || snap.pending) {
        emit({ inputs: snap.inputs, quote: null, failure: null, pending: false });
      }
    },
    dispose() {
      disposed = true;
      generation++;
      clear();
    },
    snapshot: () => snap,
  };
}
