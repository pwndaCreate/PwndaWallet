/**
 * Smoke test: generate a fresh Zephyr seed, derive the address from it
 * offline, and assert structural invariants. Does NOT cross-validate
 * against zephyr-wallet-rpc — that requires the sidecar binary to be
 * bundled. But if this passes, the derivation is at least self-consistent
 * and the address shape matches Zephyr's documented format.
 *
 * Run: node scripts/zephyr-address-smoke.mjs
 */

// Use a tiny Vite-free loader — we only need @noble + the wordlist.
// Rather than spin up tsx, inline the minimum.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

// ---------- Inline the wordlist (1626 English words) ----------
// Read directly from the TS file — it's just a const array, easy to grab.
const WORDLIST_PATH = new URL(
  "../src/wallets/xmr-wordlist.ts",
  import.meta.url
);
const wlSource = readFileSync(WORDLIST_PATH, "utf8");
const wlMatch = wlSource.match(/MONERO_ENGLISH_WORDS\s*:\s*[^=]*=\s*\[([\s\S]*?)\]/);
if (!wlMatch) throw new Error("couldn't parse wordlist");
const WORDS = wlMatch[1]
  .split(",")
  .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
  .filter(Boolean);
if (WORDS.length !== 1626) {
  throw new Error(`expected 1626 words, got ${WORDS.length}`);
}

// ---------- Minimum inline re-impl of the seed → address pipeline ----------
const L = ed25519.Point.Fn.ORDER;
const N = BigInt(WORDS.length);

function leBytesToBig(b) {
  let r = 0n;
  for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[i]);
  return r;
}
function bigToLeBytes(n, len = 32) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
function scReduce32(bytes) {
  return bigToLeBytes(leBytesToBig(bytes) % L);
}
function scalarMultBase(scalarLE) {
  return ed25519.Point.BASE.multiply(leBytesToBig(scalarLE) % L).toBytes();
}

function wordsToBytes(words) {
  if (words.length !== 24)
    throw new Error(`need 24 data words, got ${words.length}`);
  const wordIndex = new Map(WORDS.map((w, i) => [w, i]));
  const indices = words.map((w, i) => {
    const idx = wordIndex.get(w);
    if (idx == null) throw new Error(`word ${i + 1} "${w}" not in list`);
    return idx;
  });
  const out = new Uint8Array(32);
  // 24 words → 8 groups of 3 words → 8 × 4 bytes (little-endian).
  for (let g = 0; g < 8; g++) {
    const w1 = BigInt(indices[g * 3]);
    const w2 = BigInt(indices[g * 3 + 1]);
    const w3 = BigInt(indices[g * 3 + 2]);
    let val = w1 + N * ((N - w1 + w2) % N) + N * N * ((N - w2 + w3) % N);
    for (let b = 0; b < 4; b++) {
      out[g * 4 + b] = Number(val & 0xffn);
      val >>= 8n;
    }
  }
  return out;
}

const PREFIX_VARINT = new Uint8Array([0xc0, 0xb1, 0xf4, 0xa0, 0x62]);
const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function encodeBlock(block, encodedLen) {
  let num = 0n;
  for (let i = 0; i < block.length; i++) num = (num << 8n) | BigInt(block[i]);
  const chars = new Array(encodedLen).fill("1");
  let idx = encodedLen - 1;
  while (num > 0n && idx >= 0) {
    const r = Number(num % 58n);
    num /= 58n;
    chars[idx] = B58_ALPHABET[r];
    idx--;
  }
  return chars.join("");
}
function moneroBase58Encode(data) {
  let out = "";
  const fullBlocks = Math.floor(data.length / 8);
  const lastBlockSize = data.length % 8;
  for (let i = 0; i < fullBlocks; i++) {
    out += encodeBlock(data.subarray(i * 8, (i + 1) * 8), 11);
  }
  if (lastBlockSize > 0) {
    out += encodeBlock(
      data.subarray(fullBlocks * 8),
      B58_ENCODED_BLOCK_SIZES[lastBlockSize]
    );
  }
  return out;
}

