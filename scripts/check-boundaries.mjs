#!/usr/bin/env node
/**
 * scripts/check-boundaries.mjs
 *
 * Enforces the module-boundary contract documented in `BOUNDARIES.md`
 * at the repo root. Walks every feature folder under `src/features/`
 * and fails the build if any TS/TSX file imports from a banned path.
 *
 * Lightweight by design — no ESLint dependency. The project doesn't
 * have ESLint configured today (verified 2026-05-13) and a single
 * import-check rule isn't worth pulling in `@typescript-eslint` and
 * its ~50 transitive deps.
 *
 * Wire-up: run before every build via `prebuild` in package.json.
 * Wire it into CI too — `cargo build --no-default-features` is the
 * backend-side counterpart that catches Rust-side regressions.
 *
 * Source of truth: the `RULES` object below. Update both this file
 * and `BOUNDARIES.md` when adding/removing a feature.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(REPO_ROOT, "src");
const SRC_LITE = path.join(REPO_ROOT, "src-lite");
const FEATURES = path.join(SRC, "features");
const DESIGN = path.join(SRC, "design");

/**
 * Per-feature rules. Each rule operates on the **absolute** path of the
 * import target (after resolving `./` and `../` against the importing
 * file's directory). This sidesteps the depth-of-nesting trap a
 * regex-on-the-spec approach hits.
 *
 *   - `allow.under` — allow if the target is under this absolute prefix.
 *   - `allow.equals` — allow exact-match (e.g. type-only import of
 *     `src/wallets/index.ts` is fine; `src/wallets/eth-wallet.ts` is not).
 *   - `ban.under` — explicitly ban this prefix; reported with the BAN tag.
 *   - `ban.equals` — exact-match ban.
 *
 * Anything that doesn't match any allow/ban entry is reported as
 * UNCLASSIFIED. That's a softer fail than BAN: it usually means the
 * rule list needs updating, not that the code is wrong.
 */
