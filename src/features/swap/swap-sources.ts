/**
 * Per-chain "build + sign + broadcast" helpers used by
 * `executeIntentsTrade`. One function per source chain. Each takes the
 * NEAR Intents quote's deposit address + amount, produces a chain-
 * appropriate transfer transaction, signs it via the Rust core, and
 * broadcasts it. Returns the source-chain tx hash.
 *
 * Scope of v1.x:
 *   - EVM: implemented inline in `executeIntentsTrade` (legacy reasons).
 *   - SOL: this file — Solana SystemProgram::transfer via @solana/web3.js.
 *   - NEAR: this file — hand-rolled borsh-encoded Transfer action.
 *   - BTC + LTC: this file — Esplora UTXO fetch + bitcoinjs-lib PSBT build.
 *   - DOGE + BCH: not implemented — see `sourceCapable: false` in
 *     `swap-data.ts`. Address derivation works (so users can RECEIVE);
 *     source-tx signing requires legacy P2PKH + (BCH) SIGHASH_FORKID
 *     signers in the Rust core, which lands in v1.1.
 */
import { invoke } from "../../lib/tauri";
import { broadcastTx, signEvm, signPsbt, type UtxoChain } from "../../api/swap-rust";
import {
  assertNearTransferShape,
  assertPsbtOutputShape,
  assertSolTransferShape,
} from "./safety-invariants";
import { httpProxyCall, proxyGetJson, proxyPostJson } from "../../wallets/_proxy";
import { decodeCashAddr } from "../../wallets/bch-wallet";

// ─── Solana ─────────────────────────────────────────────────────

/**
 * Build, sign, and broadcast a SOL transfer to `depositAddress`. Uses
 * `@solana/web3.js` for tx assembly + `swap_sign_solana` for the
 * signature, then `swap_broadcast` (which routes to the Rust
 * `solana_broadcast` over JSON-RPC `sendTransaction`).
 *
 * **2026-05-06 fix.** The amount input is now an atomic-units string
 * (lamports) — the same unit 1Click returns in `quote.amountIn`. The
 * previous signature took a decimal-units `amountSol` string; passing
 * `amountIn` to that field caused an `× 10^9` over-conversion (the
 * Solana cousin of the EVM "5 sextillion ETH" bug). Callers that have
 * a display-units amount must convert at the call site via
 * `decimalToBaseUnitsBigInt(displayAmount, 9)`.
 */