function addressFromSeedWords(words24) {
  const seedBytes = wordsToBytes(words24);
  const spendSecret = scReduce32(seedBytes);
  const viewSecret = scReduce32(keccak_256(spendSecret));
  const spendPub = scalarMultBase(spendSecret);
  const viewPub = scalarMultBase(viewSecret);
  const payload = new Uint8Array(PREFIX_VARINT.length + 32 + 32);
  payload.set(PREFIX_VARINT, 0);
  payload.set(spendPub, PREFIX_VARINT.length);
  payload.set(viewPub, PREFIX_VARINT.length + 32);
  const checksum = keccak_256(payload).slice(0, 4);
  const raw = new Uint8Array(payload.length + checksum.length);
  raw.set(payload, 0);
  raw.set(checksum, payload.length);
  return moneroBase58Encode(raw);
}

// ---------- Tests ----------

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures++;
  } else {
    console.log(`OK:   ${msg}`);
  }
}

// Test 1: varint decodes back to 0x6241d18c0
{
  const bytes = PREFIX_VARINT;
  let n = 0n;
  let shift = 0n;
  for (const b of bytes) {
    n |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if ((b & 0x80) === 0) break;
  }
  assert(
    n === 0x6241d18c0n,
    `PREFIX_VARINT decodes to 0x6241d18c0 (got 0x${n.toString(16)})`
  );
}

// Test 2: derive an address from 24 known words (any valid seed works —
// we pick the first 24 wordlist entries, strip and pad — the checksum
// word doesn't affect derivation since our helper takes 24 words directly).
// Pick the first 24 wordlist entries as a deterministic test vector.
// Expected: address starts with "ZEPHYR" and is 101 characters.
{
  // We need 24 valid words that reduce to a valid seed. Take a random
  // 32-byte value, reduce mod l, encode to 24 words — we're testing the
  // address ENCODING, not the seed path specifically. Use a fixed seed
  // for determinism.
  const fixedSeed = new Uint8Array([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
    0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
    0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
  ]);
  const reduced = scReduce32(fixedSeed);
  // Convert to 24 words using Monero's bytes→words map
  const words = [];
  for (let g = 0; g < 8; g++) {
    let val = 0n;
    for (let b = 3; b >= 0; b--) {
      val = (val << 8n) | BigInt(reduced[g * 4 + b]);
    }
    const w1 = Number(val % N);
    const w2 = Number(((val / N) % N + BigInt(w1)) % N);
    const w3 = Number(((val / N / N) % N + BigInt(w2)) % N);
    words.push(WORDS[w1], WORDS[w2], WORDS[w3]);
  }
  const addr = addressFromSeedWords(words);
  assert(addr.startsWith("ZEPHYR"), `address starts with ZEPHYR: ${addr}`);
  assert(addr.length === 101, `address length is 101 chars (got ${addr.length})`);
  console.log(`     derived address: ${addr}`);
}

// Test 3: many random seeds all produce "ZEPHYR..." addresses
{
  let okAll = true;
  for (let trial = 0; trial < 20; trial++) {
    const rand = new Uint8Array(32);
    for (let i = 0; i < 32; i++) rand[i] = Math.floor(Math.random() * 256);
    const reduced = scReduce32(rand);
    const words = [];
    for (let g = 0; g < 8; g++) {
      let val = 0n;
      for (let b = 3; b >= 0; b--) {
        val = (val << 8n) | BigInt(reduced[g * 4 + b]);
      }
      const w1 = Number(val % N);
      const w2 = Number(((val / N) % N + BigInt(w1)) % N);
      const w3 = Number(((val / N / N) % N + BigInt(w2)) % N);
      words.push(WORDS[w1], WORDS[w2], WORDS[w3]);
    }
    const addr = addressFromSeedWords(words);
    if (!addr.startsWith("ZEPHYR") || addr.length !== 101) {
      console.error(
        `FAIL trial ${trial}: ${addr.length}-char addr ${addr}`
      );
      okAll = false;
    }
  }
  assert(okAll, "20 random seeds all produce ZEPHYR-prefixed 101-char addresses");
}

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll smoke tests passed.");
process.exit(0);
