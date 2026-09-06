#!/usr/bin/env node
/**
 * check-dead-config — a config key that is SET but read by NOTHING is a lie the
 * repo tells about itself.
 *
 * ## Where this came from
 *
 * The desk applied a rule of ours ("when an item says honour field X, first
 * check X reaches the layer that would honour it") to their own config and found
 * SEVEN live-looking keys read by nothing — their D101. Two of those are worth
 * repeating because they show the damage: `fallback: tor` reads as "if I2P
 * fails we fall back to Tor" and no such mechanism exists anywhere in their
 * tree, and `geo_fence_enroll` is a SECURITY CONTROL that reads as present and
 * does nothing when switched on.
 *
 * We ran the same check here and found one: `VITE_DEFAULT_AFFILIATE=pwndawallet`
 * in `.env.example`, declared in `vite-env.d.ts`, referenced by no source file.
 * The affiliate fee is real but PROXY-INJECTED (`SwapConfirmModal.tsx:518`), so
 * the key reads as though the client chooses where fees go while the proxy
 * actually owns it. Someone editing it would believe they had redirected a fee.
 * It is removed rather than allowlisted: a money-path key that does nothing does
 * not belong in a template people copy.
 *
 * ## Why the guard rather than the fix
 *
 * The finding is one key; the guard is what stops the next one. This is the
 * desk's design, adopted wholesale because it is better than what we would have
 * written — it fails in BOTH directions:
 *
 *   1. a declared/set key with no reader   -> FAIL (a new dead key)
 *   2. a KNOWN_DEAD key that gained one    -> FAIL (the allowlist is now stale)
 *
 * Without (2), an allowlist quietly becomes the place dead keys go to be
 * forgotten, and the next one hides behind an entry nobody re-reads.
 *
 * They also recorded getting it wrong twice first — excluding their config
 * loader entirely made its own accessors look dead, which is the same
 * over-eager judgement the check exists to prevent. The equivalent trap here is
 * the declaration files themselves, so those are excluded as READERS but still
 * mined as SOURCES.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();

/** Files that DECLARE or SET keys. Mined for names, never counted as readers. */
const SOURCES = [
  { file: "src/vite-env.d.ts", re: /readonly\s+(VITE_[A-Z0-9_]+)\??\s*:/g },
  { file: ".env.example", re: /^\s*(VITE_[A-Z0-9_]+)\s*=/gm },
  { file: ".env.sandbox.local.example", re: /^\s*(VITE_[A-Z0-9_]+)\s*=/gm },
  { file: ".env.development.local.example", re: /^\s*(VITE_[A-Z0-9_]+)\s*=/gm },
];

/** Trees searched for READERS. */
const READER_DIRS = ["src", "src-lite", "scripts"];
const READER_FILES = ["vite.config.ts"];
const READER_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".html"]);

/**
 * Keys known to be set-but-unread, each with the reason it is tolerated.
 *
 * EMPTY ON PURPOSE right now. An entry here is a standing admission that the
 * repo says something untrue, so it should be rare and should carry a reason
 * that explains why fixing it is worse than keeping it.
 */
const KNOWN_DEAD = new Map([
  // ["VITE_SOMETHING", "why this is tolerated"],
]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (READER_EXT.has(extname(name))) out.push(p);
  }
  return out;
}

const declared = new Map(); // key -> [source files]
for (const { file, re } of SOURCES) {
  const p = join(ROOT, file);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, "utf8");
  for (const m of text.matchAll(re)) {
    if (!declared.has(m[1])) declared.set(m[1], []);
    declared.get(m[1]).push(file);
  }
}

/**
 * Files excluded from the READER corpus.
 *
 * The declaration/setting files, obviously — a key is not "read" by the line
 * that declares it. And THIS FILE, because the first version of this check
 * PASSED: its own header comment names a dead key while explaining the finding,
 * `scripts/` is a reader directory, so the guard read its own documentation as
 * a consumer and reported the key alive.
 *
 * That is the very class this check exists to catch, committed inside the check
 * itself — and the exact mirror of the trap the desk hit from the other side
 * (they excluded their config loader, which made its own accessors look dead).
 * A guard that cannot fail for the reason you wrote it is worth nothing, so
 * this one is falsified deliberately: see the log entry for 2026-08-07.
 */
const SELF = "scripts/check-dead-config.mjs";
const sourceSet = new Set([
  ...SOURCES.map((s) => s.file.replace(/\\/g, "/")),
  SELF,
]);
const readerFiles = [
  ...READER_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...READER_FILES.map((f) => join(ROOT, f)).filter(existsSync),
].filter((p) => {
  const rel = p.slice(ROOT.length + 1).replace(/\\/g, "/");
  return !sourceSet.has(rel);
});

const corpus = readerFiles.map((p) => readFileSync(p, "utf8")).join("\n");

const dead = [];
const resurrected = [];
for (const [key, files] of declared) {
  const read = corpus.includes(key);
  if (!read && !KNOWN_DEAD.has(key)) dead.push({ key, files });
  if (read && KNOWN_DEAD.has(key)) resurrected.push(key);
}

console.log(
  `[dead-config] ${declared.size} declared/set key(s), ${readerFiles.length} file(s) searched`
);

if (dead.length === 0 && resurrected.length === 0) {
  console.log("[dead-config] PASS");
  process.exit(0);
}

for (const { key, files } of dead) {
  console.error(
    `[dead-config] DEAD: ${key} is set/declared in ${files.join(", ")} and read by nothing.\n` +
      `              A key set to a real value that nothing consumes is a claim the repo cannot back.\n` +
      `              Either wire it up, delete it, or add it to KNOWN_DEAD with a reason.`
  );
}
for (const key of resurrected) {
  console.error(
    `[dead-config] STALE ALLOWLIST: ${key} is in KNOWN_DEAD but now HAS a reader.\n` +
      `              Remove the entry — an allowlist nobody re-reads is where the next dead key hides.`
  );
}
process.exit(1);
