/**
 * Opening a Xelis wallet when this install has no `xelis_wallet` binary.
 *
 * Reported 2026-09-16: importing a phrase stopped at "The Xelis wallet binary
 * is missing. Download it from Settings first." Settings had no such control,
 * and the dev tree's staged payloads predated Xelis, so the binary could come
 * from nowhere. `initXelisSession` now downloads it itself, as Monero and
 * Zephyr do, and its errors keep the words `XelisSyncCard` branches on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XELIS_VECTORS } from "./xelis-vectors";

const rpc = vi.hoisted(() => ({
  checkXelisBinaryExists: vi.fn(),
  downloadXelisWalletRpc: vi.fn(),
  ensureXelisWallet: vi.fn(),
  isXelisRpcRunning: vi.fn(async () => false),
  stopXelisRpc: vi.fn(async () => {}),
}));

vi.mock("./xelis-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./xelis-rpc")>()),
  ...rpc,
}));
vi.mock("./xelis-nodes", () => ({
  pickXelisDaemon: vi.fn(async () => "https://node.xelis.io"),
}));

import { initXelisSession } from "./xelis-wallet";

/** Everything after the binary step is out of scope: stop right there. */
const PAST_THE_BINARY_STEP = "reached ensureXelisWallet";
const SEED = XELIS_VECTORS[0].seed;

/** The card's own tests for these branches, restated on the message. */
function cardReading(message: string) {
  const lower = message.toLowerCase();
  return {
    downloadButton: lower.includes("binary") && /missing|not found/.test(lower),
    blockedHint: lower.includes("download failed") && lower.includes("blocked"),
    hashHint: lower.includes("sha256") || lower.includes("hash mismatch"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.ensureXelisWallet.mockRejectedValue(new Error(PAST_THE_BINARY_STEP));
  rpc.downloadXelisWalletRpc.mockResolvedValue(undefined);
});

describe("initXelisSession — a missing binary", () => {
  it("is downloaded, then the session carries on", async () => {
    rpc.checkXelisBinaryExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(initXelisSession(SEED, "pw", "pwnda-xelis-a")).rejects.toThrow(
      PAST_THE_BINARY_STEP
    );
    expect(rpc.downloadXelisWalletRpc).toHaveBeenCalledTimes(1);
    expect(rpc.ensureXelisWallet).toHaveBeenCalledTimes(1);
  });

  it("is not downloaded when the build bundles one", async () => {
    rpc.checkXelisBinaryExists.mockResolvedValue(true);
    await expect(initXelisSession(SEED, "pw", "pwnda-xelis-b")).rejects.toThrow(
      PAST_THE_BINARY_STEP
    );
    expect(rpc.downloadXelisWalletRpc).not.toHaveBeenCalled();
  });

  it("never sends the user to a Settings download that isn't there", async () => {
    rpc.checkXelisBinaryExists.mockResolvedValue(false);
    rpc.downloadXelisWalletRpc.mockRejectedValue(
      "Download blocked: could not reach github.com (dns error)."
    );
    const err = await initXelisSession(SEED, "pw", "pwnda-xelis-c").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/from settings/i);
    expect(rpc.ensureXelisWallet).not.toHaveBeenCalled();
    // The card shows its download button AND the blocked-network hint.
    expect(cardReading(err.message)).toEqual({
      downloadButton: true,
      blockedHint: true,
      hashHint: false,
    });
  });

  it("keeps a hash mismatch recognisable", async () => {
    rpc.checkXelisBinaryExists.mockResolvedValue(false);
    rpc.downloadXelisWalletRpc.mockRejectedValue(
      "SHA256 mismatch for x86_64-pc-windows-msvc.zip — expected a, got b."
    );
    const err = await initXelisSession(SEED, "pw", "pwnda-xelis-d").catch((e) => e);
    expect(cardReading(err.message).hashHint).toBe(true);
  });

  it("says so when the download succeeded but the file is still gone", async () => {
    rpc.checkXelisBinaryExists.mockResolvedValue(false);
    const err = await initXelisSession(SEED, "pw", "pwnda-xelis-e").catch((e) => e);
    expect(err.message).toMatch(/missing after downloading/);
    expect(cardReading(err.message).downloadButton).toBe(true);
    expect(rpc.ensureXelisWallet).not.toHaveBeenCalled();
  });
});
