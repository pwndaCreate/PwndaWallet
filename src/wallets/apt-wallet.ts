/**
 * Aptos (APT) ChainAdapter.
 *
 * # Derivation — verified two ways, not assumed
 *
 * Path `m/44'/637'/0'/0'/0'` (SLIP-0010 ed25519, every segment hardened), address =
 * `sha3_256(publicKey || 0x00)`. The trailing `0x00` is Aptos's single-ed25519 scheme
 * byte; other schemes (multi-ed25519 `0x01`, single-key `0x02`) hash differently, so
 * it is load-bearing, not padding.
 *
 * Both facts were confirmed on 2026-09-02 by deriving the standard BIP39 test
 * mnemonic through `@aptos-labs/ts-sdk` AND independently through the libraries this
 * repo already uses (`ed25519-hd-key` + `@noble/hashes` sha3), and checking the two
 * agree byte-for-byte:
 *
 *   both -> 0xeb663b681209e7087d681c5d3eed12aaa8e1915e7c87794542c3f96e94b3d3bf
 *
 * That agreement is why derivation here does NOT use the SDK: it needs nothing the
 * repo lacks, and keeping it dependency-free means `deriveAllChains` — which runs on
 * every unlock — never pulls 6.35 MB into the main bundle. The SDK is `await import`ed
 * only inside `sendTransaction`.
 *
 * # An Aptos account does not exist until it is funded
 *
 * Like Hedera, an address is derivable offline but has no on-chain account until it
 * receives something. `getBalance` reports `0` for that case rather than erroring —
 * the address is valid and can receive; there is simply nothing there yet.
 */
import { derivePath } from "ed25519-hd-key";
import { mnemonicToSeedSync } from "@scure/bip39";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { decimalToAtomic, atomicToDecimal } from "./decimal-amount";
import { SendOutcomeUnknownError } from "./send-outcome";
import type {
  ChainAdapter,
  WalletInfo,
  TxResult,
  NetworkInfo,
  ChainTx,
  TxHistoryPage,
  FeeEstimate,
} from "./types";

const APTOS_API = "https://api.mainnet.aptoslabs.com/v1";

/** APT has 8 decimal places; the atomic unit is the octa. */
export const APT_DECIMALS = 8;

/** Petra / Pontem / Martian all use this path for account 0. */
export const APT_DEFAULT_PATH = "m/44'/637'/0'/0'/0'";

/**
 * Balance comes from a VIEW FUNCTION, not from reading a resource.
 *
 * The obvious implementation — GET the `0x1::coin::CoinStore<...AptosCoin>`
 * resource — is wrong on today's mainnet and would have reported **0 for
 * essentially every real account**. APT migrated to the Fungible Asset standard:
 * the balance now lives in an object-owned `FungibleStore` at a derived address,
 * which does not appear under `/accounts/{addr}/resources` at all. Checked
 * 2026-09-02 against four active mainnet senders: every one of them had exactly
 * one resource (`0x1::account::Account`) and no CoinStore, while
 * `0x1::coin::balance` returned 15570.50, 9595.41, 12745.98 and 31.53 APT.
 *
 * `0x1::coin::balance` is FA-aware and reports the UNION of any residual legacy
 * CoinStore and the migrated store, so it is correct across the migration in
 * both directions. `0x1::primary_fungible_store::balance` returns only the FA
 * half and read slightly LOW on two of the four accounts.
 */
const APT_BALANCE_VIEW = "0x1::coin::balance";

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Aptos account address for an ed25519 public key.
 *
 * `sha3_256(pubkey || 0x00)` — the scheme byte identifies single-ed25519. Aptos
 * addresses are 32 bytes rendered as `0x` + 64 hex characters; a "short" form with
 * leading zeros trimmed also exists on explorers, which is why comparisons here
 * always use the padded form.
 */
export function aptosAddressFromPublicKey(publicKey: Uint8Array): string {
  const authKey = sha3_256(Uint8Array.from([...publicKey, 0x00]));
  return "0x" + bytesToHex(authKey);
}

export function deriveAptFromMnemonic(
  mnemonic: string,
  path: string = APT_DEFAULT_PATH,
): { privateKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const { key } = derivePath(path, Buffer.from(seed).toString("hex"));
  const privateKey = new Uint8Array(key);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey, address: aptosAddressFromPublicKey(publicKey) };
}

