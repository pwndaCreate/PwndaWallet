#!/usr/bin/env node
/**
 * scripts/new-token.mjs
 *
 * Add a token to src/design/tokens.ts and regenerate outputs.
 *
 * Usage:
 *   node scripts/new-token.mjs <category> <name> <value>
 *
 * Examples:
 *   node scripts/new-token.mjs accent extraGlow "rgba(0,255,102,0.5)"
 *   node scripts/new-token.mjs space 11 40
 *
 * Limitations:
 *   - Only supports two-level paths (category.name). Nested categories
 *     (e.g. semantic.success.base) need to be edited by hand.
 *   - Replaces an existing key if present (warning printed).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS = path.resolve(__dirname, "..", "src", "design", "tokens.ts");

const [, , category, name, ...rest] = process.argv;
if (!category || !name || rest.length === 0) {
  console.error("usage: node scripts/new-token.mjs <category> <name> <value>");
  process.exit(1);
}
const value = rest.join(" ");

const src = readFileSync(TOKENS, "utf8");
const re = new RegExp(`(${category}:\\s*\\{[^}]*?)(\\n\\s*\\})`, "s");
const match = src.match(re);
if (!match) {
  console.error(`[new-token] FAIL — category "${category}" not found in tokens.ts`);
  process.exit(1);
}

const keyMatch = new RegExp(`\\b${name.replace(/[^a-zA-Z0-9_]/g, "")}\\s*:`).test(match[1]);
if (keyMatch) {
  console.warn(`[new-token] WARN — ${category}.${name} already exists; replace by hand`);
  process.exit(1);
}

// Insert as a new line before the closing brace of the category
const isStringValue = /[a-zA-Z(]/.test(value);
const formattedValue = isStringValue ? `"${value.replace(/^"|"$/g, "")}"` : value;
const insertion = `\n    ${/^[a-zA-Z_][\w]*$/.test(name) ? name : `"${name}"`}: ${formattedValue},`;
const next = src.replace(re, `$1${insertion}$2`);

writeFileSync(TOKENS, next);
console.log(`[new-token] inserted ${category}.${name} = ${formattedValue}`);

// Regenerate outputs
const gen = spawnSync("node", [path.resolve(__dirname, "generate-tokens-css.mjs")], {
  stdio: "inherit",
});
process.exit(gen.status ?? 0);
