/**
 * Tests for the release-artifact signature verifier.
 *
 * ## Why these are shaped this way
 *
 * The thing being replaced was `existsSync(file + ".sig")` — a check that could
 * not fail for the reason it was run. The obvious way to test its replacement is
 * to point it at a correctly signed artifact and assert `ok`. That test would
 * also pass against `() => ({ ok: true })`.
 *
 * So the weight here is on the NEGATIVES: a corrupted artifact, a signature
 * lifted from a different file, a key the config does not trust, and malformed
 * input must each be rejected, **with the right reason** — because
 * `key-id-mismatch` and `signature-invalid` mean different things to whoever is
 * cutting the release (wrong key vs. changed bytes) and lead to different fixes.
 *
 * Signatures are built here from a keypair generated in the test rather than
 * with the real release key: the tests need no secret, run in milliseconds, and
 * can construct cases (wrong key id, "Ed" raw mode) that no real artifact has.
 * The real artifact is still checked, as an integration case, when one happens
 * to be on disk — see the last block.
 */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign, createHash, randomBytes } from "node:crypto";
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyArtifact, parsePublicKey, parseSignature } from "./minisign.mjs";

/** Raw 32-byte Ed25519 public key out of a Node KeyObject. */
function rawPublicKey(publicKey) {
  // SPKI DER is a 12-byte header then the 32 key bytes.
  return publicKey.export({ format: "der", type: "spki" }).subarray(12);
}

/** Build the base64-of-a-minisign-file container Tauri stores. */
function container(commentLine, payload, trailer = []) {
  const text = [commentLine, payload.toString("base64"), ...trailer].join("\n") + "\n";
  return Buffer.from(text, "utf8").toString("base64");
}

function makeKeypair(keyId = randomBytes(8)) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubBlob = Buffer.concat([Buffer.from("Ed", "latin1"), keyId, rawPublicKey(publicKey)]);
  return {
    privateKey,
    keyId,
    pubkeyConfigValue: container("untrusted comment: minisign public key: TEST", pubBlob),
  };
}

/** Sign `contents`, producing the .sig file body Tauri would write. */
function makeSig({ privateKey, keyId }, contents, algorithm = "ED") {
  const message = algorithm === "ED" ? createHash("blake2b512").update(contents).digest() : contents;
  const sig = edSign(null, message, privateKey);
  const blob = Buffer.concat([Buffer.from(algorithm, "latin1"), keyId, sig]);
  return container("untrusted comment: signature from tauri secret key", blob, [
    "trusted comment: timestamp:1788714280\tfile:test-artifact",
    Buffer.alloc(64).toString("base64"), // global sig; deliberately not verified
  ]);
}

const dir = mkdtempSync(join(tmpdir(), "minisign-test-"));
let n = 0;
function write(name, data) {
  const p = join(dir, `${n++}-${name}`);
  writeFileSync(p, data);
  return p;
}

