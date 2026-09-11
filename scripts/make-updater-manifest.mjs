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
import { verifyArtifact } from "./lib/minisign.mjs";
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
// Windows: NSIS `-setup.exe`, and ONLY that. Both formats could be signed, but
// an MSI in-place upgrade depends on matching UpgradeCode + version rules while
// the NSIS installer simply overwrites the install dir — which is what "update
// without a clean install" actually means for a user. That preference is now
// settled upstream: `bundle.targets` is `["nsis"]` since 2026-09-06, so there
// is one Windows installer and it is the one the updater serves.
//
// The old rank-2 MSI rule is deliberately GONE rather than left as a harmless
// fallback. `target/release/bundle/msi/` is not cleaned between builds and
// still contains artifacts from earlier versions; a rule that scans it could
// advertise a stale, no-longer-built installer as an update the moment the
// NSIS one was missing for any reason. A missing artifact should fail loudly,
// not silently resolve to a format we stopped shipping.
//
// Linux ships THREE updatable formats, not one.
//
// `tauri-plugin-updater` implements an installer for each (AppImage replaces
// itself; `.deb` and `.rpm` go through `pkexec dpkg -i` / `rpm -U`, which is
// what apt runs underneath). Until 2026-09-10 only the AppImage was listed
// here, with a comment claiming the plugin "refuses to self-replace" the other
// two — it does not. What actually blocked them was that their signatures were
// built and never uploaded (`scripts/releaseArtifactParity.test.mjs`).
//
// # Why one manifest cannot serve all three
//
// A client looks itself up by `{os}-{arch}`, so every Linux build — AppImage,
// deb and rpm alike — reads the SAME `linux-x86_64` key. One key, one URL:
// serving all three from `latest.json` is not possible, and serving the wrong
// one is worse than serving none (the plugin would hand AppImage bytes to
// `install_deb`, which rejects them as `InvalidUpdaterFormat` after a ~180 MB
// download).
//
// The way out is `{{bundle_type}}` in the endpoint URL. The bundler stamps
// `__TAURI_BUNDLE_TYPE` into each artifact as it builds it, so a binary
// installed from the .deb asks for `latest-deb.json` and one running from the
// AppImage asks for `latest-appimage.json` — each of which carries a single
// `linux-x86_64` entry pointing at the right file.
//
// `latest.json` is still written, unchanged, and still lists the AppImage for
// Linux: clients built before this change have the old endpoint compiled in
// and must keep resolving. See `writeManifest` at the bottom.
const RULES = [
  { platform: "windows-x86_64", bundleType: "nsis", dir: "target/release/bundle/nsis", ext: ".exe" },
  { platform: "linux-x86_64", bundleType: "appimage", dir: "target-linux/release/bundle/appimage", ext: ".AppImage" },
  { platform: "linux-x86_64", bundleType: "deb", dir: "target-linux/release/bundle/deb", ext: ".deb" },
  { platform: "linux-x86_64", bundleType: "rpm", dir: "target-linux/release/bundle/rpm", ext: ".rpm" },
];

/**
 * Which bundle type `latest.json` serves for each platform.
 *
 * Pinned as data rather than inferred, because this is a compatibility
 * commitment to already-installed clients and not something a future edit
 * should be able to change by reordering a list. An old client asking for
 * `latest.json` is an
 * AppImage or an NSIS install — those were the only two formats the endpoint
 * ever served — so those are the two it must keep getting.
 */
const LEGACY_MANIFEST_TYPES = { "windows-x86_64": "nsis", "linux-x86_64": "appimage" };

// The product this manifest is for. PwndaLite builds into the same bundle dirs
// and must never appear here.
// The public key the SHIPPED app will check downloads against. Verification
// here has to use this exact value, not the signing key or a key file on the
// build machine: the only signature that matters is one the installed client
// will accept, and this string is what got baked into it.
const PUBKEY = conf.plugins?.updater?.pubkey;
if (!PUBKEY) {
  console.error(
    `${LOG} REFUSING: tauri.conf.json has no plugins.updater.pubkey, so nothing here can be
` +
      `${LOG} verified -- and the shipped app would have no key to check downloads against either.`,
  );
  process.exit(2);
}