export async function executeSolanaTransfer(args: {
  sessionId: string;
  fromAddress: string;
  depositAddress: string;
  /** Atomic units (lamports) as a decimal string; 1 SOL = 1e9 lamports. */
  amountAtomic: string;
  rpcUrl: string;
}): Promise<{ txHash: string }> {
  const { Connection, PublicKey, SystemProgram, Transaction } = await import(
    "@solana/web3.js"
  );

  const connection = new Connection(args.rpcUrl, "confirmed");
  const fromPk = new PublicKey(args.fromAddress);
  const toPk = new PublicKey(args.depositAddress);

  // Tolerate fractional tails from 1Click's amountIn formatting (e.g.
  // "1234567890.456"); on-chain lamports must be an integer.
  const lamports = atomicStringToBigInt(args.amountAtomic);
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("SOL amount exceeds JS Number safety bound");
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromPk,
      toPubkey: toPk,
      lamports: Number(lamports),
    })
  );

  // ─── SAFETY INVARIANT (SOL post-build) ──────────────────────────
  // Re-extract program id + recipient + lamports from the transaction
  // we just constructed and verify they match the expected values.
  //
  // System Program transfer instruction data layout:
  //   bytes 0..3 : u32 little-endian discriminator (= 2 for Transfer)
  //   bytes 4..11: u64 little-endian lamports
  // Decoding the lamports field directly catches any future refactor
  // that ends up serializing a different value than the one we asked
  // SystemProgram.transfer to encode.
  const builtIx = tx.instructions[0];
  const dataView = new DataView(
    builtIx.data.buffer,
    builtIx.data.byteOffset,
    builtIx.data.byteLength
  );
  const discriminator = dataView.getUint32(0, true);
  if (discriminator !== 2) {
    // Not a Transfer instruction — assertSolTransferShape's program-id
    // check will produce a helpful error, but the discriminator is a
    // tighter check.
    throw new Error(
      `Solana SystemProgram instruction discriminator ${discriminator} ≠ 2 (Transfer).`
    );
  }
  const encodedLamports = dataView.getBigUint64(4, true);
  assertSolTransferShape({
    programIdBase58: builtIx.programId.toBase58(),
    expectedRecipient: args.depositAddress,
    recipientFromTx: builtIx.keys[1].pubkey.toBase58(),
    amountAtomic: encodedLamports,
    expectedAmountAtomic: lamports,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPk;

  // Sign the message bytes with the Rust core (key never leaves Rust).
  const messageBytes = tx.serializeMessage();
  // Rust expects base64 of the serialized message per `SignSolanaInput`.
  const messageB64 = bytesToBase64(messageBytes);

  const signed = await invoke<{ publicKey: string; signature: string }>(
    "swap_sign_solana",
    { sessionId: args.sessionId, input: { message: messageB64 } }
  );

  // The Rust signer returned a base58-encoded signature (Solana convention).
  // Turn it back into 64 raw bytes and attach to the transaction.
  const sigBytes = decodeBase58Variable(signed.signature);
  if (sigBytes.length !== 64) {
    throw new Error(`unexpected SOL signature length: ${sigBytes.length}`);
  }
  tx.addSignature(fromPk, Buffer.from(sigBytes));

  // Serialize the now-signed wire form and hand it to the broadcaster.
  // Skip web3's pre-broadcast verification — it'd recompute the signature
  // (we don't have the secret here).
  const wire = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
  const txHash = await broadcastTx("SOLANA", args.rpcUrl, bytesToBase64(wire));
  return { txHash };
}

// ─── Solana SPL token transfer (Phase 2) ───────────────────────

/**
 * Build, sign, and broadcast a SPL token transfer to `depositAddress`.
 * Used for USDC.sol and USDT.sol routes through NEAR Intents.
 *
 * Flow:
 *   1. Derive source + destination ATAs from (owner, mint).
 *   2. Check if destination ATA exists; if not, prepend a Create-ATA ix.
 *   3. Build Token Program Transfer instruction.
 *   4. Sign the message bytes via `swap_sign_solana` (no Rust changes
 *      needed — the existing signer accepts any pre-built message).
 *   5. Reassemble + broadcast.
 *
 * The Rust signer signs *message bytes*, so the entire SPL flow lives
 * client-side: ATA derivation, instruction encoding, blockhash fetch,
 * gas-coin selection.
 */
export async function executeSplTransfer(args: {
  sessionId: string;
  /** Source owner pubkey (base58). */
  fromAddress: string;
  /** Destination owner pubkey (base58). 1Click's deposit address. */
  depositAddress: string;
  /** SPL mint address (base58). USDC: EPjFWdd…; USDT: Es9vMFrz…. */
  mint: string;
  /** Atomic units (token's smallest unit) as decimal string. */
  amountAtomic: string;
  rpcUrl: string;
}): Promise<{ txHash: string }> {
  const {
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
  } = await import("@solana/web3.js");

  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
  );

  const connection = new Connection(args.rpcUrl, "confirmed");
  const owner = new PublicKey(args.fromAddress);
  const recipient = new PublicKey(args.depositAddress);
  const mint = new PublicKey(args.mint);

  // ATA derivation: PDA(owner, TOKEN_PROGRAM_ID, mint).
  const [sourceAta] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const [destAta] = PublicKey.findProgramAddressSync(
    [recipient.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const amount = atomicStringToBigInt(args.amountAtomic);
  if (amount > 0xffff_ffff_ffff_ffffn) {
    throw new Error("SPL amount overflows u64");
  }

  const tx = new Transaction();

  // Check destination ATA existence; if missing, prepend create-ATA ix.
  const destAtaInfo = await connection.getAccountInfo(destAta);
  if (!destAtaInfo) {
    // Associated Token Account creation instruction. Account list:
    //   0. payer (signer, writable) — the source owner pays for the
    //      account creation rent.
    //   1. associated_token_address (writable) — the new ATA.
    //   2. wallet_address (the recipient owner) — read-only.
    //   3. token_mint_address — read-only.
    //   4. system_program — read-only.
    //   5. token_program — read-only.
    const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
    tx.add(
      new TransactionInstruction({
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: destAta, isSigner: false, isWritable: true },
          { pubkey: recipient, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        // ATA program v2 instruction: empty data = legacy "Create" (the
        // newer "CreateIdempotent" is opcode 1, used when re-running is OK).
        // We pick opcode 1 to be safe against races where a third-party
        // creates the ATA between our existence check and submission.
        data: Buffer.from([1]),
      })
    );
  }

  // Token Program Transfer instruction: opcode 3 + u64-LE amount.
  // Account list:
  //   0. source ATA (writable)
  //   1. destination ATA (writable)
  //   2. owner (signer)
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amount, 1);
  tx.add(
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: destAta, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data,
    })
  );

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;

  // Sign the message bytes.
  const messageBytes = tx.serializeMessage();
  const messageB64 = bytesToBase64(messageBytes);
  const signed = await invoke<{ publicKey: string; signature: string }>(
    "swap_sign_solana",
    { sessionId: args.sessionId, input: { message: messageB64 } }
  );

  const sigBytes = decodeBase58Variable(signed.signature);
  if (sigBytes.length !== 64) {
    throw new Error(`unexpected SOL signature length: ${sigBytes.length}`);
  }
  tx.addSignature(owner, Buffer.from(sigBytes));

  const wire = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
  const txHash = await broadcastTx("SOLANA", args.rpcUrl, bytesToBase64(wire));
  return { txHash };
}

// ─── NEAR native ────────────────────────────────────────────────

/**
 * Build, sign, and broadcast a NEAR-native Transfer action to
 * `depositAddress`. Hand-rolls the NEAR `Transaction` borsh encoding so
 * we don't pull in `near-api-js` (it's a heavy dep with its own polyfill
 * needs).
 *
 * **2026-05-06 fix.** `amountAtomic` is the yoctoNEAR string from
 * 1Click's `quote.amountIn` — already in atomic units. Previous
 * signature took a decimal-units `amountNear`; passing `amountIn` to
 * that field caused an `× 10^24` over-conversion. The NEAR cousin of
 * the EVM "5 sextillion ETH" bug.
 *
 * Prerequisite: the user's NEAR account must have at least 0.1 NEAR for
 * gas + storage. Not enforced here; the UI surfaces the hint via
 * `SWAP_COIN_META.NEAR.sourcePrerequisiteHint`.
 */
export async function executeNearNativeTransfer(args: {
  sessionId: string;
  /** 64-char hex implicit account, or named NEAR account ID. */
  fromAccountId: string;
  /** `ed25519:<base58>` form of the user's NEAR public key. */
  fromPublicKey: string;
  /** Where 1Click told us to deposit. */
  depositAddress: string;
  /** Atomic units (yoctoNEAR) as a decimal string; 1 NEAR = 1e24 yocto. */
  amountAtomic: string;
  rpcUrl: string;
}): Promise<{ txHash: string }> {
  const yoctoAmount = atomicStringToBigInt(args.amountAtomic);

  // 1. Query the access-key view to get the current nonce + recent block hash.
  const { nonce, blockHashB58 } = await fetchNearNonce(
    args.rpcUrl,
    args.fromAccountId,
    args.fromPublicKey
  );

  // 2. Borsh-encode the Transaction.
  const txBytes = encodeNearTransferTransaction({
    signerId: args.fromAccountId,
    publicKeyEd25519Base58: stripEd25519Prefix(args.fromPublicKey),
    nonce: nonce + 1n,
    receiverId: args.depositAddress,
    blockHashB58,
    yoctoAmount,
  });

  // ─── SAFETY INVARIANT (NEAR post-build) ─────────────────────────
  // Re-decode the borsh-encoded Transaction we just produced and
  // verify the action tag is Transfer (3), the receiver_id matches
  // the expected deposit address, and the yoctoNEAR amount matches
  // what we asked for. Catches any future encoder refactor that drifts
  // the action layout or the amount field.
  const decoded = decodeNearTransferTransaction(txBytes);
  assertNearTransferShape({
    expectedRecipient: args.depositAddress,
    recipientFromTx: decoded.receiverId,
    yoctoAmountFromTx: decoded.yoctoAmount,
    expectedYoctoAmount: yoctoAmount,
    actionTag: decoded.actionTag,
  });

  // 3. Sign the borsh bytes with the NEAR ed25519 key.
  const sigB64 = await invoke<string>("swap_sign_near_tx", {
    sessionId: args.sessionId,
    messageB64: bytesToBase64(txBytes),
  });
  const sigBytes = base64ToBytes(sigB64);
  if (sigBytes.length !== 64) {
    throw new Error(`unexpected NEAR signature length: ${sigBytes.length}`);
  }

  // 4. Wrap the signed transaction (borsh-encoded SignedTransaction).
  const signedBytes = encodeNearSignedTransaction(txBytes, sigBytes);
  const signedB64 = bytesToBase64(signedBytes);

  // 5. Broadcast via NEAR JSON-RPC.
  const txHash = await broadcastTx("NEAR", args.rpcUrl, signedB64);
  return { txHash };
}