const RULES = {
  mining: {
    label: "src/features/mining",
    folder: path.join(FEATURES, "mining"),
    allow: {
      under: [
        // Same feature folder — implicit
        path.join(FEATURES, "mining"),
        // Shared UI primitives and components
        path.join(SRC, "components"),
        // Pure-utility design layer (tokens, primitives, styles)
        DESIGN,
        // Pure utility code
        path.join(SRC, "lib"),
        path.join(SRC, "utils"),
        // OS-detection feature flags — pure-utility tier (no wallet/vault
        // coupling). Used by mining to hide Windows-only UI on Linux.
        path.join(SRC, "platform"),
        // Mining type definitions
        path.join(SRC, "types", "mining"),
        // Wallet metadata (no adapter code)
        path.join(SRC, "wallets", "coin-metadata"),
      ],
      equals: [
        // Type-only import of `ChainType` from the wallets barrel is fine
        // — TypeScript erases it at compile time. `coin-metadata.ts`
        // re-exports the same type for code that wants a fully wallet-free
        // import path.
        path.join(SRC, "wallets", "index"),
        path.join(SRC, "wallets"),
        path.join(SRC, "wallets", "types"),
        // CSPRNG helper at the src root — no wallet/vault coupling
        path.join(SRC, "secure-random"),
      ],
    },
    ban: {
      under: [
        // Any other feature folder
        path.join(FEATURES, "activity"),
        path.join(FEATURES, "auth"),
        path.join(FEATURES, "landscape"),
        path.join(FEATURES, "monero"),
        path.join(FEATURES, "onboarding"),
        path.join(FEATURES, "send"),
        path.join(FEATURES, "settings"),
        path.join(FEATURES, "swap"),
        // Desktop-only: the BasicSwap sidecar pulls in the swap-engine surface
        // (node supervision, offer book, spread gate). Banned from every
        // narrow product/layer so a stray import fails the build instead of
        // silently bloating it.
        path.join(FEATURES, "swap-sidecar"),
        path.join(FEATURES, "vault"),
        path.join(FEATURES, "wallet"),
        path.join(FEATURES, "zano"),
        path.join(FEATURES, "zephyr"),
        // App-level state context
        path.join(SRC, "state"),
        // Vault encryption + storage
      ],
      equals: [
        path.join(SRC, "store"),
        path.join(SRC, "crypto"),
        path.join(SRC, "App"),
      ],
    },
  },
  lite: {
    label: "src-lite",
    folder: SRC_LITE,
    allow: {
      under: [
        // Same product folder
        SRC_LITE,
        // The shared mining feature folder — Lite's entire reason for
        // existing. Every file under here is import-clean against
        // wallet/vault state thanks to the modularization plan
        // ([[pwnda-mining-modularization]]).
        path.join(FEATURES, "mining"),
        // Shared UI primitives and components
        path.join(SRC, "components"),
        // Pure-utility design layer (tokens, primitives, styles, catalog)
        DESIGN,
        path.join(SRC, "lib"),
        path.join(SRC, "utils"),
        // OS-detection feature flags — pure-utility tier (no wallet/vault
        // coupling). Lite inherits whatever mining uses; allowing it here
        // keeps both rule sets symmetric.
        path.join(SRC, "platform"),
        // Mining type definitions
        path.join(SRC, "types", "mining"),
        // Wallet metadata (no adapter code) + USD price fetcher (no
        // wallet coupling — just CoinGecko/CoinPaprika/CryptoCompare
        // HTTP)
        path.join(SRC, "wallets", "coin-metadata"),
        path.join(SRC, "wallets", "usd-prices"),
      ],
      equals: [
        // Type-only imports from the wallets barrel are fine; the
        // runtime barrel is never imported by Lite.
        path.join(SRC, "wallets", "index"),
        path.join(SRC, "wallets"),
        path.join(SRC, "wallets", "types"),
        // styles.css imported once from src-lite/main.tsx so the lite
        // window inherits the wallet's design tokens / classes.
        path.join(SRC, "styles"),
      ],
    },
    ban: {
      under: [
        // Any wallet/swap/vault feature folder
        path.join(FEATURES, "activity"),
        path.join(FEATURES, "auth"),
        path.join(FEATURES, "landscape"),
        path.join(FEATURES, "monero"),
        path.join(FEATURES, "onboarding"),
        path.join(FEATURES, "send"),
        path.join(FEATURES, "settings"),
        path.join(FEATURES, "swap"),
        // Desktop-only: the BasicSwap sidecar pulls in the swap-engine surface
        // (node supervision, offer book, spread gate). Banned from every
        // narrow product/layer so a stray import fails the build instead of
        // silently bloating it.
        path.join(FEATURES, "swap-sidecar"),
        path.join(FEATURES, "vault"),
        path.join(FEATURES, "wallet"),
        path.join(FEATURES, "zano"),
        path.join(FEATURES, "zephyr"),
        // App-level state context — Lite has its own AppStateLite
        path.join(SRC, "state"),
      ],
      equals: [
        // Vault encryption + storage are off-limits in Lite (no vault)
        path.join(SRC, "store"),
        path.join(SRC, "crypto"),
        // The full-wallet App.tsx is wallet-only
        path.join(SRC, "App"),
      ],
    },
  },
  design: {
    label: "src/design",
    folder: DESIGN,
    allow: {
      under: [
        // Same package
        DESIGN,
        // Pure utility code
        path.join(SRC, "lib"),
        path.join(SRC, "utils"),
        // Types
        path.join(SRC, "types"),
      ],
      equals: [
        // Type-only imports from the wallets barrel are fine — TypeScript
        // erases them. Primitives may want `type { ChainType }` for a
        // typed `coin: ChainType` prop without dragging adapters in.
        path.join(SRC, "wallets", "index"),
        path.join(SRC, "wallets"),
        path.join(SRC, "wallets", "types"),
        path.join(SRC, "wallets", "coin-metadata"),
      ],
    },
    ban: {
      under: [
        // Every feature folder — the failure mode the modularization
        // plan ripped out. Design layer must stay pure.
        path.join(FEATURES, "activity"),
        path.join(FEATURES, "auth"),
        path.join(FEATURES, "landscape"),
        path.join(FEATURES, "mining"),
        path.join(FEATURES, "monero"),
        path.join(FEATURES, "onboarding"),
        path.join(FEATURES, "send"),
        path.join(FEATURES, "settings"),
        path.join(FEATURES, "swap"),
        // Desktop-only: the BasicSwap sidecar pulls in the swap-engine surface
        // (node supervision, offer book, spread gate). Banned from every
        // narrow product/layer so a stray import fails the build instead of
        // silently bloating it.
        path.join(FEATURES, "swap-sidecar"),
        path.join(FEATURES, "vault"),
        path.join(FEATURES, "wallet"),
        path.join(FEATURES, "zano"),
        path.join(FEATURES, "zephyr"),
        path.join(SRC, "state"),
      ],
      equals: [
        path.join(SRC, "store"),
        path.join(SRC, "crypto"),
        path.join(SRC, "App"),
      ],
    },
    // Narrow exception — see BOUNDARIES.md "design" row.
    exempt: [path.join(DESIGN, "catalog", "compositions")],
  },
};

