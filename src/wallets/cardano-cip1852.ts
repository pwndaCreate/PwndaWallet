/**
 * Cardano CIP-1852 / BIP-32-Ed25519 / Icarus key derivation + address
 * composition. Pure-TS implementation built on the primitives we already
 * have (`@noble/hashes`, `@noble/curves`, `@scure/base`) — no WASM, no
 * cardano-serialization-lib dependency.
 *
 * Three things this file implements:
 *
 * 1. **Icarus master key**: BIP-39 entropy → 96-byte extended root key
 *    via PBKDF2-HMAC-SHA512(password="", salt=entropy, 4096, 96 bytes),
 *    with Cardano-flavor BIP-32-Ed25519 clamping on the secret half.
 *    This is the same scheme Yoroi, AdaLite, Eternl, Lace, Daedalus,
 *    Trezor (Cardano), Ledger (Cardano), and Exodus all use.
 *
 * 2. **BIP-32-Ed25519 child key derivation**: hardened + non-hardened
 *    per the Khovratovich/Law variant (https://input-output-hk.github.io/adrestia/static/Ed25519_BIP.pdf).
 *    Z is split 28-byte ZL + 32-byte ZR; kL_child = (8·ZL) + kL; kR_child = (ZR + kR) mod 2^256.
 *
 * 3. **Address composition**: payment + stake credential hashes
 *    (blake2b-224 of compressed ed25519 public key) packed with a header
 *    byte and bech32-encoded with the `addr` HRP. Type-0x01 base address
 *    (the standard `addr1q...` form Exodus produces).
 *
 * No transaction signing is implemented here; that requires CBOR
 * encoding of the tx body and is out of scope for the derivation fix.
 * The placeholder send path in `ada-wallet.ts::sendTransaction` continues
 * to throw — addresses match Exodus byte-for-byte after this lands, but
 * the user must still send via Eternl / AdaLite / Daedalus until tx-side
 * support is wired in.
 *
 * References:
 *   - CIP-3:    https://cips.cardano.org/cips/cip3/    (key derivation)
 *   - CIP-1852: https://cips.cardano.org/cips/cip1852/ (HD wallet path)
 *   - CIP-19:   https://cips.cardano.org/cips/cip19/   (address bech32)
 *   - BIP-32-Ed25519 paper (above)
 */

import { mnemonicToEntropy, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist as bip39Wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bech32 } from "@scure/base";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

/** CIP-1852 hardened indices: 1852 = "purpose", 1815 = Cardano coin type. */
const PURPOSE = 1852 + 0x80000000;
const COIN_TYPE = 1815 + 0x80000000;
const ACCOUNT_0 = 0 + 0x80000000;

/** Role index 0 = external chain (payment); 2 = stake/reward. */
const ROLE_PAYMENT = 0;
const ROLE_STAKE = 2;
const ADDRESS_INDEX_0 = 0;

/** Mainnet network id for the address header byte. */
const NETWORK_MAINNET = 1;

/**
 * Address type for "key-hash payment, key-hash stake" base address. This is
 * the type Exodus / Eternl / Yoroi produce by default. Header byte is
 * `(addr_type << 4) | network_id` → `(0 << 4) | 1` → `0x01`.
 */
const ADDR_TYPE_BASE = 0;

// ---------------------------------------------------------------------------
// Icarus master key
// ---------------------------------------------------------------------------

/**
 * Apply BIP-32-Ed25519 clamping to the secret half of the extended key.
 * The clamping ensures kL is a valid Ed25519 scalar AND that the
 * higher-order bits are constrained so that 8·kL stays in range.
 */
function clampScalar(kL: Uint8Array): void {
  kL[0] &= 0xf8;
  kL[31] = (kL[31] & 0x1f) | 0x40;
}

/** Reject seeds whose third-highest bit is already set, per CIP-3 §"Master key generation". */
function isValidIcarusKey(extended: Uint8Array): boolean {
  // The extended secret key MUST satisfy `kL[31] & 0x20 == 0` after PBKDF2
  // — otherwise the implementor must re-hash. In practice every BIP-39
  // mnemonic in active use produces a valid root on the first try.
  return (extended[31] & 0x20) === 0;
}

