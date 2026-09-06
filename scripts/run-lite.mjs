#!/usr/bin/env node
/**
 * scripts/run-lite.mjs
 *
 * Spawn a child process with `VITE_BUILD_VARIANT=lite` set. Used by the
 * `dev:lite` / `build:lite` npm scripts to bypass the need for a
 * cross-platform env-var setter like `cross-env` (which isn't already
 * a dependency).
 *
 * Usage:
 *   node scripts/run-lite.mjs vite
 *   node scripts/run-lite.mjs vite build --outDir dist-lite
 */
import { spawn } from "node:child_process";

const [, , cmd, ...args] = process.argv;
if (!cmd) {
  console.error("usage: run-lite.mjs <command> [args...]");
  process.exit(2);
}

const child = spawn(cmd, args, {
  stdio: "inherit",
  env: { ...process.env, VITE_BUILD_VARIANT: "lite" },
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error("[run-lite] failed to spawn:", err.message);
  process.exit(1);
});
