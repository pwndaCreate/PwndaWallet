/**
 * React binding for `quoteController`: prices the send the Send modal is
 * showing, for adapters that implement `quoteSend` (Zephyr, 2026-09-15).
 *
 * All timing rules (debounce, refresh, one build at a time, stale answers
 * dropped) live in `quoteController.ts`, where they are unit-tested; this hook
 * only creates the controller and feeds it the modal's inputs.
 *
 * Since 2026-10-01 (operator request) the controller's mode comes from the
 * adapter: where `quoteSend` builds the real spend (`quoteBuildsSpend`:
 * Monero, Zephyr) it builds only when the modal calls `request()` — the
 * Review button — never on an edit or a timer (`quoteModeFor`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChainAdapter } from "../../wallets/types";
import {
  EMPTY_QUOTE,
  createQuoteController,
  quotableInputs,
  type QuoteController,
  type QuoteMode,
  type QuoteSnapshot,
} from "./quoteController";

/**
 * "on-request" where a quote is a build of the spend itself, "auto" otherwise.
 * One rule for the hook and for the tests that count builds.
 */
export function quoteModeFor(adapter: Pick<ChainAdapter, "quoteBuildsSpend">): QuoteMode {
  return adapter.quoteBuildsSpend === true ? "on-request" : "auto";
}

export function useSendQuote(args: {
  adapter: ChainAdapter;
  to: string;
  amount: string;
  assetType?: string;
  /** False pauses pricing (e.g. while a send is in flight). */
  enabled: boolean;
}): QuoteSnapshot & {
  supported: boolean;
  mode: QuoteMode;
  retry: () => void;
  request: () => void;
} {
  const { adapter, to, amount, assetType, enabled } = args;
  const supported = typeof adapter.quoteSend === "function";
  const mode = quoteModeFor(adapter);
  const [snap, setSnap] = useState<QuoteSnapshot>(EMPTY_QUOTE);
  const ctrlRef = useRef<QuoteController | null>(null);

  useEffect(() => {
    setSnap(EMPTY_QUOTE);
    if (!adapter.quoteSend) return;
    const quoteSend = adapter.quoteSend.bind(adapter);
    const ctrl = createQuoteController({
      quote: (i) => quoteSend(i),
      onChange: setSnap,
      mode: quoteModeFor(adapter),
    });
    ctrlRef.current = ctrl;
    return () => {
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, [adapter]);

  // A send just started with the build on screen (`enabled` went false):
  // forget it. A send that succeeds closes the modal; one that fails is
  // reviewed again rather than offered the same transaction, which may no
  // longer be relayable (another wallet session, say). Declared before the
  // inputs effect, so it runs first in the same commit.
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (wasEnabled.current && !enabled) ctrlRef.current?.discard();
    wasEnabled.current = enabled;
  }, [enabled]);

  useEffect(() => {
    ctrlRef.current?.setInputs(enabled ? quotableInputs(to, amount, assetType) : null);
  }, [adapter, enabled, to, amount, assetType]);

  const retry = useCallback(() => ctrlRef.current?.retry(), []);
  const request = useCallback(() => ctrlRef.current?.request(), []);
  return { ...snap, supported, mode, retry, request };
}
