/**
 * Reproduce PwndaWallet's polyseed sync flow end-to-end against a real
 * monero-wallet-rpc.exe. If this script works, the RPC protocol path is
 * sound; any regression must live in the Rust Tauri bridge or the frontend
 * state glue.
 *
 * Covers, in order:
 *   1. Generate a fresh polyseed (random) + derive keys in pure JS.
 *   2. Spawn wallet-rpc on a test port with --disable-rpc-login.
 *   3. Call generate_from_keys with the JS-derived keys + polyseed birthday.
 *   4. Verify get_address matches what we derived.
 *   5. Call auto_refresh(true, 10).
 *   6. Poll get_height for 25s and assert the scan is making progress.
 *   7. Simulate the self-heal delete-and-regenerate flow on the open wallet
 *      and verify generate_from_keys succeeds after close + delete.
 *   8. Clean up.
 *
 * Run: npx tsx scripts/polyseed-sync.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  generatePolyseed,
  polyseedKeygen,
  birthdayToRestoreHeight,
} from "../src/wallets/polyseed.ts";
import { xmrKeysFromRawSecret, bytesToHex } from "../src/wallets/xmr-keys.ts";

const RPC_BINARY =
  "G:\\PwndaWalletDevelopment\\src-tauri\\binaries\\monero-wallet-rpc.exe";
const RPC_PORT = 28091;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}/json_rpc`;
const DAEMON = "http://xmr.stormycloud.org:18089";
const WALLET_FILENAME = "sync-test-active";

function assert(cond, msg) {
  if (!cond) {
    console.error(`\nFAIL: ${msg}`);
    throw new Error(`ASSERT FAIL: ${msg}`);
  }
  console.log(`  OK: ${msg}`);
}

async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "0", method, params });
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    return { __http: res.status, __body: text };
  }
  const json = JSON.parse(text);
  return json;
}

async function waitForRpc() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await rpc("get_version", {});
      if (r?.result?.version > 0) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("wallet-rpc did not come up in 20s");
}

function spawnRpc(walletDir) {
  return spawn(
    RPC_BINARY,
    [
      "--rpc-bind-ip",
      "127.0.0.1",
      "--rpc-bind-port",
      String(RPC_PORT),
      "--disable-rpc-login",
      "--wallet-dir",
      walletDir,
      "--daemon-address",
      DAEMON,
      "--non-interactive",
      "--log-level",
      "0",
    ],
    { stdio: "ignore", windowsHide: true, detached: false }
  );
}

async function main() {
  const walletDir = mkdtempSync(join(tmpdir(), "pwnda-polyseed-sync-"));
  let child = spawnRpc(walletDir);
  const cleanup = () => {
    try { child.kill("SIGKILL"); } catch {}
    try { rmSync(walletDir, { recursive: true, force: true }); } catch {}
  };
  try {
    await waitForRpc();
    console.log("[RPC] up");

    // ---- Step 1-2: generate polyseed + derive keys ----
    const { phrase, data } = generatePolyseed();
    const spendKeyRaw = polyseedKeygen(data);
    const keys = await xmrKeysFromRawSecret(spendKeyRaw);
    const restoreHeight = birthdayToRestoreHeight(data.birthday);
    console.log(`\n[phrase] ${phrase}`);
    console.log(`[JS] address = ${keys.address}`);
    console.log(`[JS] restoreHeight = ${restoreHeight}`);

    // ---- Step 3: generate_from_keys ----
    const gen = await rpc("generate_from_keys", {
      filename: WALLET_FILENAME,
      password: "",
      restore_height: restoreHeight,
      address: keys.address,
      viewkey: bytesToHex(keys.viewSecret),
      spendkey: bytesToHex(keys.spendSecret),
      language: "English",
      autosave_current: true,
    });
    assert(!gen.error, `generate_from_keys ok (err: ${JSON.stringify(gen.error)})`);

    // ---- Step 4: get_address matches ----
    const a = await rpc("get_address", { account_index: 0 });
    assert(!a.error, "get_address no error");
    assert(a.result.address === keys.address, "get_address matches JS");

    // ---- Step 5: auto_refresh ----
    const ar = await rpc("auto_refresh", { enable: true, period: 10 });
    assert(!ar.error, `auto_refresh ok (err: ${JSON.stringify(ar.error)})`);

    // ---- Step 6: poll get_height, assert progress ----
    console.log("\n[sync] polling get_height for 25s...");
    const h0 = await rpc("get_height", {});
    const start = h0.result.height;
    console.log(`  t=0s  height=${start}`);
    let end = start;
    for (let t = 1; t <= 5; t++) {
      await sleep(5000);
      const h = await rpc("get_height", {});
      end = h.result.height;
      console.log(`  t=${t * 5}s  height=${end}`);
    }
    assert(
      end > start,
      `wallet height advanced during the poll window (${start} -> ${end})`
    );

    // ---- Step 6b: get_balance works (no RPC error after restore) ----
    const bal = await rpc("get_balance", { account_index: 0 });
    assert(!bal.error, `get_balance returned no error`);
    console.log(
      `  balance = ${bal.result.balance} piconero  unlocked = ${bal.result.unlocked_balance}`
    );

    // ---- Step 7: simulate self-heal delete + regenerate ----
    console.log("\n[self-heal] testing close+delete+regenerate cycle...");
    const close = await rpc("close_wallet", {});
    assert(!close.error, "close_wallet ok");
    // Give wallet-rpc a moment to release the file handle.
    await sleep(500);
    for (const suffix of ["", ".keys", ".address.txt"]) {
      const p = join(walletDir, `${WALLET_FILENAME}${suffix}`);
      if (existsSync(p)) {
        rmSync(p, { force: true });
      }
      assert(!existsSync(p), `wallet file deleted: ${suffix || "(no suffix)"}`);
    }
    const regen = await rpc("generate_from_keys", {
      filename: WALLET_FILENAME,
      password: "",
      restore_height: restoreHeight,
      address: keys.address,
      viewkey: bytesToHex(keys.viewSecret),
      spendkey: bytesToHex(keys.spendSecret),
      language: "English",
      autosave_current: true,
    });
    assert(
      !regen.error,
      `generate_from_keys after delete ok (err: ${JSON.stringify(regen.error)})`
    );
    const a2 = await rpc("get_address", { account_index: 0 });
    assert(a2.result.address === keys.address, "regenerated wallet has same address");

    console.log("\nAll polyseed sync checks passed.");
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error("\nFAIL:", e.message);
  process.exitCode = 1;
});
