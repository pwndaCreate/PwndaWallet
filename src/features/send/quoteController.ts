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
 */
import type { SendQuote, SendQuoteErrorKind } from "../../wallets/types";
import { errorText } from "../../lib/errorText";
import { isDefinitiveQuoteError, quoteErrorKind } from "../../wallets/send-quote";

/** Wait this long after the last edit before asking the wallet. */
export const QUOTE_DEBOUNCE_MS = 600;
/** Re-price this often while the modal is open and the inputs are unchanged. */
export const QUOTE_REFRESH_MS = 60_000;

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
  /** New inputs (or null: nothing quotable). Unchanged inputs are a no-op. */
  setInputs(next: QuoteInputs | null): void;
  /** Re-price now, discarding any answer still in flight. */
  retry(): void;
  /** Stop every timer and emission. */
  dispose(): void;
  snapshot(): QuoteSnapshot;
}

export function createQuoteController(opts: {
  quote: (inputs: QuoteInputs) => Promise<SendQuote>;
  onChange: (snapshot: QuoteSnapshot) => void;
  debounceMs?: number;
  refreshMs?: number;
  timers?: QuoteTimers;
}): QuoteController {
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
  let rerun = false;
  let disposed = false;

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
      rerun = true;
      return;
    }
    inFlight = true;
    rerun = false;
    const inputs = snap.inputs;
    const gen = generation;
    if (!snap.pending) emit({ ...snap, pending: true });

    let settled: QuoteSnapshot;
    try {
      const q = await opts.quote(inputs);
      settled = { inputs, quote: q, failure: null, pending: false };
    } catch (e) {
      settled = { inputs, quote: null, failure: describeQuoteFailure(e), pending: false };
    } finally {
      inFlight = false;
    }

    if (disposed) return;
    if (rerun) {
      rerun = false;
      void run();
      return;
    }
    // Inputs changed while this build ran: its answer is for the old inputs,
    // and the debounce timer `setInputs` armed will price the new ones.
    if (gen !== generation) return;
    emit(settled);
    schedule(refreshMs);
  }

  return {
    setInputs(next) {
      if (disposed || sameInputs(next, snap.inputs)) return;
      generation++;
      clear();
      if (!next) {
        emit(EMPTY_QUOTE);
        return;
      }
      emit({ inputs: next, quote: null, failure: null, pending: true });
      schedule(debounceMs);
    },
    retry() {
      if (disposed || !snap.inputs) return;
      generation++;
      clear();
      void run();
    },
    dispose() {
      disposed = true;
      generation++;
      clear();
    },
    snapshot: () => snap,
  };
}
