/**
 * **C2 — daemon-direct routing.** Typed bindings for `src-tauri/src/swap_daemon.rs`.
 *
 * These are the only commands in the convergence that talk to a coin daemon's
 * *own* JSON-RPC socket instead of going through the BasicSwap engine's HTTP
 * API. That exists because the engine's send path cannot express a fee — no
 * `fee_rate`, no `conf_target` — and a swap-node send that cannot be priced is
 * a send that can sit unconfirmed through a swap's timeout window.
 *
 * # Everything here is refused by default
 *
 * Each gate is enforced **Rust-side**; the constants below are mirrors so the
 * UI can explain a refusal, never a substitute for it:
 *
 * | gate | effect |
 * |---|---|
 * | `PWNDA_SWAP_ROUTING != "1"` | all three commands return {@link DAEMON_ROUTING_DISABLED} |
 * | `dryRun: false` off regtest | additionally requires `PWNDA_SWAP_ROUTING_MAINNET=1` |
 * | non-loopback daemon host | refused |
 * | sidecar phase != healthy | refused |
 * | method not in Rust's `DAEMON_METHODS` | refused **before a socket opens** |
 *
 * The webview can never name an RPC method: `swap_daemon_send` takes a
 * *request*, not a method, and every `daemon_rpc` call site inside Rust passes
 * a string literal. That is the property that keeps `walletpassphrase`,
 * `dumpprivkey` and `sethdseed` unreachable from here (contract §R7), and it is
 * why this file has no `daemonRpc(method, params)` escape hatch. Do not add
 * one.
 *
 * # Casing (contract §0.1)
 *
 * Everything in this file is the **Rust-struct regime**: our own structs carry
 * `#[serde(rename_all = "camelCase")]`, so every field here is camelCase and
 * every invoke argument is camelCase (Tauri maps it to the snake_case Rust
 * parameter). Nothing upstream/engine-shaped lives in this module — if you find
 * yourself adding a `coin_from`, you are in the wrong file
 * (`src/api/basicswap.ts` holds the engine regime).
 *
 * # Amounts
 *
 * `amountSat` and `feeSat` are **integers in the coin's smallest unit** — they
 * are ours, not the engine's decimal strings. Convert with {@link amountToSat}
 * rather than `Math.round(parseFloat(x) * 1e8)`, which loses a satoshi on
 * perfectly ordinary inputs (`0.07 * 1e8 === 7000000.000000001`).
 */
import { invoke } from "../lib/tauri";

// =========================================================================
// Types — RUST-STRUCT REGIME (camelCase)
// =========================================================================

/**
 * How the fee is expressed.
 *
 * - `confTarget` maps to `conf_target` + `estimate_mode` (Core's fee estimator
 *   picks a rate that should confirm within N blocks).
 * - `feeRate` maps to an explicit `fee_rate`. **Core >= 0.21 only** — DOGE,
 *   DASH and BCH are forks of older trees and may not have it, which is exactly
 *   what {@link swapDaemonCapabilities} probes for.
 */
export type DaemonFeeMode = "confTarget" | "feeRate";

/**
 * Flat by design, not a discriminated union with payloads.
 *
 * The Rust side is a flat struct too: an internally-tagged enum with camelCase
 * *fields* needs `rename_all_fields`, whose availability varies by serde minor
 * version (contract §1.3). Flat plus a validating function is unambiguous, and
 * {@link validateFeeControl} is that function.
 *
 * `blocks` and `satPerVb` are **mutually exclusive** — supplying both, or
 * neither, is a validation error, not a precedence question.
 */
export interface DaemonFeeControl {
  mode: DaemonFeeMode;
  /** Required iff `mode === "confTarget"`. Core's `conf_target`, in blocks. */
  blocks?: number;
  /** Optional under `confTarget`; **ignored** under `feeRate` (the rate is
   *  explicit, so there is nothing to estimate). */
  estimateMode?: "economical" | "conservative";
  /** Required iff `mode === "feeRate"`. Satoshis per virtual byte. */
  satPerVb?: number;
}

