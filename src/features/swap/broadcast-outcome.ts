/**
 * After a swap deposit is SIGNED, was a failed broadcast a refusal or an
 * unknown? (2026-09-29 send-safety audit, F2.)
 *
 * The distinction decides what the user is told. A refusal — a node answered
 * the submission with an error — means nothing went out, and a new quote is a
 * safe way to try again. Anything else (a timeout, a dropped connection, a 5xx
 * from a gateway, a node that accepted the bytes and then could not find them)
 * means the deposit MAY be on the network, and the only safe instruction is
 * "check this hash before doing anything else" — the rule every send path in
 * the wallet follows (`wallets/send-outcome.ts`).
 *
 * Misclassifying in the "refused" direction is the expensive mistake: the user
 * re-quotes, deposits again, and pays twice if the first one landed. So a
 * message is a refusal ONLY when it positively looks like one, and anything
 * that hints the transaction is already known to the network overrides that.
 */

/** Wording that says the node already has this transaction (or one using the
 *  same inputs / nonce) — never a refusal, whatever else the text says. */
const MAY_BE_ON_NETWORK =
  /already|known transaction|txn-mempool-conflict|duplicate|exists|nonce too low|replacement|in the mempool|in block ?chain/i;

/** Transport-level failures: the request may have been delivered. */
const TRANSPORT =
  /network error|timed? ?out|timeout|abort|econn|enotfound|fetch failed|socket|connection (reset|closed|refused)|RPC returned 5\d\d|HTTP 5\d\d|\b50[0-9]\b|response parse error|verification call failed|returned null on the same node/i;

/** A node or API answered the submission with a definite rejection. */
const REFUSAL =
  /RPC returned 4\d\d|HTTP 4\d\d|RPC error:|simulation failed|insufficient|bad-txns|min relay fee|mempool min fee|dust|non-final|invalid|rejected|intrinsic gas|exceeds block gas limit|blockcypher push:|blockchair:|sendrawtransaction/i;

/** True only when `message` positively reads as the node refusing the tx. */
export function isDefinitiveBroadcastRefusal(message: string): boolean {
  const m = String(message ?? "");
  if (!m.trim()) return false;
  if (MAY_BE_ON_NETWORK.test(m)) return false;
  if (TRANSPORT.test(m)) return false;
  return REFUSAL.test(m);
}

/**
 * The Rust verified-broadcast error (`swap_evm_broadcast_verified`) is a
 * headline plus one `  <url> (<stage>): <error>` line per RPC tried. True only
 * when EVERY RPC refused at the broadcast stage. A "verify" line means a node
 * accepted the bytes (it returned a hash) and then could not show them — the
 * transaction may well be in a mempool somewhere.
 */
export function evmBroadcastRefusedEverywhere(message: string): boolean {
  const lines = String(message ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const attempts = lines
    .map((l) => l.match(/^(\S+) \((broadcast|verify)\): (.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null);
  if (attempts.length === 0) return false;
  return attempts.every(
    (m) => m[2] === "broadcast" && isDefinitiveBroadcastRefusal(m[3]),
  );
}

/** Stringify a thrown value (Tauri rejects with plain strings). */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(e);
}

/** Reject after `ms` with a timeout error; the original promise keeps running. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
