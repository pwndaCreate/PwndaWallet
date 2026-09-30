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
