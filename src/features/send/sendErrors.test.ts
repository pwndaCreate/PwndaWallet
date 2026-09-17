/**
 * `useSend`'s failure banner (incident 2026-09-15).
 *
 * A wallet-rpc send failure reaches `useSend` as a plain string, because
 * Tauri rejects `invoke` with the Rust command's `Err(String)`. The banner read
 * that string's `.message`, so it said "Transaction failed: undefined".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sendFailureText } from "./sendErrors";

describe("sendFailureText", () => {
  it("shows a Tauri string rejection instead of 'undefined'", () => {
    expect(sendFailureText("RPC error -17: not enough money")).toBe(
      "Transaction failed: RPC error -17: not enough money",
    );
  });

  it("shows an Error's message", () => {
    expect(sendFailureText(new Error("Invalid Zephyr address."))).toBe(
      "Transaction failed: Invalid Zephyr address.",
    );
  });

  it("never prints 'undefined' for an empty rejection", () => {
    expect(sendFailureText(undefined)).toBe(
      "Transaction failed: the wallet returned no error message.",
    );
  });

  it("is what useSend actually uses (the hook has no DOM test harness here)", () => {
    const src = readFileSync(join(__dirname, "useSend.ts"), "utf8");
    expect(src).toContain("setError(sendFailureText(e))");
    expect(src).not.toMatch(/"Transaction failed: " \+ e\.message/);
  });
});
