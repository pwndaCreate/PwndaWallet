#!/usr/bin/env node
// scripts/ram-report.mjs — RAM plan Phase 4 report from `mem-native-*.jsonl`.
//
//   node scripts/ram-report.mjs                    # newest session in the app's log dir
//   node scripts/ram-report.mjs <file.jsonl> ...   # these sessions
//   node scripts/ram-report.mjs --dir <logs dir>   # newest session in another dir
//   node scripts/ram-report.mjs --json             # the summary as JSON
//
// The sessions are written by `src-tauri/src/mem_watch.rs` (dev builds only)
// to `%LOCALAPPDATA%\com.pwnda.wallet\logs`. Read-only. See
// `scripts/lib/ram-report.mjs` for what a sample can and cannot say.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseSession, summarize, toMarkdown, verdicts } from "./lib/ram-report.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const dirAt = args.indexOf("--dir");
const files = args.filter((a, i) => !a.startsWith("--") && (dirAt < 0 || i !== dirAt + 1));

if (!files.length) {
  const dir =
    dirAt >= 0
      ? args[dirAt + 1]
      : path.join(process.env.LOCALAPPDATA ?? path.join(process.env.HOME ?? ".", ".local", "share"), "com.pwnda.wallet", "logs");
  let newest = null;
  try {
    for (const f of readdirSync(dir)) {
      if (!/^mem-native-.*\.jsonl$/.test(f)) continue;
      const full = path.join(dir, f);
      const m = statSync(full).mtimeMs;
      if (!newest || m > newest.m) newest = { full, m };
    }
  } catch (e) {
    console.error(`[ram-report] cannot read ${dir}: ${e.message}`);
    process.exit(2);
  }
  if (!newest) {
    console.error(`[ram-report] no mem-native-*.jsonl in ${dir} (the sampler runs in dev builds only)`);
    process.exit(2);
  }
  files.push(newest.full);
}

for (const f of files) {
  const summary = summarize(parseSession(readFileSync(f, "utf8")));
  if (json) {
    console.log(JSON.stringify({ file: path.basename(f), summary, verdicts: verdicts(summary) }, null, 2));
  } else {
    console.log(toMarkdown(path.basename(f), summary));
    console.log("");
  }
}