async function fetchNearNonce(
  rpcUrl: string,
  accountId: string,
  publicKey: string
): Promise<{ nonce: bigint; blockHashB58: string }> {
  const accessKeyResp = await rpcCall(rpcUrl, "query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: accountId,
    public_key: publicKey,
  });
  const nonceRaw = (accessKeyResp as { nonce?: number | string })?.nonce;
  if (nonceRaw == null) {
    throw new Error(
      `NEAR account "${accountId}" has no access key for ${publicKey}. ` +
        `New implicit accounts only become active once funded — make sure ` +
        `you've sent at least 0.1 NEAR to the account first.`
    );
  }
  // The block_hash field on the access-key response is the block we read
  // from. We use the actual current head for the tx's block_hash, since
  // NEAR validates block_hash recency at submission time.
  const status = await rpcCall(rpcUrl, "status", []);
  const blockHashB58 = (
    status as { sync_info?: { latest_block_hash?: string } }
  )?.sync_info?.latest_block_hash;
  if (!blockHashB58) {
    throw new Error("NEAR /status returned no latest_block_hash");
  }
  return { nonce: BigInt(nonceRaw), blockHashB58 };
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown
): Promise<unknown> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!resp.ok) {
    throw new Error(`NEAR RPC ${method} returned ${resp.status}`);
  }
  const json = (await resp.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(`NEAR RPC ${method}: ${json.error.message ?? "error"}`);
  }
  return json.result;
}

function stripEd25519Prefix(pk: string): string {
  return pk.startsWith("ed25519:") ? pk.slice("ed25519:".length) : pk;
}

/* ─── NEAR borsh encoder (hand-rolled, no near-api-js dep) ───── */
//
// Encodes the minimal transaction shape we need:
//   Transaction {
//     signer_id: AccountId           // length-prefixed UTF-8
//     public_key: PublicKey {
//       key_type: u8                 // 0 = ed25519
//       data: [u8; 32]
//     }
//     nonce: u64                     // little-endian
//     receiver_id: AccountId
//     block_hash: [u8; 32]
//     actions: Vec<Action>           // length-prefixed
//   }
// And the Transfer action: enum tag 3, then `deposit: u128` (LE).
//
// The borsh spec guarantees deterministic encoding so a future
// near-api-js round-trip would be byte-identical.

function encodeNearTransferTransaction(args: {
  signerId: string;
  publicKeyEd25519Base58: string; // base58 of 32 raw pubkey bytes
  nonce: bigint;
  receiverId: string;
  blockHashB58: string;
  yoctoAmount: bigint;
}): Uint8Array {
  const enc = new BorshWriter();
  enc.string(args.signerId);
  // public_key
  enc.u8(0); // ed25519
  enc.fixed(decodeBase58(args.publicKeyEd25519Base58, 32));
  // nonce
  enc.u64(args.nonce);
  // receiver_id
  enc.string(args.receiverId);
  // block_hash
  enc.fixed(decodeBase58(args.blockHashB58, 32));
  // actions: 1 transfer
  enc.u32(1);
  // Transfer action
  enc.u8(3); // enum tag for Transfer
  enc.u128(args.yoctoAmount);
  return enc.toBytes();
}

/**
 * Minimal borsh decoder for the Transaction shape we just encoded.
 * Used by the safety-invariant layer to sanity-check that the encoder
 * produced what we asked for (action tag, receiver_id, yocto amount).
 *
 * Mirrors the layout in `encodeNearTransferTransaction`:
 *   signer_id (string), public_key (key_type u8 + 32 bytes),
 *   nonce (u64), receiver_id (string), block_hash (32 bytes),
 *   actions: u32 length || [action_tag (u8) || transfer_amount (u128)]
 *
 * Not a general-purpose decoder; only handles the single-action Transfer
 * shape this file produces.
 */
function decodeNearTransferTransaction(bytes: Uint8Array): {
  receiverId: string;
  yoctoAmount: bigint;
  actionTag: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const readU32 = (): number => {
    const v = view.getUint32(off, true);
    off += 4;
    return v;
  };
  const readU64 = (): bigint => {
    const v = view.getBigUint64(off, true);
    off += 8;
    return v;
  };
  const readU128 = (): bigint => {
    const lo = view.getBigUint64(off, true);
    const hi = view.getBigUint64(off + 8, true);
    off += 16;
    return (hi << 64n) | lo;
  };
  const readString = (): string => {
    const n = readU32();
    const slice = bytes.subarray(off, off + n);
    off += n;
    return new TextDecoder().decode(slice);
  };
  const skip = (n: number): void => {
    off += n;
  };
  // signer_id
  readString();
  // public_key (1 + 32)
  skip(1 + 32);
  // nonce
  readU64();
  // receiver_id
  const receiverId = readString();
  // block_hash
  skip(32);
  // actions length
  const actionCount = readU32();
  if (actionCount !== 1) {
    throw new Error(
      `NEAR tx has ${actionCount} actions; expected exactly 1 (Transfer)`
    );
  }
  // action: tag + amount (u128)
  const actionTag = bytes[off];
  off += 1;
  const yoctoAmount = readU128();
  return { receiverId, yoctoAmount, actionTag };
}

