/**
 * Kill any orphan wallet-rpc sidecars from a previous PwndaWallet session.
 *
 * When PwndaWallet is force-closed (Task Manager, crash, power loss, etc.)
 * the `monero-wallet-rpc.exe` / `zephyr-wallet-rpc.exe` children keep
 * running — they only exit when the Rust parent sends them `close_wallet`
 * + `stop_wallet` during graceful shutdown.
 *
 * An orphaned sidecar holds two things:
 *   1. Port 18082 (Monero) or 18083 (Zephyr), which the pidfile-based
 *      stale-process cleanup in `xmr_start_rpc` / `zph_start_rpc` handles
 *      at launch time.
 *   2. A file handle on `target\debug\binaries\<name>-wallet-rpc.exe`,
 *      which Windows locks against `tauri_build`'s resource copy step —
 *      this is the one the launch-time cleanup CAN'T fix, because you
 *      can't launch the app when `cargo build` refuses to compile.
 *
 * So this script exists for case (2): nuke any orphan wallet-rpc children
 * from a previous session before running `cargo build` / `tauri dev` /
 * `tauri build`. Cheap to run — if no orphans exist, it's a no-op.
 *
 * Run:
 *   npm run kill-sidecars
 *
 * Exit 0 on success (including "nothing to kill").
 */

import { spawnSync } from "node:child_process";

const TARGETS = ["monero-wallet-rpc.exe", "zephyr-wallet-rpc.exe"];

function killByImage(image) {
  // `/FI "IMAGENAME eq X"` would be redundant here because `/IM X` already
  // filters by name. Using `/F` (force) + `/T` (kill tree) because a future
  // refactor might have the sidecar spawn children of its own.
  const res = spawnSync("taskkill", ["/F", "/IM", image], {
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
  });
  // taskkill exit codes:
  //   0   — at least one matching process killed
  //   128 — no matching process
  //   anything else — real failure (access denied, bad args)
  if (res.status === 0) {
    process.stdout.write(`killed ${image}: ${res.stdout.trim()}\n`);
    return true;
  }
  if (res.status === 128) {
    process.stdout.write(`no orphan ${image} found\n`);
    return false;
  }
  process.stderr.write(
    `taskkill ${image} failed (exit ${res.status}): ${res.stderr.trim()}\n`
  );
  return false;
}

let killed = 0;
for (const image of TARGETS) {
  if (killByImage(image)) killed++;
}

if (killed > 0) {
  process.stdout.write(
    `\nDone. You can now run cargo build / tauri dev without the file-lock error.\n`
  );
} else {
  process.stdout.write(
    `\nNothing to kill — no orphan wallet-rpc sidecars were running.\n`
  );
}
process.exit(0);