const IMPORT_RE = /(?:^|\n)\s*import(?:\s+type)?\s+[^"']*from\s+["']([^"']+)["']/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) files.push(full);
  }
  return files;
}

/**
 * Resolve a relative import spec (e.g. `./foo`, `../bar`) to its
 * absolute path on disk, stripped of extension. Bare imports (`react`,
 * `@tauri-apps/api`) return `null` — they're allowed unconditionally.
 */
function resolveSpec(spec, fromFile) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  // Strip any explicit extension so the rules don't have to repeat
  // `.ts`/`.tsx` everywhere.
  return base.replace(/\.tsx?$/, "");
}

function classify(absSpec, rule) {
  for (const eq of rule.ban.equals) {
    if (absSpec === eq) return "banned";
  }
  for (const prefix of rule.ban.under) {
    if (absSpec === prefix || absSpec.startsWith(prefix + path.sep)) {
      // Don't flag a "ban under src/features/X" hit if the same path
      // is also allow.under (e.g. mining itself).
      if (
        rule.allow.under.some(
          (p) => absSpec === p || absSpec.startsWith(p + path.sep)
        )
      ) {
        return "ok";
      }
      return "banned";
    }
  }
  for (const eq of rule.allow.equals) {
    if (absSpec === eq) return "ok";
  }
  for (const prefix of rule.allow.under) {
    if (absSpec === prefix || absSpec.startsWith(prefix + path.sep)) {
      return "ok";
    }
  }
  return "unclassified";
}

function checkFeature(feature) {
  const rule = RULES[feature];
  // Skip rules whose folder doesn't exist yet (e.g. `design` rule lives
  // dormant until Phase 1 of the design-system-modularization plan
  // creates `src/design/`).
  if (!existsSync(rule.folder)) {
    return { feature, label: rule.label, fileCount: 0, violations: [], skipped: true };
  }
  const files = walk(rule.folder);
  const violations = [];
  // Per-rule exempt folders (e.g. design/catalog/compositions may
  // import real feature views to render them under MockProvider).
  const exempt = rule.exempt ?? [];
  for (const file of files) {
    if (exempt.some((p) => file.startsWith(p + path.sep) || file === p)) continue;
    const src = readFileSync(file, "utf8");
    const seen = new Set();
    for (const re of [IMPORT_RE, REQUIRE_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const spec = m[1];
        if (seen.has(spec)) continue;
        seen.add(spec);
        const absSpec = resolveSpec(spec, file);
        if (absSpec === null) continue; // bare import
        const verdict = classify(absSpec, rule);
        if (verdict !== "ok") {
          violations.push({
            file: path.relative(REPO_ROOT, file),
            spec,
            absSpec: path.relative(REPO_ROOT, absSpec),
            verdict,
          });
        }
      }
    }
  }
  return { feature, label: rule.label, fileCount: files.length, violations };
}

function main() {
  let totalViolations = 0;
  for (const feature of Object.keys(RULES)) {
    const result = checkFeature(feature);
    if (result.skipped) {
      console.log(`[boundaries] ${result.label} — skipped (folder absent)`);
      continue;
    }
    console.log(
      `[boundaries] ${result.label} — ${result.fileCount} files scanned`
    );
    for (const v of result.violations) {
      const tag = v.verdict === "banned" ? "BAN" : "UNCLASSIFIED";
      console.error(
        `  [${tag}] ${v.file}`
      );
      console.error(
        `         import "${v.spec}"  (-> ${v.absSpec})`
      );
      totalViolations += 1;
    }
  }
  if (totalViolations > 0) {
    console.error(
      `\n[boundaries] FAIL — ${totalViolations} violation(s). ` +
      `See BOUNDARIES.md at the repo root for the rule set.`
    );
    process.exit(1);
  }
  console.log("[boundaries] PASS");
}

main();
