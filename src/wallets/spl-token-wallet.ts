/**
 * SPL token adapters — the Solana half of the stablecoin registry.
 *
 * Mirrors `evm-factory.ts`'s role for ERC-20: one factory, one adapter per
 * (token, chain) pair, so USDC-on-Solana is a real `ChainType` with balance,
 * send, receive and history like any other chain. Before this, Solana was a
 * native-SOL-only surface and the wallet had no SPL reader at all.
 *
 * # Key material
 *
 * Reuses `solAdapter`'s derivation verbatim — the SPL owner IS the SOL
 * account, so a token leg must never derive its own key. `deriveFromMnemonic`
 * delegates, which also means a change to Solana's derivation path can never
 * silently desynchronise the token legs from the native one.
 *
 * # RPC
 *
 * Goes through `runOnAnySolanaRpc`, the same sticky-routing/rotation helper
 * native SOL uses, so token legs share its endpoint list, its Tauri fetch
 * shim and its 429 handling. Opening a separate `Connection` here would have
 * doubled the request rate against endpoints `sol-wallet.ts` already documents
 * as easy to rate-limit.
 *
 * # Sending
 *
 * Since the 2026-09-29 send-safety audit a send is decided in full before
 * anything is signed, then signed ONCE by `submitSolanaTransaction`
 * (`sol-wallet.ts`), which reads the outcome by signature. Before, the whole
 * build-sign-broadcast-confirm ran inside the RPC rotation: one press could
 * sign and broadcast up to eleven transfers, and `confirmTransaction`'s
 * `value.err` was dropped, so a transfer that failed on chain read as sent.
 *
 *  - The recipient is looked up on chain (`splDestination`). A wallet, or an
 *    address with no account yet, is paid at its associated token account,
 *    opened with the Associated Token program's IDEMPOTENT create when
 *    absent. A token account of this mint is paid directly, as `spl-token
 *    transfer` does. Everything else is refused: a token account of another
 *    mint, a Token-2022 account, a program's account, an off-curve address.
 *    Until then every recipient was treated as an owner, so a token
 *    account's address produced a "nested" ATA owned by the token account
 *    itself — rent paid by the sender, tokens movable only through the ATA
 *    program's RecoverNested.
 *  - The sender's token account and SOL are checked: the fee, plus ~0.00204
 *    SOL of rent when the recipient's token account has to be opened,
 *    without leaving the SOL account below its rent-exempt minimum.
 *    `getGasBudget` answers the same question for the Send modal, which had
 *    no way to warn about it (`gasToken` was absent).
 *
 * The transfer itself is still `Transfer` (instruction 3), the layout
 * `swap-sources.ts::executeSplTransfer` uses for Intents deposits. That
 * deposit path still uses the non-idempotent create; it is not the Send
 * button's and was outside this change.
 */
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import type {
  ChainAdapter,
  ChainTx,
  FeeEstimate,
  GasBudget,
  NetworkInfo,
  TxHistoryPage,
  TxResult,
  WalletInfo,
  ChainType,
} from "./types";
import {
  solAdapter,
  runOnAnySolanaRpc,
  submitSolanaTransaction,
  solanaKeypairFromPrivateKey,
  parseSolanaAddress,
  rentExemptMinimum,
  solSpendProblem,
  lamportsToSol,
  isTokenProgram,
  SOL_TX_FEE_LAMPORTS,
  TOKEN_PROGRAM_ID,
} from "./sol-wallet";
import { atomicToDecimal, decimalToAtomic } from "./decimal-amount";

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** Data length of a classic SPL Token account (a mint is 82, a multisig 355). */
const TOKEN_ACCOUNT_LEN = 165;

