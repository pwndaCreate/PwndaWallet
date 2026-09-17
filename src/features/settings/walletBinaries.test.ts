/**
 * Settings ▸ Wallet binaries (2026-09-16): one row per bundled wallet program,
 * and an Unpack/Download that uses each chain's existing commands.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => tauri);

import {
  WALLET_BINARIES,
  describeWalletBinary,
  installWalletBinary,
  type WalletBinaryStatus,
} from "./walletBinaries";

const row = (over: Partial<WalletBinaryStatus>): WalletBinaryStatus => ({
  id: "xelis",
  installed: null,
  present: false,
  bundled: null,
  ...over,
});

describe("describeWalletBinary", () => {
  it("covers every state a row can be in", () => {
    expect(describeWalletBinary(row({ present: true, installed: "v1.25.0", bundled: "v1.25.0" }))).toBe(
      "in use: v1.25.0"
    );
    expect(describeWalletBinary(row({ present: true, installed: "v0.18.5.0", bundled: "v0.18.5.1" }))).toBe(
      "in use: v0.18.5.0 · shipped: v0.18.5.1"
    );
    // A Zano binary downloaded before version markers existed.
    expect(describeWalletBinary(row({ present: true, bundled: "v2.2.1.506" }))).toBe(
      "installed (version not recorded) · shipped: v2.2.1.506"
    );
    expect(describeWalletBinary(row({ bundled: "v1.25.0" }))).toBe(
      "shipped: v1.25.0 · unpacked when you first open this wallet"
    );
    // The state the operator's dev wallet was in on 2026-09-16.
    expect(describeWalletBinary(row({}))).toBe(
      "not in this build · downloaded when you first open this wallet"
    );
  });
});

describe("installWalletBinary", () => {
  beforeEach(() => {
    // A block body: an arrow returning the mock would hand Vitest a function,
    // which it then runs as a cleanup hook (an extra, argument-less invoke).
    tauri.invoke.mockReset();
  });

  it("unpacks through the status command and does not download", async () => {
    tauri.invoke.mockResolvedValueOnce(true);
    await installWalletBinary("xelis");
    expect(tauri.invoke.mock.calls).toEqual([["xelis_binary_status"]]);
  });

  it("downloads when the build carries none, then re-checks", async () => {
    tauri.invoke
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true);
    await installWalletBinary("zano");
    expect(tauri.invoke.mock.calls.map((c) => c[0])).toEqual([
      "zano_binary_status",
      "zano_download_wallet_rpc",
      "zano_binary_status",
    ]);
  });

  it("fails loudly when the file is gone after a download", async () => {
    tauri.invoke
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(false);
    await expect(installWalletBinary("monero")).rejects.toThrow(/still missing/);
  });

  it("passes a download error through unchanged", async () => {
    tauri.invoke.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("Download blocked"));
    await expect(installWalletBinary("zephyr")).rejects.toThrow("Download blocked");
  });
});

/**
 * `command-parity.test.ts` only sees a string literal written directly inside
 * an invoke call, and these names live in a table. Check them against the
 * registration directly.
 */
describe("WALLET_BINARIES command names", () => {
  const libRs = readFileSync(resolve(__dirname, "../../../src-tauri/src/lib.rs"), "utf8");
  const registered = new Set(
    [...libRs.matchAll(/\b[a-z_]+_rpc::([a-z0-9_]+)\s*,/g)].map((m) => m[1])
  );

  it("covers exactly the four bundled wallets", () => {
    expect(Object.keys(WALLET_BINARIES).sort()).toEqual(["monero", "xelis", "zano", "zephyr"]);
  });

  for (const [id, w] of Object.entries(WALLET_BINARIES)) {
    it(`${id}: both commands are registered`, () => {
      expect(registered, w.check).toContain(w.check);
      expect(registered, w.download).toContain(w.download);
    });
  }
});
