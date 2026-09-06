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
 * The instruction layout is the one `swap-sources.ts::executeSplTransfer`
 * already uses in production for Intents deposits: derive both associated
 * token accounts, create the RECIPIENT's if absent, then a `Transfer`
 * (instruction 3) on the SPL Token program. The two paths are deliberately
 * the same shape — if the deposit path is right, this is right.
 *
 * `createAssociatedTokenAccount` costs the sender ~0.002 SOL of rent, and
 * only when the recipient has never held this token. A send from an account
 * with no SOL therefore fails on fees, which is correct and is surfaced as a
 * plain error rather than guessed around.
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import type {
  ChainAdapter,
  ChainTx,
  FeeEstimate,
  NetworkInfo,
  TxHistoryPage,
  TxResult,
  WalletInfo,
  ChainType,
} from "./types";
import { solAdapter, runOnAnySolanaRpc } from "./sol-wallet";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

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

    async sendTransaction(
      privateKey: string,
      to: string,
      amount: string,
    ): Promise<TxResult> {
      const secret = hexToBytes(privateKey);
      const keypair =
        secret.length === 64
          ? Keypair.fromSecretKey(secret)
          : Keypair.fromSeed(secret);
      const owner = keypair.publicKey;
      const recipient = new PublicKey(to);
      const atomic = decimalStringToAtomic(amount, cfg.decimals);

      const fromAta = ataFor(owner, mint);
      const toAta = ataFor(recipient, mint);

      return runOnAnySolanaRpc(async (conn: Connection) => {
        const tx = new Transaction();

        // Create the recipient's ATA when it does not exist yet. Costs the
        // SENDER rent (~0.002 SOL) — unavoidable, and the reason a token send
        // can fail for lack of SOL even when the token balance is sufficient.
        const toInfo = await conn.getAccountInfo(toAta);
        if (!toInfo) {
          tx.add(
            new TransactionInstruction({
              programId: ASSOCIATED_TOKEN_PROGRAM_ID,
              keys: [
                { pubkey: owner, isSigner: true, isWritable: true },
                { pubkey: toAta, isSigner: false, isWritable: true },
                { pubkey: recipient, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              ],
              data: Buffer.alloc(0),
            }),
          );
        }

        // SPL Token `Transfer` = instruction 3, then u64 amount little-endian.
        // Deliberately NOT `TransferChecked` (12): `Transfer` is what
        // `executeSplTransfer` uses for Intents deposits and what every SPL
        // wallet accepts; keeping the two paths identical means a bug in one
        // is a bug in both rather than a divergence nobody notices.
        const data = Buffer.alloc(9);
        data.writeUInt8(3, 0);
        data.writeBigUInt64LE(atomic, 1);
        tx.add(
          new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [
              { pubkey: fromAta, isSigner: false, isWritable: true },
              { pubkey: toAta, isSigner: false, isWritable: true },
              { pubkey: owner, isSigner: true, isWritable: false },
            ],
            data,
          }),
        );

        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = owner;
        tx.sign(keypair);

        const sig = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        return { hash: sig };
      });
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
export const __testables = { ataFor, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };

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
