/**
 * Unit-ish test for the `getSyncStatus` floor fix. We stub wallet-rpc via a
 * minimal tauri/core shim and a fake `/get_info` server so we can exercise
 * the function without touching a real wallet-rpc.
 *
 * Purpose: lock in the fix for the "height stuck at 1 while refreshing"
 * UX problem — getSyncStatus should clamp the reported wallet height to
 * the provided floor so the progress bar reflects the restore position
 * rather than starting at block 1.
 */

import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

// ---- Shim @tauri-apps/api/core so xmr-rpc.ts's `invoke` calls our mock ----
// The real module reads `window.__TAURI_INTERNALS__`; Node has no window.
let nextHeightResponse = 1; // raw wallet-rpc height value
globalThis.window = globalThis;
globalThis.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
    if (cmd !== "xmr_rpc_call") throw new Error(`unexpected invoke: ${cmd}`);
    if (args.method === "get_height") {
      return { height: nextHeightResponse };
    }
    throw new Error(`unexpected rpc method: ${args.method}`);
  },
};

// ---- Stand up a fake daemon /get_info ----
const DAEMON_TIP = 3_658_000;
const server = http.createServer((req, res) => {
  if (req.url?.endsWith("/get_info")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ height: DAEMON_TIP, synchronized: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const daemonUrl = `http://127.0.0.1:${port}`;

// Import AFTER shimming the Tauri invoke.
const { getSyncStatus } = await import("../src/wallets/xmr-rpc.ts");

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  OK: ${msg}`);
}

try {
  // 1) Floor=0: no clamp, raw height is surfaced.
  nextHeightResponse = 1;
  let s = await getSyncStatus(daemonUrl, 0);
  assert(s.walletHeight === 1, "floor=0: walletHeight=1 (raw)");
  assert(Math.floor(s.percent) === 0, "floor=0: percent ~ 0%");

  // 2) Floor>1 while wallet-rpc returns 1: clamp to floor.
  nextHeightResponse = 1;
  s = await getSyncStatus(daemonUrl, 3_100_000);
  assert(
    s.walletHeight === 3_100_000,
    "first-refresh-in-progress: walletHeight clamped to restore floor"
  );
  assert(
    Math.floor(s.percent) >= 84 && Math.floor(s.percent) <= 85,
    `percent reflects floored progress (~84-85%, got ${s.percent.toFixed(2)}%)`
  );
  assert(!s.synced, "still not synced at 84%");

  // 3) Wallet has caught up to real height above floor: raw value used.
  nextHeightResponse = 3_600_000;
  s = await getSyncStatus(daemonUrl, 3_100_000);
  assert(s.walletHeight === 3_600_000, "raw height > floor: raw value kept");

  // 4) Wallet at tip: synced=true.
  nextHeightResponse = DAEMON_TIP;
  s = await getSyncStatus(daemonUrl, 3_100_000);
  assert(s.synced, "at tip: synced=true");

  // 5) Daemon unreachable: floor still applies, daemonOk=false.
  await new Promise((r) => server.close(r));
  nextHeightResponse = 1;
  s = await getSyncStatus(daemonUrl, 3_100_000);
  assert(
    s.walletHeight === 3_100_000,
    "daemon unreachable: floor still clamps wallet height"
  );
  assert(!s.daemonOk, "daemon unreachable: daemonOk=false");

  console.log("\nAll getSyncStatus floor checks passed.");
} catch (e) {
  try { server.close(); } catch {}
  // Re-throw so non-zero exit
  throw e;
}