/**
 * One send. `dryRun` is deliberately **required** — there is no default,
 * because the difference between the two values is "nothing happened" and
 * "coins left the wallet", and a defaulted boolean is how that distinction
 * gets lost in a refactor.
 */
export interface DaemonSendRequest {
  /** Lowercase coin key, e.g. `"btc"`. Resolved to a daemon Rust-side. */
  coin: string;
  toAddress: string;
  /** Integer, coin's smallest unit. See {@link amountToSat}. */
  amountSat: number;
  /** Take the fee out of the amount (Core's `subtractFeeFromOutputs`). */
  subtractFee: boolean;
  fee: DaemonFeeControl;
  /** `true` — fund and sign, report, **do not broadcast**. */
  dryRun: boolean;
}

/**
 * `txid` is `null` on a dry run — that is the whole point of one, not a
 * failure. Check {@link DaemonSendResult.broadcast} to tell "we deliberately
 * did not send" from "we tried and got no txid".
 *
 * `lockedUtxos` is the count of outputs the daemon had reserved (engine-held
 * swap inputs); a funded transaction must never include one, which is what the
 * regtest itest for §R9 asserts.
 */
export interface DaemonSendResult {
  txid: string | null;
  feeSat: number;
  vsize: number;
  inputs: number;
  lockedUtxos: number;
  broadcast: boolean;
}

/**
 * What one coin's daemon can actually do, **probed live**.
 *
 * Do not hard-code this table. Contract §4.3 items 5 and 6 list `fee_rate`,
 * `importdescriptors`, `listdescriptors` and `getdescriptorinfo` support on
 * DOGE / DASH / BCH as unsettled-without-a-node, and a static table would
 * answer those questions by assertion instead of by measurement.
 */
export interface DaemonCapability {
  coin: string;
  /** The `_rpc_wallet` this coin's daemon serves — `chainclients.<coin>.wallet_name`,
   *  default `"wallet.dat"`. NOT the engine's watch wallet. */
  wallet: string;
  /** `importdescriptors` is available. */
  descriptors: boolean;
  /** `fee_rate` is accepted by `fundrawtransaction` / `send`. */
  feeRate: boolean;
  /** `conf_target` is accepted. */
  confTarget: boolean;
  /** An account xpub could be captured for the watch record. */
  xpubAvailable: boolean;
}

// =========================================================================
// Refusal strings — mirrors of Rust's, for explaining not for enforcing
// =========================================================================

/** Verbatim from `swap_daemon.rs`'s routing gate. */
export const DAEMON_ROUTING_DISABLED = "daemon-direct routing is disabled";

/**
 * Verbatim mapping of JSON-RPC error `-13`.
 *
 * The correct response is to surface it and stop. **Never** prompt for a
 * passphrase and never call `walletpassphrase` — the wallet key is C5's, held
 * in Rust memory, and a UI that asks the user for it has recreated the exact
 * credential-in-the-webview problem this subsystem is built to avoid.
 */
export const DAEMON_WALLET_LOCKED = "the swap node's wallet is locked";

/** Is this failure just "the feature flag is off"? Substring, because Tauri
 *  wraps command errors on the way out. */
export function isRoutingDisabled(message: string): boolean {
  return message.includes(DAEMON_ROUTING_DISABLED);
}

/** Is this the locked-wallet refusal (RPC -13)? */
export function isWalletLocked(message: string): boolean {
  return message.includes(DAEMON_WALLET_LOCKED);
}

// =========================================================================
// Pure helpers
// =========================================================================