/**
 * Normalise an address to the padded 0x + 64-hex form, FOR READS ONLY: the
 * wallet's own address and the addresses in its history. Never for a
 * recipient — see {@link parseAptosRecipient}.
 */
export function normalizeAptosAddress(address: string): string {
  const raw = address.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,64}$/.test(raw)) {
    throw new Error(`Invalid Aptos address: ${address}`);
  }
  return "0x" + raw.padStart(64, "0");
}

/**
 * A SEND recipient: exactly 64 hex characters (the `0x` is optional), and
 * nothing is ever padded (2026-09-29 send-safety audit).
 *
 * The send used `normalizeAptosAddress`, which accepts 1–64 hex characters and
 * zero-pads them. So an Ethereum address (0x + 40 hex) or a paste that lost
 * its last character became a valid-looking 64-character address, and
 * `aptos_account::transfer` CREATED an account there that nobody holds a key
 * for. Short forms are refused too, even the legitimate special ones (0x1 is
 * the framework): no person's wallet lives there, so a user typing one is a
 * mistake, and refusing costs nothing.
 */
export function parseAptosRecipient(input: string): string {
  const t = input.trim();
  const hex = t.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      "That is not an Aptos address. An Aptos address is 0x followed by 64 hex characters (0-9, a-f).",
    );
  }
  if (hex.length === 40) {
    throw new Error(
      "That looks like an Ethereum address (40 hex characters). An Aptos address has 64. " +
        "Sending to it would create an Aptos account nobody controls. Nothing was sent.",
    );
  }
  if (hex.length !== 64) {
    throw new Error(
      `An Aptos address has 64 hex characters after 0x; this one has ${hex.length}. ` +
        "It may have been cut off — copy it again. Shorter forms are not accepted, because " +
        "they are filled out with zeros into a different address that nobody owns.",
    );
  }
  return "0x" + hex.toLowerCase();
}

/**
 * Timing for confirming a send. Mutable for tests only.
 *
 *  - `expirySecs`: the signed transaction's own expiry. After the chain's
 *    clock passes it, the transaction can never be committed — which is what
 *    lets an uncertain send be settled as "did not happen" instead of
 *    "unknown".
 *  - `ledgerMarginSecs`: how far past the expiry the node's ledger must be
 *    before a missing transaction counts as expired. The public endpoint is a
 *    pool of fullnodes that can be a few seconds apart.
 *  - `graceMs`: how long past the expiry to keep asking before giving up.
 */
export const APT_CONFIRM = {
  pollMs: 1_000,
  expirySecs: 30,
  ledgerMarginSecs: 10,
  graceMs: 30_000,
};

/**
 * The floor for `maxGasAmount`: the SDK's own `MIN_MAX_GAS_AMOUNT`, below which
 * it raises the value anyway (checked in @aptos-labs/ts-sdk 7.3.0).
 */
export const APT_MIN_MAX_GAS = 2_000n;

/**
 * `maxGasAmount` for a send whose simulation used `gasUsed` units: 1.5× that,
 * never below {@link APT_MIN_MAX_GAS} (2026-09-29 send-safety audit).
 *
 * Why not the SDK default: `DEFAULT_MAX_GAS_AMOUNT` is 2,000,000 units, and
 * the chain requires the sender to hold `maxGasAmount × gasUnitPrice` up front
 * — 2 APT at the usual price of 100 octas. A wallet with less than about 2 APT
 * could not send at all (INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE) while the
 * modal quoted a fee of about 0.001 APT. Only gas actually used is charged, so
 * the headroom costs nothing when it is not needed.
 */
