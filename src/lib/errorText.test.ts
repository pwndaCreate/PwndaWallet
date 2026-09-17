/**
 * `errorText` — the caught-value-to-text helper.
 *
 * Incident 2026-09-15: Tauri rejects `invoke` with a plain string for Rust
 * `Result<_, String>` errors, so `"Transaction failed: " + e.message` in
 * `useSend.ts` printed "Transaction failed: undefined" for every wallet-rpc
 * send failure. The first case below is that exact rejection shape.
 */
import { describe, it, expect } from "vitest";
import { errorText } from "./errorText";

describe("errorText", () => {
  it("returns a Tauri string rejection verbatim (the 2026-09-15 shape)", () => {
    const rejection = "RPC error -4: not enough unlocked money";
    expect(errorText(rejection)).toBe(rejection);
    // What the old code produced from the same value:
    expect("Transaction failed: " + (rejection as unknown as Error).message).toBe(
      "Transaction failed: undefined",
    );
    expect("Transaction failed: " + errorText(rejection)).toBe(
      "Transaction failed: RPC error -4: not enough unlocked money",
    );
  });

  it("returns an Error's message", () => {
    expect(errorText(new Error("Invalid Zephyr address."))).toBe("Invalid Zephyr address.");
  });

  it("reads `message` off a plain object", () => {
    expect(errorText({ message: "boom", code: -1 })).toBe("boom");
  });

  it("falls back instead of printing undefined, null, blanks or [object Object]", () => {
    expect(errorText(undefined)).toBe("Unknown error");
    expect(errorText(null, "Send failed")).toBe("Send failed");
    expect(errorText("   ")).toBe("Unknown error");
    expect(errorText(new Error(""))).toBe("Unknown error");
    expect(errorText({ code: 7 })).toBe("Unknown error");
    expect(errorText({ message: 42 })).toBe("Unknown error");
  });

  it("stringifies other primitives", () => {
    expect(errorText(42)).toBe("42");
    expect(errorText(false)).toBe("false");
  });
});