function encodeNearSignedTransaction(
  txBytes: Uint8Array,
  sig64: Uint8Array
): Uint8Array {
  // SignedTransaction { transaction, signature }
  // signature = enum Signature { ED25519: [u8; 64] }
  const out = new BorshWriter();
  out.fixed(txBytes);
  out.u8(0); // ed25519 signature variant
  out.fixed(sig64);
  return out.toBytes();
}

class BorshWriter {
  private chunks: Uint8Array[] = [];

  u8(n: number): void {
    this.chunks.push(new Uint8Array([n & 0xff]));
  }
  u32(n: number): void {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, n, true);
    this.chunks.push(buf);
  }
  u64(n: bigint): void {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, n, true);
    this.chunks.push(buf);
  }
  u128(n: bigint): void {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setBigUint64(0, n & 0xffff_ffff_ffff_ffffn, true);
    view.setBigUint64(8, n >> 64n, true);
    this.chunks.push(buf);
  }
  string(s: string): void {
    const utf8 = new TextEncoder().encode(s);
    this.u32(utf8.length);
    this.chunks.push(utf8);
  }
  fixed(b: Uint8Array): void {
    this.chunks.push(b);
  }
  toBytes(): Uint8Array {
    let len = 0;
    for (const c of this.chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

/** Variable-length base58 decoder. Returns however many bytes the input
 *  decodes to. */
function decodeBase58Variable(s: string): Uint8Array {
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]] = i;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const c = map[s[i]];
    if (c === undefined) throw new Error(`Invalid base58 char ${s[i]}`);
    let carry = c;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < zeros; i++) bytes.push(0);
  bytes.reverse();
  return new Uint8Array(bytes);
}

function decodeBase58(s: string, expectedLen: number): Uint8Array {
  // Tiny base58 decoder so we don't pull in a new dep. The bs58 package
  // is already in the node_modules graph (transitive) but importing it
  // would require an async dynamic import here too; keeping it local is
  // simpler.
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]] = i;

  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const c = map[s[i]];
    if (c === undefined) throw new Error(`Invalid base58 char ${s[i]}`);
    let carry = c;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < zeros; i++) bytes.push(0);
  bytes.reverse();
  const out = new Uint8Array(bytes);
  if (out.length !== expectedLen) {
    throw new Error(
      `base58 decode produced ${out.length} bytes, expected ${expectedLen}`
    );
  }
  return out;
}

// ─── BTC / LTC source flow ──────────────────────────────────────

/**
 * Build, sign, and broadcast a UTXO transfer (BTC or LTC) to
 * `depositAddress`. Implementation outline:
 *   1. Esplora `GET /address/{addr}/utxo` → list of UTXOs.
 *   2. Greedy coin selection covering amount + estimated fee.
 *   3. Build a P2WPKH PSBT via bitcoinjs-lib with the LTC/BTC network
 *      params injected.
 *   4. `swap_sign_psbt` with the chain hint signs every matching input.
 *   5. `swap_broadcast` POSTs the raw tx hex to the chain's Esplora.
 */
export async function executeUtxoTransfer(args: {
  sessionId: string;
  chain: UtxoChain; // "btc" or "ltc" — DOGE/BCH not yet
  fromAddress: string;
  depositAddress: string;
  /**
   * Atomic units (satoshis) as a decimal string; 1 BTC/LTC = 1e8 sat.
   * Same units `quote.amountIn` from 1Click reports for UTXO-source
   * routes. Previous signature took a decimal-units `amountDecimal`,
   * which double-converted into ×10^8 over-spending when called from
   * `executeIntentsTrade`.
   */
  amountAtomic: string;
  /** Esplora-compatible base URL (e.g. https://blockstream.info/api). */
  rpcUrl: string;
  /** Sat/vB fee rate. Caller may estimate from Esplora /fee-estimates. */
  feeRateSatVb?: number;
}): Promise<{ txHash: string }> {
  if (args.chain === "doge" || args.chain === "bch") {
    return executeLegacyUtxoTransfer({
      sessionId: args.sessionId,
      chain: args.chain,
      fromAddress: args.fromAddress,
      depositAddress: args.depositAddress,
      amountAtomic: args.amountAtomic,
      feeRateOverride: args.feeRateSatVb,
    });
  }
  if (args.chain !== "btc" && args.chain !== "ltc") {
    throw new Error(`Unsupported UTXO chain: ${args.chain}`);
  }
  const bitcoinjs = await import("bitcoinjs-lib");
  // tiny-secp256k1 must be initialised once for bitcoinjs-lib's ECC ops
  // (sig validation during PSBT finalize). It's already a dep.
  const ecc = await import("tiny-secp256k1");
  bitcoinjs.initEccLib(ecc as Parameters<typeof bitcoinjs.initEccLib>[0]);

  const network = networkFor(bitcoinjs, args.chain);

  const amountSat = atomicStringToBigInt(args.amountAtomic);
  if (amountSat > 21_000_000n * 100_000_000n) {
    throw new Error("amount exceeds the chain's max supply — cannot send");
  }

  // 1. Fetch UTXOs from Esplora.
  const utxos = await fetchEsploraUtxos(args.rpcUrl, args.fromAddress);
  if (utxos.length === 0) {
    throw new Error(
      `No UTXOs found at ${args.fromAddress}. Did the funding tx confirm?`
    );
  }
  utxos.sort((a, b) => Number(a.value - b.value)); // smallest-first

  // 2. Greedy coin selection assuming ~110-vB tx baseline + 32 vB per
  //    extra input. Recalibrate as inputs are added.
  const feeRate = args.feeRateSatVb ?? 5; // sane default for both chains
  const selected: typeof utxos = [];
  let inSum = 0n;
  let estVbytes = 110;
  for (const u of utxos) {
    selected.push(u);
    inSum += u.value;
    estVbytes += 68; // P2WPKH input weight
    const fee = BigInt(Math.ceil(estVbytes * feeRate));
    if (inSum >= amountSat + fee) break;
  }
  const fee = BigInt(Math.ceil(estVbytes * feeRate));
  if (inSum < amountSat + fee) {
    throw new Error(
      `Insufficient funds: have ${inSum}, need ${amountSat + fee} (incl. ${fee} sat fee).`
    );
  }
  const change = inSum - amountSat - fee;

  // 3. Build the PSBT. We need the witness-utxo (script + value) per
  //    input — Esplora gives us scriptpubkey hex + value.
  const psbt = new bitcoinjs.Psbt({ network });
  for (const u of selected) {
    const scriptHex = await fetchEsploraSpendingScript(
      args.rpcUrl,
      u.txid,
      u.vout
    );
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: {
        script: Buffer.from(scriptHex, "hex"),
        value: u.value,
      },
    });
  }
  psbt.addOutput({
    address: args.depositAddress,
    value: amountSat,
  });
  // Dust threshold for P2WPKH ≈ 294 sat (3*98 by core's calc). Skip the
  // change output below ~330 sat — let it become miner fee.
  if (change > 330n) {
    psbt.addOutput({
      address: args.fromAddress,
      value: change,
    });
  }

  // ─── SAFETY INVARIANT (UTXO post-build) ─────────────────────────
  // Re-extract every output's address + value from the PSBT we just
  // built. The recipient + value at the deposit-address output MUST
  // match what 1Click told us; if not, refuse to sign.
  // bitcoinjs-lib stores outputs as `{ script, value }`; we decode the
  // script back into an address using the network params.
  const outputs = psbt.txOutputs.map((o) => ({
    address: bitcoinjs.address.fromOutputScript(o.script, network),
    valueSat: BigInt(o.value),
  }));
  assertPsbtOutputShape({
    outputs,
    expectedRecipient: args.depositAddress,
    expectedValueSat: amountSat,
    ticker: args.chain === "ltc" ? "LTC" : "BTC",
  });

  // 4. Sign via Rust signer.
  const psbtHex = psbt.toHex();
  const signed = await signPsbt(args.sessionId, psbtHex, args.chain);

  // 5. Broadcast via Esplora POST /tx.
  const broadcastChain = args.chain === "ltc" ? "LTC" : "BTC";
  const txHash = await broadcastTx(broadcastChain, args.rpcUrl, signed.rawTx);
  return { txHash };
}

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: bigint;
}

