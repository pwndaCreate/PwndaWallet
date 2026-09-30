/**
 * Which asset the open Send modal is sending: ONE value, readable by both
 * layouts.
 *
 * # Why this is a store and not `useState` (2026-09-15)
 *
 * `useSend` owns the send flow, and `App.tsx` hands its `sendAssetType` to the
 * landscape root only. Portrait's `ViewRouter` mounts the same `SendModal` but
 * never received the asset, so a portrait ZEPHUSD send would have been titled
 * "Send ZEPH" while `handleSend` sent ZEPHUSD.
 *
 * The obvious in-scope fix, a second copy of the asset in `ViewRouter` set by
 * its own opener, is a value in two places: a layout switch with the modal
 * open, or any opener that does not go through that wrapper, leaves the label
 * describing one asset and the send moving another. So the value lives here.
 * `useSend` reads and writes it, and any mount reads the same value with
 * `useSendAssetType()`. Same pattern as `src/lib/utxoAccountRegistry.ts`.
 *
 * `undefined` means "the chain's native asset", exactly as before.
 */
import { useSyncExternalStore } from "react";
import type { SendMemo, SendMemoType } from "../../wallets/types";

let current: string | undefined = undefined;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSendAssetType(): string | undefined {
  return current;
}

export function setSendAssetType(next: string | undefined): void {
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

export function useSendAssetType(): string | undefined {
  return useSyncExternalStore(subscribe, getSendAssetType, getSendAssetType);
}

// ─── The XRP destination tag (2026-09-29) ─────────────────────────────────
//
// The same one-value-for-both-layouts reason as the asset above: `SendModal`
// renders the field in whichever layout mounted it, and `useSend` must send
// exactly what that field shows. Held as the field's raw text; parsed by
// `parseDestinationTag` at the two places that need a number.

let tagRaw = "";
const tagListeners = new Set<() => void>();

function subscribeTag(cb: () => void): () => void {
  tagListeners.add(cb);
  return () => {
    tagListeners.delete(cb);
  };
}

export function getSendDestinationTag(): string {
  return tagRaw;
}

export function setSendDestinationTag(next: string): void {
  if (next === tagRaw) return;
  tagRaw = next;
  for (const l of tagListeners) l();
}

export function useSendDestinationTag(): string {
  return useSyncExternalStore(subscribeTag, getSendDestinationTag, getSendDestinationTag);
}

/** An XRP Ledger destination tag is an unsigned 32-bit integer. */
const MAX_DESTINATION_TAG = 4294967295;

/**
 * The field's text as a tag: `{}` when empty (no tag), `{ tag }` when valid,
 * `{ error }` otherwise. A tag that does not fit 32 bits is an error, never
 * truncated: a wrong tag credits a stranger's exchange account.
 */
export function parseDestinationTag(raw: string): { tag?: number; error?: string } {
  const t = raw.trim();
  if (!t) return {};
  if (!/^\d{1,10}$/.test(t) || Number(t) > MAX_DESTINATION_TAG) {
    return { error: "A destination tag is a whole number from 0 to 4294967295." };
  }
  return { tag: Number(t) };
}

// ─── The Stellar memo (2026-09-29 send-safety audit) ──────────────────────
//
// Same reason as the tag: the modal renders the field in whichever layout
// mounted it, and `useSend` must send exactly what the field shows. Held as
// the field's raw text plus the memo TYPE the user picked; parsed by
// `parseSendMemo` at the two places that need a memo. Reset wherever the tag
// is, so a memo typed for one send never rides along on the next.

export interface SendMemoInput {
  raw: string;
  type: SendMemoType;
}

const EMPTY_MEMO: SendMemoInput = { raw: "", type: "text" };
// One object per state, replaced on change: `useSyncExternalStore` compares
// snapshots by reference.
let memoState: SendMemoInput = EMPTY_MEMO;
const memoListeners = new Set<() => void>();

function subscribeMemo(cb: () => void): () => void {
  memoListeners.add(cb);
  return () => {
    memoListeners.delete(cb);
  };
}

function setMemoState(next: SendMemoInput): void {
  if (next.raw === memoState.raw && next.type === memoState.type) return;
  memoState = next;
  for (const l of memoListeners) l();
}

export function getSendMemo(): SendMemoInput {
  return memoState;
}

export function setSendMemoText(raw: string): void {
  setMemoState({ raw, type: memoState.type });
}

export function setSendMemoType(type: SendMemoType): void {
  setMemoState({ raw: memoState.raw, type });
}

/** Forget the memo and its type. Called everywhere the tag is cleared. */
export function resetSendMemo(): void {
  setMemoState(EMPTY_MEMO);
}

export function useSendMemo(): SendMemoInput {
  return useSyncExternalStore(subscribeMemo, getSendMemo, getSendMemo);
}

/** The largest Stellar `MEMO_ID`: an unsigned 64-bit integer. */
export const MAX_MEMO_ID = 18446744073709551615n;

/**
 * The field's text as a memo: `{}` when empty (no memo), `{ memo }` when
 * valid, `{ error }` otherwise.
 *
 * Refused, never repaired, because a memo that is not exactly what the
 * exchange gave credits nobody (or somebody else):
 *  - an ID with anything but digits ("123-456", "0x10", "1e5") is an error,
 *    not "123456" / 16 / 100000;
 *  - an ID above 2^64 - 1 is an error. `@stellar/stellar-base`'s `Memo.id`
 *    does NOT refuse it: checked 2026-09-29, `Memo.id("18446744073709551616")`
 *    encodes as memo ID 0, and `Memo.id("0x10")` as 16;
 *  - a text memo longer than `textMaxBytes` UTF-8 bytes is an error, not a
 *    truncation.
 * Surrounding whitespace is trimmed (a pasted memo often carries a newline).
 */
export function parseSendMemo(
  raw: string,
  type: SendMemoType,
  textMaxBytes: number,
): { memo?: SendMemo; error?: string } {
  const t = raw.trim();
  if (!t) return {};
  if (type === "id") {
    if (!/^\d{1,20}$/.test(t) || BigInt(t) > MAX_MEMO_ID) {
      return { error: "A memo ID is a whole number from 0 to 18446744073709551615, digits only." };
    }
    return { memo: { type: "id", value: BigInt(t).toString() } };
  }
  const bytes = new TextEncoder().encode(t).length;
  if (bytes > textMaxBytes) {
    return {
      error: `A text memo is at most ${textMaxBytes} bytes; this one is ${bytes}. Use the memo exactly as the recipient gave it.`,
    };
  }
  return { memo: { type: "text", value: t } };
}
