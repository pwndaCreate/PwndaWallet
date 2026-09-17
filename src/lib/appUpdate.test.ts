/**
 * The shared update store behind the banner and both Settings rows
 * (2026-09-17: landscape could not install, and nothing could restart).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  isUpdaterSupported: vi.fn(),
  installUpdate: vi.fn(),
  restartApp: vi.fn(),
}));
vi.mock("./updater", () => api);

import {
  __resetAppUpdateForTests,
  checkAppUpdate,
  getAppUpdateState,
  installAppUpdate,
  restartIntoUpdate,
} from "./appUpdate";

const FOUND = { version: "0.6.4", currentVersion: "0.6.3" };

beforeEach(() => {
  __resetAppUpdateForTests();
  for (const f of Object.values(api)) f.mockReset();
  api.checkForUpdate.mockResolvedValue(FOUND);
  api.isUpdaterSupported.mockResolvedValue(true);
  api.installUpdate.mockImplementation(async (onProgress?: (f: number) => void) => {
    onProgress?.(0.5);
  });
  api.restartApp.mockResolvedValue(undefined);
});

describe("app update store", () => {
  it("asks the release endpoint once per launch however many surfaces mount", async () => {
    await Promise.all([checkAppUpdate(), checkAppUpdate(), checkAppUpdate()]);
    expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(getAppUpdateState()).toMatchObject({ phase: "found", info: FOUND, canSelfInstall: true });
  });

  it("re-checks when the user presses check now", async () => {
    await checkAppUpdate();
    await checkAppUpdate(true);
    expect(api.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("reports up to date when there is no newer release", async () => {
    api.checkForUpdate.mockResolvedValue(null);
    await checkAppUpdate();
    expect(getAppUpdateState()).toMatchObject({ phase: "current", info: null });
    expect(api.isUpdaterSupported).not.toHaveBeenCalled();
  });

  it("installs, then restarts only when asked", async () => {
    await checkAppUpdate();
    await installAppUpdate();
    expect(getAppUpdateState()).toMatchObject({ phase: "done", progress: 0.5 });
    expect(api.restartApp).not.toHaveBeenCalled();
    await restartIntoUpdate();
    expect(api.restartApp).toHaveBeenCalledTimes(1);
    expect(getAppUpdateState().phase).toBe("restarting");
  });

  it("does not install on a build that cannot update itself", async () => {
    api.isUpdaterSupported.mockResolvedValue(false);
    await checkAppUpdate();
    await installAppUpdate();
    expect(api.installUpdate).not.toHaveBeenCalled();
    expect(getAppUpdateState().phase).toBe("found");
  });

  it("does not restart before an install finished", async () => {
    await checkAppUpdate();
    await restartIntoUpdate();
    expect(api.restartApp).not.toHaveBeenCalled();
  });

  it("keeps the release on a failed install so it can be retried", async () => {
    api.installUpdate.mockRejectedValueOnce(new Error("signature mismatch"));
    await checkAppUpdate();
    await installAppUpdate();
    expect(getAppUpdateState()).toMatchObject({ phase: "error", info: FOUND, error: "signature mismatch" });
    await installAppUpdate();
    expect(getAppUpdateState().phase).toBe("done");
  });

  it("a check during an install does not reset it", async () => {
    await checkAppUpdate();
    await installAppUpdate();
    await checkAppUpdate(true);
    expect(getAppUpdateState().phase).toBe("done");
    expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("tells the user to reopen the app when the restart call fails", async () => {
    api.restartApp.mockRejectedValueOnce(new Error("no handle"));
    await checkAppUpdate();
    await installAppUpdate();
    await restartIntoUpdate();
    expect(getAppUpdateState().phase).toBe("done");
    expect(getAppUpdateState().error).toMatch(/Close and reopen PwndaWallet/);
  });
});