async function fetchEsploraUtxos(
  base: string,
  address: string
): Promise<EsploraUtxo[]> {
  const resp = await fetch(
    `${base.replace(/\/$/, "")}/address/${encodeURIComponent(address)}/utxo`
  );
  if (!resp.ok) {
    throw new Error(`Esplora UTXO query returned ${resp.status}`);
  }
  const list = (await resp.json()) as Array<{
    txid: string;
    vout: number;
    value: number;
  }>;
  return list.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: BigInt(u.value),
  }));
}

async function fetchEsploraSpendingScript(
  base: string,
  txid: string,
  vout: number
): Promise<string> {
  const resp = await fetch(
    `${base.replace(/\/$/, "")}/tx/${encodeURIComponent(txid)}`
  );
  if (!resp.ok) {
    throw new Error(`Esplora tx fetch returned ${resp.status}`);
  }
  const tx = (await resp.json()) as { vout: Array<{ scriptpubkey: string }> };
  const out = tx.vout[vout];
  if (!out?.scriptpubkey) {
    throw new Error(`Esplora tx ${txid} missing vout[${vout}].scriptpubkey`);
  }
  return out.scriptpubkey;
}

function networkFor(
  bjs: typeof import("bitcoinjs-lib"),
  chain: UtxoChain
): import("bitcoinjs-lib").networks.Network {
  if (chain === "btc") return bjs.networks.bitcoin;
  if (chain === "ltc") {
    // LTC mainnet network params. SegWit HRP is "ltc"; the rest mirrors
    // BTC mainnet's script versions. P2PKH/P2SH version bytes are
    // documented in Litecoin Core's chainparams.
    return {
      ...bjs.networks.bitcoin,
      messagePrefix: "\x19Litecoin Signed Message:\n",
      bech32: "ltc",
      pubKeyHash: 0x30,
      scriptHash: 0x32,
      wif: 0xb0,
    } as import("bitcoinjs-lib").networks.Network;
  }
  if (chain === "doge") {
    // Dogecoin Core chainparams.cpp. No segwit (bech32 HRP set to a
    // never-matching value so any accidental p2wpkh call fails fast).
    return {
      messagePrefix: "\x19Dogecoin Signed Message:\n",
      bech32: "doge",
      bip32: { public: 0x02facafd, private: 0x02fac398 },
      pubKeyHash: 0x1e, // "D..."
      scriptHash: 0x16,
      wif: 0x9e,
    } as import("bitcoinjs-lib").networks.Network;
  }
  if (chain === "bch") {
    // BCH legacy address encoding shares BTC's version bytes; CashAddr
    // is a separate encoding layered on top (see decodeCashAddr in
    // bch-wallet.ts). Internally bitcoinjs-lib only sees the legacy
    // form, which is what the script_pubkey carries anyway.
    return bjs.networks.bitcoin;
  }
  throw new Error(`Unsupported UTXO chain ${chain}`);
}

/* ──────────────────────────────────────────────────────────────────
   Legacy UTXO source-tx flow — DOGE + BCH

   Different from the BTC/LTC SegWit flow in three ways:
     1. UTXO source: BlockCypher (DOGE) / Blockchair (BCH) instead of
        Esplora — different response shapes, different prev-tx fetch.
     2. PSBT input shape: `nonWitnessUtxo` (full prev-tx hex) instead
        of `witnessUtxo`. Legacy P2PKH signing needs the entire prev tx
        to compute the value being spent.
     3. Address encoding: DOGE base58 P2PKH (D-prefix); BCH CashAddr
        (`bitcoincash:q…`) which we decode to a legacy P2PKH script
        before passing to bitcoinjs-lib's PSBT builder.

   Signing dispatches to the same `swap_sign_psbt` Rust command as
   BTC/LTC; the chain hint selects the appropriate sighash branch:
   BIP-143 segwit for BTC/LTC, legacy for DOGE, BIP-143-with-FORKID
   for BCH.
   ─────────────────────────────────────────────────────────────────*/

