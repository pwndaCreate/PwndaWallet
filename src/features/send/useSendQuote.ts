/**
 * React binding for `quoteController`: prices the send the Send modal is
 * showing, for adapters that implement `quoteSend` (Zephyr, 2026-09-15).
 *
 * All timing rules (debounce, refresh, one build at a time, stale answers
 * dropped) live in `quoteController.ts`, where they are unit-tested; this hook
 * only creates the controller and feeds it the modal's inputs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChainAdapter } from "../../wallets/types";
import {
  EMPTY_QUOTE,
  createQuoteController,
  quotableInputs,
  type QuoteController,
  type QuoteSnapshot,
} from "./quoteController";

export function useSendQuote(args: {
  adapter: ChainAdapter;
  to: string;
  amount: string;
  assetType?: string;
  /** False pauses pricing (e.g. while a send is in flight). */
  enabled: boolean;
}): QuoteSnapshot & { supported: boolean; retry: () => void } {
  const { adapter, to, amount, assetType, enabled } = args;
  const supported = typeof adapter.quoteSend === "function";
  const [snap, setSnap] = useState<QuoteSnapshot>(EMPTY_QUOTE);
  const ctrlRef = useRef<QuoteController | null>(null);

  useEffect(() => {
    setSnap(EMPTY_QUOTE);
    if (!adapter.quoteSend) return;
    const quoteSend = adapter.quoteSend.bind(adapter);
    const ctrl = createQuoteController({ quote: (i) => quoteSend(i), onChange: setSnap });
    ctrlRef.current = ctrl;
    return () => {
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, [adapter]);

  useEffect(() => {
    ctrlRef.current?.setInputs(enabled ? quotableInputs(to, amount, assetType) : null);
  }, [adapter, enabled, to, amount, assetType]);

  const retry = useCallback(() => ctrlRef.current?.retry(), []);
  return { ...snap, supported, retry };
}
