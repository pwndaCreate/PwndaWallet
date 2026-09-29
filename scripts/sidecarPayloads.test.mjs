/**
 * The bundled wallet binaries: one table, one gate, and the pins that must
 * agree across the fetch script and the Rust code.
 *
 * Found 2026-09-16. The dev tree's staged set dated from 2026-09-13, before
 * Xelis was added to fetch-sidecars.mjs, and was staged for Linux. Nothing
 * gated the wallet payloads, so the Windows dev wallet had no Xelis binary to
 * unpack and told the user to download it from a Settings control that did not
 * exist. `check-sidecar-payloads.mjs` is the gate; these tests make sure it can
 * fail for the reasons it exists.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIDECAR_PAYLOADS, binaryFileName } from "./lib/sidecar-payloads.mjs";
import { checkSidecarPayloads } from "./check-sidecar-payloads.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const read = (p) => readFile(path.join(REPO, p), "utf8");

/** The staged manifest as it stood on 2026-09-13 (Linux, no Xelis). */
const MANIFEST_2026_09_13 = {
  platform: "linux",
  generated: "release-time (scripts/fetch-sidecars.mjs)",
  monero: { version: "v0.18.5.1", binary: "monero-wallet-rpc", sha256: "c1e3aff7c72837e6f29045c439b772a82b5cd7324c8b831fa825a6ce2019a656", bytes: 29026368 },
  zephyr: { version: "v2.3.0", binary: "zephyr-wallet-rpc", sha256: "904423f6a3d85ef2014b188353c2a54c014cf2d189eda68a2ceecff1547b6794", bytes: 31885280 },
  zano: { version: "v2.2.1.506+src.ee3de1e", binary: "simplewallet", sha256: "118d70506fdf4f077cca18a82f99b541e3ee00ab1180c2d4e70f95ee6fca4af6", bytes: 46859400 },
};