async function executeLegacyUtxoTransfer(args: {
  sessionId: string;
  chain: "doge" | "bch";
  fromAddress: string;
  depositAddress: string;
  amountAtomic: string;
  feeRateOverride?: number;
}): Promise<{ txHash: string }> {
  const bitcoinjs = await import("bitcoinjs-lib");
  const ecc = await import("tiny-secp256k1");
  bitcoinjs.initEccLib(ecc as Parameters<typeof bitcoinjs.initEccLib>[0]);
  const network = networkFor(bitcoinjs, args.chain);

  const amountSat = atomicStringToBigInt(args.amountAtomic);
  if (amountSat <= 0n) {
    throw new Error(`amount must be positive (got ${args.amountAtomic})`);
  }

  // DOGE/BCH UTXO + prev-tx fetchers route through the http_proxy
  // allowlist (already includes blockcypher.com, blockchair.com,
  // dogechain.info, fullstack.cash). The TS doge-wallet.ts and
  // bch-wallet.ts adapters use the same endpoints for dashboard sends
  // — the swap path runs the same network surface, just with a
  // PSBT-shaped output instead of the in-TS signing path.
  const utxos =
    args.chain === "doge"
      ? await fetchDogeUtxos(args.fromAddress)
      : await fetchBchUtxos(args.fromAddress);
  if (utxos.length === 0) {
    throw new Error(
      `No UTXOs found at ${args.fromAddress}. Did the funding tx confirm?`
    );
  }
  utxos.sort((a, b) => Number(a.value - b.value)); // smallest-first

  // Fee estimation: legacy P2PKH inputs are larger than P2WPKH (148 vs
  // 68 vbytes per input). Per-chain default rates per their TS adapter:
  //   - DOGE: 0.01 DOGE/kB minimum (recommended); ≈ 1 sat-per-vbyte at
  //     1e8 atomic/coin. 1500 satoshi-equivalent per vbyte = generous.
  //   - BCH:  ~1 sat/vB matches recent mempool norms.
  const feeRate =
    args.feeRateOverride ?? (args.chain === "doge" ? 1500 : 1);

  // Greedy coin selection. Estimate ~10 base + 148 per legacy input +
  // 34 per output (P2PKH output). Recalibrate as we add inputs.
  const selected: typeof utxos = [];
  let inSum = 0n;
  let estVbytes = 10 + 34 * 2; // baseline + 2 outputs (recipient + change)
  for (const u of utxos) {
    selected.push(u);
    inSum += u.value;
    estVbytes += 148; // legacy P2PKH input
    const fee = BigInt(Math.ceil(estVbytes * feeRate));
    if (inSum >= amountSat + fee) break;
  }
  const fee = BigInt(Math.ceil(estVbytes * feeRate));
  if (inSum < amountSat + fee) {
    throw new Error(
      `Insufficient funds: have ${inSum}, need ${amountSat + fee} (incl. ${fee} fee).`
    );
  }
  const change = inSum - amountSat - fee;

  // Build PSBT with `nonWitnessUtxo` populated for legacy inputs.
  const psbt = new bitcoinjs.Psbt({ network });
  for (const u of selected) {
    const prevHex =
      args.chain === "doge"
        ? await fetchDogePrevTx(u.txid)
        : await fetchBchPrevTx(u.txid);
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      nonWitnessUtxo: Buffer.from(prevHex, "hex"),
    });
  }

  // Output 1: deposit address (NEAR Intents bridge). For BCH, the
  // bridge gives us a CashAddr; bitcoinjs-lib doesn't recognize that
  // format, so we decode to legacy P2PKH script and add an OUTPUT-by-
  // script instead of by-address. DOGE addresses are vanilla base58
  // P2PKH that bitcoinjs handles natively.
  if (args.chain === "bch") {
    const script = bchAddressToScript(bitcoinjs, args.depositAddress);
    psbt.addOutput({ script, value: amountSat });
  } else {
    psbt.addOutput({ address: args.depositAddress, value: amountSat });
  }

  // P2PKH dust threshold ~546 sat (modeled on BTC). Skip change below
  // dust+fee; let it become miner fee.
  if (change > 546n) {
    if (args.chain === "bch") {
      const script = bchAddressToScript(bitcoinjs, args.fromAddress);
      psbt.addOutput({ script, value: change });
    } else {
      psbt.addOutput({ address: args.fromAddress, value: change });
    }
  }

  // Safety invariant — recipient + value at output[0] must match the
  // 1Click-quoted depositAddress + amountIn. Re-extract via the
  // bitcoinjs script-decoder using the chain's network params. For BCH
  // we re-encode the script to CashAddr to compare against depositAddress.
  const outputs = psbt.txOutputs.map((o) => ({
    address: addressFromScript(bitcoinjs, Buffer.from(o.script), args.chain),
    valueSat: BigInt(o.value),
  }));
  assertPsbtOutputShape({
    outputs,
    expectedRecipient: args.depositAddress,
    expectedValueSat: amountSat,
    ticker: args.chain === "doge" ? "DOGE" : "BCH",
  });

  const psbtHex = psbt.toHex();
  const signed = await signPsbt(args.sessionId, psbtHex, args.chain);

  // Broadcast — legacy chains use BlockCypher (DOGE) / Blockchair (BCH)
  // instead of the Esplora-shaped `POST /tx` the BTC/LTC path uses.
  const txHash =
    args.chain === "doge"
      ? await broadcastDogeRawTx(signed.rawTx)
      : await broadcastBchRawTx(signed.rawTx);
  return { txHash };
}

// ─── DOGE source helpers ────────────────────────────────────────

