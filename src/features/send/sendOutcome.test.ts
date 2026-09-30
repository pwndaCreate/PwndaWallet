/**
 * A send that may have gone out is not a failure (2026-09-29 send-safety
 * audit).
 *
 * Six chains could pay twice the same way: a node accepted the transaction,
 * something failed after that, the adapter said "Transaction failed" with the
 * form still filled, and one more press signed a NEW transaction. Adapters now
 * throw `SendOutcomeUnknownError` for that case; these tests pin what the user
 * is told and that the form cannot be pressed again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sendOutcomeUnknownText, sendSuccessText } from "./sendErrors";
import {
  SendOutcomeUnknownError,
  isSendOutcomeUnknown,
} from "../../wallets/send-outcome";

const read = (rel: string) =>
  readFileSync(join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

describe("an unknown outcome is reported as unknown", () => {
  it("names the hash and says to check before sending again", () => {
    const text = sendOutcomeUnknownText(
      new SendOutcomeUnknownError("receipt poll timed out", "0xabc"),
    );
    expect(text).toContain("may have been sent");
    expect(text).toContain("Hash: 0xabc");
    expect(text).toContain("before sending again");
    expect(text).toContain("receipt poll timed out");
  });

  it("never says 'failed' or 'try again'", () => {
    const text = sendOutcomeUnknownText(new SendOutcomeUnknownError("timeout"));
    expect(text.toLowerCase()).not.toContain("failed");
    expect(text.toLowerCase()).not.toContain("try again");
    // No hash known: no "Hash: undefined".
    expect(text).not.toContain("undefined");
  });

  it("is recognised by class and, across a module boundary, by name", () => {
    expect(isSendOutcomeUnknown(new SendOutcomeUnknownError("x"))).toBe(true);
    const foreign = Object.assign(new Error("x"), { name: "SendOutcomeUnknownError" });
    expect(isSendOutcomeUnknown(foreign)).toBe(true);
    expect(isSendOutcomeUnknown(new Error("x"))).toBe(false);
    expect(isSendOutcomeUnknown("RPC error -17")).toBe(false);
    expect(isSendOutcomeUnknown(undefined)).toBe(false);
  });
});

describe("a submitted send is not called 'sent' until confirmed", () => {
  it("distinguishes submitted from confirmed", () => {
    expect(sendSuccessText({ hash: "h1" })).toBe("Transaction sent! Hash: h1");
    expect(sendSuccessText({ hash: "h2", pending: true })).toBe(
      "Transaction submitted, not confirmed yet. Hash: h2",
    );
  });
});

describe("useSend closes the form on an unknown outcome", () => {
  // The hook has no DOM harness here; these pin the source the way
  // `sendErrors.test.ts` does.
  const src = read("useSend.ts");

  it("handles the unknown outcome before the ordinary failure", () => {
    const unknownAt = src.indexOf("if (isSendOutcomeUnknown(e)) {");
    const failureAt = src.indexOf("setError(sendFailureText(e))");
    expect(unknownAt).toBeGreaterThan(-1);
    expect(failureAt).toBeGreaterThan(unknownAt);
    const branch = src.slice(unknownAt, failureAt);
    for (const call of [
      'setSendTo("")',
      'setSendAmount("")',
      "setShowSendModal(false)",
      "setError(sendOutcomeUnknownText(e))",
      "return;",
    ]) {
      expect(branch, call).toContain(call);
    }
  });

  it("reports success through sendSuccessText", () => {
    expect(src).toContain("setSuccess(sendSuccessText(result))");
    expect(src).not.toContain("setSuccess(`Transaction sent! Hash: ${result.hash}`)");
  });

  it("forgets recipient and amount with the tag on Cancel", () => {
    const close = /const closeSendModal = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/.exec(src);
    expect(close, "closeSendModal not found").not.toBeNull();
    expect(close![1]).toContain('setSendDestinationTag("")');
    expect(close![1]).toContain('setSendTo("")');
    expect(close![1]).toContain('setSendAmount("")');
  });
});

describe("both layouts show send failures above the modal backdrop", () => {
  const portrait = read("../../ViewRouter.tsx");
  const landscape = read("../landscape/LandscapeRoot.tsx");

  it("mounts the one AppAlerts component in each root", () => {
    for (const src of [portrait, landscape]) {
      expect(src).toContain('from "');
      expect(src).toMatch(/<AppAlerts[\s/>]/);
    }
  });

  it("portrait no longer renders its alerts in page flow", () => {
    expect(portrait).not.toContain('{error && <div className="alert alert-error">{error}</div>}');
  });

  it("the component sits above .modal-overlay (z-index 2000)", () => {
    const comp = read("../../components/AppAlerts.tsx");
    const z = /zIndex:\s*(\d+)/.exec(comp);
    expect(z).not.toBeNull();
    expect(Number(z![1])).toBeGreaterThan(2000);
    expect(comp).toContain('position: "fixed"');
  });
});
