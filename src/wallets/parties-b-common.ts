/**
 * Small helpers shared by the `getTransactionParties` implementations of the
 * account-model and eUTXO chains (XRP, Stellar, Sui, Aptos, NEAR, Cardano,
 * Algorand, Hedera, Conflux, Ergo) and the sidecar chains, 2026-09-30. See
 * `TxParties` in `types.ts` for the contract. No imports on purpose: every
 * adapter can use these without pulling another module into its graph.
 */

/**
 * Addresses in first-seen order, with empty values and repeats dropped. The
 * contract asks for the chain's own order, duplicates removed.
 */
export function uniqueAddresses(list: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") continue;
    const a = v.trim();
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/** The host of any `scheme://host/...` URL (wss:// included), or the input. */
export function urlHost(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1] : url;
}
