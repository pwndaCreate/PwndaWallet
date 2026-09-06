/**
 * Variant of polyseed-sync.mjs using HARD-CODED restore_height (3,100,000)
 * so we can compare behaviour against the Rust integration test. Goal: prove
 * whether the "height stuck at 1" issue is specific to Digest auth (Rust
 * test) or reproduces with unauthenticated access + identical parameters.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const RPC_BINARY =
  "G:\\PwndaWalletDevelopment\\src-tauri\\binaries\\monero-wallet-rpc.exe";
const RPC_PORT = 28093;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}/json_rpc`;
const DAEMON = "http://xmr.stormycloud.org:18089";

// Exact reference polyseed keys (from scripts/polyseed-e2e.mjs).
const ADDRESS =
  "47AjPj7DVPQVGGXJXbbTMZWcKQDejGHYZChVkeujy8qPLjKkgdsxge4DzvkRMgU4sDUigGLuBN9stKBMowhuXH2HJHWAuRf";
const SPENDKEY = "6dd6b2029bfdf1c44a36ce8b229f35dcaa5800b8d858da9facf4b0a778dc2800";
const VIEWKEY = "3c56a3cc3e7f94dc428ffe3b856adb6054552dfa14360d4cdec3f7730b999107";
const RESTORE_HEIGHT = 3_100_000;

async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "0", method, params });
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function waitForRpc() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await rpc("get_version", {});
      if (r.result?.version > 0) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("rpc not ready");
}

const walletDir = mkdtempSync(join(tmpdir(), "pwnda-hard-"));
const child = spawn(
  RPC_BINARY,
  [
    "--rpc-bind-ip", "127.0.0.1",
    "--rpc-bind-port", String(RPC_PORT),
    "--disable-rpc-login",
    "--wallet-dir", walletDir,
    "--daemon-address", DAEMON,
    "--non-interactive",
    "--log-level", "0",
  ],
  { stdio: "ignore", windowsHide: true }
);

try {
  await waitForRpc();
  console.log("[RPC] up");

  const gen = await rpc("generate_from_keys", {
    filename: "hard",
    password: "",
    restore_height: RESTORE_HEIGHT,
    address: ADDRESS,
    viewkey: VIEWKEY,
    spendkey: SPENDKEY,
    language: "English",
    autosave_current: true,
  });
  console.log("[generate_from_keys]", gen.result);

  const ar = await rpc("auto_refresh", { enable: true, period: 10 });
  console.log("[auto_refresh]", ar.result);

  console.log("[polling get_height]");
  for (let t = 0; t <= 25; t += 5) {
    const h = await rpc("get_height", {});
    console.log(`  t=${t}s  height=${h.result?.height}`);
    if (t < 25) await sleep(5000);
  }
} finally {
  try { child.kill("SIGKILL"); } catch {}
  try { rmSync(walletDir, { recursive: true, force: true }); } catch {}
}
