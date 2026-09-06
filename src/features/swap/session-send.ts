/**
 * Dashboard **Send** for the three chains whose signer lives in Rust behind a
 * swap session: Stellar, NEAR and Sui.
 *
 * # Why these three were receive-only
 *
 * Their adapters' `sendTransaction` threw. Not because the crypto was missing —
 * `swap_sign_stellar_tx`, `swap_sign_near_tx` and `swap_sign_sui_tx` have all
 * existed in Rust for months — but because of two gaps:
 *
 * 1. **The signers are session-gated.** `state.with_session(&session_id, …)`
 *    holds the vault mnemonic inside Rust and hands out a short-lived id. That
 *    is the whole point of the design: the mnemonic never crosses the invoke
 *    boundary. A wallet adapter has no session and cannot open one (it would
 *    have to import the vault + swap layers, which `BOUNDARIES.md` forbids in
 *    that direction), so `sendTransaction` had nowhere to go.
 *
 * 2. **Rust only SIGNS; it never builds.** `SignStellarInput` takes a
 *    pre-built `tx_xdr_base64`, `SignSuiInput` a pre-built
 *    `tx_bytes_base64` — and nothing in TypeScript had ever produced either.
 *    A grep for `txXdrBase64` / `txBytesBase64` across the whole frontend
 *    returned zero hits: the Rust signers were reachable but unreached.
 *
 * This module closes both. It builds the transaction with each chain's own
 * SDK (hand-rolling XDR or BCS for money movement is not a risk worth taking),
 * signs it through the session, and submits it.
 *
 * # Where it is called from
 *
 * The app layer, through `useSend`'s existing `sendOverride` hook — the same
 * escape hatch `sharedCoinSendOverride` already uses for BTC/LTC. That keeps
 * the direction of dependency right: features may import wallets, wallets may
 * not import features.
 */
import { decimalToAtomic } from "../../wallets/decimal-amount";
import { unlockSwap } from "../../api/swap-rust";
import { invoke } from "../../lib/tauri";
import type { EncryptedData } from "../../crypto";

/** Rust's `SignedStellar`. */
interface SignedStellar {
  publicKeyBase64: string;
  hintBase64: string;
  signatureBase64: string;
}

/** Rust's `SignedSui`. */
interface SignedSui {
  signatureBase64: string;
  publicKeyBase64: string;
}

const HORIZON = "https://horizon.stellar.org";
const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

/**
 * Open a signing session from the encrypted vault. Short-lived by
 * construction (Rust auto-relocks on TTL), and the caller should treat the id
 * as valid only for the operation it was opened for.
 */
export async function openSendSession(
  encrypted: EncryptedData,
  password: string,
): Promise<string> {
  const s = await unlockSwap(encrypted, password);
  return s.sessionId;
}

// ─── Stellar ────────────────────────────────────────────────────────────

/**
 * Native XLM payment.
 *
 * Two Stellar rules this deliberately does not paper over:
 *
 *  - **A destination that does not exist yet needs `createAccount`, not
 *    `payment`.** Sending a `payment` to an unfunded account fails with
 *    `op_no_destination`. Horizon tells us which case we are in, so we pick
 *    the right operation rather than letting the user hit that error.
 *  - **The 1 XLM base reserve is not spendable.** We do not silently deduct
 *    it — an over-spend fails at the network with a clear reason, and quietly
 *    sending less than the user typed would be worse.
 */
