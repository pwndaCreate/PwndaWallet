import { mnemonicToSeedSync } from "@scure/bip39";
import { blake2b } from "@noble/hashes/blake2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bech32 } from "@scure/base";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
} from "./types";
import { proxyPostJson, proxyGetJson } from "./_proxy";
import { deriveCardanoKeySet } from "./cardano-cip1852";
import { sendAda } from "./cardano-tx";
import { getAddressBalance } from "./cardano-koios";

// Koios is a community-run, keyless Cardano API. Used for everything
// network-side (balance, history, params). The legacy Blockfrost path
// stays around as a fallback only because some users may have a key.
const KOIOS_BASE = "https://api.koios.rest/api/v1";

const BLOCKFROST_API = "https://cardano-mainnet.blockfrost.io/api/v0";
// Blockfrost requires a per-project API key for ALL endpoints — there
// is no anonymous tier. Without a key every request 403s and gets
// auto-logged by the browser. We short-circuit to avoid the network
// roundtrip + grouped-warn once per session so the console isn't
// spammed. Set `VITE_BLOCKFROST_KEY` in `.env.local` to get real
// Cardano balance + history.
const BLOCKFROST_KEY = (import.meta.env.VITE_BLOCKFROST_KEY as string | undefined) ?? "";

let _blockfrostWarned = false;
function warnBlockfrostMissingKeyOnce(): void {
  if (_blockfrostWarned) return;
  _blockfrostWarned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[network] cardano: no Blockfrost project key configured. ADA balance " +
      "+ history are unavailable. Set VITE_BLOCKFROST_KEY in .env.local " +
      "(free tier at https://blockfrost.io) to enable.",
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * LEGACY pre-2026-05-06 Cardano derivation. Used ONLY for the Wallet
 * Details "Legacy ADA address" panel so users with stranded funds at
 * the old non-standard derivation can still find them. Do NOT call
 * this for new flows — `deriveCardanoKeySet` (CIP-1852, matches Exodus)
 * is the standard.
 *
 * What this used to do (kept verbatim for compatibility):
 *   1. Hash the BIP-39 seed (NOT entropy) with blake2b-32 → private key
 *   2. Standard RFC-8032 Ed25519 public key (hash-then-sign, NOT
 *      BIP-32-Ed25519 scalar)
 *   3. Compose a TYPE-0x61 mainnet ENTERPRISE address (no stake credential)
 *
 * Result: an `addr1v…` address that no other wallet produces.
 */
function deriveLegacyKeysFromMnemonic(mnemonic: string): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const edSeed = blake2b(seed, { dkLen: 32 });
  const privateKey = edSeed;
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Legacy enterprise-address composition. Type 0x61 = enterprise, mainnet. */
function legacyPublicKeyToAddress(publicKey: Uint8Array): string {
  const keyHash = blake2b(publicKey, { dkLen: 28 });
  const addressBytes = new Uint8Array(1 + 28);
  addressBytes[0] = 0x61;
  addressBytes.set(keyHash, 1);
  return bech32.encode("addr", bech32.toWords(addressBytes), 1023);
}

export const adaAdapter: ChainAdapter = {
  chain: "cardano",
  displayName: "Cardano",
  ticker: "ADA",
  color: "#4a8bf0",
  addressPlaceholder: "addr1...",
  derivation: {
    kind: "bip39",
    path: "m/1852'/1815'/0'/0/0",
    standard: "CIP-1852 — Yoroi, Eternl, Daedalus",
    hasAlternatives: true,
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    // Cardano private-key import is intentionally limited to the
    // "single ed25519 secret → enterprise address" path, since base
    // addresses require BOTH a payment key AND a stake key (which are
    // independent extended keys, not derivable from one another). A
    // raw private key is therefore insufficient to reconstruct the
    // standard `addr1q…` address — users must import via mnemonic to
    // get a CIP-1852 wallet that matches Exodus.
    const privKeyBytes = hexToBytes(privateKey);
    const publicKey = ed25519.getPublicKey(privKeyBytes);
    const address = legacyPublicKeyToAddress(publicKey);
    return {
      chain: "cardano",
      address,
      mnemonic: "",
      privateKey: bytesToHex(privKeyBytes),
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    // Standard CIP-1852 + Icarus + base address. Matches Exodus, Eternl,
    // Yoroi, AdaLite, Daedalus, Lace, Trezor (Cardano), Ledger (Cardano)
    // byte-for-byte.
    const ks = deriveCardanoKeySet(mnemonic);
    return {
      chain: "cardano",
      address: ks.address,
      mnemonic: mnemonic.trim(),
      // Store the payment private key only. The stake key can be
      // re-derived from the mnemonic at signing time. Both halves of
      // the CIP-1852 derivation are recoverable, so this is just a
      // display value.
      privateKey: ks.paymentPrivateKey,
    };
  },

  async getBalance(address: string): Promise<string> {
    // Keyless balance via Koios `/address_info`. Works for both the
    // standard `addr1q…` base address and the legacy `addr1v…` enterprise
    // address. Routed through the Rust http proxy so the Tauri webview
    // origin doesn't trigger CORS rejection.
    //
    // Optional Blockfrost path is preserved for users with a project
    // key — slightly more granular response shape if the user supplies
    // one — but defaults to Koios so the wallet works out-of-the-box.
    if (BLOCKFROST_KEY) {
      try {
        const resp = await fetch(`${BLOCKFROST_API}/addresses/${address}`, {
          headers: { project_id: BLOCKFROST_KEY },
        });
        if (resp.ok) {
          const data = await resp.json();
          const lovelace = data.amount?.find(
            (a: any) => a.unit === "lovelace"
          );
          const balance = lovelace ? Number(lovelace.quantity) : 0;
          return (balance / 1_000_000).toFixed(6);
        }
        if (resp.status === 404) return "0.000000";
      } catch {
        /* fall through to Koios */
      }
    }
    // No catch→"0" here (2026-08-22): a Koios outage used to render as a zero
    // balance, indistinguishable from an empty wallet. A failure must REJECT so
    // the caller shows "—" (unknown) rather than "0.000000" (confidently empty);
    // the dashboard keeps the last-known value and logs the chain. See
    // `cardano-koios.ts::getAddressBalance` for why that distinction matters.
    const lovelace = await getAddressBalance(address);
    return (lovelace / 1_000_000).toFixed(6);
  },

  async sendTransaction(
    keyMaterial: string,
    to: string,
    amount: string
  ): Promise<TxResult> {
    // BIP-32-Ed25519 signing requires the FULL extended secret AND the
    // chain code, which can only be re-derived from the mnemonic. The
    // 64-byte payment private-key hex returned by import paths doesn't
    // carry the chain code, so it cannot sign Cardano txs on its own.
    //
    // `useSend` (`src/features/send/useSend.ts`) routes Cardano sends
    // with `keyMaterial = wallet.mnemonic` rather than the private key.
    // If a caller bypasses that and passes raw hex, surface the mismatch
    // explicitly rather than silently mis-signing.
    const looksLikeMnemonic =
      /\s/.test(keyMaterial.trim()) &&
      keyMaterial.trim().split(/\s+/).length >= 12;
    if (!looksLikeMnemonic) {
      throw new Error(
        "Cardano send requires the wallet's BIP-39 mnemonic — BIP-32-Ed25519 " +
          "signing needs the chain code, which a raw payment private key " +
          "doesn't carry. Use the dashboard's Send button (which reads the " +
          "mnemonic from the unlocked vault)."
      );
    }
    // Re-derive the source address from the mnemonic so callers don't
    // have to thread the wallet's display address through; this also
    // protects against caller mismatch where the address and mnemonic
    // are out of sync.
    const ks = deriveCardanoKeySet(keyMaterial);
    const result = await sendAda({
      mnemonic: keyMaterial,
      fromAddress: ks.address,
      toAddress: to,
      amountAda: amount,
    });
    return { hash: result.txHash };
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      // Koios `tip` returns the latest block; the epoch is on it.
      const data = await proxyGetJson<Array<{ epoch_no: number }>>(
        `${KOIOS_BASE}/tip`
      );
      const epoch = data?.[0]?.epoch_no;
      return {
        label: "Epoch",
        value: epoch !== undefined ? String(epoch) : "N/A",
        unit: "",
      };
    } catch {
      return { label: "Network", value: "Mainnet", unit: "" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    // Koios POST /address_txs takes a body with the address list. Cursor
    // is the lower-bound block number to page further back.
    const body: any = { _addresses: [address] };
    if (opts?.cursor) body._after_block_height = Number(opts.cursor);
    const list = await proxyPostJson<Array<{ tx_hash: string; block_height: number; block_time: number }>>(
      `${KOIOS_BASE}/address_txs`,
      body
    );
    const sliced = list.slice(0, limit);
    if (sliced.length === 0) return { items: [] };

    // Koios `tx_info` returns full tx detail in batch.
    const detail = await proxyPostJson<any[]>(`${KOIOS_BASE}/tx_info`, {
      _tx_hashes: sliced.map((t) => t.tx_hash),
      _inputs: false,
      _metadata: false,
      _assets: false,
      _withdrawals: false,
      _certs: false,
      _scripts: false,
      _bytecode: false,
    });
    const detailByHash = new Map(detail.map((d) => [d.tx_hash, d]));

    const items: ChainTx[] = sliced.map((row) => {
      const d = detailByHash.get(row.tx_hash);
      // Compute net lovelace flow on `address` from the outputs.
      let inToMe = 0n;
      let outFromMe = 0n;
      let counterparty: string | undefined;
      for (const o of d?.outputs ?? []) {
        if (o.payment_addr?.bech32 === address) {
          inToMe += BigInt(o.value ?? 0);
        } else if (!counterparty && o.payment_addr?.bech32) {
          counterparty = o.payment_addr.bech32;
        }
      }
      // Inputs: Koios omits prev-output values in this lean call, so we
      // approximate direction by whether anything came back to us. A
      // detail drawer can pull `_inputs: true` for full accounting.
      const direction: ChainTx["direction"] = inToMe > 0n ? "in" : "out";
      const amount = direction === "in"
        ? (Number(inToMe) / 1_000_000).toFixed(6)
        : (Number(outFromMe || inToMe) / 1_000_000).toFixed(6);
      const fee = d?.fee ? (Number(d.fee) / 1_000_000).toFixed(6) : undefined;
      return {
        chain: "cardano",
        hash: row.tx_hash,
        direction,
        amount,
        fee: direction === "out" ? fee : undefined,
        timestamp: row.block_time,
        height: row.block_height,
        counterparty,
        meta: { epoch_no: d?.epoch_no, slot: d?.absolute_slot },
      };
    });

    const cursor =
      sliced.length === limit ? String(sliced[sliced.length - 1].block_height) : undefined;
    return { items, cursor };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    // Cardano fees are deterministic: min_fee_a * tx_size + min_fee_b.
    // We surface the per-tx baseline for a typical 200-byte payment.
    const params = await proxyGetJson<Array<{ min_fee_a: number; min_fee_b: number }>>(
      `${KOIOS_BASE}/epoch_params`
    );
    const p = params?.[0];
    const a = p?.min_fee_a ?? 44;
    const b = p?.min_fee_b ?? 155381;
    const size = 200;
    const lovelace = a * size + b;
    return {
      normal: { value: (lovelace / 1_000_000).toFixed(6) },
      unit: "ADA",
      fetchedAt: Date.now(),
      raw: { min_fee_a: a, min_fee_b: b, assumed_size: size },
    };
  },
};

/**
 * Derive the legacy `addr1v…` enterprise address that pre-2026-05-06
 * PwndaWallet builds produced from this mnemonic. Used by the
 * AdaLegacyPanel to surface funds stranded at the non-standard derivation.
 */
export function deriveLegacyAdaFromMnemonic(mnemonic: string): WalletInfo {
  const { privateKey, publicKey } = deriveLegacyKeysFromMnemonic(mnemonic);
  const address = legacyPublicKeyToAddress(publicKey);
  return {
    chain: "cardano",
    address,
    mnemonic: mnemonic.trim(),
    privateKey: bytesToHex(privateKey),
  };
}

/**
 * Query the legacy enterprise address's lovelace balance via Koios's
 * keyless `/address_info` POST endpoint. Returns lovelace as a number;
 * 0 if the address has never been seen on-chain.
 *
 * Koios is the only keyless option here — Blockfrost requires a project
 * id even for read-only queries. If Koios is unreachable we return 0
 * rather than throw, since the only consumer is a "should we surface
 * the legacy panel?" gate where a false-negative is acceptable (the
 * user will simply not see the panel; they can re-check later).
 */
export async function getLegacyAdaBalanceLovelace(legacyAddress: string): Promise<number> {
  try {
    const data = await proxyPostJson<Array<{ balance?: string }>>(
      `${KOIOS_BASE}/address_info`,
      { _addresses: [legacyAddress] }
    );
    const row = data?.[0];
    if (!row || !row.balance) return 0;
    return Number(row.balance);
  } catch {
    return 0;
  }
}
