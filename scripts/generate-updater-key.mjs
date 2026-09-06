#!/usr/bin/env node
/**
 * Generate the minisign keypair that signs PwndaWallet updates.
 *
 * Usage:
 *   node scripts/generate-updater-key.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS SCRIPT EXISTS
 *
 * Updater signing was blocked from 2026-05-16 to 2026-08-12. Three keypairs
 * were generated with:
 *
 *     $env:TAURI_KEY_PASSWORD = "<random hex>"
 *     tauri signer generate --ci -w pwnda.key
 *
 * and every subsequent `tauri signer sign` failed with
 * "Wrong password for that key" — with the random password AND with an empty
 * one. The cause, reproduced and confirmed 2026-08-12:
 *
 *   `--ci` generates a key with NO password. It prints
 *   "Warn Generating new private key without password" and it does NOT read
 *   TAURI_KEY_PASSWORD — that env var is not an input to the generate step.
 *   The resulting key file still carries the `rsign encrypted secret key`
 *   header, which is what made it look password-protected.
 *
 *   A key made that way then fails to sign with the intended password (wrong)
 *   AND with an empty password (also wrong) — it is effectively unusable.
 *
 * The fix is the `-p/--password` flag, which IS the generate-time input:
 *
 *     tauri signer generate -p "<password>" -w pwnda.key
 *     TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<same password>" tauri signer sign ...
 *
 * Verified end to end on 2026-08-12: generate with -p, sign, signature emitted.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * SECURITY
 *
 * The private key this produces controls what code runs on every user's
 * machine that has PwndaWallet installed. The updater verifies downloads
 * against the matching public key compiled into the binary, so anyone holding
 * the private key can ship arbitrary code as a "PwndaWallet update".
 *
 * Treat it like a code-signing certificate:
 *   - NEVER commit it. `.env.local` is gitignored; keep it there.
 *   - NEVER paste it into an issue, a chat, or CI logs.
 *   - Back it up offline. Losing it means no existing install can ever
 *     auto-update again — you'd have to ship a new pubkey and every user
 *     would need to reinstall manually.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY_PATH = path.join(REPO_ROOT, "pwnda-updater.key");

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["@tauri-apps/cli", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || out || `exit ${code}`))
    );
  });
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const rl = createInterface({ input: stdin, output: stdout });

console.log("PwndaWallet updater keypair generator\n");

if (await exists(KEY_PATH)) {
  console.error(
    `Refusing to overwrite an existing key at:\n  ${KEY_PATH}\n\n` +
      `If you really mean to rotate it, move that file aside first — and know\n` +
      `that every already-installed copy will stop auto-updating, because they\n` +
      `verify against the OLD public key baked into their binary.`
  );
  process.exit(1);
}

const password = await rl.question("Password for the new signing key (not echoed to disk): ");
if (!password) {
  console.error(
    "\nEmpty password rejected. A passwordless key is the exact failure mode\n" +
      "this script exists to prevent — see the header comment."
  );
  process.exit(1);
}
const confirm = await rl.question("Confirm password: ");
rl.close();
if (password !== confirm) {
  console.error("\nPasswords do not match.");
  process.exit(1);
}

console.log("\nGenerating…");
// -p is the generate-time password input. Do NOT use --ci here.
await run(["signer", "generate", "-p", password, "-w", KEY_PATH]);

const privKey = (await readFile(KEY_PATH, "utf8")).trim();
const pubKey = (await readFile(`${KEY_PATH}.pub`, "utf8")).trim();

const envPath = path.join(REPO_ROOT, ".env.local");
const line =
  `\n# Updater signing key — generated ${new Date().toISOString().slice(0, 10)}.\n` +
  `# NEVER commit. See scripts/generate-updater-key.mjs.\n` +
  `TAURI_SIGNING_PRIVATE_KEY=${privKey}\n` +
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=${password}\n`;
await writeFile(envPath, ((await exists(envPath)) ? await readFile(envPath, "utf8") : "") + line);

console.log(`
Done.

  private key   ${KEY_PATH}          (gitignored — back this up offline)
  public key    ${KEY_PATH}.pub
  env written   .env.local            (TAURI_SIGNING_PRIVATE_KEY[_PASSWORD])

NEXT STEPS

  1. Paste this public key into BOTH tauri confs, at plugins.updater.pubkey:

${pubKey}

     - src-tauri/tauri.conf.json
     - src-tauri/tauri-lite.conf.json

  2. Set "createUpdaterArtifacts": true in both confs.

  3. Point plugins.updater.endpoints at the repo you actually publish releases
     from. It must serve latest.json at:
       https://github.com/<owner>/<repo>/releases/latest/download/latest.json

  4. Build. Confirm .sig files appear next to the bundles:
       src-tauri/target-linux/release/bundle/appimage/*.AppImage.sig

  5. Back up ${path.basename(KEY_PATH)} somewhere offline. If you lose it, no
     existing install can ever auto-update again.
`);
