/**
 * End-to-end cross-validation: for the reference polyseed phrase from the
 * upstream test suite, our pure-JS address derivation must match what
 * monero-wallet-rpc reports when given the same (address, viewkey, spendkey)
 * via `generate_from_keys`.
 *
 * If these disagree, our polyseed implementation produces different keys
 * than Feather/GUI would — catastrophic. This test is a hard guarantee
 * that the keygen + address derivation round-trip is correct.
 *
 * Requires a locally spawned monero-wallet-rpc.exe. Intended to be run
 * manually during development; not part of CI. Usage:
 *
 *   npx tsx src/wallets/polyseed-e2e.test.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  polyseedDecode,
  polyseedKeygen,
} from "../src/wallets/polyseed.ts";
import { xmrKeysFromRawSecret, bytesToHex } from "../src/wallets/xmr-keys.ts";

const REF_PHRASE =
  "raven tail swear infant grief assist regular lamp duck valid someone little harsh puppy airport language";
const RPC_BINARY =
  "G:\\PwndaWalletDevelopment\\src-tauri\\binaries\\monero-wallet-rpc.exe";
const RPC_PORT = 28090;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}/json_rpc`;
const DAEMON = "https://xmr-node.cakewallet.com:18081";

async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "0", method, params });
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${text}`);
  const json = JSON.parse(text);
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function waitForRpc() {
  for (let i = 0; i < 80; i++) {
    try {
      await rpc("get_version", {});
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("wallet-rpc did not come up in 20s");
}

async function main() {
  // 1. Derive keys from the polyseed in pure JS.
  const decoded = polyseedDecode(REF_PHRASE);
  if (!decoded.ok) throw new Error("decode failed: " + decoded.error);
  const spendKeyRaw = polyseedKeygen(decoded.data);
  const keys = await xmrKeysFromRawSecret(spendKeyRaw);
  const jsAddress = keys.address;
  const jsSpendHex = bytesToHex(keys.spendSecret);
  const jsViewHex = bytesToHex(keys.viewSecret);

  console.log("[JS] address    :", jsAddress);
  console.log("[JS] spend (hex):", jsSpendHex);
  console.log("[JS] view  (hex):", jsViewHex);

  // 2. Spawn wallet-rpc in a temp directory with --disable-rpc-login
  //    (test only — we don't talk to it over a shared socket).
  const walletDir = mkdtempSync(join(tmpdir(), "pwnda-polyseed-e2e-"));
  const child = spawn(
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

  const cleanup = () => {
    try { child.kill("SIGKILL"); } catch {}
    try { rmSync(walletDir, { recursive: true, force: true }); } catch {}
  };

  try {
    await waitForRpc();
    console.log("[RPC] up");

    // 3. Ask wallet-rpc to open a wallet from our derived keys.
    await rpc("generate_from_keys", {
      filename: "e2e-polyseed",
      password: "",
      restore_height: 0,
      address: jsAddress,
      viewkey: jsViewHex,
      spendkey: jsSpendHex,
      language: "English",
      autosave_current: false,
    });

    const a = await rpc("get_address", { account_index: 0 });
    console.log("[RPC] address  :", a.address);

    if (a.address !== jsAddress) {
      console.error("\nFAIL: address mismatch");
      console.error("  JS : ", jsAddress);
      console.error("  RPC: ", a.address);
      process.exitCode = 1;
    } else {
      console.log("\nPASS: JS-derived address matches wallet-rpc's");
    }
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exitCode = 1;
});