let dir;
/** A staged directory: small random "binaries", gzipped, with a manifest. */
async function stage(target, { omit = [], tamper = [], manifestOverride } = {}) {
  const d = await mkdtemp(path.join(dir, "stage-"));
  const manifest = { platform: target, generated: "test" };
  for (const p of SIDECAR_PAYLOADS) {
    if (omit.includes(p.id)) continue;
    const raw = randomBytes(1024 * 1024 + 4096); // incompressible, so the .gz clears the 1 MB floor
    manifest[p.id] = {
      version: "v1.0.0",
      binary: binaryFileName(p, target),
      sha256: createHash("sha256").update(raw).digest("hex"),
      bytes: raw.length,
    };
    const onDisk = tamper.includes(p.id) ? randomBytes(raw.length) : raw;
    await writeFile(path.join(d, `${p.gz}.gz`), gzipSync(onDisk));
  }
  await writeFile(path.join(d, "sidecars.json"), JSON.stringify(manifestOverride ?? manifest));
  return d;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pwnda-sidecar-gate-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("check-sidecar-payloads", () => {
  it("passes a complete, verified set", async () => {
    const d = await stage("win32");
    const r = await checkSidecarPayloads({ binDir: d, target: "win32", shallow: false });
    expect(r.problems).toEqual([]);
    expect(r.ok).toHaveLength(4);
  });

  it("fails the 2026-09-13 staged set for BOTH reasons it was wrong", async () => {
    const d = await mkdtemp(path.join(dir, "old-"));
    await writeFile(path.join(d, "sidecars.json"), JSON.stringify(MANIFEST_2026_09_13));
    // On Windows: the platform alone rejects everything.
    const win = await checkSidecarPayloads({ binDir: d, target: "win32", shallow: true });
    expect(win.problems.join("\n")).toMatch(/staged for "linux" but this build is "win32"/);
    // On Linux: Xelis is simply not there.
    const lin = await checkSidecarPayloads({ binDir: d, target: "linux", shallow: true });
    expect(lin.problems).toContain("xelis: not in sidecars.json");
  });

  it("fails a missing payload file", async () => {
    const d = await stage("linux");
    await rm(path.join(d, "xelis-wallet.gz"));
    const r = await checkSidecarPayloads({ binDir: d, target: "linux", shallow: true });
    expect(r.problems).toEqual(["xelis: xelis-wallet.gz is missing"]);
  });

  it("fails a payload that does not match its manifest, but only when deep", async () => {
    const d = await stage("linux", { tamper: ["zano"] });
    const shallow = await checkSidecarPayloads({ binDir: d, target: "linux", shallow: true });
    expect(shallow.problems).toEqual([]);
    const deep = await checkSidecarPayloads({ binDir: d, target: "linux", shallow: false });
    expect(deep.problems).toHaveLength(1);
    expect(deep.problems[0]).toMatch(/^zano: payload sha256 /);
  });

  it("fails a binary named for the other platform", async () => {
    const d = await stage("win32");
    const m = JSON.parse(await readFile(path.join(d, "sidecars.json"), "utf8"));
    m.xelis.binary = "xelis_wallet";
    await writeFile(path.join(d, "sidecars.json"), JSON.stringify(m));
    const r = await checkSidecarPayloads({ binDir: d, target: "win32", shallow: true });
    expect(r.problems).toEqual([
      'xelis: manifest names binary "xelis_wallet", this platform needs "xelis_wallet.exe"',
    ]);
  });

  it("fails when nothing is staged at all", async () => {
    const d = await mkdtemp(path.join(dir, "empty-"));
    const r = await checkSidecarPayloads({ binDir: d, target: "linux", shallow: true });
    expect(r.problems).toEqual(["no sidecars.json in src-tauri/binaries/"]);
  });
});

describe("one table, three places", () => {
  it("matches the Rust sidecar_naming for every wallet", async () => {
    const rs = await read("src-tauri/src/wallet_rpc_common.rs");
    const fn = rs.slice(rs.indexOf("fn sidecar_naming("), rs.indexOf("fn current_platform_tag("));
    for (const p of SIDECAR_PAYLOADS) {
      if (p.gz === p.binary) {
        // monero / zephyr share the `<id>-wallet-rpc` arm
        expect(p.gz).toBe(`${p.id}-wallet-rpc`);
        expect(fn).toContain(`"${p.id}"`);
      } else {
        expect(fn).toContain(`"${p.id}" => Ok(("${p.gz}".to_string(), "${p.binary}".to_string()))`);
      }
    }
  });

  it("stages every wallet the gate requires", async () => {
    const src = await read("scripts/fetch-sidecars.mjs");
    for (const p of SIDECAR_PAYLOADS) {
      expect(src, p.id).toContain(`binaryBase: "${p.gz}"`);
      expect(src, p.id).toMatch(new RegExp(`\\b${p.id}: ${p.id === "monero" ? "mon" : p.id === "zephyr" ? "zph" : p.id}Entry\\b`));
    }
  });

  it("pins the same XELIS release in the fetch script and the Rust downloader", async () => {
    const js = await read("scripts/fetch-sidecars.mjs");
    const rs = await read("src-tauri/src/xelis_rpc.rs");
    const tag = js.match(/const XELIS_TAG = "([^"]+)"/)[1];
    expect(rs).toContain(`const XELIS_RELEASE_TAG: &str = "${tag}";`);
    const shas = [...js.slice(js.indexOf("const XELIS_ARCHIVE_SHA256")).matchAll(/"([0-9a-f]{64})"/g)]
      .slice(0, 2)
      .map((m) => m[1]);
    expect(shas).toHaveLength(2);
    for (const sha of shas) expect(rs).toContain(`"${sha}"`);
    for (const name of ["x86_64-pc-windows-msvc.zip", "x86_64-unknown-linux-gnu.tar.gz"]) {
      expect(js).toContain(`"${name}"`);
      expect(rs).toContain(`"${name}"`);
    }
  });

  it("takes only the wallet out of the XELIS archive (light client only)", async () => {
    const js = await read("scripts/fetch-sidecars.mjs");
    const block = js.slice(js.indexOf('label: "xelis-wallet"'), js.indexOf("version: XELIS_TAG"));
    expect(block).toContain("findName: `xelis_wallet${EXE}`");
    const code = js
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/xelis_daemon|xelis_miner/);
  });
});

describe("the gate is wired in", () => {
  it("runs before both platform builds and warns before dev", async () => {
    const pkg = JSON.parse(await read("package.json"));
    expect(pkg.scripts["check-bundle:win"]).toContain("check-sidecar-payloads.mjs win32");
    expect(pkg.scripts["check-bundle:linux"]).toContain("check-sidecar-payloads.mjs linux");
    expect(pkg.scripts["tauri:build"]).toContain("check-bundle:win");
    expect(pkg.scripts["build:linux"]).toContain("check-bundle:linux");
    expect(pkg.scripts.predev).toBe("node scripts/check-sidecar-payloads.mjs --warn");
  });

  it("leaves the tree Windows-ready after a release's Linux half", async () => {
    const ps = await read("scripts/release-local.ps1");
    const linux = ps.indexOf("scripts/build-linux-docker.ps1");
    expect(linux).toBeGreaterThan(0);
    expect(ps.indexOf("npm run fetch-sidecars:win", linux)).toBeGreaterThan(linux);
  });
});