export interface ExtendedKey {
  /** kL || kR — 64-byte BIP-32-Ed25519 secret. */
  secret: Uint8Array;
  /** Chain code, 32 bytes. */
  chainCode: Uint8Array;
}

/**
 * Derive the Icarus master extended key from a BIP-39 mnemonic.
 * `passphrase` is the BIP-39 passphrase, NOT the vault encryption
 * password — leave empty unless the user explicitly set one in Yoroi /
 * Daedalus during wallet creation.
 */
export function icarusMasterKey(mnemonic: string, passphrase = ""): ExtendedKey {
  const entropy = mnemonicToEntropy(mnemonic.trim(), bip39Wordlist);
  // PBKDF2(password=passphrase, salt=entropy, iters=4096, keylen=96, hash=SHA-512).
  // Note the order: the BIP-39 PASSPHRASE is the password input; the
  // ENTROPY is the salt. This is reversed from BIP-39's seed derivation.
  const passphraseBytes = new TextEncoder().encode(passphrase);
  const out = pbkdf2(sha512, passphraseBytes, entropy, { c: 4096, dkLen: 96 });
  const kL = out.slice(0, 32);
  const kR = out.slice(32, 64);
  const chainCode = out.slice(64, 96);
  clampScalar(kL);
  if (!isValidIcarusKey(kL)) {
    // Empirically this is unreachable from a valid BIP-39 mnemonic, but
    // the spec mandates the check. If we ever do hit it, the right
    // response is to re-hash with a different salt — we throw so the
    // failure surfaces immediately in tests rather than silently
    // producing a wrong-but-plausible address.
    throw new Error(
      "Cardano Icarus master key clamping check failed — seed entropy is not Cardano-compatible"
    );
  }
  const secret = new Uint8Array(64);
  secret.set(kL, 0);
  secret.set(kR, 32);
  return { secret, chainCode };
}

// ---------------------------------------------------------------------------
// BIP-32-Ed25519 child key derivation (V2 / Khovratovich-Law variant)
// ---------------------------------------------------------------------------

function ser32LE(i: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = i & 0xff;
  b[1] = (i >>> 8) & 0xff;
  b[2] = (i >>> 16) & 0xff;
  b[3] = (i >>> 24) & 0xff;
  return b;
}

/**
 * Ed25519 curve subgroup order: 2^252 + 27742317777372353535851937790883648493.
 * BIP-32-Ed25519 stores kL as a 256-bit value that, post-clamping, can
 * exceed n. The public key A_P = kL · B is invariant under kL mod n
 * (subtracting any Z·n changes the scalar but adds Z·n·B = O on-curve),
 * so reducing is safe and matches what AdaLite / Yoroi / @stricahq do.
 */
const ED25519_N = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

/**
 * Compress an Ed25519 secret to its canonical 32-byte public key. The
 * BIP-32-Ed25519 paper uses A_P = (kL · B) where B is the base point;
 * we cannot use `ed25519.getPublicKey(kL)` because that hashes the seed
 * first (RFC 8032 standard Ed25519). For Cardano the secret IS the
 * scalar — we do raw scalar-mult of B by kL (mod n).
 */
function compressedPublicKey(kL: Uint8Array): Uint8Array {
  const scalar = bytesToBigIntLE(kL) % ED25519_N;
  const point = ed25519.Point.BASE.multiply(scalar);
  return point.toBytes();
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]);
  }
  return v;
}

