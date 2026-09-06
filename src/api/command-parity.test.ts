/**
 * TS → Rust command parity.
 *
 * Every command name the frontend passes to `invoke()` must exist in the Rust
 * `invoke_handler!` registration. Nothing else enforces this: `invoke()` takes
 * a bare string, so a typo or a command that was planned but never implemented
 * type-checks cleanly, ships, and fails only when a user reaches that code path
 * — where it surfaces as an opaque "command not found" rather than as the
 * missing feature it actually is.
 *
 * This is not hypothetical. It was found on 2026-08-19: a workflow implementing
 * the daemon-routing wave lost its Rust agents to a session limit partway
 * through, and `daemonRouting.ts` shipped an `invoke("swap_daemon_capture_xpubs")`
 * whose Rust half never got written. Both `tsc` and all 967 vitest tests passed.
 *
 * The check is deliberately source-text based rather than runtime based: it has
 * to work without a Tauri process, and the registration macro is the single
 * place the truth lives.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const LIB_RS = join(REPO_ROOT, "src-tauri", "src", "lib.rs");
const SRC_DIRS = ["src", "src-lite"].map((d) => join(REPO_ROOT, d));

/** Files that legitimately mention invoke() without calling a real command. */
const EXEMPT_FILES = new Set([
  // The mock catalog names every command it fakes — by definition it lists
  // commands, it does not call them.
  join(REPO_ROOT, "src", "lib", "tauri-mocks.ts"),
  // The wrapper itself.
  join(REPO_ROOT, "src", "lib", "tauri.ts"),
  // This file.
  join(REPO_ROOT, "src", "api", "command-parity.test.ts"),
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Command names registered in `generate_handler![...]`.
 *
 * Entries look like `swap_sidecar::swap_sidecar_start,` or bare `greet,`, and
 * are interleaved with `#[cfg(feature = "full")]` attributes and comments.
 */
function registeredCommands(): Set<string> {
  const src = readFileSync(LIB_RS, "utf8");
  const start = src.indexOf("generate_handler![");
  expect(start, "generate_handler! not found in lib.rs").toBeGreaterThan(-1);

  // Walk to the matching close bracket so trailing code is not scanned.
  let depth = 0;
  let end = start;
  for (let i = src.indexOf("[", start); i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = src.slice(start, end);

  const names = new Set<string>();
  for (const line of block.split("\n")) {
    const stripped = line.split("//")[0].trim();
    if (!stripped || stripped.startsWith("#[") || stripped.startsWith("generate_handler")) {
      continue;
    }
    for (const m of stripped.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*,/g)) {
      names.add(m[1]);
    }
    // last entry may lack a trailing comma
    const tail = stripped.match(/(?:::)?([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (tail && !stripped.endsWith(",")) names.add(tail[1]);
  }
  return names;
}

/** Every `invoke("name")` / `invoke<T>("name")` literal in the frontend. */
function invokedCommands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of SRC_DIRS) {
    for (const file of walk(dir)) {
      if (EXEMPT_FILES.has(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/g)) {
        const name = m[1];
        const list = found.get(name) ?? [];
        list.push(file.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"));
        found.set(name, list);
      }
    }
  }
  return found;
}

describe("TS → Rust command parity", () => {
  it("finds the registration block and some commands", () => {
    const reg = registeredCommands();
    // Sanity: if the parser silently returned nothing, every assertion below
    // would fail for the wrong reason, so pin a couple of known-good entries.
    expect(reg.size).toBeGreaterThan(20);
    expect(reg.has("swap_sidecar_status")).toBe(true);
    expect(reg.has("swap_sidecar_start")).toBe(true);
  });

  it("finds invoke() call sites", () => {
    const invoked = invokedCommands();
    // Same guard in the other direction: an empty scan would make the parity
    // assertion vacuously true.
    expect(invoked.size).toBeGreaterThan(10);
  });

  it("every invoked command is registered in lib.rs", () => {
    const registered = registeredCommands();
    const invoked = invokedCommands();

    const missing: string[] = [];
    for (const [name, files] of invoked) {
      if (!registered.has(name)) {
        missing.push(`  ${name}\n      invoked from: ${[...new Set(files)].join(", ")}`);
      }
    }

    expect(
      missing.length === 0,
      missing.length === 0
        ? ""
        : `These commands are invoked from the frontend but are NOT registered in ` +
            `src-tauri/src/lib.rs's generate_handler!. They will fail at runtime with ` +
            `"command not found":\n${missing.join("\n")}`,
    ).toBe(true);
  });
});

// ===========================================================================
// ARGUMENT parity
// ===========================================================================
/**
 * Command-name parity above is necessary and not sufficient. Tauri v2 maps a
 * camelCase JS argument to the snake_case Rust parameter of the same name
 * (contract §0.2), and it does so BY NAME — so `{ confirmPhrase }` reaching a
 * parameter Rust spells `confirm_phrase` works, while `{ confirm_phrase }`,
 * `{ phrase }`, or a parameter someone renamed Rust-side does not. None of
 * those are visible to `tsc`: by the time the object reaches `invoke` it is a
 * `Record<string, unknown>`, so every key type-checks.
 *
 * The failure is quiet in the worst way. A misspelled OPTIONAL argument
 * deserializes as `None` and the command runs with a default — a descriptor
 * import that rescans from genesis instead of from the wallet birthday, a start
 * that silently ignores the XMR node the user picked. Nothing errors.
 *
 * Scope: the same `src` + `src-lite` tree as the name check above, so this
 * covers every binding in the app, not only the swap-sidecar ones.
 */
import ts from "typescript";

/** A JS-supplied Rust parameter. `optional` === declared `Option<…>`. */
interface RustParam {
  name: string;
  optional: boolean;
}

/**
 * Parameter types Tauri injects rather than reading from the invoke payload.
 * A `State`/`AppHandle`/`Window` parameter has no JS counterpart, so counting
 * one as required would make every call site look broken.
 */
function isInjected(type: string): boolean {
  const t = type.replace(/\s+/g, "");
  return (
    /(^|:)AppHandle$/.test(t) ||
    /(^|:)State</.test(t) ||
    /(^|:)Window$/.test(t) ||
    /(^|:)WebviewWindow$/.test(t)
  );
}

function snakeToCamel(s: string): string {
  const [head, ...rest] = s.split("_");
  return head + rest.map((w) => w.slice(0, 1).toUpperCase() + w.slice(1)).join("");
}

/** Slice a balanced `(...)` given the index of its opening paren. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

function rustFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) rustFiles(p, out);
    else if (e.endsWith(".rs")) out.push(p);
  }
  return out;
}

/**
 * `#[tauri::command]` fn name → its JS-supplied parameters.
 *
 * Paren-balanced rather than regex-to-`->` on purpose: several commands in this
 * tree return `()` and so have no `->` at all (`swap_lock`, `swap_sidecar_*`
 * setters). A regex that scans forward to the next `->` swallows them and
 * mis-attributes the FOLLOWING command's parameters to them — a parser that
 * invents drift is worse than no parser, so the first test below pins it.
 */
function rustCommandParams(): Map<string, RustParam[]> {
  const out = new Map<string, RustParam[]>();
  for (const file of rustFiles(join(REPO_ROOT, "src-tauri", "src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/#\[tauri::command\]/g)) {
      const at = m.index ?? 0;
      const after = src.slice(at, at + 800);
      const fn = /\bfn\s+(\w+)\s*\(/.exec(after);
      if (!fn) continue;
      const open = at + (fn.index ?? 0) + fn[0].length - 1;
      const body = balanced(src, open).replace(/\/\/[^\n]*/g, "");
      const params: RustParam[] = [];
      for (const raw of body.split(/,(?![^<>()[\]]*[>)\]])/)) {
        const p = raw.trim();
        if (!p || !p.includes(":")) continue;
        const name = p.slice(0, p.indexOf(":")).trim();
        const type = p.slice(p.indexOf(":") + 1).trim();
        if (isInjected(type)) continue;
        params.push({ name: snakeToCamel(name), optional: /^Option\s*</.test(type) });
      }
      out.set(fn[1], params);
    }
  }
  return out;
}

interface InvokeSite {
  cmd: string;
  keys: string[];
  file: string;
  line: number;
}

/** Member names of an inline `{a: X; b: Y}` type, or of a same-file interface. */
function membersOfType(
  type: ts.TypeNode | undefined,
  sf: ts.SourceFile,
): string[] | null {
  if (!type) return null;
  if (ts.isTypeLiteralNode(type)) {
    return type.members
      .map((mem) => (mem.name && ts.isIdentifier(mem.name) ? mem.name.text : null))
      .filter((x): x is string => x !== null);
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const want = type.typeName.text;
    let found: string[] | null = null;
    sf.forEachChild((node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === want) {
        found = node.members
          .map((mem) => (mem.name && ts.isIdentifier(mem.name) ? mem.name.text : null))
          .filter((x): x is string => x !== null);
      } else if (
        ts.isTypeAliasDeclaration(node) &&
        node.name.text === want &&
        ts.isTypeLiteralNode(node.type)
      ) {
        found = membersOfType(node.type, sf);
      }
    });
    return found;
  }
  return null;
}

/** The declared member names of parameter `name` on the function enclosing `node`. */
function enclosingParamType(
  node: ts.Node,
  name: string,
  sf: ts.SourceFile,
): string[] | null {
  for (let p: ts.Node | undefined = node; p; p = p.parent) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isArrowFunction(p) ||
      ts.isFunctionExpression(p) ||
      ts.isMethodDeclaration(p)
    ) {
      for (const param of p.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === name) {
          return membersOfType(param.type, sf);
        }
      }
    }
  }
  return null;
}