/**
 * Validate a fee control the way Rust's `fund_options` does.
 *
 * Returns the refusal message, or `null` when the control is coherent. Called
 * by {@link swapDaemonSend} *before* the invoke, so a malformed fee costs no
 * IPC and cannot half-build a transaction.
 *
 * The exclusivity is the load-bearing rule: `blocks` XOR `satPerVb`. Both set
 * would leave the daemon to pick, and which one it picks differs by fork.
 */
export function validateFeeControl(
  fee: DaemonFeeControl | null | undefined,
): string | null {
  if (!fee || (fee.mode !== "confTarget" && fee.mode !== "feeRate")) {
    return "fee mode must be confTarget or feeRate";
  }
  if (fee.mode === "confTarget") {
    if (fee.satPerVb != null) {
      return "confTarget mode cannot carry satPerVb — blocks and satPerVb are exclusive";
    }
    if (fee.blocks == null) return "confTarget mode requires blocks";
    if (!Number.isInteger(fee.blocks) || fee.blocks < 1 || fee.blocks > 65535) {
      return "blocks must be a whole number between 1 and 65535";
    }
    if (
      fee.estimateMode != null &&
      fee.estimateMode !== "economical" &&
      fee.estimateMode !== "conservative"
    ) {
      return "estimateMode must be economical or conservative";
    }
    return null;
  }
  if (fee.blocks != null) {
    return "feeRate mode cannot carry blocks — blocks and satPerVb are exclusive";
  }
  if (fee.satPerVb == null) return "feeRate mode requires satPerVb";
  if (!Number.isFinite(fee.satPerVb) || fee.satPerVb <= 0) {
    return "satPerVb must be a positive number";
  }
  return null;
}

/**
 * Validate a whole send request. Returns the refusal, or `null`.
 *
 * Rust re-validates everything here — this is a local pre-flight so a typo
 * fails instantly and without touching a wallet, **not** the security
 * boundary. Treating a `null` return as authorisation is the mistake this note
 * exists to prevent.
 */
export function validateSendRequest(req: DaemonSendRequest): string | null {
  if (!req || typeof req.coin !== "string" || req.coin.trim() === "") {
    return "a coin is required";
  }
  if (typeof req.toAddress !== "string" || req.toAddress.trim() === "") {
    return "a destination address is required";
  }
  if (!Number.isInteger(req.amountSat) || req.amountSat <= 0) {
    return "amountSat must be a positive whole number of the coin's smallest unit";
  }
  if (typeof req.subtractFee !== "boolean") {
    return "subtractFee must be stated explicitly";
  }
  if (typeof req.dryRun !== "boolean") return "dryRun must be stated explicitly";
  return validateFeeControl(req.fee);
}

/** Look one coin up in a capability list, case-insensitively. `null` when the
 *  probe did not report that coin — which is NOT the same as "it cannot". */
export function capabilityFor(
  caps: readonly DaemonCapability[] | null | undefined,
  coin: string,
): DaemonCapability | null {
  if (!caps || typeof coin !== "string") return null;
  const want = coin.trim().toLowerCase();
  if (want === "") return null;
  return caps.find((c) => c.coin.toLowerCase() === want) ?? null;
}

/** Which fee modes this daemon actually accepts. Empty means neither. */
export function supportedFeeModes(cap: DaemonCapability | null): DaemonFeeMode[] {
  if (!cap) return [];
  const out: DaemonFeeMode[] = [];
  if (cap.feeRate) out.push("feeRate");
  if (cap.confTarget) out.push("confTarget");
  return out;
}

/**
 * The mode to use when the caller has no opinion: an explicit rate beats an
 * estimate, because the estimate is the thing that varies by fork.
 * `null` means this coin cannot be priced at all.
 */
export function preferredFeeMode(cap: DaemonCapability | null): DaemonFeeMode | null {
  return supportedFeeModes(cap)[0] ?? null;
}

/**
 * Is daemon-direct routing worth using for this coin?
 *
 * **No fee control means no.** The entire reason to bypass the engine's send is
 * to price the transaction; on a fork that accepts neither `fee_rate` nor
 * `conf_target` the bypass buys nothing and costs a second code path
 * (contract §4.3 item 5). Callers should fall back to the engine send there.
 */
