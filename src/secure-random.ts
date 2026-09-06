/**
 * Secure entropy for wallet seed generation, sourced from the OS CSPRNG via
 * the Rust backend (see `src-tauri/src/secure_random.rs`).
 *
 * Why not just `crypto.getRandomValues` here?
 *   - WebCrypto in Tauri's WebView2 is OS-backed and correct on Windows,
 *     but routing seed entropy through Rust gives us:
 *     1. A trivially auditable trust boundary (one Rust function).
 *     2. Insulation from any future WebView sandboxing/timing surprises.
 *     3. A natural place to bolt on `zeroize`-on-drop later if the seed
 *        ever moves fully server-side.
 *   - This helper is for SEED entropy specifically. AES-GCM nonces and
 *     PBKDF2 salts (`src/crypto.ts`) still use WebCrypto — they're not
 *     long-lived secrets and the round-trip would just add latency.
 */

import { invoke } from "./lib/tauri";

/**
 * Pull `byteCount` bytes of cryptographically secure entropy from the OS
 * via the `generate_seed_entropy` Tauri command.
 *
 * - `byteCount` must be in `[1, 64]`. The Rust side enforces the same bound
 *   and will error on out-of-range requests; the upfront check here gives
 *   a faster, JS-side error message for misuse.
 * - The IPC layer serializes the bytes as a `number[]`; we wrap them back
 *   into a `Uint8Array` so callers get the same shape as
 *   `crypto.getRandomValues` returns.
 * - Throws on IPC failure or OS-RNG-syscall failure (extraordinarily rare).
 *
 * Used by:
 *   - BIP39 mnemonic generation in `App.tsx` (16 bytes)
 *   - `xmr-keys.ts::generateXmrSeed` (32 bytes → reduce32)
 *   - `polyseed.ts::generatePolyseed` (19 bytes → top-2-bits cleared)
 *   - `zph-keys.ts::generateZephyrSeed` (delegates to `generateXmrSeed`)
 */
export async function secureRandomBytes(byteCount: number): Promise<Uint8Array> {
  if (!Number.isInteger(byteCount) || byteCount < 1 || byteCount > 64) {
    throw new Error(
      `secureRandomBytes: byteCount must be an integer in [1, 64], got ${byteCount}`
    );
  }
  const bytes = await invoke<number[]>("generate_seed_entropy", { byteCount });
  if (!Array.isArray(bytes) || bytes.length !== byteCount) {
    throw new Error(
      `secureRandomBytes: backend returned ${bytes?.length ?? "non-array"} bytes, expected ${byteCount}`
    );
  }
  return new Uint8Array(bytes);
}

/** Constant-time byte-array equality. Used by post-generation sanity checks. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
