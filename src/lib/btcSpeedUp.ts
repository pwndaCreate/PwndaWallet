/**
 * "Speed up" for an unconfirmed BTC transaction, as the screens use it
 * (operator request, 2026-10-01): which rows are offered it, the steps it
 * goes through, and the figures it shows. Shared by the transaction details
 * (`TxDetails`, Activity and the wallet's Recent rows, both layouts) and the
 * swap details (`SwapDetailsModal`, a NEAR Intents swap whose BTC deposit has
 * not confirmed), through `components/SpeedUpPanel.tsx`.
 *
 * The transaction work — reading the original, the replacement rules,
 * signing once, broadcasting once — is `wallets/btc-rbf.ts`. This holds the
 * part with no I/O of its own, so it is tested without React (this repo has
 * no DOM test harness): `createSpeedUpController` is the state machine the
 * hook drives, with its effects injected.
 */
import { useEffect, useRef, useState } from "react";
import type { ChainTx, TxResult, WalletInfo } from "../wallets/types";
import { errorText } from "./errorText";
import { isSendOutcomeUnknown } from "../wallets/send-outcome";
import {
  isBtcSpeedUpRefusal,
  quoteBtcSpeedUp,
  speedUpBtcTransaction,
  type BtcSpeedUpQuote,
  type BtcSpeedUpRefusalCode,
  type BtcWalletSecret,
} from "../wallets/btc-rbf";
import { btcAdapter } from "../wallets/btc-wallet";
import { fetchUsdPrices } from "../wallets/usd-prices";
import { useUtxoAccountSummary } from "./utxoAccountRegistry";

// ── Which rows ─────────────────────────────────────────────────────────────