export function canRouteDaemonDirect(cap: DaemonCapability | null): boolean {
  return supportedFeeModes(cap).length > 0;
}

/**
 * Decimal string to integer smallest-unit, exactly.
 *
 * Rejects (rather than rounds) anything it cannot represent: a sign, an
 * exponent, more fraction digits than the coin has, or a result past
 * `Number.MAX_SAFE_INTEGER`. That last one is not theoretical — DOGE's supply
 * at 8 decimals exceeds 2^53, so a large DOGE amount silently loses precision
 * in a float and would send the wrong quantity.
 *
 * @throws RangeError / TypeError with a message naming the input.
 */
export function amountToSat(amount: string, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`decimals must be a whole number 0..18, got ${decimals}`);
  }
  if (typeof amount !== "string") {
    throw new TypeError(`amount must be a decimal string, got ${typeof amount}`);
  }
  const t = amount.trim();
  if (t === "" || t === "." || !/^\d*(\.\d*)?$/.test(t)) {
    throw new RangeError(`not a plain decimal amount: ${JSON.stringify(amount)}`);
  }
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) {
    throw new RangeError(`${t} has more than ${decimals} decimal places`);
  }
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const scaled =
    BigInt(whole === "" ? "0" : whole) * 10n ** BigInt(decimals) +
    BigInt(padded === "" ? "0" : padded);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${t} does not fit in a safe integer at ${decimals} decimals`,
    );
  }
  return Number(scaled);
}

/**
 * Integer smallest-unit to canonical decimal string (always `decimals` places).
 *
 * Not an exact inverse of {@link amountToSat} at the *string* level —
 * `"1.5"` round-trips to `"1.50000000"` at 8 decimals. That is intentional:
 * one canonical spelling is what makes two amounts comparable.
 */
export function satToAmount(sat: number, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`decimals must be a whole number 0..18, got ${decimals}`);
  }
  if (!Number.isSafeInteger(sat) || sat < 0) {
    throw new RangeError(`sat must be a non-negative safe integer, got ${sat}`);
  }
  if (decimals === 0) return String(sat);
  const s = BigInt(sat).toString().padStart(decimals + 1, "0");
  return `${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`;
}

// =========================================================================
// Commands
// =========================================================================

/**
 * Fund, sign, and (unless `dryRun`) broadcast one send from a coin daemon's
 * own wallet.
 *
 * Rejects **locally, without IPC**, when {@link validateSendRequest} refuses —
 * so a malformed fee never reaches a wallet that would half-build a
 * transaction for it.
 *
 * Invoke args: `{ req }` (contract §1.3).
 */
export function swapDaemonSend(req: DaemonSendRequest): Promise<DaemonSendResult> {
  const bad = validateSendRequest(req);
  if (bad) return Promise.reject(new Error(bad));
  return invoke<DaemonSendResult>("swap_daemon_send", { req });
}

/**
 * Probe every configured coin's daemon for what it supports. Read-only:
 * capability probes are `help` / `getwalletinfo`-shaped calls, nothing that
 * touches keys.
 */
export function swapDaemonCapabilities(): Promise<DaemonCapability[]> {
  return invoke<DaemonCapability[]>("swap_daemon_capabilities");
}

/**
 * Capture each coin's account **xpub** into the watch record.
 *
 * Public keys only. The Rust side refuses any extended key that is private —
 * `listdescriptors true` returns xprv/zprv and one wrong flag would write a
 * spending key to `<sidecar_base>/watch/<coin>.json` (contract §R8). There is
 * deliberately no TS helper that parses or transports an extended private key.
 */
export function swapDaemonCaptureXpubs(): Promise<DaemonCapability[]> {
  return invoke<DaemonCapability[]>("swap_daemon_capture_xpubs");
}
