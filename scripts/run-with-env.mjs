#!/usr/bin/env node
/**
 * scripts/run-with-env.mjs
 *
 * Generic env-var setter / unsetter + spawn. Avoids the cross-env dep.
 *
 * Usage:
 *   node scripts/run-with-env.mjs KEY=value [KEY2=value2 ...] [-KEY3 ...] <command> [args...]
 *
 * The `KEY=value` form SETS an env var (overrides any inherited value).
 *
 * The `-KEY` form DELETES an env var inherited from the parent shell
 * before spawning. Added 2026-05-26 so npm scripts can guarantee the
 * subprocess won't see stale persistent env vars (e.g., a Windows
 * registry HKCU\Environment entry set during earlier debugging).
 *
 * Examples:
 *   node scripts/run-with-env.mjs VITE_ENTRY=catalog vite
 *   node scripts/run-with-env.mjs VITE_ENTRY=catalog VITE_BUILD_VARIANT=lite vite
 *   node scripts/run-with-env.mjs -STALE_VAR tauri dev
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const env = { ...process.env };
let cmdIdx = 0;
for (const a of args) {
  if (/^[A-Z_][A-Z0-9_]*=/.test(a)) {
    // SET: KEY=value
    const eq = a.indexOf("=");
    env[a.slice(0, eq)] = a.slice(eq + 1);
    cmdIdx++;
  } else if (/^-[A-Z_][A-Z0-9_]*$/.test(a)) {
    // UNSET: -KEY
    const key = a.slice(1);
    delete env[key];
    cmdIdx++;
  } else {
    break;
  }
}
const [cmd, ...rest] = args.slice(cmdIdx);
if (!cmd) {
  console.error("usage: run-with-env.mjs KEY=value [...] <command> [args...]");
  process.exit(2);
}

const child = spawn(cmd, rest, { stdio: "inherit", env, shell: true });
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error("[run-with-env] failed to spawn:", err.message);
  process.exit(1);
});