function bigIntToBytesLE(v: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let val = v;
  for (let i = 0; i < length; i++) {
    out[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return out;
}

/** Add two 32-byte little-endian unsigned ints, mod 2^256. */
function add32LE(a: Uint8Array, b: Uint8Array): Uint8Array {
  return bigIntToBytesLE((bytesToBigIntLE(a) + bytesToBigIntLE(b)) & ((1n << 256n) - 1n), 32);
}

/** Compute (8 · ZL) as a 32-byte little-endian integer. ZL is 28 bytes. */
function eightTimes(zL28: Uint8Array): Uint8Array {
  return bigIntToBytesLE(8n * bytesToBigIntLE(zL28), 32);
}

function isHardened(i: number): boolean {
  return (i & 0x80000000) !== 0;
}

/**
 * Derive a child extended key. `index` is a 32-bit unsigned integer; set
 * the high bit (or use `0x80000000 + n`) to request hardened derivation.
 */
export function deriveChild(parent: ExtendedKey, index: number): ExtendedKey {
  const idxBytes = ser32LE(index);
  let zInput: Uint8Array;
  let cInput: Uint8Array;
  if (isHardened(index)) {
    zInput = concat(new Uint8Array([0x00]), parent.secret, idxBytes);
    cInput = concat(new Uint8Array([0x01]), parent.secret, idxBytes);
  } else {
    const A_P = compressedPublicKey(parent.secret.slice(0, 32));
    zInput = concat(new Uint8Array([0x02]), A_P, idxBytes);
    cInput = concat(new Uint8Array([0x03]), A_P, idxBytes);
  }
  const Z = hmac(sha512, parent.chainCode, zInput);
  const I = hmac(sha512, parent.chainCode, cInput);
  const ZL = Z.slice(0, 28);
  const ZR = Z.slice(32, 64);
  const kL_parent = parent.secret.slice(0, 32);
  const kR_parent = parent.secret.slice(32, 64);
  const kL_child = add32LE(eightTimes(ZL), kL_parent);
  const kR_child = add32LE(ZR, kR_parent);
  const childChain = I.slice(32, 64);
  const childSecret = new Uint8Array(64);
  childSecret.set(kL_child, 0);
  childSecret.set(kR_child, 32);
  return { secret: childSecret, chainCode: childChain };
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

/** Walk the entire path m/i_1/i_2/.../i_n from the master key. */
export function deriveByPath(master: ExtendedKey, path: number[]): ExtendedKey {
  let key = master;
  for (const idx of path) {
    key = deriveChild(key, idx);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Address composition
// ---------------------------------------------------------------------------

/** Blake2b-224 hash of the compressed ed25519 public key — Cardano credential. */
function credential(extendedKey: ExtendedKey): Uint8Array {
  const pk = compressedPublicKey(extendedKey.secret.slice(0, 32));
  return blake2b(pk, { dkLen: 28 });
}

/**
 * Compose a base address from payment + stake credentials. Header byte
 * is `(addr_type << 4) | network_id` — type 0 (key-hash + key-hash) on
 * mainnet → 0x01. Bech32 HRP is `addr` (mainnet) or `addr_test` (testnet).
 */
export function baseAddressMainnet(paymentCred: Uint8Array, stakeCred: Uint8Array): string {
  const header = (ADDR_TYPE_BASE << 4) | NETWORK_MAINNET;
  const bytes = new Uint8Array(1 + 28 + 28);
  bytes[0] = header;
  bytes.set(paymentCred, 1);
  bytes.set(stakeCred, 1 + 28);
  return bech32.encode("addr", bech32.toWords(bytes), 1023);
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

export interface CardanoKeySet {
  /** The derived `addr1q…` base address — what Exodus shows. */
  address: string;
  /** Hex-encoded payment private key (kL || kR, 64 bytes). */
  paymentPrivateKey: string;
  /** Hex-encoded stake private key (kL || kR, 64 bytes). */
  stakePrivateKey: string;
  /** Hex-encoded payment credential (blake2b-224 hash of payment pubkey). */
  paymentCredentialHex: string;
  /** Hex-encoded stake credential. */
  stakeCredentialHex: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive the standard Cardano payment + stake key pair at the
 * Yoroi/Eternl/Exodus default path:
 *   payment: m/1852'/1815'/0'/0/0
 *   stake:   m/1852'/1815'/0'/2/0
 * and compose the resulting `addr1q…` base address.
 *
 * Account-0 is hardcoded — multi-account support is out of scope for the
 * fix; Exodus, Eternl, Yoroi default to account 0 and that's what every
 * import flow PwndaWallet supports has used historically.
 */
export function deriveCardanoKeySet(mnemonic: string, passphrase = ""): CardanoKeySet {
  return deriveCardanoKeySetAt(mnemonic, 0, 0, passphrase);
}

/**
 * Variant of {@link deriveCardanoKeySet} that takes an explicit `account`
 * and address `index`. Used by `CardanoDerivationPanel` to probe multiple
 * non-default Cardano derivations when the user's seed lives at a
 * different account/index than the standard a=0 i=0 (e.g. some Atomic /
 * Ledger / Trust Wallet flows assign account 1 by default).
 *
 * Path layout per CIP-1852:
 *   payment: m/1852'/1815'/{account}'/0/{index}
 *   stake:   m/1852'/1815'/{account}'/2/0
 *
 * Stake role-index is always 0 — there's only one stake key per account
 * regardless of how many addresses you generate. The header byte and
 * Blake2b-224 credential hashing are unchanged.
 */
export function deriveCardanoKeySetAt(
  mnemonic: string,
  accountIndex: number,
  addressIndex: number,
  passphrase = ""
): CardanoKeySet {
  const master = icarusMasterKey(mnemonic, passphrase);
  return deriveCardanoKeySetFromMaster(master, accountIndex, addressIndex);
}

/**
 * Brute-force-friendly variant: takes a pre-computed Icarus master key
 * so the caller can amortize the PBKDF2(4096-iter HMAC-SHA512) cost
 * across many (account, index) probes. Without this split, probing
 * 66 candidates would re-run PBKDF2 66 times (~25ms each) and the
 * brute-force find would take ~1.7s instead of ~50ms.
 *
 * Derive the master once with {@link icarusMasterKey} and pass it in.
 */
export function deriveCardanoKeySetFromMaster(
  master: ExtendedKey,
  accountIndex: number,
  addressIndex: number
): CardanoKeySet {
  return deriveCardanoKeySetWithPurpose(master, PURPOSE, accountIndex, addressIndex);
}

/**
 * Exodus's actual Cardano derivation, reverse-engineered by HeptaSean
 * (Cardano Forum, 2024-01-02) and independently corroborated by
 * ronaldjonkers (GitHub, 2025-09). Replaces a previous wrong
 * implementation that assumed Icarus master + BIP-44 path; that
 * assumption never matched any Exodus output.
 *
 * The actual scheme is a hybrid not used by any other wallet:
 *   1. Standard BIP-39 PBKDF2 → 64-byte seed
 *   2. **secp256k1** BIP-32 walk at `m/44'/1815'/{account}'/0/{index}`
 *      (NOT ed25519! This is the load-bearing oddity.)
 *   3. Take the resulting 32-byte secp256k1 private key and feed it
 *      into the Byron-Legacy "hashRepeatedly" function as the HMAC key,
 *      with message `"Root Seed Chain " + ASCII(i)` starting at i=1
 *   4. The output (after tweakBits + bit-5 retry) is a 64-byte extended
 *      Ed25519 secret + 32-byte chain code
 *   5. Compute the Ed25519 public key by raw scalar-mult of the base
 *      point (using kL[0..32] mod n)
 *   6. blake2b-224 the public key → credential hash
 *   7. Compose Shelley base address with `header || cred || cred` —
 *      paymentCred and stakeCred are the SAME hash (Exodus's other
 *      quirk)
 *
 * Canonical test vector for `abandon × 11 + about` mnemonic:
 *   addr1q9av2w6nz9tzv8rc3vfqs95av844gkcqxm0qeezvlf07p3r6c5a4xy2kycw83zcjpqtf6c0t23dsqdk7pnjye7jlurzqm0pqxa
 *
 * Returns the full key set so callers can extract the bech32 address
 * AND the underlying secret material for signing (signing not yet
 * implemented — Exodus uses standard Shelley tx format so signatures
 * would still be BIP-32-Ed25519 over the Byron-Legacy-derived key).
 *
 * `account` and `index` parameterize step 2's BIP-32 walk only; the
 * Byron-Legacy step always starts at i=1. Multi-account ("portfolio")
 * variants in Exodus most likely change `account`.
 *
 * References:
 *   - HeptaSean post #3, https://forum.cardano.org/t/exodus-wallet-byron-era-question/126040
 *   - HeptaSean post #10, https://forum.cardano.org/t/import-exodus-shelley-wallet-to-eternl-for-midnight-glacier-drop-claim/147428
 *   - ronaldjonkers/exodus-cardano-python-private-key-extractor
 *   - CIP-3 Byron spec for Root Seed Chain origin
 */
export function deriveExodusCardanoKeySet(
  mnemonic: string,
  account = 0,
  addressIndex = 0,
  passphrase = ""
): CardanoKeySet {
  const seed64 = mnemonicToSeedSync(mnemonic.trim(), passphrase);
  const root = HDKey.fromMasterSeed(seed64);
  return deriveExodusCardanoKeySetFromRoot(root, account, addressIndex);
}

/**
 * Brute-force-friendly variant: takes a pre-computed secp256k1 HDKey
 * root (BIP-32 master node) so the caller can amortize the BIP-39
 * PBKDF2 + master-key derivation cost across many (account, index)
 * probes. Without this hoist, each candidate would repeat ~25ms of
 * PBKDF2 + setup work, blowing the brute-force budget when probing
 * many account/index variants.
 */
export function deriveExodusCardanoKeySetFromRoot(
  root: HDKey,
  account: number,
  addressIndex: number
): CardanoKeySet {
  // Step 1+2: secp256k1 BIP-32 walk at m/44'/1815'/account'/0/index
  // Apostrophe in the path string makes @scure/bip32 harden that segment;
  // chain (0) and index are unhardened. secp256k1 BIP-32 supports both.
  const path = `m/44'/1815'/${account}'/0/${addressIndex}`;
  const node = root.derive(path);
  if (!node.privateKey) {
    throw new Error("Exodus Cardano derivation: secp256k1 walk produced no private key");
  }
  const sk32 = node.privateKey;

  // Step 3+4: Byron-Legacy hashRepeatedly transform
  const { kPrv, cc } = hashRepeatedlyExodus(sk32, 1);

  // Step 5+6: blake2b-224 of the ed25519 public key derived from kL
  //           via raw scalar mult on the base point. The existing
  //           `credential` helper does both — same code path Icarus uses.
  const credBytes = credential({ secret: kPrv, chainCode: cc });

  // Step 7: Shelley base address with header 0x01 + cred + cred (SAME)
  const header = (ADDR_TYPE_BASE << 4) | NETWORK_MAINNET;
  const bytes = new Uint8Array(1 + 28 + 28);
  bytes[0] = header;
  bytes.set(credBytes, 1);
  bytes.set(credBytes, 1 + 28); // SAME hash twice — Exodus quirk
  const address = bech32.encode("addr", bech32.toWords(bytes), 1023);

  return {
    address,
    paymentPrivateKey: bytesToHex(kPrv),
    stakePrivateKey: bytesToHex(kPrv), // same key serves both roles
    paymentCredentialHex: bytesToHex(credBytes),
    stakeCredentialHex: bytesToHex(credBytes),
  };
}

/**
 * Variant of {@link deriveExodusCardanoKeySet} that derives the stake
 * key separately at `m/44'/1815'/{account}'/2/0` on the same secp256k1
 * + Byron-Legacy stack, then composes the Shelley base address with
 * DIFFERENT payment + stake credential hashes.
 *
 * Justification: the user's reported address
 * `addr1q8qf6lk06mdnzm7hysllh75ludjngs4rpmwff2qjkrf5dl7qn4lvl4kmx9hawfpll0aflcm9x3p2xrkujj5p9vxngmlsl3ue4p`
 * has distinct payment vs stake halves on bech32 decode, while the
 * canonical HeptaSean reference scheme produces identical halves. This
 * fallback is for users on a newer Exodus build that switched to a
 * separate stake key.
 *
 * Probed by `bruteForceFindCardano` after the same-key form misses.
 */
export function deriveExodusCardanoKeySetSplitStake(
  mnemonic: string,
  account = 0,
  addressIndex = 0,
  passphrase = ""
): CardanoKeySet {
  const seed64 = mnemonicToSeedSync(mnemonic.trim(), passphrase);
  const root = HDKey.fromMasterSeed(seed64);
  return deriveExodusCardanoKeySetSplitStakeFromRoot(root, account, addressIndex);
}

/** Brute-force-friendly split-stake variant — see {@link deriveExodusCardanoKeySetFromRoot}. */
export function deriveExodusCardanoKeySetSplitStakeFromRoot(
  root: HDKey,
  account: number,
  addressIndex: number
): CardanoKeySet {
  const payNode = root.derive(`m/44'/1815'/${account}'/0/${addressIndex}`);
  const stkNode = root.derive(`m/44'/1815'/${account}'/2/0`);
  if (!payNode.privateKey || !stkNode.privateKey) {
    throw new Error(
      "Exodus Cardano split-stake derivation: secp256k1 walk produced no private key"
    );
  }
  const payByronOut = hashRepeatedlyExodus(payNode.privateKey, 1);
  const stkByronOut = hashRepeatedlyExodus(stkNode.privateKey, 1);

  const payCred = credential({
    secret: payByronOut.kPrv,
    chainCode: payByronOut.cc,
  });
  const stkCred = credential({
    secret: stkByronOut.kPrv,
    chainCode: stkByronOut.cc,
  });

  const header = (ADDR_TYPE_BASE << 4) | NETWORK_MAINNET;
  const bytes = new Uint8Array(1 + 28 + 28);
  bytes[0] = header;
  bytes.set(payCred, 1);
  bytes.set(stkCred, 1 + 28);
  const address = bech32.encode("addr", bech32.toWords(bytes), 1023);

  return {
    address,
    paymentPrivateKey: bytesToHex(payByronOut.kPrv),
    stakePrivateKey: bytesToHex(stkByronOut.kPrv),
    paymentCredentialHex: bytesToHex(payCred),
    stakeCredentialHex: bytesToHex(stkCred),
  };
}

/**
 * Byron-Legacy "Root Seed Chain" hashRepeatedly transform. CIP-3 Byron
 * spec at <https://github.com/cardano-foundation/CIPs/tree/master/CIP-0003>.
 *
 * Loop:
 *   I_64 = HMAC-SHA512(key=input, msg="Root Seed Chain " || ASCII(i))
 *   prv_64 = SHA-512(I[0..32])
 *   tweakBits: prv[0] &= 0xf8; prv[31] &= 0x7f; prv[31] |= 0x40
 *   if prv[31] & 0x20: increment i, restart
 *   else: return (kPrv = prv_64, cc = I[32..64])
 *
 * Bounded by `MAX_RETRIES` to prevent infinite loops on pathological
 * input. The canonical abandon mnemonic converges on the first
 * iteration.
 */
function hashRepeatedlyExodus(
  key: Uint8Array,
  startI: number
): { kPrv: Uint8Array; cc: Uint8Array } {
  const MAX_RETRIES = 1000;
  for (let i = startI; i < startI + MAX_RETRIES; i++) {
    const msg = new TextEncoder().encode("Root Seed Chain " + String(i));
    const I = hmac(sha512, key, msg);
    const iL = I.slice(0, 32);
    const iR = I.slice(32, 64);
    const prv = sha512(iL); // 64 bytes
    // tweakBits per CIP-3 Byron / Icarus
    prv[0] &= 0xf8;
    prv[31] &= 0x7f;
    prv[31] |= 0x40;
    // Bit-5 retry: if set, increment i and re-hash
    if (prv[31] & 0x20) continue;
    return { kPrv: prv, cc: iR };
  }
  throw new Error(
    "Exodus Cardano hashRepeatedly: did not converge within " +
      MAX_RETRIES +
      " retries — input is pathological"
  );
}

// Backward-compat shim: the old (wrong) function name is kept as a
// deprecated alias so callers still typecheck during the migration.
// New code should use `deriveExodusCardanoKeySet` directly.
/** @deprecated Wrong algorithm — use `deriveExodusCardanoKeySet` instead. */
export function deriveCardanoExodusKeySetFromMaster(
  _master: ExtendedKey,
  accountIndex: number,
  addressIndex: number
): CardanoKeySet {
  // Forward to the actual algorithm. The `master` param is ignored —
  // the actual algorithm doesn't use the Icarus master key.
  // We have no way to recover the mnemonic from the master, so callers
  // MUST migrate to deriveExodusCardanoKeySet which takes the mnemonic.
  throw new Error(
    "deriveCardanoExodusKeySetFromMaster is deprecated; use deriveExodusCardanoKeySet(mnemonic, account, index) instead. The Exodus Cardano scheme requires the BIP-39 mnemonic, not an Icarus master key — see PwndaWalletVault/wiki/sources/ExodusWalletSolanaAndCardanoResearch.md for the algorithm."
  );
}

function deriveCardanoKeySetWithPurpose(
  master: ExtendedKey,
  purpose: number,
  accountIndex: number,
  addressIndex: number
): CardanoKeySet {
  const accountHardened = accountIndex + 0x80000000;
  const account = deriveByPath(master, [purpose, COIN_TYPE, accountHardened]);
  const payment = deriveByPath(account, [ROLE_PAYMENT, addressIndex]);
  const stake = deriveByPath(account, [ROLE_STAKE, ADDRESS_INDEX_0]);
  const paymentCred = credential(payment);
  const stakeCred = credential(stake);
  const address = baseAddressMainnet(paymentCred, stakeCred);
  return {
    address,
    paymentPrivateKey: bytesToHex(payment.secret),
    stakePrivateKey: bytesToHex(stake.secret),
    paymentCredentialHex: bytesToHex(paymentCred),
    stakeCredentialHex: bytesToHex(stakeCred),
  };
}

// ---------------------------------------------------------------------------
// BIP-32-Ed25519 signing (Khovratovich-Law / Cardano variant)
// ---------------------------------------------------------------------------

/**
 * Sign `message` with a BIP-32-Ed25519 extended secret. This is NOT
 * RFC-8032 standard Ed25519 — the deterministic-`r` prefix is the kR
 * (right half of the extended secret) instead of `SHA512(seed)[32..64]`,
 * and the scalar is `kL` directly rather than `SHA512(seed)[0..32]` clamped.
 *
 * The output format and verification path are identical to standard
 * Ed25519: a 64-byte `R || s` blob, verifiable with `ed25519.verify(sig,
 * message, publicKey)` against the `compressedPublicKey(kL)` produced
 * during derivation.
 *
 * Spec: https://input-output-hk.github.io/adrestia/static/Ed25519_BIP.pdf §"Sign".
 */
export function signBip32Ed25519(message: Uint8Array, ext: ExtendedKey): Uint8Array {
  const kL = ext.secret.slice(0, 32);
  const kR = ext.secret.slice(32, 64);
  const A = compressedPublicKey(kL);

  // r = SHA-512(kR || message) mod n. The 64-byte SHA-512 output is
  // interpreted as a little-endian integer and reduced mod the Ed25519
  // subgroup order.
  const rHash = sha512(concat(kR, message));
  const r = bytesToBigIntLE(rHash) % ED25519_N;
  const R = ed25519.Point.BASE.multiply(r === 0n ? 1n : r);
  const Rbytes = R.toBytes();

  // h = SHA-512(R || A || message) mod n
  const hHash = sha512(concat(Rbytes, A, message));
  const h = bytesToBigIntLE(hHash) % ED25519_N;

  // s = (r + h * kL) mod n. kL is the SCALAR — reduce mod n (matches the
  // reduction we did in compressedPublicKey for A_P, so the verifier sees
  // a consistent (A, sig) pair).
  const kLscalar = bytesToBigIntLE(kL) % ED25519_N;
  const s = (r + h * kLscalar) % ED25519_N;
  const sBytes = bigIntToBytesLE(s, 32);

  const out = new Uint8Array(64);
  out.set(Rbytes, 0);
  out.set(sBytes, 32);
  return out;
}

/** Public-key bytes (32) at the payment path — useful for vkey-witness construction. */
export function paymentPublicKey(mnemonic: string, passphrase = ""): Uint8Array {
  const master = icarusMasterKey(mnemonic, passphrase);
  const account = deriveByPath(master, [PURPOSE, COIN_TYPE, ACCOUNT_0]);
  const payment = deriveByPath(account, [ROLE_PAYMENT, ADDRESS_INDEX_0]);
  return compressedPublicKey(payment.secret.slice(0, 32));
}

/** Extended payment key (kL || kR + chain code) — for tx signing. */
export function paymentExtendedKey(mnemonic: string, passphrase = ""): ExtendedKey {
  const master = icarusMasterKey(mnemonic, passphrase);
  const account = deriveByPath(master, [PURPOSE, COIN_TYPE, ACCOUNT_0]);
  return deriveByPath(account, [ROLE_PAYMENT, ADDRESS_INDEX_0]);
}
