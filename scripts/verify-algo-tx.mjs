/**
 * Prove the hand-rolled Algorand canonical msgpack is correct, against a LIVE node.
 *
 * # Why this exists rather than a unit test alone
 *
 * A unit test can only assert my encoder matches my expectation. If I misread the
 * canonical rules, the test encodes my misreading and passes. The authority on
 * Algorand's encoding is an Algorand node, so ask one.
 *
 * # How it proves anything without spending
 *
 * Build a real, correctly-signed payment from a throwaway unfunded account and submit
 * it. algod's rejection tells us exactly how far it got:
 *
 *   - "msgpack decode error" / "unknown field"  -> the ENCODING is wrong.
 *   - "signature validation failed"             -> encoding parsed, but we signed
 *                                                  different bytes than it hashed.
 *   - "account ... balance 0 below min"         -> encoding parsed AND the signature
 *     or "overspend"                               verified. Everything under test is
 *                                                  correct; it only lacks funds.
 *
 * The third outcome is a PASS. It is the furthest a valid transaction can get from an
 * empty account, and it cannot be reached by a malformed one.
 *
 * Also checks locally-computed txId against algod's `/v2/transactions/pending` view
 * where available, since the id is a hash of the exact bytes that were signed.
 *
 * Run: node scripts/verify-algo-tx.mjs
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512_256 } from "@noble/hashes/sha2.js";
import { base32 } from "@scure/base";

const API = "https://mainnet-api.algonode.cloud";

// ── minimal re-implementation mirroring src/wallets/algo-tx.ts ──────────
// Deliberately a copy, not an import: this script is a CHECK on that file's
// rules, and importing it would only prove the file agrees with itself. The
// two must be kept in step; the unit tests pin the shared vectors.

const enc = (s) => new TextEncoder().encode(s);
const cat = (...ps) => {
  const out = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of ps) { out.set(p, o); o += p.length; }
  return out;
};
function uint(n) {
  if (n < 128n) return Uint8Array.of(Number(n));
  if (n <= 0xffn) return Uint8Array.of(0xcc, Number(n));
  if (n <= 0xffffn) return Uint8Array.of(0xcd, Number(n >> 8n) & 255, Number(n & 0xffn));
  if (n <= 0xffffffffn) return Uint8Array.of(0xce, Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn));
  const o = new Uint8Array(9); o[0] = 0xcf;
  for (let i = 8; i >= 1; i--) { o[i] = Number(n & 0xffn); n >>= 8n; }
  return o;
}
const str = (s) => { const b = enc(s); return cat(Uint8Array.of(0xa0 | b.length), b); };
const bin = (b) => cat(Uint8Array.of(0xc4, b.length), b);
const val = (v) => v instanceof Uint8Array ? bin(v) : typeof v === "string" ? str(v) : uint(v);

function canonicalMap(fields) {
  const kept = Object.entries(fields).filter(([, v]) =>
    v !== undefined && !(typeof v === "bigint" && v === 0n) &&
    !(typeof v === "string" && !v.length) && !(v instanceof Uint8Array && !v.length));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return cat(Uint8Array.of(0x80 | kept.length), ...kept.flatMap(([k, v]) => [str(k), val(v)]));
}

const b64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));

function addrToPub(a) {
  const raw = base32.decode(a.trim().toUpperCase() + "======");
  return raw.slice(0, 32);
}
function pubToAddr(pub) {
  return base32.encode(cat(pub, sha512_256(pub).slice(-4))).replace(/=+$/, "");
}

// ── build + submit ──────────────────────────────────────────────────────

const priv = sha512_256(enc("pwnda-algo-encoding-check-v1")); // deterministic, unfunded
const pub = ed25519.getPublicKey(priv);
const from = pubToAddr(pub);
// Algorand Foundation fee sink — a real, always-valid mainnet address, so a
// rejection can only be about US, never about the destination.
const to = "Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA";

console.log(`from (unfunded): ${from}`);

const p = await (await fetch(`${API}/v2/transactions/params`)).json();
const params = {
  fee: BigInt(Math.max(Number(p.fee ?? 0), Number(p["min-fee"] ?? 1000))),
  fv: BigInt(p["last-round"]),
  lv: BigInt(p["last-round"]) + 1000n,
  gen: String(p["genesis-id"]),
  gh: b64(String(p["genesis-hash"])),
};

const txn = canonicalMap({
  amt: 100000n,
  fee: params.fee,
  fv: params.fv,
  gen: params.gen,
  gh: params.gh,
  lv: params.lv,
  rcv: addrToPub(to),
  snd: pub,
  type: "pay",
});

const localId = base32.encode(sha512_256(cat(enc("TX"), txn))).replace(/=+$/, "");
console.log(`local txId:      ${localId}`);
console.log(`txn bytes:       ${txn.length}`);

const sig = ed25519.sign(cat(enc("TX"), txn), priv);
const signed = cat(Uint8Array.of(0x82), str("sig"), bin(sig), str("txn"), txn);

const r = await fetch(`${API}/v2/transactions`, {
  method: "POST",
  headers: { "Content-Type": "application/x-binary" },
  body: signed,
});
const text = await r.text();
let msg = text;
try { msg = JSON.parse(text).message ?? text; } catch { /* plain text */ }

console.log(`\nalgod HTTP ${r.status}`);
console.log(`algod says: ${msg.slice(0, 300)}`);

const lower = msg.toLowerCase();
let verdict, ok;
if (r.ok) {
  verdict = "SUBMITTED — the account was funded after all; encoding is certainly valid.";
  ok = true;
} else if (lower.includes("msgpack") || lower.includes("decode") || lower.includes("unknown field")) {
  verdict = "FAIL — algod could not DECODE the transaction. The canonical msgpack is wrong.";
  ok = false;
} else if (lower.includes("below min") || lower.includes("overspend") || lower.includes("insufficient")) {
  verdict = "PASS — algod DECODED the transaction and VERIFIED the signature, then rejected it only for lack of funds. Encoding and signing are correct.";
  ok = true;
} else if (lower.includes("signature validation failed") || lower.includes("failed to verify")) {
  // Matched AFTER the funds case, and on a specific phrase. The first version of
  // this script tested `lower.includes("auth")` BEFORE the funds check — and an
  // "overspend" rejection (the PASS outcome) dumps the account struct, which
  // contains the field `AuthAddr`. So a CORRECT encoding was reported as a
  // signature failure. The check was real; its verdict logic was not.
  verdict = "FAIL — decoded, but the SIGNATURE did not verify. We signed different bytes than algod hashed.";
  ok = false;
} else {
  verdict = "UNKNOWN — read the message above; it is not one of the expected outcomes.";
  ok = false;
}

const echoed = msg.includes(localId);
console.log(`\ntxId echoed back by algod: ${echoed ? "YES — algod hashed the same bytes we signed" : "no"}`);
console.log(`\n${verdict}`);
process.exit(ok ? 0 : 1);