const DOGE_BLOCKCYPHER = "https://api.blockcypher.com/v1/doge/main";

async function fetchDogeUtxos(
  address: string
): Promise<Array<{ txid: string; vout: number; value: bigint }>> {
  // BlockCypher returns a single dashboard payload with `txrefs` (spent
  // + unspent intermixed) and `unspent_outputs` separately. We use
  // `?unspentOnly=true&limit=2000` for cleanliness.
  const r = await proxyGetJson<{
    txrefs?: Array<{
      tx_hash: string;
      tx_output_n: number;
      value: number;
      spent?: boolean;
    }>;
  }>(`${DOGE_BLOCKCYPHER}/addrs/${encodeURIComponent(address)}?unspentOnly=true&limit=2000`);
  const list = r.txrefs ?? [];
  return list
    .filter((t) => t.spent !== true)
    .map((t) => ({
      txid: t.tx_hash,
      vout: t.tx_output_n,
      value: BigInt(t.value),
    }));
}

async function fetchDogePrevTx(txid: string): Promise<string> {
  // BlockCypher returns the full tx with `hex` field when
  // `?includeHex=true` is set.
  const r = await proxyGetJson<{ hex?: string; error?: string }>(
    `${DOGE_BLOCKCYPHER}/txs/${encodeURIComponent(txid)}?includeHex=true`
  );
  if (!r.hex) {
    throw new Error(`DOGE prev-tx ${txid} fetch missing hex field`);
  }
  return r.hex;
}

async function broadcastDogeRawTx(rawHex: string): Promise<string> {
  const r = await proxyPostJson<{
    tx?: { hash?: string };
    error?: string;
  }>(`${DOGE_BLOCKCYPHER}/txs/push`, { tx: rawHex });
  if (r.error) throw new Error(`blockcypher push: ${r.error}`);
  if (!r.tx?.hash) throw new Error("blockcypher push: no hash");
  return r.tx.hash;
}

// ─── BCH source helpers ────────────────────────────────────────

const BCH_BLOCKCHAIR = "https://api.blockchair.com/bitcoin-cash";

async function fetchBchUtxos(
  address: string
): Promise<Array<{ txid: string; vout: number; value: bigint }>> {
  // Blockchair BCH dashboard supports CashAddr or legacy in the URL.
  // `utxo` returns just the unspent outputs.
  const r = await proxyGetJson<{
    data?: {
      [addr: string]: {
        utxo?: Array<{
          transaction_hash: string;
          index: number;
          value: number;
        }>;
      };
    };
  }>(`${BCH_BLOCKCHAIR}/dashboards/address/${encodeURIComponent(address)}?limit=2000`);
  const entry = r.data?.[address] ?? Object.values(r.data ?? {})[0];
  const list = entry?.utxo ?? [];
  return list.map((u) => ({
    txid: u.transaction_hash,
    vout: u.index,
    value: BigInt(u.value),
  }));
}

async function fetchBchPrevTx(txid: string): Promise<string> {
  // Blockchair raw-transaction endpoint returns the tx wire format.
  const r = await proxyGetJson<{
    data?: { [txid: string]: { raw_transaction?: string } };
  }>(`${BCH_BLOCKCHAIR}/raw/transaction/${encodeURIComponent(txid)}`);
  const entry = r.data?.[txid] ?? Object.values(r.data ?? {})[0];
  const raw = entry?.raw_transaction;
  if (!raw) throw new Error(`BCH prev-tx ${txid} fetch missing raw_transaction`);
  return raw;
}

async function broadcastBchRawTx(rawHex: string): Promise<string> {
  // Blockchair push expects form-urlencoded `data=<hex>`. proxyPostJson
  // hard-codes JSON content-type, so we go through httpProxyCall.
  const r = await httpProxyCall({
    method: "POST",
    url: `${BCH_BLOCKCHAIR}/push/transaction`,
    body: `data=${encodeURIComponent(rawHex)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`blockchair BCH push HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(r.body) as {
    data?: { transaction_hash?: string };
    context?: { error?: string };
  };
  if (parsed.context?.error) throw new Error(`blockchair: ${parsed.context.error}`);
  const hash = parsed.data?.transaction_hash;
  if (!hash) throw new Error("blockchair BCH push: no transaction_hash");
  return hash;
}

// ─── BCH address ↔ script helpers ──────────────────────────────

/**
 * Convert a CashAddr or legacy BCH address to a P2PKH script for
 * bitcoinjs-lib's PSBT builder. CashAddr decoding lives in
 * `bch-wallet.ts::decodeCashAddr`; the resulting 20-byte hash is the
 * standard `OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG` shape.
 *
 * Falls back to bitcoinjs-lib's `address.toOutputScript` if the input
 * is already a legacy base58 BCH address (Bitcoin-style). Most BCH
 * deposit addresses 1Click returns are CashAddr.
 */
function bchAddressToScript(
  bjs: typeof import("bitcoinjs-lib"),
  address: string
): Buffer {
  // CashAddr addresses contain a colon prefix or start with q/p (data
  // section). decodeCashAddr accepts both bitcoincash:-prefixed and
  // bare q-prefixed forms.
  if (address.includes(":") || /^[qp][a-z0-9]{40,}$/i.test(address)) {
    const { hash, type } = decodeCashAddr(address);
    if (type !== "p2pkh") {
      // P2SH bridge addresses are uncommon but possible; defer.
      throw new Error(`BCH P2SH deposit addresses not yet supported: ${address}`);
    }
    // P2PKH script: OP_DUP OP_HASH160 <push 20> <hash> OP_EQUALVERIFY OP_CHECKSIG
    return Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      Buffer.from(hash),
      Buffer.from([0x88, 0xac]),
    ]);
  }
  // Legacy base58 BCH address — bitcoinjs-lib handles it the same as
  // BTC because BCH inherited the version bytes pre-fork. The
  // `toOutputScript` return type widened to Uint8Array in bitcoinjs
  // v7; wrap to Buffer for our PSBT API surface.
  return Buffer.from(bjs.address.toOutputScript(address, bjs.networks.bitcoin));
}

