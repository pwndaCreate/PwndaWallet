#!/usr/bin/env node
// Build the updater manifest (`latest.json`) the in-app updater fetches.
//
//   node scripts/make-updater-manifest.mjs --version v0.5.0 [--notes "..."]
//        [--out <path>] [--repo owner/name] [--allow-partial]
//
// ── Why this script exists ───────────────────────────────────────────────────
//
// Tauri v2 does NOT emit `latest.json`. With `createUpdaterArtifacts: true` it
// writes a detached `<bundle>.sig` beside each installer and stops there; the
// manifest that tells a running app "a newer version exists, here it is, here
// is its signature" is the release pipeline's job. `release-local.ps1` used to
// glob for `appimage/latest.json` as if the bundler produced one — it never
// did, so that glob matched nothing and no manifest was ever uploaded. An
// updater endpoint that 404s is indistinguishable, from inside the app, from
// "you are up to date": `check()` returns null either way.
//
// ── What it refuses to do ────────────────────────────────────────────────────
//
// A bundle with no `.sig` beside it is a HARD ERROR, not a skipped platform.
// The updater verifies signatures against the pubkey baked into
// `tauri.conf.json`; an unsigned entry in the manifest produces a download that
// every client rejects at the last step, after paying for the whole transfer.
// Failing here, in the release, is the cheap version of that failure.
//
// `--allow-partial` is the deliberate escape hatch for "I only built Windows
// this run". It still refuses unsigned bundles; it only permits MISSING ones,
// and it names what it left out so a half-release cannot look like a whole one.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const LOG = "[updater-manifest]";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

if (flag("help") || flag("h")) {
  console.log(
    "usage: node scripts/make-updater-manifest.mjs --version vX.Y.Z " +
      "[--notes TEXT] [--out FILE] [--repo owner/name] [--allow-partial]",
  );
  process.exit(0);
}

const version = arg("version");
if (!version || !/^v?\d+\.\d+\.\d+/.test(version)) {
  console.error(`${LOG} --version is required and must look like v1.2.3 (got ${version ?? "nothing"})`);
  process.exit(2);
}
// The manifest carries the BARE version. Tauri compares it to the app's own
// `version` from tauri.conf.json with semver; a leading "v" fails that compare
// and the app silently decides it is up to date.
const bare = version.replace(/^v/, "");

const conf = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
if (conf.version !== bare) {
  console.error(
    `${LOG} REFUSING: tauri.conf.json says version ${conf.version} but this release is ${bare}.\n` +
      `${LOG} The app compares the manifest against ITS OWN baked-in version, so a mismatch here\n` +
      `${LOG} either offers an update to every user forever, or to none of them. Bump the conf first.`,
  );
  process.exit(2);
}

