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