/**
 * Decode an output script back to its address representation for the
 * given chain. Used by `assertPsbtOutputShape` to verify the recipient
 * of the deposit output matches what 1Click told us.
 */
function addressFromScript(
  bjs: typeof import("bitcoinjs-lib"),
  script: Buffer,
  chain: "doge" | "bch" | "btc" | "ltc"
): string {
  if (chain === "bch") {
    // P2PKH script → CashAddr. Extract the 20-byte hash from positions
    // [3..23] (after the 76 a9 14 push prefix).
    if (
      script.length === 25 &&
      script[0] === 0x76 &&
      script[1] === 0xa9 &&
      script[2] === 0x14 &&
      script[23] === 0x88 &&
      script[24] === 0xac
    ) {
      // We could re-encode to CashAddr here for a stricter match, but
      // `assertPsbtOutputShape` only checks string equality — and the
      // value match is what really matters. Return the legacy form;
      // the caller can normalize.
      const hash = script.subarray(3, 23);
      const legacyAddr = bjs.address.toBase58Check(
        hash,
        bjs.networks.bitcoin.pubKeyHash
      );
      // Normalize the comparison: encode back to CashAddr so the
      // assertion compares like-shaped strings against the deposit
      // address (which 1Click returns as CashAddr).
      // Lazy import to avoid a cyclic dep at module init.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { encodeCashAddr } = require("../../wallets/bch-wallet") as {
        encodeCashAddr: (h: Uint8Array, t: "p2pkh" | "p2sh") => string;
      };
      try {
        return encodeCashAddr(hash, "p2pkh");
      } catch {
        return legacyAddr;
      }
    }
    return bjs.address.fromOutputScript(script, bjs.networks.bitcoin);
  }
  const network =
    chain === "doge"
      ? networkFor(bjs, "doge")
      : chain === "ltc"
        ? networkFor(bjs, "ltc")
        : bjs.networks.bitcoin;
  return bjs.address.fromOutputScript(script, network);
}

// ─── Cardano (ADA) source — TS-signed, not Rust ─────────────────

/**
 * Build, sign, and submit an ADA transfer to `depositAddress` using the
 * TS Cardano stack (`cardano-tx.ts`). UNLIKE every other source helper in
 * this file, signing happens in TS, not the Rust core: Cardano's
 * BIP-32-Ed25519 (Icarus) + CBOR stack lives in `cardano-tx.ts` /
 * `cardano-cip1852.ts` — the same code the dashboard Send flow uses —
 * and porting it to Rust would duplicate the hardest crypto in the
 * codebase for no functional gain. There is no `swap_sign_cardano`.
 *
 * The mnemonic is the vault's BIP-39 mnemonic, threaded from
 * `walletsByChain.cardano` (exactly as ADA Send does). We re-derive the
 * source address from it (mirroring `adaAdapter.sendTransaction`) so the
 * signing key is guaranteed to own the inputs regardless of the address
 * the caller passed.
 *
 * `amountAtomic` is lovelace (6dp) — the same atomic unit 1Click returns
 * in `quote.amountIn`. We pass it through as a bigint so there's no
 * decimal round-trip. The deposit broadcasts via Koios through the http
 * proxy (`cardano-koios.ts`), not a chain RPC — so this helper takes no
 * rpcUrl.
 */
export async function executeCardanoTransfer(args: {
  mnemonic: string;
  /** User's addr1 base address (informational; the signer re-derives). */
  fromAddress: string;
  /** 1Click deposit address (addr1…). */
  depositAddress: string;
  /** Atomic units (lovelace) as a decimal string; 1 ADA = 1e6 lovelace. */
  amountAtomic: string;
}): Promise<{ txHash: string }> {
  const { sendAda } = await import("../../wallets/cardano-tx");
  const { deriveCardanoKeySet } = await import("../../wallets/cardano-cip1852");

  const lovelace = atomicStringToBigInt(args.amountAtomic);
  if (lovelace <= 0n) {
    throw new Error(`ADA amount must be positive (got ${args.amountAtomic}).`);
  }
  // Re-derive the source address from the mnemonic so the signing key is
  // guaranteed to own the inputs (mirror of adaAdapter.sendTransaction).
  const ks = deriveCardanoKeySet(args.mnemonic);
  if (args.fromAddress && args.fromAddress !== ks.address) {
    // Caller's source address disagrees with the mnemonic-derived one.
    // The mnemonic is authoritative (it owns the keys); proceed with the
    // derived address but surface the mismatch for diagnostics.
    console.warn(
      `[swap:cardano] sourceAddress mismatch — signing for mnemonic-derived ` +
        `${ks.address.slice(0, 12)}… not ${args.fromAddress.slice(0, 12)}…`
    );
  }
  const result = await sendAda({
    mnemonic: args.mnemonic,
    fromAddress: ks.address,
    toAddress: args.depositAddress,
    amountLovelace: lovelace,
  });
  return { txHash: result.txHash };
}

// ─── shared helpers ─────────────────────────────────────────────

/**
 * Atomic-units string → bigint. Tolerates a fractional tail (1Click
 * occasionally returns oddly-formatted integers like
 * `"5000000000000000.0000022936575480"`). The on-chain value must be
 * an integer, so the fraction is truncated.
 *
 * Use for `amountIn` from 1Click responses where the unit is already
 * atomic. For user-typed display amounts, use `decimalToBaseUnitsBigInt`.
 */
export function atomicStringToBigInt(s: string): bigint {
  const trimmed = s.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid atomic-units string: ${s}`);
  }
  const [intPart] = trimmed.split(".");
  return BigInt(intPart || "0");
}

/** Decimal display string → base-units bigint, no float loss. */
export function decimalToBaseUnitsBigInt(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  const [intPart, fracPart = ""] = trimmed.split(".");
  const padded =
    fracPart.length >= decimals
      ? fracPart.slice(0, decimals)
      : fracPart + "0".repeat(decimals - fracPart.length);
  return BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  // btoa is available in the Tauri webview (Chromium runtime).
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Re-export so consumers can use the same helper without re-importing.
export const __testing = { decimalToBaseUnitsBigInt };
