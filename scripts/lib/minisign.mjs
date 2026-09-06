/**
 * Minisign signature verification for release artifacts.
 *
 * ## Why this exists
 *
 * `make-updater-manifest.mjs` used to decide "is this artifact signed?" with
 * `existsSync(file + ".sig")`. That is a question about the DIRECTORY, not about
 * the artifact. A signature from a different build, or from the wrong key,
 * passes it — and the consequence is specific and bad for a wallet: `latest.json`
 * publishes, every client downloads ~150 MB, and every client then rejects it at
 * its own signature check, with nothing visibly wrong on the publishing side.
 *
 * A staleness guard (refuse a `.sig` older than its artifact) was added first and
 * catches only the accident that exposed the gap. This module answers the real
 * question: does this signature verify against this file, under the key the app
 * was built to trust?
 *
 * ## Formats, as Tauri actually writes them
 *
 * Both the `pubkey` in `tauri.conf.json` and the `.sig` on disk are **base64 of a
 * whole minisign text file**, not of the raw key/signature. Decoded:
 *
 *     untrusted comment: minisign public key: 55B26C61A6B9ED36
 *     RWQ27bmmYWyyVVHmYdwiR53W1w5q0sY9Ghsi9iPAFnx7/J0E4ws3qRnI
 *
 *     untrusted comment: signature from tauri secret key
 *     RUQ27bmmYWyyVWnLM6AVmSmQzbfx7SdGp09IDc2u2eMIncyR...
 *     trusted comment: timestamp:1788714280	file:PwndaWallet_0.6.0_amd64.AppImage
 *     TvnWy0dO6fZcox5t+Q0T5l0ICMjHaooGgzZeEsJB74Z2aCsl...
 *
 * The base64 line under each comment decodes to a fixed layout:
 *
 *     public key  (42 bytes):  alg[2] "Ed"   | key id[8] | Ed25519 public key[32]
 *     signature   (74 bytes):  alg[2] "Ed"/"ED" | key id[8] | Ed25519 signature[64]
 *
 * `Ed` signs the file bytes directly; `ED` signs the file's BLAKE2b-512 digest.
 * Tauri emits `ED`. Both are implemented — guessing which one is in use is
 * exactly the kind of assumption that produces a verifier that always says ok.
 *
 * The key id is stored little-endian, which is why the hex above reads reversed
 * relative to the comment. Nothing here depends on that: ids are compared as
 * bytes.
 *
 * ## What is NOT verified
 *
 * The 4th line is a second signature over `signature || trusted comment`, which
 * is what makes minisign's trusted comment trustworthy. We do not check it: the
 * comment carries only a timestamp and filename, neither of which we act on, and
 * the client updater does not check it either. Verifying the artifact signature
 * is the property that matters. Stated rather than silently skipped.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";

/** DER/SPKI wrapper for a raw 32-byte Ed25519 public key. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class MinisignError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Decode a base64 blob that is really a minisign text file, and return its lines. */
function decodeContainer(b64, what) {
  let text;
  try {
    text = Buffer.from(b64.trim(), "base64").toString("utf8");
  } catch {
    throw new MinisignError("malformed", `${what} is not valid base64`);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    throw new MinisignError(
      "malformed",
      `${what} does not look like a minisign file (expected a comment line then a base64 line, got ${lines.length} line(s))`
    );
  }
  return lines;
}

/**
 * Parse the `plugins.updater.pubkey` value from tauri.conf.json.
 * @returns {{ algorithm: string, keyId: Buffer, key: Buffer }}
 */
export function parsePublicKey(configValue) {
  const lines = decodeContainer(configValue, "public key");
  const raw = Buffer.from(lines[1].trim(), "base64");
  if (raw.length !== 42) {
    throw new MinisignError("malformed", `public key is ${raw.length} bytes, expected 42`);
  }
  return {
    algorithm: raw.subarray(0, 2).toString("latin1"),
    keyId: raw.subarray(2, 10),
    key: raw.subarray(10, 42),
  };
}

/**
 * Parse a `.sig` file's contents.
 * @returns {{ algorithm: string, keyId: Buffer, signature: Buffer, trustedComment: string|null }}
 */
export function parseSignature(sigFileContents) {
  const lines = decodeContainer(sigFileContents, "signature");
  const raw = Buffer.from(lines[1].trim(), "base64");
  if (raw.length !== 74) {
    throw new MinisignError("malformed", `signature is ${raw.length} bytes, expected 74`);
  }
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new MinisignError(
      "malformed",
      `unknown signature algorithm ${JSON.stringify(algorithm)} (expected "Ed" or "ED")`
    );
  }
  const trusted = lines.find((l) => l.startsWith("trusted comment:"));
  return {
    algorithm,
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10, 74),
    trustedComment: trusted ? trusted.slice("trusted comment:".length).trim() : null,
  };
}

/**
 * Verify `artifactPath` against `sigPath` under the configured public key.
 *
 * Returns a result object rather than throwing, because the caller collects
 * every failing artifact before refusing rather than dying on the first.
 *
 * `reason` distinguishes the two failures that mean different things:
 *   - `key-id-mismatch`  — the artifact was signed by a key the app does not
 *                          trust. The config and the signing key disagree; a
 *                          release built this way is unusable by every client,
 *                          and re-signing with the right key is the fix.
 *   - `signature-invalid` — right key, wrong bytes. The artifact changed after
 *                          it was signed (rebuilt, truncated, or swapped).
 *
 * @returns {{ ok: true, algorithm: string, keyId: string }
 *          | { ok: false, reason: string, message: string }}
 */
export function verifyArtifact({ artifactPath, sigPath, pubkeyConfigValue }) {
  let pub, sig;
  try {
    pub = parsePublicKey(pubkeyConfigValue);
    sig = parseSignature(readFileSync(sigPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof MinisignError ? e.code : "malformed",
      message: e.message,
    };
  }

  if (!pub.keyId.equals(sig.keyId)) {
    return {
      ok: false,
      reason: "key-id-mismatch",
      message:
        `signed by key id ${sig.keyId.toString("hex")} but tauri.conf.json trusts ` +
        `${pub.keyId.toString("hex")} — the signing key and the shipped pubkey disagree, ` +
        `so every client would reject this download`,
    };
  }

  const contents = readFileSync(artifactPath);
  // "ED" signs the BLAKE2b-512 digest; "Ed" signs the file itself.
  const message =
    sig.algorithm === "ED" ? createHash("blake2b512").update(contents).digest() : contents;

  const keyObject = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, pub.key]),
    format: "der",
    type: "spki",
  });

  let good = false;
  try {
    good = cryptoVerify(null, message, keyObject, sig.signature);
  } catch (e) {
    return { ok: false, reason: "malformed", message: `Ed25519 verify failed: ${e.message}` };
  }

  if (!good) {
    return {
      ok: false,
      reason: "signature-invalid",
      message:
        `signature does not verify against this file (key id ${sig.keyId.toString("hex")} is ` +
        `correct, so the ARTIFACT changed after it was signed — rebuilt, replaced or truncated)`,
    };
  }

  return { ok: true, algorithm: sig.algorithm, keyId: sig.keyId.toString("hex") };
}
