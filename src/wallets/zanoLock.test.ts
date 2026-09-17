/**
 * Zano Lock vs close (incident 2026-09-15).
 *
 * Lock used `closeZanoWallet`, whose `zano_stop_rpc` killed Main even while
 * the swap node was using it for a swap. A lock now asks Rust to keep Main
 * when the node holds its claim (`zano_rpc.rs::stop_keeps_main`), and every
 * other close (a wallet switch, a daemon switch, removal) stays a hard stop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from "../lib/tauri";
import { closeZanoWallet, lockZanoWallet } from "./zano-wallet";

const invokeMock = vi.mocked(invoke);

const stopCalls = () =>
  invokeMock.mock.calls.filter(([cmd]) => cmd === "zano_stop_rpc").map(([, args]) => args);

beforeEach(() => {
  invokeMock.mockClear();
});

describe("Zano Lock keeps Main for the swap node; close does not", () => {
  it("lock asks Rust to keep Main (lock: true)", async () => {
    await lockZanoWallet();
    expect(stopCalls()).toEqual([{ lock: true }]);
  });

  it("the hard close still stops Main (lock: false)", async () => {
    await closeZanoWallet();
    expect(stopCalls()).toEqual([{ lock: false }]);
  });
});
