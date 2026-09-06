/**
 * Keyless Cardano data + submission via Koios. All endpoints public, no
 * project key, no signup. Routed through `proxyGetJson` / `proxyPostJson`
 * so CORS is bypassed (Tauri webview origin is rejected by Koios's
 * Cloudflare WAF).
 *
 * Surface used by the wallet:
 *   - getEpochParams()       — fee coefficients (a, b) + max_tx_size
 *   - getCurrentTipSlot()    — TTL anchor for new txs
 *   - getAddressUtxos(addr)  — UTXO set at base address
 *   - getAddressBalance(addr)— lovelace at any address
 *   - submitTx(cborHex)      — broadcast a signed tx
 *
 * Koios routes all of these through `https://api.koios.rest/api/v1/...`.
 * The submission endpoint is the only POST that takes a non-JSON body
 * (raw CBOR bytes with content-type `application/cbor`); we use the Rust
 * proxy directly for that one to attach the right content-type.
 */

import { proxyGetJson, proxyPostJson, httpProxyCall } from "./_proxy";

const KOIOS_BASE = "https://api.koios.rest/api/v1";

export interface KoiosEpochParams {
  /** Per-byte fee coefficient. Currently 44. */
  min_fee_a: number;
  /** Constant fee floor. Currently 155381. */
  min_fee_b: number;
  /** Hard cap on tx size (bytes). Currently 16384. */
  max_tx_size: number;
  /** Slot length, ms. */
  slot_duration?: number;
  /** Min UTXO value (lovelace) — Cardano enforces a per-output minimum. */
  coins_per_utxo_size?: number;
  /** Effective epoch number this row describes. */
  epoch_no: number;
}

export interface KoiosUtxo {
  /** Hex tx hash producing this UTXO. */
  tx_hash: string;
  /** Output index in that tx. */
  tx_index: number;
  /** Lovelace value at this UTXO (string because Koios returns large numbers as strings). */
  value: string;
  /** Block-height of inclusion (so we can sort by age if we ever want to). */
  block_height?: number;
  /** Optional native-asset multi-asset payload. We send only ADA, so a UTXO
   *  with assets is skipped to avoid creating a token-burning transaction. */
  asset_list?: Array<{ policy_id: string; asset_name: string; quantity: string }>;
}

/** Latest epoch parameters. */
export async function getEpochParams(): Promise<KoiosEpochParams> {
  const rows = await proxyGetJson<KoiosEpochParams[]>(`${KOIOS_BASE}/epoch_params`);
  const row = rows[0];
  if (!row) throw new Error("Koios returned no epoch_params row");
  return row;
}

/** Latest tip slot — used to anchor TTLs. */
export async function getCurrentTipSlot(): Promise<number> {
  const rows = await proxyGetJson<Array<{ abs_slot: number }>>(`${KOIOS_BASE}/tip`);
  const slot = rows?.[0]?.abs_slot;
  if (typeof slot !== "number") throw new Error("Koios tip response missing abs_slot");
  return slot;
}

/**
 * UTXO set at a Cardano address. Koios's `address_info` returns one row
 * per address with a nested `utxo_set`; we return that flattened.
 */
export async function getAddressUtxos(address: string): Promise<KoiosUtxo[]> {
  type Row = {
    address: string;
    balance: string;
    utxo_set: KoiosUtxo[];
  };
  const rows = await proxyPostJson<Row[]>(`${KOIOS_BASE}/address_info`, {
    _addresses: [address],
  });
  if (!rows || rows.length === 0) return [];
  return rows[0].utxo_set ?? [];
}

/**
 * Lovelace balance at a Cardano address (works for both `addr1q…` and
 * `addr1v…`).
 *
 * THROWS on lookup failure — it does not report 0.
 *
 * Until 2026-08-13 this swallowed every error and returned 0, which made a
 * network failure indistinguishable from an empty address. Two consequences,
 * both bad:
 *   - the wallet displayed a confident "0.000000 ADA" when it had simply
 *     failed to ask, and a user can act on that ("my funds are gone");
 *   - `refreshAllBalances` writes "—" only when `getBalance` REJECTS, so a
 *     swallowed error could never surface as unknown, and the 60s balance
 *     poll re-swallowed it forever. That is the "ADA balance never refreshes"
 *     report: it wasn't stale, it was a failure wearing a zero's clothes.
 *
 * An address with no UTXOs legitimately returns 0 — that case comes back as a
 * row with balance "0" (or no row), and is still reported as 0 below. Only
 * genuine failures propagate.
 *
 * Probe callers that WANT "treat unreachable as empty" (the derivation
 * scanner) already wrap this in their own try/catch — see
 * `derivation-detector.ts::adaAddressBalance`.
 */
export async function getAddressBalance(address: string): Promise<number> {
  type Row = { balance?: string };
  // Throws on transport/HTTP failure (2026-08-22) — an unfunded address is
  // an empty row (→ 0), which is a different thing from "Koios is down".
  const rows = await proxyPostJson<Row[]>(`${KOIOS_BASE}/address_info`, {
    _addresses: [address],
  });
  const row = rows?.[0];
  // No row = address unseen on chain = genuinely empty. Distinct from a
  // failed request, which threw above.
  if (!row || row.balance == null) return 0;
  return Number(row.balance);
}

/**
 * Submit a fully-signed CBOR-encoded tx. Koios requires
 * `Content-Type: application/cbor` and a raw-bytes body.
 *
 * Returns the tx hash hex on success. On failure, parses Koios's
 * structured error and surfaces the message; the user can retry from
 * the wallet view.
 */
export async function submitTx(txCborBytes: Uint8Array): Promise<string> {
  // We send hex-of-bytes via the proxy because Tauri's IPC layer can't
  // ship raw binary cleanly. Koios accepts hex when content-type is
  // `application/cbor` (it decodes either way); the official spec
  // example uses raw bytes, but in practice the hex path works on every
  // Koios mirror we've tested.
  const url = `${KOIOS_BASE}/submittx`;
  const hexBody = Array.from(txCborBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const r = await httpProxyCall({
    method: "POST",
    url,
    body: hexBody,
    headers: {
      "Content-Type": "application/cbor",
      Accept: "application/json",
    },
  });
  if (r.status < 200 || r.status >= 300) {
    let message = r.body.slice(0, 500);
    try {
      const parsed = JSON.parse(r.body);
      if (parsed?.contents) message = JSON.stringify(parsed.contents).slice(0, 500);
      else if (parsed?.message) message = parsed.message;
    } catch {
      /* keep raw body */
    }
    throw new Error(`Koios submit failed (HTTP ${r.status}): ${message}`);
  }
  // The submit endpoint returns the tx hash as a JSON string.
  const trimmed = r.body.trim();
  return trimmed.startsWith('"') ? JSON.parse(trimmed) : trimmed;
}
