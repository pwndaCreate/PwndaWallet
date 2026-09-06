#!/usr/bin/env node
/**
 * scripts/new-primitive.mjs
 *
 * Scaffolds a new primitive file set under src/design/primitives/:
 *   <Name>.tsx          — minimal React component skeleton
 *   <Name>.md           — 5-section contract (Purpose / Variants /
 *                          Behaviors / When-to-use / Related)
 * Wires the barrel (`src/design/primitives/index.ts`) and registers
 * a `<Name>Showcase.tsx` placeholder in the catalog.
 *
 * Usage:
 *   npm run new-primitive <Name>
 *
 * Example:
 *   npm run new-primitive Spinner
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PRIMITIVES = path.join(ROOT, "src", "design", "primitives");
const CATALOG = path.join(ROOT, "src", "design", "catalog", "primitives");

const Name = process.argv[2];
if (!Name || !/^[A-Z][A-Za-z0-9]+$/.test(Name)) {
  console.error("usage: node scripts/new-primitive.mjs <CamelCaseName>");
  process.exit(1);
}

const TSX = `/**
 * <${Name}>
 *
 * TODO: describe purpose in one line.
 *
 * See src/design/BEHAVIORS.md for any motion this primitive owns.
 */

import type { CSSProperties, ReactNode } from "react";

export function ${Name}({
  children,
  style,
}: {
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ ...style }}>
      {children}
    </div>
  );
}
`;

const MD = `# <${Name}>

## Purpose

TODO

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| children | ReactNode | — | |
| style | CSSProperties | — | |

## Behaviors

None (or list rows from src/design/BEHAVIORS.md that apply).

## When to use / when NOT to use

TODO

## Related

- src/design/BEHAVIORS.md
`;

const SHOWCASE = `/**
 * ${Name}Showcase — catalog demo for <${Name}>.
 *
 * Renders every variant + state. Mounted under Catalog → Primitives.
 */

import { ${Name} } from "../../primitives/${Name}";

export function ${Name}Showcase() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--white)" }}>
        ${Name}
      </h2>
      <${Name}>example</${Name}>
    </div>
  );
}
`;

const tsxPath = path.join(PRIMITIVES, `${Name}.tsx`);
const mdPath = path.join(PRIMITIVES, `${Name}.md`);
const showcasePath = path.join(CATALOG, `${Name}Showcase.tsx`);

if (existsSync(tsxPath)) {
  console.error(`[new-primitive] FAIL — ${tsxPath} already exists`);
  process.exit(1);
}

writeFileSync(tsxPath, TSX);
writeFileSync(mdPath, MD);
console.log(`[new-primitive] wrote ${path.relative(ROOT, tsxPath)}`);
console.log(`[new-primitive] wrote ${path.relative(ROOT, mdPath)}`);

if (existsSync(path.dirname(showcasePath))) {
  writeFileSync(showcasePath, SHOWCASE);
  console.log(`[new-primitive] wrote ${path.relative(ROOT, showcasePath)}`);
}

// Wire the barrel
const barrelPath = path.join(PRIMITIVES, "index.ts");
const barrel = readFileSync(barrelPath, "utf8");
if (!barrel.includes(`from "./${Name}"`)) {
  const next = barrel.replace(/(\n)(export type \{)/, `\nexport { ${Name} } from "./${Name}";\n$2`);
  writeFileSync(barrelPath, next);
  console.log(`[new-primitive] wired barrel src/design/primitives/index.ts`);
}

console.log(`\nNext steps:`);
console.log(`  1. Fill in the .tsx implementation`);
console.log(`  2. Fill in the .md contract`);
console.log(`  3. Open npm run dev:catalog to see the showcase`);