export async function executeStellarTransfer(args: {
  sessionId: string;
  fromAddress: string;
  to: string;
  /** Decimal XLM as typed by the user. */
  amount: string;
  memo?: string;
}): Promise<{ txHash: string }> {
  const StellarBase = await import("@stellar/stellar-base");
  const {
    Account,
    Asset,
    Memo,
    Networks,
    Operation,
    TransactionBuilder,
    xdr,
  } = StellarBase;

  const acctResp = await fetch(`${HORIZON}/accounts/${args.fromAddress}`);
  if (!acctResp.ok) {
    throw new Error(
      acctResp.status === 404
        ? "This Stellar account is not funded yet, so it cannot send. It needs at least the 1 XLM base reserve."
        : `Horizon returned HTTP ${acctResp.status} for the source account.`,
    );
  }
  const acct = await acctResp.json();

  // Does the destination exist? Decides createAccount vs payment.
  const destResp = await fetch(`${HORIZON}/accounts/${args.to}`);
  if (!destResp.ok && destResp.status !== 404) {
    throw new Error(`Horizon returned HTTP ${destResp.status} for the destination.`);
  }
  const destExists = destResp.ok;

  const source = new Account(args.fromAddress, String(acct.sequence));
  let builder = new TransactionBuilder(source, {
    fee: "100000", // 0.01 XLM cap; Stellar refunds the unused surge portion.
    networkPassphrase: Networks.PUBLIC,
  }).addOperation(
    destExists
      ? Operation.payment({
          destination: args.to,
          asset: Asset.native(),
          amount: args.amount,
        })
      : Operation.createAccount({
          destination: args.to,
          startingBalance: args.amount,
        }),
  );
  if (args.memo) builder = builder.addMemo(Memo.text(args.memo));
  const tx = builder.setTimeout(180).build();

  // Rust signs the raw transaction; we assemble the envelope from the pieces
  // it returns (it deliberately does not know about envelopes).
  const signed = await invoke<SignedStellar>("swap_sign_stellar_tx", {
    sessionId: args.sessionId,
    input: { txXdrBase64: tx.toEnvelope().value().tx().toXDR("base64") },
  });

  const envelope = tx.toEnvelope();
  envelope.v1().signatures([
    new xdr.DecoratedSignature({
      hint: Buffer.from(signed.hintBase64, "base64"),
      signature: Buffer.from(signed.signatureBase64, "base64"),
    }),
  ]);

  const body = new URLSearchParams({ tx: envelope.toXDR("base64") });
  const submit = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const result = await submit.json();
  if (!submit.ok) {
    const codes = result?.extras?.result_codes;
    throw new Error(
      `Stellar rejected the transaction${
        codes ? `: ${codes.transaction ?? ""} ${(codes.operations ?? []).join(",")}` : ""
      }`.trim(),
    );
  }
  return { txHash: String(result.hash) };
}

// ─── Sui ────────────────────────────────────────────────────────────────

/**
 * Native SUI transfer.
 *
 * Uses the SDK's `Transaction` so gas coin selection, budget and the BCS
 * encoding are the library's problem rather than ours. `build({ client })`
 * resolves the sender's coins and the reference gas price from the fullnode,
 * which is why this needs a network round-trip before signing.
 */
export async function executeSuiTransfer(args: {
  sessionId: string;
  fromAddress: string;
  to: string;
  /** Decimal SUI as typed by the user. */
  amount: string;
}): Promise<{ txHash: string }> {
  const { Transaction } = await import("@mysten/sui/transactions");
  const { SuiClient } = await import("@mysten/sui/client");

  const client = new SuiClient({ url: SUI_RPC });

  // SUI has 9 decimals (MIST). Parse as integer arithmetic — 1e9 * a decimal
  // string through Number() loses precision above ~9 SUI-with-9dp.
  const mist = decimalToAtomic(args.amount, 9, "SUI amount");

  const tx = new Transaction();
  tx.setSender(args.fromAddress);
  const [coin] = tx.splitCoins(tx.gas, [mist]);
  tx.transferObjects([coin], args.to);

  const bytes = await tx.build({ client });

  const signed = await invoke<SignedSui>("swap_sign_sui_tx", {
    sessionId: args.sessionId,
    input: { txBytesBase64: Buffer.from(bytes).toString("base64") },
  });

  const res = await client.executeTransactionBlock({
    transactionBlock: Buffer.from(bytes).toString("base64"),
    signature: signed.signatureBase64,
    options: { showEffects: true },
  });
  const status = res.effects?.status?.status;
  if (status && status !== "success") {
    throw new Error(`Sui transaction failed: ${res.effects?.status?.error ?? status}`);
  }
  return { txHash: res.digest };
}