export function aptMaxGasFor(gasUsed: bigint): bigint {
  const withHeadroom = (gasUsed * 3n + 1n) / 2n; // ceil(1.5 × used)
  return withHeadroom > APT_MIN_MAX_GAS ? withHeadroom : APT_MIN_MAX_GAS;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The node's ledger clock, in whole seconds; null when it cannot be read. */
async function aptosLedgerSecs(): Promise<number | null> {
  try {
    const r = await fetch(APTOS_API);
    if (!r.ok) return null;
    const d = await r.json();
    const us = d?.ledger_timestamp;
    return us == null ? null : Number(BigInt(String(us)) / 1_000_000n);
  } catch {
    return null;
  }
}

type AptosLookup =
  | { state: "committed"; success: boolean; vmStatus: string }
  | { state: "pending" }
  | { state: "missing" }
  | { state: "error"; detail: string };

async function lookupAptosTx(hash: string): Promise<AptosLookup> {
  try {
    const r = await fetch(`${APTOS_API}/transactions/by_hash/${hash}`);
    if (r.status === 404) return { state: "missing" };
    if (!r.ok) return { state: "error", detail: `HTTP ${r.status} looking the transaction up` };
    const t = await r.json();
    if (t?.type === "pending_transaction") return { state: "pending" };
    if (typeof t?.success === "boolean") {
      return { state: "committed", success: t.success, vmStatus: String(t.vm_status ?? "") };
    }
    return { state: "error", detail: `unexpected lookup answer (type ${String(t?.type)})` };
  } catch (e) {
    return { state: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Settle a submitted (or possibly-submitted) send by its hash.
 *
 * `accepted` says whether the node answered the submit with the transaction
 * accepted. It decides only the case nothing else settles — still not
 * committed and not provably expired when the time runs out: an accepted
 * transaction is reported as submitted-not-confirmed (`pending`), one whose
 * submit failed ambiguously as {@link SendOutcomeUnknownError}. Both close the
 * Send form; neither invites a second press.
 */
async function settleAptosSend(
  hash: string,
  expireSecs: number,
  accepted: boolean,
  submitProblem: string,
): Promise<TxResult> {
  const deadline = Math.max(Date.now(), expireSecs * 1000) + APT_CONFIRM.graceMs;
  let lastProblem = submitProblem;
  for (;;) {
    // The ledger clock FIRST, then the lookup: a node that had already passed
    // the expiry before we asked would have shown a committed transaction.
    const ledgerSecs = await aptosLedgerSecs();
    const found = await lookupAptosTx(hash);
    if (found.state === "committed") {
      if (found.success) return { hash };
      throw new Error(
        `Aptos committed the transaction but it failed (${found.vmStatus || "no reason given"}). ` +
          `The network fee was charged; the amount was not sent. Hash: ${hash}`,
      );
    }
    if (
      found.state === "missing" &&
      ledgerSecs !== null &&
      ledgerSecs > expireSecs + APT_CONFIRM.ledgerMarginSecs
    ) {
      throw new Error(
        "The Aptos transaction expired before it was committed, so it can no longer go through. " +
          `Nothing was sent; it is safe to send again. Hash: ${hash}`,
      );
    }
    if (found.state === "error") lastProblem = found.detail;
    if (Date.now() >= deadline) break;
    await sleep(APT_CONFIRM.pollMs);
  }
  if (accepted) return { hash, pending: true };
  throw new SendOutcomeUnknownError(
    `Aptos did not confirm the transaction${lastProblem ? ` (${lastProblem})` : ""}.`,
    hash,
  );
}

/** A plain sentence for a simulation that says the transfer would fail. */
function aptosRefusalText(vmStatus: string): string {
  const s = vmStatus || "no reason given";
  if (/INSUFFICIENT_BALANCE/i.test(s)) {
    return `Not enough APT for this amount plus the network fee (Aptos: ${s}). Nothing was sent.`;
  }
  return `Aptos would refuse this transfer (${s}). Nothing was sent.`;
}

export const aptAdapter: ChainAdapter = {
  chain: "aptos",
  displayName: "Aptos",
  ticker: "APT",
  color: "#4ad4c4",
  addressPlaceholder: "0x...",
  derivation: {
    kind: "bip39",
    path: APT_DEFAULT_PATH,
    standard: "SLIP-0010 ed25519, every segment hardened — Petra/Martian form",
    hasAlternatives: false,
  },

  deriveFromMnemonic(mnemonic: string, choice?: string): WalletInfo {
    const { privateKey, address } = deriveAptFromMnemonic(
      mnemonic,
      choice && choice.startsWith("m/") ? choice : APT_DEFAULT_PATH,
    );
    return {
      chain: "aptos",
      address,
      mnemonic: mnemonic.trim(),
      privateKey: bytesToHex(privateKey),
    };
  },

  importFromMnemonic(mnemonic: string): WalletInfo {
    return this.deriveFromMnemonic(mnemonic);
  },

  importFromPrivateKey(privateKey: string): WalletInfo {
    const key = Uint8Array.from(
      Buffer.from(privateKey.trim().replace(/^0x/, ""), "hex"),
    );
    if (key.length !== 32) {
      throw new Error("An Aptos private key is 32 bytes (64 hex characters).");
    }
    const publicKey = ed25519.getPublicKey(key);
    return {
      chain: "aptos",
      address: aptosAddressFromPublicKey(publicKey),
      mnemonic: "",
      privateKey: bytesToHex(key),
    };
  },

  async getBalance(address: string): Promise<string> {
    const r = await fetch(`${APTOS_API}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        function: APT_BALANCE_VIEW,
        type_arguments: ["0x1::aptos_coin::AptosCoin"],
        arguments: [normalizeAptosAddress(address)],
      }),
    });
    // An account that has never been funded does not exist on-chain, and the
    // view aborts rather than returning zero. That is a genuine 0 — the address
    // is still valid to receive on. Any OTHER failure throws, so a node outage
    // is never rendered as an empty wallet.
    if (r.status === 400 || r.status === 404) return "0";
    if (!r.ok) throw new Error(`Aptos node HTTP ${r.status}`);
    const out = await r.json();
    return atomicToDecimal(BigInt(out?.[0] ?? 0), APT_DECIMALS);
  },

  /**
   * Build, price, sign ONCE, submit once, then settle by hash (2026-09-29
   * send-safety audit).
   *
   * What changed, and why:
   *  - The recipient must be exactly 64 hex characters ({@link
   *    parseAptosRecipient}); it used to be zero-padded into an unowned address.
   *  - The gas limit comes from a simulation ({@link aptMaxGasFor}); the SDK
   *    default of 2,000,000 units made anyone holding under ~2 APT unable to
   *    send.
   *  - The SDK's `waitForTransaction` is gone. It throws on its own 20 s timeout
   *    and on any non-404 4xx (a 429 included) even after the node accepted
   *    the transaction, and that throw was reported as "Transaction failed" for
   *    a transfer that had gone through — one more press paid twice. The hash
   *    is now computed before the submit and the outcome looked up by it.
   */
  async sendTransaction(
    privateKey: string,
    to: string,
    amount: string,
  ): Promise<TxResult> {
    // Decided before anything is built or signed: a plain error, safe to retry.
    const recipient = parseAptosRecipient(to);
    const octas = decimalToAtomic(amount, APT_DECIMALS, "APT amount");
    if (octas <= 0n) throw new Error("Amount must be greater than zero.");

    // Lazy — keeps 6.35 MB out of the bundle for every user who never sends APT.
    const {
      Account,
      Aptos,
      AptosConfig,
      Ed25519PrivateKey,
      Network,
      generateUserTransactionHash,
    } = await import("@aptos-labs/ts-sdk");

    const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }));
    const signer = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey("0x" + privateKey.replace(/^0x/, "")),
    });

    // `0x1::aptos_account::transfer` (not `0x1::coin::transfer`) because it
    // CREATES the destination account if it does not exist yet. `coin::transfer`
    // aborts on an unfunded destination, which is the common case for a first
    // send to a fresh wallet.
    const data = {
      function: "0x1::aptos_account::transfer" as const,
      functionArguments: [recipient, octas],
    };

    // 1. Price it. The draft is only simulated, never signed. With
    //    `estimateMaxGasAmount` the node simulates at what the account can
    //    afford, so the SDK's 2-APT default cannot fail the simulation itself.
    const draft = await aptos.transaction.build.simple({ sender: signer.accountAddress, data });
    const [sim] = await aptos.transaction.simulate.simple({
      signerPublicKey: signer.publicKey,
      transaction: draft,
      options: { estimateMaxGasAmount: true, estimateGasUnitPrice: true },
    });
    if (!sim) throw new Error("Aptos returned no simulation for this transfer. Nothing was sent.");
    if (sim.success !== true) throw new Error(aptosRefusalText(String(sim.vm_status ?? "")));
    const maxGasAmount = aptMaxGasFor(BigInt(sim.gas_used));
    const gasUnitPrice = BigInt(sim.gas_unit_price);

    // 2. The one transaction that is signed: the draft's sequence number, the
    //    simulated price, and an expiry this code knows (see APT_CONFIRM).
    const expireSecs = Math.floor(Date.now() / 1000) + APT_CONFIRM.expirySecs;
    const transaction = await aptos.transaction.build.simple({
      sender: signer.accountAddress,
      data,
      options: {
        maxGasAmount: Number(maxGasAmount),
        gasUnitPrice: Number(gasUnitPrice),
        accountSequenceNumber: draft.rawTransaction.sequence_number,
        expireTimestamp: expireSecs,
      },
    });

    // 3. Sign once. The hash is known before anything leaves the machine, so
    //    every outcome after this point can be looked up rather than guessed.
    const senderAuthenticator = aptos.transaction.sign({ signer, transaction });
    const hash = generateUserTransactionHash({ transaction, senderAuthenticator });

    // 4. Submit once. Only a 4xx that is the node REFUSING the transaction is
    //    a failure; a timeout, 408/409/429, a 5xx or a dropped connection may
    //    have reached the mempool and is settled by hash like a success.
    let accepted = false;
    let submitProblem = "";
    try {
      const pending = await aptos.transaction.submit.simple({ transaction, senderAuthenticator });
      accepted = true;
      if (pending?.hash && pending.hash.toLowerCase() !== hash.toLowerCase()) {
        // Inference: cannot happen for a correctly hashed transaction. Logged
        // rather than trusted, and the locally computed hash is kept.
        console.warn(`[aptos] node returned hash ${pending.hash}, computed ${hash}`);
      }
    } catch (e) {
      const status = (e as { status?: unknown })?.status;
      const detail = e instanceof Error ? e.message : String(e);
      if (
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 409 &&
        status !== 429
      ) {
        throw new Error(`Aptos refused the transaction: ${detail}. Nothing was sent.`);
      }
      submitProblem = detail;
    }

    // 5. Settle by hash.
    return settleAptosSend(hash, expireSecs, accepted, submitProblem);
  },

  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const r = await fetch(APTOS_API);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      return {
        label: "Ledger version",
        value: String(d.ledger_version ?? "—"),
        unit: "",
      };
    } catch {
      return { label: "Ledger version", value: "—", unit: "" };
    }
  },

  async getTransactionHistory(
    address: string,
    opts?: { limit?: number },
  ): Promise<TxHistoryPage> {
    const limit = opts?.limit ?? 25;
    const addr = normalizeAptosAddress(address);
    const r = await fetch(`${APTOS_API}/accounts/${addr}/transactions?limit=${limit}`);
    if (r.status === 404) return { items: [] };
    if (!r.ok) throw new Error(`Aptos node HTTP ${r.status}`);
    const rows: any[] = await r.json();

    const items: ChainTx[] = [];
    for (const t of Array.isArray(rows) ? rows : []) {
      if (t.type !== "user_transaction") continue;
      // Covers the legacy coin path AND the post-migration fungible-asset one:
      // `aptos_account::transfer`, `aptos_account::transfer_coins`,
      // `coin::transfer`, `primary_fungible_store::transfer`.
      const fn = String(t?.payload?.function ?? "");
      if (!/::(aptos_account|coin|primary_fungible_store)::transfer/.test(fn)) continue;
      const [dest, value] = t?.payload?.arguments ?? [];
      const outgoing =
        normalizeAptosAddress(String(t.sender ?? "0x0")) === addr;
      items.push({
        chain: "aptos",
        hash: String(t.hash ?? ""),
        direction: outgoing ? "out" : "in",
        amount: atomicToDecimal(BigInt(value ?? 0), APT_DECIMALS),
        fee: atomicToDecimal(
          BigInt(t.gas_used ?? 0) * BigInt(t.gas_unit_price ?? 0),
          APT_DECIMALS,
        ),
        // Aptos timestamps are MICROseconds since epoch, not milliseconds.
        timestamp: t.timestamp ? Math.floor(Number(t.timestamp) / 1_000_000) : undefined,
        height: t.version ? Number(t.version) : undefined,
        // The chain is instantly final: a transaction that appears here is
        // committed. Reported as 1 so the UI never labels it "unconfirmed".
        confirmations: t.success === false ? 0 : 1,
        counterparty: outgoing ? String(dest ?? "") : String(t.sender ?? ""),
      });
    }
    return { items };
  },

  async getFeeEstimate(): Promise<FeeEstimate> {
    try {
      const r = await fetch(`${APTOS_API}/estimate_gas_price`);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      const price = BigInt(d.gas_estimate ?? 100);
      // A simple transfer costs on the order of 1000 gas units.
      return {
        normal: {
          value: atomicToDecimal(price * 1000n, APT_DECIMALS),
          eta: "≈ 1 s",
        },
        unit: "APT",
        fetchedAt: Date.now(),
      };
    } catch {
      return {
        normal: { value: "—", label: "Normal" } as any,
        unit: "APT",
        fetchedAt: Date.now(),
      };
    }
  },
};
