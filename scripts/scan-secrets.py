#!/usr/bin/env python3
"""Scan a directory tree for credentials. Exit 1 if any survive triage.

    python scripts/scan-secrets.py [DIR]      # default: the repo root

Used as the gate in `publish-public.ps1`: the public tree is scanned after it is
assembled and before it is committed, and a hit stops the publish. A scan that
only warns is a scan that gets ignored.

Findings print file:line and the RULE NAME only, never the matched text, so the
output can be pasted anywhere without re-leaking what it found.

# Known-good material is DECLARED, not silently tolerated

This project legitimately ships key-shaped constants: BIP39's `abandon abandon…`
test vector and the published polyseed reference keys. Every one of them is
listed in ALLOW below with the reason it is safe. A declaration is a decision;
silence is a bug — the same rule as `NOT_BUNDLED` in bundle-binaries.mjs. If a
new constant trips this scan, add it here with a reason or remove it from the
tree; do not widen a pattern to make the noise go away.
"""
import os
import re
import sys

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else
                       os.path.join(os.path.dirname(__file__), ".."))

RULES = [
    ("PEM private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("GitHub token", re.compile(r"\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("OpenAI/Anthropic key", re.compile(r"\bsk-(ant-)?[A-Za-z0-9_-]{20,}")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Blockfrost project id", re.compile(r"\b(preprod|mainnet|preview)[0-9A-Za-z]{28,36}\b")),
    ("Infura/Alchemy url key", re.compile(r"(infura\.io/v3/|alchemyapi\.io/v2/|g\.alchemy\.com/v2/)[0-9A-Za-z_-]{16,}")),
    ("Monero secret key hex", re.compile(r"(?i)\b(secret|spend|view)[_-]?key\s*[=:]\s*['\"]?[0-9a-f]{64}\b")),
    ("hex assigned to *SKEY/PRIVKEY", re.compile(r"(?i)\b\w*(skey|privkey|private_key|seckey)\w*\s*[=:]\s*['\"]?[0-9a-f]{64,128}\b")),
    ("updater signing secret", re.compile(r"\bdW50cnVzdGVkIGNvbW1lbnQ6.*c2VjcmV0", re.I)),
]

# path fragment -> why it is safe. Checked against the repo-relative path.
ALLOW_PATHS = {
    "scripts/polyseed-sync-hardcoded.mjs":
        "published polyseed reference vector, labelled in-file; no funds",
    "scripts/polyseed-e2e.mjs":
        "the same published polyseed reference vector",
    "src-tauri/src/xmr_rpc.rs":
        "the same polyseed reference vector, in a unit test",
    "scripts/scan-secrets.py":
        "this file — the patterns themselves",
}

# literal -> why it is safe. Checked against the matching LINE.
ALLOW_LINES = [
    ("abandon abandon", "the standard BIP39 test vector; world-public by design"),
    ("47AjPj7DVPQVGGXJXbbTMZWcKQDejGHYZChVkeujy8qPLjKkgdsxge4DzvkRMgU4sDUigGLuBN9stKBMowhuXH2HJHWAuRf",
     "published polyseed reference address"),
    ("s3cr3t-console-pw", "literal inside console_init_script_carries_no_password"),
    ("EXAMPLE", "documented placeholder"),
    ("your-", "documented placeholder"),
    ("<REDACTED>", "already redacted"),
]

# Any directory named target* is a cargo build tree (target, target-linux,
# target-sandbox, target-claude-lite, …). Scanning them is slow and produces
# nothing but PEM strings vendored inside .rlib files by pkcs8/native-tls.
SKIP_DIR_PREFIXES = ("target",)
SKIP_DIRS = {".git", "node_modules", "dist", "dist-lite", ".cache",
             ".swap-sidecar-work", "__pycache__", ".playwright-mcp", ".obsidian"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".zip", ".gz", ".xz",
            ".enc", ".wasm", ".exe", ".dll", ".so", ".pdf", ".keys", ".bin", ".woff",
            ".woff2", ".ttf", ".mp4", ".lock"}

hits, scanned = [], 0
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames
                   if d not in SKIP_DIRS and not d.startswith(SKIP_DIR_PREFIXES)]
    for fn in filenames:
        full = os.path.join(dirpath, fn)
        rel = os.path.relpath(full, ROOT).replace("\\", "/")
        if os.path.splitext(fn)[1].lower() in SKIP_EXT:
            continue
        if any(rel == p or rel.endswith("/" + p) for p in ALLOW_PATHS):
            continue
        try:
            if os.path.getsize(full) > 8 * 1024 * 1024:
                continue
            with open(full, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        scanned += 1

        # A RAW KEY FILE: the whole file is one hex blob with no `key=` around
        # it, so every line-level rule above is blind to it. This is exactly the
        # shape of `ada-funding.preprod.skey` — 64 bytes of Ed25519 secret and
        # nothing else — which the first version of this scanner missed while
        # correctly flagging the same key's hex inside an env file (2026-09-06).
        # Digest files are the obvious false positive, so they are excluded by
        # extension and by the "hash plus a filename" shape.
        stripped = text.strip()
        if (32 <= len(stripped) <= 256
                and re.fullmatch(r"[0-9a-fA-F]+", stripped)
                and len(stripped) % 2 == 0
                and not fn.lower().endswith((".sha256", ".sha512", ".md5", ".sum", ".txt"))
                and "SUMS" not in fn.upper()):
            hits.append(("raw key file (whole file is hex)", f"{rel}:1"))

        for i, line in enumerate(text.splitlines(), 1):
            if len(line) > 4000:
                continue
            if any(tok in line for tok, _ in ALLOW_LINES):
                continue
            for name, rx in RULES:
                if rx.search(line):
                    hits.append((name, f"{rel}:{i}"))

print(f"[scan-secrets] {scanned} file(s) scanned under {ROOT}")
if not hits:
    print("[scan-secrets] clean — no credential patterns survived triage")
    sys.exit(0)

print(f"[scan-secrets] {len(hits)} FINDING(S) — publish must not proceed:")
for name, loc in hits[:40]:
    print(f"    [{name}] {loc}")
if len(hits) > 40:
    print(f"    ... and {len(hits)-40} more")
print("\n[scan-secrets] Either remove the material, or — if it is genuinely safe —")
print("[scan-secrets] declare it in ALLOW_PATHS / ALLOW_LINES with the reason.")
sys.exit(1)