function repoSlug() {
  const explicit = arg("repo");
  if (explicit) return explicit;
  try {
    const url = execSync("git remote get-url origin", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  console.error(`${LOG} could not determine the GitHub repo; pass --repo owner/name`);
  process.exit(2);
}
const slug = repoSlug();

// ── Which built file is the updater artifact for which platform ──────────────
//
// Windows: NSIS `-setup.exe` is preferred over MSI. Both can be signed, but an
// MSI in-place upgrade depends on matching UpgradeCode + version rules, while
// the NSIS installer simply overwrites the install dir — which is what "update
// without a clean install" actually means for a user. If both exist we take
// NSIS and say so.
//
// Linux: AppImage only. `.deb` and `.rpm` are owned by apt/dnf and the plugin
// refuses to self-replace them (see src/lib/updater.ts) — listing them here
// would advertise an update path the client is right to reject.
const RULES = [
  { platform: "windows-x86_64", dir: "target/release/bundle/nsis", ext: ".exe", rank: 1 },
  { platform: "windows-x86_64", dir: "target/release/bundle/msi", ext: ".msi", rank: 2 },
  { platform: "linux-x86_64", dir: "target-linux/release/bundle/appimage", ext: ".AppImage", rank: 1 },
];

// The product this manifest is for. PwndaLite builds into the same bundle dirs
// and must never appear here.
const productName = conf.productName;
if (!productName) {
  console.error(`${LOG} tauri.conf.json has no productName; cannot tell this product's bundles from a sibling's`);
  process.exit(2);
}

const found = new Map(); // platform -> {file, sig, rank, dir}
const unsigned = [];

// `--from <dir>` reads a FLAT directory of already-renamed, ready-to-publish
// artifacts instead of the per-bundler build dirs. The release script stages
// there so the file names users download are the names the manifest points at:
// GitHub serves an asset under its filename, so a friendly download name and a
// working updater URL have to be the same string or the update 404s.
const fromDir = arg("from");

for (const rule of RULES) {
  const dir = fromDir
    ? resolve(fromDir)
    : join(REPO_ROOT, "src-tauri", ...rule.dir.split("/"));
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(rule.ext)) continue;

    // Scope to THIS release of THIS product.
    //
    // The bundle dirs are never cleaned, so they accumulate: this repo holds
    // MSIs from 0.1.0, 0.2.0 and 0.3.0 under two former product names, plus
    // PwndaLite — a SEPARATE product that ships its own installer from the same
    // target dir. Without this filter a stale unsigned 0.1.0 artifact makes the
    // signature check below fail forever, and a PwndaLite bundle could be
    // advertised to PwndaWallet clients as their update.
    if (!name.includes(bare)) continue;
    if (!name.startsWith(productName)) continue;
    // In --from mode every rule sees the same flat dir, so a .exe could be
    // matched by both the nsis and msi rules. Extension is the discriminator
    // and both rules already carry one; nothing further is needed, but the
    // rank still decides which wins for a platform.


    const file = join(dir, name);
    const sig = `${file}.sig`;
    if (!existsSync(sig)) {
      // Report the dir actually scanned, not the rule's nominal one --
      // in --from mode they differ and the message would name a path the
      // file is not in.
      unsigned.push(`${dir}/${name}  (no ${name}.sig beside it)`);
      continue;
    }
    const prev = found.get(rule.platform);
    if (!prev || rule.rank < prev.rank) {
      found.set(rule.platform, { file, name, sig, rank: rule.rank, dir: rule.dir });
    }
  }
}

if (unsigned.length) {
  console.error(`${LOG} REFUSING: ${unsigned.length} bundle(s) built WITHOUT a signature:`);
  for (const u of unsigned) console.error(`${LOG}   ${u}`);
  console.error(
    `${LOG}\n${LOG} The updater verifies every download against the pubkey in tauri.conf.json, so an\n` +
      `${LOG} unsigned entry produces a download every client rejects AFTER transferring it.\n` +
      `${LOG} Set "createUpdaterArtifacts": true and provide TAURI_SIGNING_PRIVATE_KEY[_PASSWORD].`,
  );
  process.exit(1);
}

const WANTED = ["windows-x86_64", "linux-x86_64"];
const missing = WANTED.filter((p) => !found.has(p));
if (missing.length && !flag("allow-partial")) {
  console.error(`${LOG} REFUSING: no signed updater artifact for ${missing.join(", ")}.`);
  console.error(
    `${LOG} Users on those platforms would silently never be offered this release.\n` +
      `${LOG} Build them, or pass --allow-partial if that is genuinely intended.`,
  );
  process.exit(1);
}
if (missing.length) {
  console.warn(`${LOG} PARTIAL RELEASE: no update will be offered to ${missing.join(", ")}.`);
}

const platforms = {};
for (const [platform, hit] of found) {
  const signature = readFileSync(hit.sig, "utf8").trim();
  if (!signature) {
    console.error(`${LOG} REFUSING: ${hit.name}.sig is empty`);
    process.exit(1);
  }
  platforms[platform] = {
    signature,
    url: `https://github.com/${slug}/releases/download/${version}/${encodeURIComponent(hit.name)}`,
  };
  const sha = createHash("sha256").update(readFileSync(hit.file)).digest("hex");
  console.log(`${LOG} ${platform.padEnd(16)} ${hit.name}`);
  console.log(`${LOG} ${"".padEnd(16)} sha256 ${sha}`);
}

const manifest = {
  version: bare,
  notes: arg("notes", `PWNDA Wallet ${version}`),
  // Fixed-format UTC. `new Date().toISOString()` is what Tauri's own examples
  // use and what the client parses.
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms,
};

const out = arg("out", join(REPO_ROOT, "src-tauri", "target", "release", "bundle", "latest.json"));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`${LOG} wrote ${out}`);
console.log(`${LOG} version ${bare}, ${Object.keys(platforms).length} platform(s), repo ${slug}`);