/** Every `invoke("cmd", <args>)` site, with the argument keys it actually sends. */
function invokeSites(): { sites: InvokeSite[]; unresolved: string[] } {
  const sites: InvokeSite[] = [];
  const unresolved: string[] = [];

  for (const dir of SRC_DIRS) {
    for (const file of walk(dir)) {
      if (EXEMPT_FILES.has(file)) continue;
      const text = readFileSync(file, "utf8");
      if (!/\binvoke\s*[<(]/.test(text)) continue;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const rel = file.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");

      const visit = (node: ts.Node): void => {
        const first = ts.isCallExpression(node) ? node.arguments[0] : undefined;
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "invoke" &&
          first &&
          ts.isStringLiteral(first)
        ) {
          const cmd = first.text;
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const arg = node.arguments[1];
          let keys: string[] | null = [];

          if (!arg) {
            keys = [];
          } else if (ts.isObjectLiteralExpression(arg)) {
            const acc: string[] = [];
            for (const prop of arg.properties) {
              if (ts.isSpreadAssignment(prop)) {
                const spread = ts.isIdentifier(prop.expression)
                  ? enclosingParamType(node, prop.expression.text, sf)
                  : null;
                if (!spread) {
                  keys = null;
                  break;
                }
                acc.push(...spread);
              } else if (prop.name && ts.isIdentifier(prop.name)) {
                acc.push(prop.name.text);
              }
            }
            if (keys !== null) keys = acc;
          } else if (ts.isIdentifier(arg)) {
            keys = enclosingParamType(node, arg.text, sf);
          } else {
            keys = null;
          }

          if (keys === null) unresolved.push(`${cmd} @ ${rel}:${line}`);
          else sites.push({ cmd, keys, file: rel, line });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return { sites, unresolved };
}

describe("TS to Rust argument parity", () => {
  it("parses Rust command signatures without swallowing bodyless ones", () => {
    const params = rustCommandParams();
    // Guards: an empty or mis-parsed map makes every assertion below vacuous.
    expect(params.size).toBeGreaterThan(100);

    // `swap_lock` returns `()`. It is exactly the command a scan-to-`->` parser
    // eats, taking the NEXT command's parameters with it — pin it explicitly so
    // that regression shows up here rather than as phantom drift elsewhere.
    expect(params.get("swap_lock")).toEqual([]);
    expect(params.get("swap_get_addresses")).toEqual([
      { name: "sessionId", optional: false },
    ]);

    // A known required/optional mix, spelled the camelCase way TS must send it.
    expect(params.get("swap_sidecar_import_descriptors")).toEqual([
      { name: "coin", optional: false },
      { name: "encrypted", optional: false },
      { name: "password", optional: false },
      { name: "birthdayUnix", optional: true },
      { name: "rangeEnd", optional: true },
    ]);
  });

  it("resolves every invoke site's argument keys", () => {
    const { sites, unresolved } = invokeSites();
    expect(sites.length).toBeGreaterThan(40);

    // A site whose keys cannot be resolved is a HOLE in the two checks below,
    // not a pass. Surface it instead of skipping it silently.
    expect(
      unresolved,
      `These invoke sites pass arguments this check cannot resolve statically, ` +
        `so their argument names are UNVERIFIED. Give the parameter an explicit ` +
        `object type, or pass an object literal:\n  ${unresolved.join("\n  ")}`,
    ).toEqual([]);

    // The spread site is the one most worth pinning: `swapSidecarStart` forwards
    // `{ ...args }`, so `SwapSidecarStartArgs`' field names ARE the wire names
    // and no call site spells them out where a reviewer would notice.
    const start = sites.find((s) => s.cmd === "swap_sidecar_start");
    expect(start?.keys.slice().sort()).toEqual([
      "network",
      "particlMnemonic",
      "reconfigure",
      "xmrRpcHost",
      "xmrRpcPort",
    ]);
  });

  it("every invoke argument names a real Rust parameter", () => {
    const rust = rustCommandParams();
    const { sites } = invokeSites();

    const bad: string[] = [];
    for (const s of sites) {
      const params = rust.get(s.cmd);
      if (!params) continue; // unregistered commands belong to the name check
      const known = new Set(params.map((p) => p.name));
      for (const k of s.keys) {
        if (!known.has(k)) {
          bad.push(
            `  ${s.cmd} is sent "${k}", which is not a parameter of the Rust ` +
              `command (it declares: ${params.map((p) => p.name).join(", ") || "none"})\n` +
              `      ${s.file}:${s.line}`,
          );
        }
      }
    }

    expect(
      bad.length === 0,
      bad.length === 0
        ? ""
        : `Argument-name drift. Tauri matches invoke arguments to Rust ` +
            `parameters BY NAME; an unmatched one arrives as absent, so an ` +
            `optional parameter silently falls back to its default:\n${bad.join("\n")}`,
    ).toBe(true);
  });

  it("every REQUIRED Rust parameter is supplied by every call site", () => {
    const rust = rustCommandParams();
    const { sites } = invokeSites();

    const bad: string[] = [];
    for (const s of sites) {
      const params = rust.get(s.cmd);
      if (!params) continue;
      const sent = new Set(s.keys);
      for (const p of params) {
        if (!p.optional && !sent.has(p.name)) {
          bad.push(
            `  ${s.cmd} requires "${p.name}" but this call site does not send it\n` +
              `      ${s.file}:${s.line}`,
          );
        }
      }
    }

    expect(
      bad.length === 0,
      bad.length === 0
        ? ""
        : `A non-Option Rust parameter with no matching invoke argument fails ` +
            `deserialization at runtime:\n${bad.join("\n")}`,
    ).toBe(true);
  });
});
