/**
 * TypeScript bindings for the Rust signing core.
 *
 * Every call here keeps key material in the Rust process. The webview only
 * ever sees: the `sessionId` token (random hex, not derived from the seed),
 * public addresses, and signed-tx blobs (which are safe to broadcast).
 *
 * NEVER add a binding here that returns a mnemonic, seed bytes, or raw
 * private key. The Rust core also lacks any such command — both layers
 * agree on this constraint.
 */
import { invoke } from "../lib/tauri";
import type { EncryptedData } from "../crypto";

export interface UnlockResp {
  sessionId: string;
  expiresAt: string; // ISO8601
}

export interface Addresses {
  eth: string;
  btc: string;
  near: string; // "ed25519:<base58>"
  sol: string;  // base58
}

export interface SignedHex {
  rawTx: string;
}

export interface SignedNep413 {
  standard: "nep413";
  payload: {
    message: string;
    nonce: string; // base64
    recipient: string;
    callbackUrl?: string;
  };
  publicKey: string; // ed25519:<base58>
  signature: string; // base64
}

export interface SignedSolana {
  publicKey: string; // base58
  signature: string; // base58
}

export interface UnsignedEvmTxFromProxy {
  chainId: number;
  nonce?: number | string;
  from?: string;
  to: string;
  value?: string | number;
  data?: string;
  /** Required by the Rust signer; aliases `gasLimit`/`gas` from upstream. */
  gas?: number | string;
  gasLimit?: number | string;
  gasPrice?: number | string;
  maxFeePerGas?: number | string;
  maxPriorityFeePerGas?: number | string;
}

/** Unlock the swap signing session. Idempotent w.r.t. the encrypted vault. */
export async function unlockSwap(
  encrypted: EncryptedData,
  password: string
): Promise<UnlockResp> {
  return invoke<UnlockResp>("swap_unlock", { encrypted, password });
}

export async function lockSwap(): Promise<void> {
  await invoke<void>("swap_lock");
}

export async function getSwapAddresses(sessionId: string): Promise<Addresses> {
  return invoke<Addresses>("swap_get_addresses", { sessionId });
}

/** UTXO chain hint used by the new multi-chain commands. Matches the
 *  Rust enum's serde lowercase representation. Phase 5 (2026-05-08)
 *  added "dash". */
export type UtxoChain = "btc" | "ltc" | "doge" | "bch" | "dash";

export async function getUtxoAddress(
  sessionId: string,
  chain: UtxoChain,
  account = 0,
  index = 0
): Promise<string> {
  return invoke<string>("swap_get_utxo_address", { sessionId, chain, account, index });
}

export async function getSolanaAddress(sessionId: string): Promise<string> {
  return invoke<string>("swap_get_solana_address", { sessionId });
}

export interface NearAddress {
  /** 64-char hex (the implicit account / funding target). */
  accountId: string;
  /** `ed25519:<base58>` form. */
  publicKey: string;
}

export async function getNearAddress(sessionId: string): Promise<NearAddress> {
  return invoke<NearAddress>("swap_get_near_address", { sessionId });
}

export async function signEvm(
  sessionId: string,
  tx: UnsignedEvmTxFromProxy,
  account = 0,
  index = 0
): Promise<SignedHex> {
  return invoke<SignedHex>("swap_sign_evm", { sessionId, account, index, tx });
}

export async function signPsbt(
  sessionId: string,
  psbtHex: string,
  chain: UtxoChain = "btc"
): Promise<SignedHex> {
  return invoke<SignedHex>("swap_sign_psbt", { sessionId, psbtHex, chain });
}

export interface SignNep413Input {
  message: string;
  nonce: string; // base64 of 32 bytes
  recipient: string;
  callbackUrl?: string;
}

export async function signNearIntent(
  sessionId: string,
  input: SignNep413Input
): Promise<SignedNep413> {
  return invoke<SignedNep413>("swap_sign_near_intent", { sessionId, input });
}

export async function signSolanaMessage(
  sessionId: string,
  messageB64OrHex: string
): Promise<SignedSolana> {
  return invoke<SignedSolana>("swap_sign_solana", {
    sessionId,
    input: { message: messageB64OrHex },
  });
}

/**
 * Broadcast a signed transaction directly to a chain RPC. The proxy is NOT
 * involved — it never sees signed bytes (per the non-custodial contract).
 *
 * @param chainKind one of "EVM" | "UTXO"|"BTC"|"LTC"|"DOGE"|"BCH" | "SOLANA"|"SOL" | "NEAR"
 */
export async function broadcastTx(
  chainKind: string,
  rpcUrl: string,
  rawTx: string
): Promise<string> {
  return invoke<string>("swap_broadcast", {
    input: { chainKind, rpcUrl, rawTx },
  });
}

/**
 * Verified EVM broadcast — iterates through `rpcUrls` in Rust, runs
 * `eth_sendRawTransaction` + `eth_getTransactionByHash` against each
 * node, and returns the hash only when the SAME node confirms the tx
 * is in its pool view. The hash is then provably real, not a node-
 * computed forgery from a rate-limited submission that never
 * propagated.
 *
 * Use this for every EVM broadcast that moves real money. The plain
 * `broadcastTx` stays for non-critical paths and for non-EVM chains.
 *
 * Throws an `Error` whose message includes the per-URL audit trail
 * when every URL fails. The UI surfaces this via the modal's error
 * banner so the user gets actionable diagnostics.
 */
export interface VerifiedBroadcastResult {
  txHash: string;
  urlUsed: string;
  attempts: Array<{ url: string; stage: "broadcast" | "verify"; error: string }>;
}

export async function broadcastEvmVerified(
  rpcUrls: string[],
  rawTxHex: string
): Promise<VerifiedBroadcastResult> {
  return invoke<VerifiedBroadcastResult>("swap_evm_broadcast_verified", {
    input: { rpcUrls, rawTxHex },
  });
}
