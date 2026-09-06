/**
 * **C6 — the swap node's Monero wallet, as a first-class wallet.**
 *
 * Receive is a rotating subaddress from the engine
 * (`swap_bridge_next_deposit_addr`). Send is {@link useSweepBack} — and *only*
 * that: there is no arbitrary-destination XMR send command anywhere in the
 * frozen contract, because a command that took a destination from the renderer
 * would give back exactly the property C4 was built to hold (§R13). "Send" in
 * this wallet means "sweep back to your own pinned XMR address".
 *
 * # Rotation is a user action, never a mount effect
 *
 * `nextdepositaddr` *derives a new subaddress* — it changes engine state. This
 * hook therefore never calls it on mount. The address shown at rest is the one
 * `/json/wallets` already reports for XMR; rotation happens when the user asks.
 * Auto-rotating on every mount would quietly retire an address the user may
 * have just handed to a counterparty.
 *
 * # Amounts stay strings, all the way down
 *
 * XMR carries **12 decimals**. `parseFloat("0.000000000001")` is representable
 * but `balance - reserved` in floating point is not reliably exact at that
 * scale, and the error shows up as a spendable figure that is slightly wrong in
 * the dangerous direction. {@link subtractAmount} does the arithmetic in
 * `BigInt` on the digit strings and never converts to a number.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  nextDepositAddr,
  normalizeDepositAddress,
  type BasicSwapWalletInfo,
} from "../../api/basicswap";

/** Monero's atomic-unit exponent. Here for callers that need it; the helpers
 *  below infer scale from the strings and do not need to be told. */
export const XMR_DECIMALS = 12;

// =========================================================================
// Pure helpers
// =========================================================================

const DECIMAL_RE = /^-?\d*(\.\d*)?$/;

function fracLen(s: string): number {
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/** Decimal string to a scaled BigInt at `scale` fraction digits, or `null`. */
function scaled(s: string, scale: number): bigint | null {
  const t = s.trim();
  if (t === "" || t === "." || t === "-" || t === "-." || !DECIMAL_RE.test(t)) {
    return null;
  }
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1) : t;
  const [whole, frac = ""] = body.split(".");
  if (frac.length > scale) return null;
  const padded = (frac + "0".repeat(scale)).slice(0, scale);
  const v =
    BigInt(whole === "" ? "0" : whole) * 10n ** BigInt(scale) +
    BigInt(padded === "" ? "0" : padded);
  return neg ? -v : v;
}

function unscale(v: bigint, scale: number): string {
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const body =
    scale === 0
      ? digits
      : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  return neg ? `-${body}` : body;
}

/**
 * `a - b`, exactly, on decimal strings. Never touches a float.
 *
 * The result carries as many fraction digits as the wider input, so
 * `"1.0" - "0.000000000001"` is `"0.999999999999"` and not `"1"`.
 *
 * - `a` absent or unparseable yields `null` ("we do not know the balance").
 * - `b` absent or blank yields `a` normalised ("nothing is reserved").
 * - A **negative result is returned as-is**, with its sign. Reserved exceeding
 *   the balance is a real anomaly — clamping it to zero would hide the one
 *   number that says something is wrong.
 */
export function subtractAmount(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  if (typeof a !== "string" || a.trim() === "") return null;
  const bStr = typeof b === "string" && b.trim() !== "" ? b.trim() : "0";
  const scale = Math.max(fracLen(a.trim()), fracLen(bStr));
  const av = scaled(a, scale);
  const bv = scaled(bStr, scale);
  if (av === null || bv === null) return null;
  return unscale(av - bv, scale);
}

/** Is this amount string negative? Cheap, and the card needs it to decide
 *  whether the "reserved exceeds balance" warning applies. */
export function isNegativeAmount(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().startsWith("-");
}

/**
 * What the user can actually move: reported balance minus what in-flight swaps
 * have committed.
 *
 * `reserved` is **supplied by the caller**, not derived here. There is no
 * endpoint that reports "XMR committed to live bids" — the number comes from
 * the caller's own view of in-flight swaps, and inventing a source for it here
 * would be fabricating data the engine does not publish.
 */
export function spendableXmr(
  info: BasicSwapWalletInfo | null | undefined,
  reserved: string | null | undefined,
): string | null {
  return subtractAmount(info?.balance ?? null, reserved);
}

/**
 * The address to show: a freshly rotated one if there is one, otherwise
 * whatever `/json/wallets` last reported.
 *
 * Both go through `normalizeDepositAddress`, so upstream's placeholders
 * ("Refresh necessary", "WARNING: Unknown wallet seed", "Error: unowned
 * address") become `null` rather than something a copy button would offer
 * (§R18). `null` means "no address yet", never "error".
 */
export function displayAddress(
  rotated: string | null | undefined,
  info: BasicSwapWalletInfo | null | undefined,
): string | null {
  return (
    normalizeDepositAddress(rotated) ??
    normalizeDepositAddress(info?.deposit_address)
  );
}

// =========================================================================
// Hook
// =========================================================================

export interface DexXmrWalletState {
  /** What to render / offer for copy. `null` means "not available yet". */
  address: string | null;
  /** Only the rotated value, if the user has rotated this session. */
  rotated: string | null;
  rotating: boolean;
  error: string | null;
  /** Balance minus the caller-supplied reserved amount. */
  spendable: string | null;
  /** Ask the engine for a fresh subaddress. User-initiated only. */
  rotate(): Promise<string | null>;
}

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/**
 * Headless state for the DEX-XMR wallet card.
 *
 * `info` comes from `useSidecarBalances` — this hook does not poll, so mounting
 * it next to the balances card costs no extra RPC fan-out.
 */
export function useDexXmrWallet(opts: {
  enabled: boolean;
  info: BasicSwapWalletInfo | null;
  reserved?: string | null;
  /** Defaults to `"XMR"`. Present so the same hook can back ZEPH later. */
  ticker?: string;
}): DexXmrWalletState {
  const { enabled, info, reserved = null, ticker = "XMR" } = opts;
  const [rotated, setRotated] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A revoked opt-in must not leave a rotated address on screen.
  useEffect(() => {
    if (!enabled) {
      setRotated(null);
      setError(null);
      setRotating(false);
    }
  }, [enabled]);

  const rotate = useCallback(async (): Promise<string | null> => {
    if (!enabled) throw new Error("the swap sidecar is not enabled");
    setRotating(true);
    setError(null);
    try {
      const addr = await nextDepositAddr(ticker);
      const clean = normalizeDepositAddress(addr);
      if (alive.current) setRotated(clean);
      return clean;
    } catch (e) {
      if (alive.current) setError(errMsg(e));
      throw e;
    } finally {
      if (alive.current) setRotating(false);
    }
  }, [enabled, ticker]);

  return {
    address: displayAddress(rotated, info),
    rotated,
    rotating,
    error,
    spendable: spendableXmr(info, reserved),
    rotate,
  };
}