const productName = conf.productName;
if (!productName) {
  console.error(`${LOG} tauri.conf.json has no productName; cannot tell this product's bundles from a sibling's`);
  process.exit(2);
}

/**
 * bundleType -> the one verified artifact of that format.
 *
 * The single source of truth for everything below. There used to be a second
 * map keyed by PLATFORM, with a `rank` field breaking ties for the shared
 * `linux-x86_64` key — that made sense when Linux had one updatable format and
 * the only contest was msi-vs-nsis. Now three Linux formats share that key and
 * every one of them needs its own manifest, so "which artifact is the deb" is
 * the only question worth indexing. Which format `latest.json` serves is a
 * separate, pinned decision (`LEGACY_MANIFEST_TYPES`), not a race a rank
 * number wins.
 */
const byType = new Map();
const verified = [];
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
    // In --from mode every rule sees the same flat dir, so each rule must be
    // able to recognise its own artifact by extension alone. Every rule has a
    // distinct one (.exe / .AppImage / .deb / .rpm), and `.deb.sig` does not
    // end with `.deb`, so signatures are never mistaken for artifacts.


    const file = join(dir, name);
    const sig = `${file}.sig`;

    if (!existsSync(sig)) {
      // Report the dir actually scanned, not the rule's nominal one --
      // in --from mode they differ and the message would name a path the
      // file is not in.
      unsigned.push(`${dir}/${name}  (no ${name}.sig beside it)`);
      continue;
    }

    // ACTUALLY VERIFY IT.
    //
    // This was `existsSync(sig)` and nothing else -- a question about the
    // DIRECTORY, not about the artifact. A signature from a different build, or
    // from a key the app does not trust, passed it. What that publishes is an
    // update every client downloads in full (~150 MB) and then rejects at its
    // own signature check, with the release looking perfectly healthy from here.
    //
    // A stale-mtime guard was added first (2026-09-06), after a bare
    // `npm run tauri:build` with no signing key in the environment rebuilt the
    // installer and left the previous build's .sig beside it. It caught the
    // accident that exposed the gap and nothing else, and it is now gone: a
    // stale signature fails verification on its merits, and keeping a proxy
    // check beside the real one only invites trusting the proxy.
    const v = verifyArtifact({ artifactPath: file, sigPath: sig, pubkeyConfigValue: PUBKEY });
    if (!v.ok) {
      unsigned.push(`${dir}/${name}  [${v.reason}] ${v.message}`);
      continue;
    }
    verified.push(`${name}  (${v.algorithm}, key ${v.keyId})`);
    const hit = { file, name, sig, dir: rule.dir, platform: rule.platform };
    // Two artifacts of the SAME bundle type is not a tie to break, it is an
    // ambiguity: both passed the version+product filter, so there is no
    // principled way to pick, and silently taking one could publish the wrong
    // binary. Refuse instead.
    const clash = byType.get(rule.bundleType);
    if (clash && clash.name !== name) {
      console.error(
        `${LOG} REFUSING: two ${rule.bundleType} artifacts for ${bare}: ${clash.name} and ${name}.`,
      );
      process.exit(1);
    }
    byType.set(rule.bundleType, hit);
  }
}

if (unsigned.length) {
  console.error(`${LOG} REFUSING: ${unsigned.length} bundle(s) failed signature verification:`);
  for (const u of unsigned) console.error(`${LOG}   ${u}`);
  console.error(
    `${LOG}
${LOG} The updater verifies every download against the pubkey in tauri.conf.json, so a
` +
      `${LOG} bad entry produces a download every client rejects AFTER transferring it.
` +
      `${LOG}
` +
      `${LOG}   no .sig beside it  -> set "createUpdaterArtifacts": true and provide
` +
      `${LOG}                         TAURI_SIGNING_PRIVATE_KEY[_PASSWORD].
` +
      `${LOG}   key-id-mismatch    -> the signing key and the pubkey in tauri.conf.json are
` +
      `${LOG}                         DIFFERENT KEYS. Re-sign with the right one, or correct the
` +
      `${LOG}                         config -- but never rotate a shipped pubkey casually:
` +
      `${LOG}                         installed clients only trust the old one.
` +
      `${LOG}   signature-invalid  -> right key, wrong bytes. The artifact was rebuilt or
` +
      `${LOG}                         replaced after it was signed. Re-sign it.`,
  );
  process.exit(1);
}
for (const v of verified) console.log(`${LOG} signature OK  ${v}`);