/** Associated Token Account address for (owner, mint). */
function ataFor(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Format atomic units as a decimal string, trimming trailing zeros. */
export function atomicToDecimalString(atomic: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const frac = (atomic % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

/** Decimal string → atomic units. Rejects more precision than the token has
 *  rather than silently truncating a digit off the user's amount. */
export function decimalStringToAtomic(amount: string, decimals: number): bigint {
  const t = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`Invalid amount: ${amount}`);
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `Amount has ${frac.length} decimal places but this token has ${decimals}.`,
    );
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** The fields of a classic SPL token account that a send needs. */
interface TokenAccountFields {
  mint: PublicKey;
  /** The wallet allowed to move the tokens. */
  owner: PublicKey;
  amount: bigint;
  /** 0 uninitialized, 1 initialized, 2 frozen. */
  state: number;
}

/** Decode a classic SPL token account; `null` for anything else (a mint, a multisig). */
function decodeTokenAccount(data: Uint8Array): TokenAccountFields | null {
  if (data.length !== TOKEN_ACCOUNT_LEN) return null;
  const b = Buffer.from(data);
  return {
    mint: new PublicKey(b.subarray(0, 32)),
    owner: new PublicKey(b.subarray(32, 64)),
    amount: b.readBigUInt64LE(64),
    state: b[108],
  };
}

/** Where a token transfer must actually be paid. */
type SplDestination =
  /** The pasted address IS a token account of this mint: pay it directly. */
  | { kind: "token-account"; account: PublicKey }
  /** A wallet: pay its associated token account, opening it when absent. */
  | { kind: "wallet"; owner: PublicKey; ata: PublicKey; ataExists: boolean };

/**
 * Decide from the chain where a transfer to `recipient` goes, or refuse it
 * (2026-09-29 send-safety audit).
 *
 * The recipient used to be treated as an OWNER, always, and paid at
 * ATA(recipient). Given the address of a token account, that derived a
 * "nested" ATA owned by the token account itself: the sender paid its rent
 * (~0.00204 SOL), and the tokens could leave only through the Associated Token
 * program's RecoverNested, signed by whoever owns the outer account.
 *
 * `recipientAtaInfo` is the account at ATA(recipient, mint), read in the same
 * call; it only matters when the recipient turns out to be a wallet.
 */
function splDestination(
  recipient: PublicKey,
  recipientInfo: AccountInfo<Buffer> | null,
  recipientAtaInfo: AccountInfo<Buffer> | null,
  mint: PublicKey,
  ticker: string,
): { ok: true; dest: SplDestination } | { ok: false; reason: string } {
  const addr = recipient.toBase58();
  const ask = "Ask the recipient for their Solana wallet address.";
  if (recipientInfo && isTokenProgram(recipientInfo.owner)) {
    if (!recipientInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      return {
        ok: false,
        reason: `${addr} is a Token-2022 account. ${ticker} is a classic SPL token and cannot be held there. ${ask}`,
      };
    }
    const acct = decodeTokenAccount(recipientInfo.data);
    if (!acct) {
      return {
        ok: false,
        reason: `${addr} is a token mint or multisig account, not a wallet or a token account. ${ask}`,
      };
    }
    if (!acct.mint.equals(mint)) {
      return {
        ok: false,
        reason: `${addr} is a token account for a different token (mint ${acct.mint.toBase58()}), so it cannot receive ${ticker}. ${ask}`,
      };
    }
    if (acct.state !== 1) {
      return {
        ok: false,
        reason: `${addr} is a ${ticker} token account that is ${acct.state === 2 ? "frozen" : "not initialized"}, so it cannot receive ${ticker}.`,
      };
    }
    // A token account of this very mint. Paying it directly is what the
    // user asked for, and what `spl-token transfer` does with such an address.
    return { ok: true, dest: { kind: "token-account", account: recipient } };
  }
  if (recipientInfo && !recipientInfo.owner.equals(SystemProgram.programId)) {
    return {
      ok: false,
      reason: `${addr} is an account of the program ${recipientInfo.owner.toBase58()}, not a wallet. ${ticker} sent to it could end up where nobody can sign for it. ${ask}`,
    };
  }
  if (!PublicKey.isOnCurve(recipient.toBytes())) {
    // Off the ed25519 curve: a program-derived address with no private key —
    // a closed token account, a program's vault. Its ATA could only ever be
    // moved by a program.
    return {
      ok: false,
      reason:
        `${addr} is not a wallet address: it is a program-derived address (for example a closed token account). ` +
        `${ticker} sent there would sit in a token account only a program could move. ` +
        `If it is a multisig vault, paste the vault's ${ticker} token account instead.`,
    };
  }
  const ata = ataFor(recipient, mint);
  if (recipientAtaInfo) {
    // Derived, so it should be this wallet's account of this mint. Anything
    // else is not what the transfer would assume.
    const acct = recipientAtaInfo.owner.equals(TOKEN_PROGRAM_ID)
      ? decodeTokenAccount(recipientAtaInfo.data)
      : null;
    if (!acct || !acct.mint.equals(mint) || !acct.owner.equals(recipient)) {
      return {
        ok: false,
        reason: `The ${ticker} account at ${ata.toBase58()} does not belong to ${addr}; refusing to send there.`,
      };
    }
    if (acct.state !== 1) {
      return { ok: false, reason: `${addr}'s ${ticker} account is frozen, so it cannot receive ${ticker}.` };
    }
    return { ok: true, dest: { kind: "wallet", owner: recipient, ata, ataExists: true } };
  }
  return { ok: true, dest: { kind: "wallet", owner: recipient, ata, ataExists: false } };
}

/** Why the sender's token account cannot fund this transfer, or `null`. */
function splSourceProblem(
  info: AccountInfo<Buffer> | null,
  owner: PublicKey,
  fromAta: PublicKey,
  mint: PublicKey,
  atomic: bigint,
  cfg: { ticker: string; decimals: number },
): string | null {
  // Sends draw on the associated token account only, while the balance sums
  // every token account of the mint — so name the gap when it can matter.
  const elsewhere = `If this wallet shows more ${cfg.ticker}, the rest is in another token account of this address, which Send cannot draw from yet.`;
  const acct = info && info.owner.equals(TOKEN_PROGRAM_ID) ? decodeTokenAccount(info.data) : null;
  if (!acct || !acct.mint.equals(mint) || !acct.owner.equals(owner)) {
    return `This wallet has no ${cfg.ticker} token account at ${fromAta.toBase58()}, so there is no ${cfg.ticker} to send from it. ${elsewhere}`;
  }
  if (acct.state === 2) {
    return `This wallet's ${cfg.ticker} token account is frozen by the token's issuer, so nothing can be sent from it.`;
  }
  if (acct.amount < atomic) {
    return (
      `This wallet's ${cfg.ticker} token account holds ${atomicToDecimal(acct.amount, cfg.decimals)} ${cfg.ticker}; ` +
      `this send needs ${atomicToDecimal(atomic, cfg.decimals)}. ${elsewhere}`
    );
  }
  return null;
}

/**
 * Associated Token program `CreateIdempotent` (instruction 1): opens the
 * account, or does nothing if it already exists. The plain `Create` (0) this
 * replaced FAILS when the account appears between the check and the landing,
 * and a failed transaction still costs its fee.
 */
function createAtaIdempotentIx(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/**
 * SPL Token `Transfer` = instruction 3, then u64 amount little-endian.
 * Deliberately NOT `TransferChecked` (12): `Transfer` is what
 * `executeSplTransfer` uses for Intents deposits and what every SPL wallet
 * accepts. The Token program itself refuses a destination of another mint.
 */
function transferIx(
  source: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  atomic: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(atomic, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

const SOL_FEE_ASSET = { ticker: "SOL", chainName: "Solana" } as const;

/**
 * Can an address holding `balance` lamports pay, in SOL, for a token send?
 *
 * `opens`: whether the send must open the recipient's token account (rent),
 * or `null` when there is no usable recipient yet. When the answer is no,
 * `required` is what the address has to HOLD: the cost plus the rent-exempt
 * minimum Solana makes it keep (emptying it to exactly zero is the only other
 * way through, and no real balance lands on that).
 */
function splSolBudget(balance: bigint, opens: boolean | null, ataRent: bigint, rentMin: bigint): GasBudget {
  const fee = SOL_TX_FEE_LAMPORTS;
  const base = { ...SOL_FEE_ASSET, includesAmount: false, available: lamportsToSol(balance) };
  const can = (extra: bigint) => solSpendProblem(balance, fee, extra, rentMin) === null;
  if (opens === null) {
    // No recipient yet: the fee for certain, rent only if they have no account.
    if (!can(0n)) return { ...base, required: lamportsToSol(fee + rentMin), sufficient: false };
    return { ...base, required: lamportsToSol(fee), sufficient: can(ataRent) ? true : null };
  }
  const extra = opens ? ataRent : 0n;
  const ok = can(extra);
  return { ...base, required: lamportsToSol(fee + extra + (ok ? 0n : rentMin)), sufficient: ok };
}

/** The Send modal asks on every keystroke; the answer barely moves in seconds. */
const BUDGET_CACHE_MS = 15_000;

export interface SplTokenAdapterConfig {
  chain: ChainType;
  displayName: string;
  ticker: string;
  color: string;
  /** SPL mint, base58. Verified on chain (owner = SPL Token program, and the
   *  parsed account type is `mint`) before entering the registry. */
  mint: string;
  decimals: number;
}

export function createSplTokenAdapter(cfg: SplTokenAdapterConfig): ChainAdapter {
  const mint = new PublicKey(cfg.mint);
  const budgetCache = new Map<string, { v: GasBudget; at: number }>();

  return {
    chain: cfg.chain,
    displayName: cfg.displayName,
    ticker: cfg.ticker,
    color: cfg.color,
    addressPlaceholder: "Solana address…",
    // An SPL leg has no derivation of its own: the token account is an ATA
    // derived from the OWNER address, so the path that matters is Solana's.
    // Declared here in the factory so every SPL leg inherits one answer.
    derivation: {
      kind: "bip39",
      path: "m/44'/501'/0'/0'",
      standard: "Phantom, Solflare, Trezor, Ledger Live (the SOL owner path)",
      hasAlternatives: true,
    },

    // Key material is Solana's — never derive separately (see header).
    importFromMnemonic: (m: string) => ({
      ...solAdapter.importFromMnemonic(m),
      chain: cfg.chain,
    }),
    deriveFromMnemonic: (m: string) => ({
      ...solAdapter.deriveFromMnemonic(m),
      chain: cfg.chain,
    }),
    importFromPrivateKey: (k: string) => ({
      ...solAdapter.importFromPrivateKey(k),
      chain: cfg.chain,
    }),

    async getBalance(address: string): Promise<string> {
      const owner = new PublicKey(address);

      // PREFERRED: every token account for this mint. A wallet can legitimately
      // hold the same mint in more than one account — its ATA plus an older
      // account created by a different wallet — and reading only the ATA would
      // report a balance the user can see on an explorer as missing.
      //
      // BUT `getTokenAccountsByOwner` is an *indexed* request, and a large part
      // of the public endpoint list in `sol-wallet.ts` refuses those without an
      // API key ("Indexed requests require a personal token", observed live from
      // publicnode). Treating that refusal as a balance failure would leave the
      // row permanently blank on exactly the keyless endpoints this wallet is
      // built around.
      try {
        const res = await runOnAnySolanaRpc((conn: Connection) =>
          conn.getParsedTokenAccountsByOwner(owner, { mint }),
        );
        let total = 0n;
        for (const { account } of res.value) {
          const raw = (account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } })
            ?.parsed?.info?.tokenAmount?.amount;
          if (typeof raw === "string" && /^\d+$/.test(raw)) total += BigInt(raw);
        }
        return atomicToDecimalString(total, cfg.decimals);
      } catch (indexedErr) {
        // FALLBACK: read the associated token account directly. Not an indexed
        // request, so it works on every endpoint. Covers the overwhelmingly
        // common case (funds in the ATA); a balance parked in a non-ATA account
        // is invisible to this path, which is why it is the fallback and not
        // the primary.
        const ata = ataFor(owner, mint);
        try {
          const bal = await runOnAnySolanaRpc((conn: Connection) =>
            conn.getTokenAccountBalance(ata),
          );
          const raw = bal?.value?.amount;
          if (typeof raw === "string" && /^\d+$/.test(raw)) {
            return atomicToDecimalString(BigInt(raw), cfg.decimals);
          }
          return "0";
        } catch (ataErr) {
          // An ATA that does not exist is a real zero, not a failure: the
          // account is only created the first time the token is received.
          const msg = String((ataErr as Error)?.message ?? ataErr);
          if (/could not find account|Invalid param|not found/i.test(msg)) return "0";
          // Anything else is a genuine outage — throw so the sweep keeps the
          // last-known value instead of writing a fake zero.
          throw indexedErr;
        }
      }
    },

    // Fees — and the rent for opening a recipient's token account — are paid
    // in SOL, never in the token (2026-09-29).
    gasToken: SOL_FEE_ASSET,

    async getGasBudget(address: string, opts?: { to?: string; amount?: string }): Promise<GasBudget> {
      const unknown: GasBudget = {
        ...SOL_FEE_ASSET,
        includesAmount: false,
        available: "0",
        required: null,
        sufficient: null,
      };
      let owner: PublicKey;
      try {
        owner = new PublicKey(address.trim());
      } catch {
        return unknown;
      }
      // A recipient still being typed is simply "no recipient yet".
      let recipient: PublicKey | null = null;
      try {
        const t = opts?.to?.trim();
        if (t) recipient = new PublicKey(t);
      } catch {
        recipient = null;
      }
      // The amount does not change the SOL a token send needs.
      const key = `${owner.toBase58()}|${recipient?.toBase58() ?? ""}`;
      const hit = budgetCache.get(key);
      if (hit && Date.now() - hit.at < BUDGET_CACHE_MS) return hit.v;
      try {
        const keys = recipient ? [owner, recipient, ataFor(recipient, mint)] : [owner];
        const infos = await runOnAnySolanaRpc((conn: Connection) =>
          conn.getMultipleAccountsInfo(keys, "confirmed"),
        );
        const rentMin = await rentExemptMinimum(0);
        const ataRent = await rentExemptMinimum(TOKEN_ACCOUNT_LEN);
        let opens: boolean | null = null;
        if (recipient) {
          const d = splDestination(recipient, infos[1] ?? null, infos[2] ?? null, mint, cfg.ticker);
          // A refused recipient is refused by the send itself; here it just
          // means "cannot say yet".
          opens = d.ok ? d.dest.kind === "wallet" && !d.dest.ataExists : null;
        }
        const v = splSolBudget(BigInt(infos[0]?.lamports ?? 0), opens, ataRent, rentMin);
        for (const [k, e] of budgetCache) if (Date.now() - e.at >= BUDGET_CACHE_MS) budgetCache.delete(k);
        budgetCache.set(key, { v, at: Date.now() });
        return v;
      } catch (e) {
        // Unknown is not zero: "you have no SOL" is a claim an unreachable
        // endpoint cannot support.
        console.warn(`[spl] ${cfg.ticker} gas budget read failed:`, e);
        return unknown;
      }
    },

    async sendTransaction(
      privateKey: string,
      to: string,
      amount: string,
    ): Promise<TxResult> {
      // The input first, outside any RPC rotation (2026-09-29 send-safety
      // audit): a pasted address is trimmed, and a bad one is reported as
      // such rather than as an outage.
      const keypair = solanaKeypairFromPrivateKey(privateKey);
      const owner = keypair.publicKey;
      const recipient = parseSolanaAddress(to);
      const atomic = decimalToAtomic(amount, cfg.decimals, `${cfg.ticker} amount`);
      if (atomic <= 0n) throw new Error("Amount must be greater than zero.");
      const fromAta = ataFor(owner, mint);

      // One read for every account the checks need. Nothing is signed yet,
      // so rotating endpoints is harmless.
      const [ownerInfo, sourceInfo, recipientInfo, recipientAtaInfo] = await runOnAnySolanaRpc(
        (conn: Connection) =>
          conn.getMultipleAccountsInfo(
            [owner, fromAta, recipient, ataFor(recipient, mint)],
            "confirmed",
          ),
      );
      const resolved = splDestination(recipient, recipientInfo, recipientAtaInfo, mint, cfg.ticker);
      if (!resolved.ok) throw new Error(resolved.reason);
      const dest = resolved.dest;
      const sourceProblem = splSourceProblem(sourceInfo, owner, fromAta, mint, atomic, cfg);
      if (sourceProblem) throw new Error(sourceProblem);

      // The SOL side: the fee, plus rent when the recipient's token account
      // has to be opened — paid by the SENDER, and the reason a token send
      // can fail for lack of SOL with the token balance in hand.
      const opens = dest.kind === "wallet" && !dest.ataExists;
      const rentMin = await rentExemptMinimum(0);
      const ataRent = opens ? await rentExemptMinimum(TOKEN_ACCOUNT_LEN) : 0n;
      const balance = BigInt(ownerInfo?.lamports ?? 0);
      const fee = SOL_TX_FEE_LAMPORTS;
      const solProblem = solSpendProblem(balance, fee, ataRent, rentMin);
      if (solProblem) {
        const cost = opens
          ? `the ${lamportsToSol(fee)} SOL network fee plus ${lamportsToSol(ataRent)} SOL to open the recipient's ${cfg.ticker} account`
          : `the ${lamportsToSol(fee)} SOL network fee`;
        throw new Error(
          solProblem === "insufficient"
            ? `Sending ${cfg.ticker} on Solana costs ${cost}, paid in SOL. This address holds ${lamportsToSol(balance)} SOL. Add SOL first.`
            : `Paying ${cost} would leave this address below Solana's rent-exempt minimum of ${lamportsToSol(rentMin)} SOL, ` +
                `and the network refuses that. Add SOL so it holds at least ${lamportsToSol(fee + ataRent + rentMin)} SOL.`,
        );
      }

      const instructions: TransactionInstruction[] = [];
      if (dest.kind === "wallet" && !dest.ataExists) {
        instructions.push(createAtaIdempotentIx(owner, dest.ata, dest.owner, mint));
      }
      instructions.push(
        transferIx(fromAta, dest.kind === "wallet" ? dest.ata : dest.account, owner, atomic),
      );
      try {
        return await submitSolanaTransaction(keypair, instructions);
      } finally {
        // Whatever happened, the SOL balance the modal last saw may be stale.
        budgetCache.clear();
      }
    },

    async getNetworkInfo(): Promise<NetworkInfo> {
      return solAdapter.getNetworkInfo();
    },

    async getTransactionHistory(
      address: string,
      opts?: { limit?: number; cursor?: string },
    ): Promise<TxHistoryPage> {
      // Signatures are fetched against the OWNER's token account, so the list
      // is this token's activity rather than every SOL transaction.
      const owner = new PublicKey(address);
      const ata = ataFor(owner, mint);
      const limit = opts?.limit ?? 25;
      const sigs = await runOnAnySolanaRpc((conn: Connection) =>
        conn.getSignaturesForAddress(ata, { limit }),
      ).catch(() => []);
      const items: ChainTx[] = sigs.map((s) => ({
        chain: cfg.chain,
        hash: s.signature,
        // Direction needs the parsed transaction to know which side moved;
        // that is one RPC call per row, so it is left unresolved rather than
        // guessed. `pending` is honest: "on chain, direction not determined".
        direction: "pending",
        amount: "",
        timestamp: s.blockTime ?? undefined,
        confirmations: s.confirmationStatus === "finalized" ? 1 : 0,
      }));
      return { items };
    },

    async getFeeEstimate(): Promise<FeeEstimate> {
      return {
        normal: { value: "0.000005", eta: "≈ 1 slot" },
        unit: "SOL",
        fetchedAt: Date.now(),
      };
    },
  } as ChainAdapter;
}

/** Re-exported for tests that need the ATA derivation without an adapter. */
export const __testables = { ataFor, decodeTokenAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };

export type { WalletInfo };

// ── Shipped SPL legs. Mints verified on chain: owner = SPL Token program,
// parsed account type = `mint`, decimals read from `getTokenSupply`.
export const usdcSolAdapter = createSplTokenAdapter({
  chain: "usdc-sol",
  displayName: "USDC (Solana)",
  ticker: "USDC",
  color: "#2775ca",
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
});

export const usdtSolAdapter = createSplTokenAdapter({
  chain: "usdt-sol",
  displayName: "USDT (Solana)",
  ticker: "USDT",
  color: "#26a17b",
  mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  decimals: 6,
});
