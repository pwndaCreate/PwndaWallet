/**
 * The version the UI shows is the version that is running.
 *
 * ## Incident (2026-09-16)
 *
 * The operator saw "v2.0.1" in several places of a 0.6.3 install. No
 * PwndaWallet release ever carried 2.0.1: it was a design-mock number that six
 * surfaces hardcoded (title bar default, home + login splash, landscape header,
 * both Settings layouts), and PwndaLite hardcoded its own "v0.5.0" copy. The
 * Settings one read `VITE_APP_VERSION`, which nothing ever set, so it always
 * fell back to the literal too. Found by grepping src/ for `v\d+\.\d+\.\d+`,
 * not by any test: nothing compared a displayed string to a shipped version.
 *
 * These tests close both halves:
 *  1. `APP_VERSION` (what the UI shows) equals `package.json`, which must equal
 *     `tauri.conf.json` (what the binary reports and the updater compares).
 *     Same for PwndaLite against `tauri-lite.conf.json`.
 *  2. No UI source file spells an app version out by hand.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { APP_VERSION, LITE_APP_VERSION, formatAppVersion } from "./appVersion";

const ROOT = resolve(__dirname, "..", "..");
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

describe("app version has one source", () => {
  const pkg = readJson("package.json").version as string;
  const conf = readJson("src-tauri/tauri.conf.json").version as string;
  const liteConf = readJson("src-tauri/tauri-lite.conf.json").version as string;

  it("package.json and tauri.conf.json agree (displayed == shipped)", () => {
    expect(pkg).toBe(conf);
  });

  it("APP_VERSION is that version, and formats with a single v", () => {
    expect(APP_VERSION).toBe(conf);
    expect(formatAppVersion()).toBe(`v${conf}`);
    expect(formatAppVersion(`v${conf}`)).toBe(`v${conf}`);
  });

  it("LITE_APP_VERSION is what the PwndaLite binary reports", () => {
    expect(LITE_APP_VERSION).toBe(liteConf);
  });
});

/**
 * UI source: where a hand-written app version would be user-visible. Chain
 * adapters, RPC clients and the mock catalog legitimately quote THIRD-PARTY
 * versions (monero v0.18.5.1, xelis_wallet v1.25.0) and are not scanned.
 */
const UI_ROOTS = ["src/features", "src/components", "src/design", "src/App.tsx", "src-lite"];

function collect(p: string, out: string[] = []): string[] {
  const full = join(ROOT, p);
  if (statSync(full).isDirectory()) {
    for (const e of readdirSync(full)) {
      if (e === "node_modules") continue;
      collect(join(p, e), out);
    }
  } else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) {
    out.push(p);
  }
  return out;
}

/** Drop comments so prose about third-party versions is not flagged. Crude,
 *  but `//` inside a URL string is preceded by `:`, which this keeps. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const APP_VERSION_SHAPE = /\bv\d+\.\d+\.\d+\b/;

function offendingLines(src: string): string[] {
  const bare = new RegExp(`["'\`]v?${APP_VERSION.replace(/\./g, "\\.")}["'\`]`);
  return stripComments(src)
    .split("\n")
    .filter((l) => APP_VERSION_SHAPE.test(l) || bare.test(l))
    .map((l) => l.trim());
}

describe("no hardcoded app version in UI source", () => {
  it("the scanner goes red on the lines that caused the incident", () => {
    // A check that cannot fail is not a check: prove it flags the old code.
    expect(offendingLines('  version = "v2.0.1",')).toHaveLength(1);
    expect(offendingLines("<Glow>Welcome to PWNDA — Wallet Terminal v2.0.1</Glow>")).toHaveLength(1);
    expect(offendingLines(`const LITE_VERSION = "v0.5.0";`)).toHaveLength(1);
    expect(offendingLines(`const v = "${APP_VERSION}";`)).toHaveLength(1);
    // ...and stays quiet on comments.
    expect(offendingLines("// node daemon v1.25.0 reports")).toHaveLength(0);
  });

  it("every UI file takes the version from src/lib/appVersion.ts", () => {
    const hits: string[] = [];
    for (const root of UI_ROOTS) {
      for (const f of collect(root)) {
        for (const line of offendingLines(readFileSync(join(ROOT, f), "utf8"))) {
          hits.push(`${relative(ROOT, join(ROOT, f)).replace(/\\/g, "/")}: ${line}`);
        }
      }
    }
    expect(hits, "use formatAppVersion() from src/lib/appVersion.ts").toEqual([]);
  });
});
