/**
 * `getSyncStatus` on a wallet that has not finished its first sync.
 *
 * Found 2026-09-16 by running the bundled Linux `xelis_wallet` through the
 * app's own restore-then-open sequence: straight after the restore,
 * `get_topoheight` answers
 *
 *     -32004 UNSPECIFIED Error while loading data with hashed key TOPH from disk
 *
 * until the first scan stores a height. `getSyncStatus` used to reject on it,
 * so the sync card read "Sync status unavailable: RPC error -32004 …" for the
 * whole first sync.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/tauri", () => tauri);

import { getSyncStatus, isXelisHeightNotRecorded } from "./xelis-rpc";

/** As `xelis_rpc.rs::do_rpc_call` formats the wallet's JSON-RPC error. */
const TOPH =
  "RPC error -32004: UNSPECIFIED Error while loading data with hashed key TOPH from disk";

function wallet(answers: Record<string, unknown | (() => unknown)>) {
  tauri.invoke.mockImplementation(async (cmd: string, args: { method: string }) => {
    expect(cmd).toBe("xelis_rpc_call");
    const a = answers[args.method];
    if (typeof a === "function") return (a as () => unknown)();
    if (a === undefined) throw new Error(`unexpected method ${args.method}`);
    return a;
  });
}

beforeEach(() => {
  // A block body: an arrow returning the mock would hand Vitest a function,
  // which it then runs as a cleanup hook (an extra, argument-less invoke).
  tauri.invoke.mockReset();
});

describe("getSyncStatus — first sync", () => {
  it("reports no height yet instead of failing", async () => {
    wallet({
      is_online: true,
      get_topoheight: () => {
        throw TOPH;
      },
      network_info: { topoheight: 8_925_700, stable_topoheight: 8_925_670 },
    });
    await expect(getSyncStatus()).resolves.toEqual({
      online: true,
      walletTopoheight: null,
      daemonTopoheight: 8_925_700,
      synced: false,
    });
  });

  it("reports no height while offline too", async () => {
    wallet({
      is_online: false,
      get_topoheight: () => {
        throw new Error(TOPH);
      },
    });
    await expect(getSyncStatus()).resolves.toEqual({
      online: false,
      walletTopoheight: null,
      daemonTopoheight: null,
      synced: false,
    });
  });

  it("still fails on any other get_topoheight error", async () => {
    wallet({
      is_online: true,
      get_topoheight: () => {
        throw "Xelis RPC rejected our credentials (401)";
      },
    });
    await expect(getSyncStatus()).rejects.toBe("Xelis RPC rejected our credentials (401)");
  });

  it("is synced once the recorded height reaches the stable one", async () => {
    wallet({
      is_online: true,
      get_topoheight: 8_925_670,
      network_info: { topoheight: 8_925_700, stable_topoheight: 8_925_670 },
    });
    await expect(getSyncStatus()).resolves.toMatchObject({ walletTopoheight: 8_925_670, synced: true });
  });

  it("recognises the error only by its key, not by the generic code", () => {
    expect(isXelisHeightNotRecorded(TOPH)).toBe(true);
    expect(isXelisHeightNotRecorded(new Error(TOPH))).toBe(true);
    expect(isXelisHeightNotRecorded("RPC error -32004: NOT_ONLINE_MODE Wallet is not in online mode")).toBe(false);
  });
});