function metaString(tx: ChainTx, key: string): string | undefined {
  const v = tx.meta?.[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Could this history row be sped up? A Bitcoin transaction, not yet in a
 * block, that the wallet SENT (or sent to itself). Cheap and offline: the
 * rest — does it signal replace-by-fee, did this app build it, are its
 * inputs the wallet's — is read from the chain when the details open.
 *
 * A mempool row's own `direction` is `pending`; which way it went rides in
 * `meta.netDirection` (the account merge, `utxo-account-history.ts`) or, on a
 * per-address row, in the sign of `meta.netSat`.
 */
export function speedUpCandidate(tx: ChainTx): boolean {
  if (tx.chain !== "bitcoin") return false;
  if (tx.height) return false;
  const unconfirmed = tx.confirmations === 0 || tx.direction === "pending";
  if (!unconfirmed) return false;
  const d = tx.direction;
  if (d === "out" || d === "self") return true;
  if (d !== "pending") return false;
  const hint = metaString(tx, "netDirection") ?? metaString(tx, "intended");
  if (hint) return hint === "out" || hint === "self";
  const net = tx.meta?.netSat;
  return typeof net === "number" && net < 0;
}

/** What signs for a Bitcoin wallet entry, or null for a watch-only one or none. */
export function secretOf(wallet: WalletInfo | null | undefined): BtcWalletSecret | null {
  if (!wallet || wallet.watchOnly) return null;
  if (wallet.mnemonic && wallet.mnemonic.trim()) return { mnemonic: wallet.mnemonic };
  if (wallet.privateKey && wallet.privateKey.trim()) return { privateKey: wallet.privateKey };
  return null;
}

// ── The steps ──────────────────────────────────────────────────────────────

export type SpeedUpState =
  /** Reading the transaction, the fee estimate and the price. */
  | { phase: "checking" }
  /** It cannot be sped up. `quiet`: say nothing (not this wallet's to touch). */
  | { phase: "unavailable"; code: BtcSpeedUpRefusalCode; reason: string; quiet: boolean }
  /** The explorers could not be read. */
  | { phase: "error"; reason: string }
  /** It can: the button. */
  | { phase: "ready"; quote: BtcSpeedUpQuote; usdPrice: number | null }
  /** The figures, and one confirm. */
  | { phase: "review"; quote: BtcSpeedUpQuote; usdPrice: number | null }
  | { phase: "sending"; quote: BtcSpeedUpQuote; usdPrice: number | null }
  | { phase: "sent"; quote: BtcSpeedUpQuote; usdPrice: number | null; newTxid: string }
  /** Nothing was sent: the reason, and a way to check again. */
  | { phase: "failed"; quote: BtcSpeedUpQuote; usdPrice: number | null; reason: string }
  /** It may have reached the network. Never offered again from here. */
  | { phase: "unknown"; reason: string; newTxid?: string };

/** Refusals that are not worth a sentence: not a transaction this wallet may touch. */
const QUIET: ReadonlySet<BtcSpeedUpRefusalCode> = new Set<BtcSpeedUpRefusalCode>([
  "confirmed",
  "not-own-tx",
  "not-own-inputs",
]);

export interface SpeedUpDeps {
  /** The network's fast rate, sat/vB, or null when it cannot be read. */
  fastRate(): Promise<number | null>;
  /** BTC in USD, or null. */
  usdPrice(): Promise<number | null>;
  quote: typeof quoteBtcSpeedUp;
  send: typeof speedUpBtcTransaction;
}

export interface SpeedUpController {
  readonly state: SpeedUpState;
  check(): Promise<void>;
  review(): void;
  cancel(): void;
  confirm(): Promise<void>;
  dispose(): void;
}

/**
 * The speed-up's state machine: checking → ready → review → sending → sent
 * (or failed / unknown). `confirm` acts only from `review`, and moves to
 * `sending` before it awaits anything, so a second press — or a press in a
 * second view of the same panel — cannot send twice. The rate it sends at is
 * the one the review showed.
 */
export function createSpeedUpController(
  input: {
    txid: string;
    secret: BtcWalletSecret;
    known?: () => ReadonlyArray<{ address: string; path: string }>;
    usdPrice?: number | null;
  },
  deps: SpeedUpDeps,
  emit: (s: SpeedUpState) => void,
): SpeedUpController {
  let state: SpeedUpState = { phase: "checking" };
  let disposed = false;
  let targetRate: number | null = null;
  const set = (s: SpeedUpState) => {
    state = s;
    if (!disposed) emit(s);
  };
  return {
    get state() {
      return state;
    },
    async check() {
      // Once a replacement is out (or may be), this panel's job is done:
      // the original is gone, and asking about it again could only offer
      // a second, competing replacement.
      if (state.phase === "sending" || state.phase === "sent" || state.phase === "unknown") return;
      set({ phase: "checking" });
      const [rate, price] = await Promise.all([
        deps.fastRate().catch(() => null),
        input.usdPrice != null ? Promise.resolve(input.usdPrice) : deps.usdPrice().catch(() => null),
      ]);
      targetRate = rate;
      try {
        const quote = await deps.quote({
          txid: input.txid,
          secret: input.secret,
          targetRate: rate,
          known: input.known?.(),
        });
        set({ phase: "ready", quote, usdPrice: price });
      } catch (e) {
        if (isBtcSpeedUpRefusal(e)) {
          set({ phase: "unavailable", code: e.code, reason: e.message, quiet: QUIET.has(e.code) });
        } else {
          set({ phase: "error", reason: errorText(e, "the explorers did not answer") });
        }
      }
    },
    review() {
      if (state.phase === "ready") set({ phase: "review", quote: state.quote, usdPrice: state.usdPrice });
    },
    cancel() {
      if (state.phase === "review") set({ phase: "ready", quote: state.quote, usdPrice: state.usdPrice });
    },
    async confirm() {
      if (state.phase !== "review") return;
      const { quote, usdPrice } = state;
      set({ phase: "sending", quote, usdPrice });
      let r: TxResult;
      try {
        r = await deps.send({
          txid: input.txid,
          secret: input.secret,
          targetRate,
          known: input.known?.(),
          expectFeeSat: quote.newFeeSat,
        });
      } catch (e) {
        if (isSendOutcomeUnknown(e)) {
          set({ phase: "unknown", reason: e.message, newTxid: e.hash });
        } else {
          set({ phase: "failed", quote, usdPrice, reason: errorText(e, "the replacement was not sent") });
        }
        return;
      }
      set({ phase: "sent", quote, usdPrice, newTxid: r.hash });
    },
    dispose() {
      disposed = true;
    },
  };
}

// ── What it shows ──────────────────────────────────────────────────────────

/** `$1.23`, `< $0.01`. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "< $0.01";
  if (usd >= 1000) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${usd.toFixed(2)}`;
}

/** sat/vB to one decimal. */
export function formatRate(rate: number): string {
  return `${rate.toFixed(1)} sat/vB`;
}

const btcText = (sat: number) => `${(sat / 1e8).toFixed(8)} BTC`;

export interface SpeedUpFigures {
  currentRate: string;
  newRate: string;
  /** Where the new rate came from, in words. */
  newRateSource: string;
  newFee: string;
  newFeeUsd: string | null;
  extraFee: string;
  extraFeeUsd: string | null;
  changeBefore: string;
  changeAfter: string;
}

/** The review's numbers, as text. Pure. */
export function speedUpFigures(quote: BtcSpeedUpQuote, usdPrice: number | null): SpeedUpFigures {
  const usd = (sat: number) => (usdPrice && usdPrice > 0 ? formatUsd((sat / 1e8) * usdPrice) : null);
  return {
    currentRate: formatRate(quote.currentRate),
    newRate: formatRate(quote.newRate),
    newRateSource:
      quote.targetRate === null
        ? "the least a replacement may pay (the network's fee estimate could not be read)"
        : quote.atMinimum
          ? `the least a replacement may pay (the network's fast rate, ${formatRate(quote.targetRate)}, is lower)`
          : "the network's fast rate",
    newFee: btcText(quote.newFeeSat),
    newFeeUsd: usd(quote.newFeeSat),
    extraFee: btcText(quote.extraFeeSat),
    extraFeeUsd: usd(quote.extraFeeSat),
    changeBefore: btcText(quote.change.beforeSat),
    changeAfter: btcText(quote.change.afterSat),
  };
}

// ── The hook ───────────────────────────────────────────────────────────────

async function fastRateFromAdapter(): Promise<number | null> {
  const est = await btcAdapter.getFeeEstimate();
  const n = Number((est.fast ?? est.normal)?.value);
  return Number.isFinite(n) && n > 0 && !est.isFallback ? n : null;
}

async function btcUsdPrice(): Promise<number | null> {
  const p = (await fetchUsdPrices(["BTC"])).BTC;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
}

export const DEFAULT_SPEED_UP_DEPS: SpeedUpDeps = {
  fastRate: fastRateFromAdapter,
  usdPrice: btcUsdPrice,
  quote: quoteBtcSpeedUp,
  send: speedUpBtcTransaction,
};

/**
 * The speed-up for one transaction. Reads it once when mounted (and again on
 * `recheck`); `null` while it is not asked (no key for it, or `enabled` false).
 */
export function useBtcSpeedUp(args: {
  txid: string;
  wallet: WalletInfo | null | undefined;
  /** BTC's USD price when the host knows it; otherwise it is fetched. */
  usdPrice?: number | null;
  enabled?: boolean;
  deps?: SpeedUpDeps;
}): {
  state: SpeedUpState | null;
  review: () => void;
  cancel: () => void;
  confirm: () => void;
  recheck: () => void;
} {
  const secret = secretOf(args.wallet);
  const enabled = (args.enabled ?? true) && secret !== null;
  const summary = useUtxoAccountSummary("bitcoin");
  // Read at the moment of asking, so a scan that lands later is used.
  const knownRef = useRef<ReadonlyArray<{ address: string; path: string }>>([]);
  knownRef.current = (summary?.entries ?? []).map((e) => ({ address: e.address, path: e.path }));
  const priceRef = useRef(args.usdPrice ?? null);
  priceRef.current = args.usdPrice ?? null;
  const secretRef = useRef(secret);
  secretRef.current = secret;
  // "checking" from the first render when it will be asked, so the panel
  // does not appear only after a blank frame.
  const [state, setState] = useState<SpeedUpState | null>(() => (enabled ? { phase: "checking" } : null));
  const ctl = useRef<SpeedUpController | null>(null);
  // The wallet is named by its address, never by its secret, in the deps.
  const walletKey = args.wallet ? `${args.wallet.chain}:${args.wallet.address}` : "";

  useEffect(() => {
    const s = secretRef.current;
    if (!enabled || !s) {
      setState(null);
      return;
    }
    const c = createSpeedUpController(
      { txid: args.txid, secret: s, known: () => knownRef.current, usdPrice: priceRef.current },
      args.deps ?? DEFAULT_SPEED_UP_DEPS,
      setState,
    );
    ctl.current = c;
    setState(c.state);
    void c.check();
    return () => {
      c.dispose();
      if (ctl.current === c) ctl.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.txid, enabled, walletKey]);

  return {
    state,
    review: () => ctl.current?.review(),
    cancel: () => ctl.current?.cancel(),
    confirm: () => void ctl.current?.confirm(),
    recheck: () => void ctl.current?.check(),
  };
}