describe("minisign artifact verification", () => {
  const artifact = Buffer.from("pretend this is a 150MB installer");

  it("accepts a correctly signed artifact (prehashed, as Tauri writes)", () => {
    const kp = makeKeypair();
    const file = write("app.exe", artifact);
    const sigPath = write("app.exe.sig", makeSig(kp, artifact, "ED"));
    const r = verifyArtifact({ artifactPath: file, sigPath, pubkeyConfigValue: kp.pubkeyConfigValue });
    expect(r.ok).toBe(true);
    expect(r.algorithm).toBe("ED");
  });

  it("accepts the raw (non-prehashed) 'Ed' variant too", () => {
    // Tauri emits "ED", but minisign defines both and guessing which one is in
    // use is how a verifier ends up only ever returning ok.
    const kp = makeKeypair();
    const file = write("app.exe", artifact);
    const sigPath = write("app.exe.sig", makeSig(kp, artifact, "Ed"));
    const r = verifyArtifact({ artifactPath: file, sigPath, pubkeyConfigValue: kp.pubkeyConfigValue });
    expect(r.ok).toBe(true);
    expect(r.algorithm).toBe("Ed");
  });

  it("REJECTS an artifact that changed after signing", () => {
    // The real 2026-09-06 case: a rebuild left the previous build's .sig beside
    // a new installer. Right key, wrong bytes.
    const kp = makeKeypair();
    const sigPath = write("app.exe.sig", makeSig(kp, artifact));
    const tampered = Buffer.from(artifact);
    tampered[0] ^= 0xff;
    const file = write("app.exe", tampered);
    const r = verifyArtifact({ artifactPath: file, sigPath, pubkeyConfigValue: kp.pubkeyConfigValue });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("signature-invalid");
  });

  it("REJECTS a signature taken from a different file", () => {
    const kp = makeKeypair();
    const other = Buffer.from("a different artifact entirely");
    const sigPath = write("app.exe.sig", makeSig(kp, other));
    const file = write("app.exe", artifact);
    const r = verifyArtifact({ artifactPath: file, sigPath, pubkeyConfigValue: kp.pubkeyConfigValue });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("signature-invalid");
  });

  it("REJECTS a valid signature made by a key the config does not trust", () => {
    // Distinct from the above on purpose: the bytes are fine, the KEY is wrong.
    // Every installed client would refuse this, and the fix is different.
    const signer = makeKeypair();
    const trusted = makeKeypair();
    const file = write("app.exe", artifact);
    const sigPath = write("app.exe.sig", makeSig(signer, artifact));
    const r = verifyArtifact({ artifactPath: file, sigPath, pubkeyConfigValue: trusted.pubkeyConfigValue });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("key-id-mismatch");
  });

  it("does not confuse a key-id match with a valid signature", () => {
    // Same key id, signature bytes replaced. If the id check were mistaken for
    // verification this would pass.
    const kp = makeKeypair();
    const good = Buffer.from(makeSig(kp, artifact), "base64").toString("utf8").split("\n");
    const blob = Buffer.from(good[1], "base64");
    randomBytes(64).copy(blob, 10); // keep alg + key id, destroy the signature
    good[1] = blob.toString("base64");
    const sigPath = write("app.exe.sig", Buffer.from(good.join("\n"), "utf8").toString("base64"));
    const file = write("app.exe", artifact);
    const r = verifyArtifact({ artifactPath: file, sigPath, pubkeyConfigValue: kp.pubkeyConfigValue });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("signature-invalid");
  });

  it("REJECTS malformed input instead of throwing", () => {
    const kp = makeKeypair();
    const file = write("app.exe", artifact);
    for (const bad of ["", "not base64 at all !!!", Buffer.from("short\n\n", "utf8").toString("base64")]) {
      const sigPath = write("app.exe.sig", bad);
      const r = verifyArtifact({ artifactPath: file, sigPath, pubkeyConfigValue: kp.pubkeyConfigValue });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed");
    }
  });

  it("parses the real shipped pubkey's framing", () => {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    const pub = parsePublicKey(conf.plugins.updater.pubkey);
    expect(pub.algorithm).toBe("Ed");
    expect(pub.key).toHaveLength(32);
    expect(pub.keyId).toHaveLength(8);
  });
});

describe("minisign — real release artifact", () => {
  // Integration, when a built artifact happens to be on disk. Skipped rather
  // than failed on a clean checkout: this asserts against the actual signing
  // key and the actual Tauri output, which unit fixtures cannot stand in for.
  const appImage =
    "src-tauri/target-linux/release/bundle/appimage/PwndaWallet_0.6.0_amd64.AppImage";

  it.skipIf(!existsSync(appImage) || !existsSync(`${appImage}.sig`))(
    "verifies the genuinely signed AppImage against the shipped pubkey",
    () => {
      const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
      const parsed = parseSignature(readFileSync(`${appImage}.sig`, "utf8"));
      expect(parsed.algorithm).toBe("ED"); // what Tauri actually emits
      const r = verifyArtifact({
        artifactPath: appImage,
        sigPath: `${appImage}.sig`,
        pubkeyConfigValue: conf.plugins.updater.pubkey,
      });
      expect(r.ok).toBe(true);
    }
  );
});
