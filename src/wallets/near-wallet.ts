/**
 * NEAR (NEAR Protocol) ChainAdapter.
 *
 * NEAR uses ed25519 keypairs derived via SLIP-10 at `m/44'/397'/0'`
 * (3 hardened steps — the NEAR CLI / Ledger convention). The implicit
 * account ID is `hex(public_key)` — a 64-character lowercase hex string
 * that is BOTH the account name and the deposit address for unfunded
 * accounts.
 *
 * Algorithm parity: this TS adapter produces byte-for-byte identical
 * addresses to the Rust `derive::near_implicit_account` function in
 * `src-tauri/src/swap/derive.rs:340` (the path `m/44'/397'/0'` and the
 * ed25519 public-key form are identical). The Rust path remains in
 * place for swap source-tx signing (`swap_sign_near_tx`), which still
 * needs the session-gated keypair access for actual transaction bytes.
 * This adapter only does what every chain adapter does: derive the
 * address at vault-load so it lands in `WalletsByChain.near` and is
 * available to the dashboard, the swap form, and the registry-driven
 * `addressForTicker` resolver — no Rust session needed.
 *
 * Pre-2026-05-25 the address derivation was Rust-only and gated behind
 * `swap_unlock`. That meant `WalletsByChain.near` was never populated
 * by `useVault.deriveAllChains`, which in turn meant
 * `addressForTicker("NEAR", wallets)` returned null, which collapsed
 * `SwapView.confirmReady` to false for any NEAR-source pair — the
 * exact bug class as the CARDANO blocker resolved earlier the same
 * day. Deriving in TS unblocks it.
 *
 * In v1.x NEAR is destination-and-address-only here — `getBalance`,
 * `sendTransaction`, `getTransactionHistory`, etc. are stubs that
 * report zero / "Not implemented". Source-tx flow for NEAR Intents
 * still runs through the Rust `swap_sign_near_tx` + `executeNearNativeTransfer`
 * path; this adapter just exists so the address shows up everywhere
 * else the wallet expects a chain entry.
 */

import { mnemonicToSeedSync } from "@scure/bip39";
import { derivePath } from "ed25519-hd-key";
import { ed25519 } from "@noble/curves/ed25519.js";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
} from "./types";

const DERIVATION_PATH = "m/44'/397'/0'";

function deriveKeypair(mnemonic: string, path: string = DERIVATION_PATH): {
  secret: Uint8Array;
  publicKey: Uint8Array;
} {
  const seed = mnemonicToSeedSync(mnemonic);
  const seedHex = Buffer.from(seed).toString("hex");
  const { key } = derivePath(path, seedHex);
  const publicKey = ed25519.getPublicKey(key);
  return { secret: new Uint8Array(key), publicKey };
}

/**
 * NEAR implicit account ID = hex-encoded ed25519 public key.
 * 64 lowercase hex characters.
 */
function nearImplicitAccount(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("hex");
}

export const nearAdapter: ChainAdapter = {
  chain: "near",
  displayName: "NEAR Protocol",
  ticker: "NEAR",
  color: "#00c08b",
  addressPlaceholder: "<64-char hex implicit account>",
  derivation: {
    kind: "bip39",
    path: "m/44'/397'/0'",
    standard: "NEAR CLI convention — 3 hardened steps, ed25519",
    hasAlternatives: false,
  },
  /** Arbitrary-path derivation — powers the generic finder + funded-path scan. */
  deriveAtPath(mnemonic: string, path: string): WalletInfo {
    const { secret, publicKey } = deriveKeypair(mnemonic, path);
    return {
      chain: "near",
      address: nearImplicitAccount(publicKey),
      mnemonic,
      privateKey: Buffer.from(secret).toString("hex"),
    };
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    // NEAR private keys are typically expressed as `ed25519:<base58>`
    // (64-byte expanded form) but we accept the raw 32-byte hex seed
    // shape here for symmetry with the other ed25519 adapters. The
    // 64-byte expanded import path can be added when a user actually
    // needs it.
    const clean = privateKey.startsWith("0x")
      ? privateKey.slice(2)
      : privateKey;
    const secret = new Uint8Array(clean.length / 2);
    for (let i = 0; i < secret.length; i++) {
      secret[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    if (secret.length !== 32) {
      throw new Error("NEAR secret must be 32 bytes");
    }
    const publicKey = ed25519.getPublicKey(secret);
    return {
      chain: "near",
      address: nearImplicitAccount(publicKey),
      mnemonic: "",
      privateKey: clean,
    };
  },

  deriveFromMnemonic(mnemonic: string): WalletInfo {
    const { secret, publicKey } = deriveKeypair(mnemonic);
    return {
      chain: "near",
      address: nearImplicitAccount(publicKey),
      mnemonic,
      privateKey: Buffer.from(secret).toString("hex"),
    };
  },

  async getBalance(_address: string): Promise<string> {
    // v1.x: balance fetch not wired. Returning "0" rather than a real
    // RPC call so the dashboard renders the row instead of hanging on
    // a loading state. Wire up `account_view` RPC + yoctoNEAR formatting
    // when NEAR balance reads are needed.
    return "0";
  },

  async sendTransaction(): Promise<TxResult> {
    // NEAR source-tx broadcast flows through
    // `swap-sources.ts::executeNearNativeTransfer`, which uses the
    // session-gated Rust signer (`swap_sign_near_tx`). The
    // dashboard's generic Send button is not wired for NEAR in v1.x.
    // Reachable only if something bypasses the app-layer override. The
    // dashboard Send for this chain goes through `sessionSignedSendOverride`
    // in App.tsx -> `features/swap/session-send.ts`, because the signer is
    // session-gated in Rust and an adapter cannot open a session without
    // importing the vault + swap layers (BOUNDARIES.md forbids that
    // direction). Wired 2026-09-02; before then this chain was receive-only.
    throw new Error(
      "NEAR send must go through the app-layer session override (App.tsx -> executeNearNativeTransfer) — the signer is session-gated."
    );
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    // No RPC call — adapters that can't reach a network return a
    // placeholder rather than block the dashboard's network-info row.
    return { label: "Network", value: "mainnet", unit: "" };
  },

  async getTransactionHistory(): Promise<TxHistoryPage> {
    return { items: [] as ChainTx[] };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    return {
      normal: { value: "0.0001" },
      unit: "NEAR",
      fetchedAt: Date.now(),
    };
  },
};