// What `latest.json` will contain. Which format the LEGACY endpoint serves is
// a compatibility commitment to already-installed clients, so it is read from
// LEGACY_MANIFEST_TYPES and from nowhere else.
const platforms = {};
for (const [platform, type] of Object.entries(LEGACY_MANIFEST_TYPES)) {
  const hit = byType.get(type);
  if (!hit) continue;
  platforms[platform] = entryForVerbose(hit, platform);
}

const WANTED = ["windows-x86_64", "linux-x86_64"];
const missing = WANTED.filter((p) => !(p in platforms));
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

const notes = arg("notes", `PWNDA Wallet ${version}`);
// Fixed-format UTC. `new Date().toISOString()` is what Tauri's own examples
// use and what the client parses. Computed ONCE so every manifest this run
// writes carries the same timestamp — they describe one release.
const pubDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const out = arg("out", join(REPO_ROOT, "src-tauri", "target", "release", "bundle", "latest.json"));
mkdirSync(dirname(out), { recursive: true });

/**
 * Build one manifest entry from a verified hit.
 *
 * Declared as a `function` (not a `const`) deliberately: it is called from the
 * `latest.json` assembly further UP the file, and hoisting is what lets the
 * helpers live next to the writer that is their main consumer.
 */
function entryFor(hit) {
  const signature = readFileSync(hit.sig, "utf8").trim();
  if (!signature) {
    console.error(`${LOG} REFUSING: ${hit.name}.sig is empty`);
    process.exit(1);
  }
  return {
    signature,
    url: `https://github.com/${slug}/releases/download/${version}/${encodeURIComponent(hit.name)}`,
  };
}

/**
 * As [`entryFor`], and print the artifact + its sha256.
 *
 * The hash is logged, never published: `latest.json` has no field for it (the
 * signature is what the client verifies). It is here so a release operator can
 * match what was published against what is on disk without re-deriving it.
 */
function entryForVerbose(hit, platform) {
  const entry = entryFor(hit);
  const sha = createHash("sha256").update(readFileSync(hit.file)).digest("hex");
  console.log(`${LOG} ${platform.padEnd(16)} ${hit.name}`);
  console.log(`${LOG} ${"".padEnd(16)} sha256 ${sha}`);
  return entry;
}

function writeManifest(path, platformMap) {
  writeFileSync(
    path,
    `${JSON.stringify({ version: bare, notes, pub_date: pubDate, platforms: platformMap }, null, 2)}\n`,
    "utf8",
  );
  console.log(`${LOG} wrote ${path}  (${Object.keys(platformMap).join(", ")})`);
}

// 1. `latest.json` — the endpoint compiled into every client built before the
//    `{{bundle_type}}` change. Its contents must not drift: those clients are
//    AppImage and NSIS installs, and that is what it has always served.
writeManifest(out, platforms);

// 2. One manifest per bundle type, for the `{{bundle_type}}` endpoint. Each
//    carries exactly ONE platform entry, because a client that resolves
//    `latest-deb.json` is by construction a deb install and there is nothing
//    else in that file for it to pick up by mistake.
const perType = [];
for (const [type, hit] of byType) {
  const path = join(dirname(out), `latest-${type}.json`);
  writeManifest(path, { [hit.platform]: entryFor(hit) });
  perType.push(type);
}

console.log(
  `${LOG} version ${bare}, ${Object.keys(platforms).length} platform(s) in latest.json, ` +
    `per-type: ${perType.join(", ") || "none"}, repo ${slug}`,
);
