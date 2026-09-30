/**
 * The Send modal's memo field, tag field and fee check (2026-09-29 send-safety
 * audit).
 *
 *  - Stellar had no memo field: the session send accepted a memo nothing ever
 *    passed, so XLM sent to an exchange arrived without one and was credited
 *    to nobody. The memo now lives in the send store like the XRP tag, is
 *    reset with it, and reaches the send through `SendOptions`.
 *  - The XRP tag field stripped non-digits, so "123-456" silently became tag
 *    123456. It is now kept as typed and refused.
 *  - `loadGas` re-ran on every keystroke with no guard, so an older reply
 *    could land after a newer one and put back a stale verdict.
 *
 * The modal is rendered with react-dom/server (effects do not run there) and
 * the hook is pinned by its source, as `sendOutcome.test.ts` does: this repo
 * has no DOM test harness.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SendModal, createLatestGate } from "./SendModal";
import {
  MAX_MEMO_ID,
  getSendMemo,
  parseSendMemo,
  resetSendMemo,
  setSendDestinationTag,
  setSendMemoText,
  setSendMemoType,
} from "./sendAssetStore";
import { stellarAdapter } from "../../wallets/stellar-wallet";
import type { ChainAdapter } from "../../wallets/types";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

function render(adapter: ChainAdapter, over: { sendTo?: string; sendAmount?: string } = {}) {
  return renderToStaticMarkup(
    createElement(SendModal, {
      adapter,
      sendTo: over.sendTo ?? "",
      setSendTo: () => {},
      sendAmount: over.sendAmount ?? "",
      setSendAmount: () => {},
      sending: false,
      onSend: () => {},
      onClose: () => {},
    }),
  );
}
const noMemo = { ...stellarAdapter, memo: undefined } as ChainAdapter;
const tagged = {
  ...stellarAdapter,
  memo: undefined,
  destinationTag: { label: "Destination tag", hint: "tag hint" },
} as ChainAdapter;
/** The Send button's opening tag. */
const sendButton = (html: string) => /<button class="btn-primary"[^>]*>/.exec(html)?.[0] ?? "";

beforeEach(() => {
  // `?.`: this file was also run against the pre-2026-09-29 store, which has
  // no memo, to show each assertion fails there for its own reason.
  resetSendMemo?.();
  setSendDestinationTag("");
});

describe("parseSendMemo", () => {
  it("empty is no memo", () => {
    expect(parseSendMemo("", "text", 28)).toEqual({});
    expect(parseSendMemo("   ", "id", 28)).toEqual({});
  });

  it("text: up to the byte limit, counted in UTF-8, trimmed, never truncated", () => {
    expect(parseSendMemo(" deposit 77\n", "text", 28)).toEqual({ memo: { type: "text", value: "deposit 77" } });
    expect(parseSendMemo("x".repeat(28), "text", 28).memo?.value).toBe("x".repeat(28));
    expect(parseSendMemo("x".repeat(29), "text", 28).error).toMatch(/at most 28 bytes; this one is 29/);
    expect(parseSendMemo("é".repeat(14), "text", 28).memo).toBeDefined(); // 28 bytes
    expect(parseSendMemo("é".repeat(15), "text", 28).error).toMatch(/this one is 30/);
  });

  it("ID: digits only, 0 to 2^64 - 1, refused rather than repaired", () => {
    expect(MAX_MEMO_ID).toBe(2n ** 64n - 1n);
    expect(parseSendMemo("12345", "id", 28)).toEqual({ memo: { type: "id", value: "12345" } });
    expect(parseSendMemo(" 007 ", "id", 28)).toEqual({ memo: { type: "id", value: "7" } });
    expect(parseSendMemo("18446744073709551615", "id", 28).memo?.value).toBe("18446744073709551615");
    for (const bad of ["18446744073709551616", "123-456", "0x10", "1e5", "-1", "1.5", "abc"]) {
      expect(parseSendMemo(bad, "id", 28).error, bad).toMatch(/memo ID is a whole number/);
    }
  });
});

describe("the memo store", () => {
  it("holds the text and the type, and resets both", () => {
    setSendMemoText("900");
    setSendMemoType("id");
    expect(getSendMemo()).toEqual({ raw: "900", type: "id" });
    resetSendMemo();
    expect(getSendMemo()).toEqual({ raw: "", type: "text" });
  });

  it("keeps the same snapshot when nothing changed (useSyncExternalStore compares by reference)", () => {
    setSendMemoText("a");
    const before = getSendMemo();
    setSendMemoText("a");
    expect(getSendMemo()).toBe(before);
  });
});

describe("the Send modal offers a memo only where the chain has one (#2)", () => {
  it("Stellar declares the memo, with Stellar's 28-byte text limit", () => {
    expect(stellarAdapter.memo).toMatchObject({ label: "Memo", textMaxBytes: 28 });
  });

  it("renders the memo field and its type choice for Stellar", () => {
    const html = render(stellarAdapter);
    expect(html).toContain("data-send-memo");
    expect(html).toContain('aria-label="Memo"');
    expect(html).toContain('data-memo-type="text"');
    expect(html).toContain('data-memo-type="id"');
  });

  it("renders no memo field for a chain without one", () => {
    expect(render(noMemo)).not.toContain("data-send-memo");
  });

  it("a malformed memo is shown as the reason Send is off", () => {
    setSendMemoType("id");
    setSendMemoText("123-456");
    const html = render(stellarAdapter, { sendTo: "G", sendAmount: "1" });
    expect(html).toContain("A memo ID is a whole number");
    expect(sendButton(html)).toContain("disabled");
    expect(sendButton(html)).toContain('title="A memo ID is a whole number');
  });

  it("a number typed as a TEXT memo gets a note, and does not block", () => {
    setSendMemoText("12345");
    const html = render(stellarAdapter, { sendTo: "G", sendAmount: "1" });
    expect(html).toContain("This memo is a number");
    expect(sendButton(html)).not.toContain("memo");
  });
});

describe("the tag field refuses what it used to repair", () => {
  it("keeps the text as typed: no digit-stripping in the input handler", () => {
    const src = read("SendModal.tsx");
    expect(src).toContain("onChange={(e) => setSendDestinationTag(e.target.value)}");
    expect(src).not.toContain('setSendDestinationTag(e.target.value.replace(/[^0-9]/g, ""))');
  });

  it("'123-456' is shown with the refusal, and Send stays off", () => {
    setSendDestinationTag("123-456");
    const html = render(tagged, { sendTo: "r", sendAmount: "1" });
    expect(html).toContain('value="123-456"');
    expect(html).toContain("A destination tag is a whole number");
    expect(sendButton(html)).toContain('title="A destination tag is a whole number');
  });
});

describe("gas replies: only the newest request's answer is applied", () => {
  it("a stale reply is discarded", async () => {
    const gate = createLatestGate();
    let shown = "";
    const request = (answer: string, delayMs: number) => {
      const stamp = gate.begin();
      return new Promise<void>((r) => setTimeout(r, delayMs)).then(() => {
        if (gate.isCurrent(stamp)) shown = answer;
      });
    };
    // The estimate for the first keystroke is slower than the one after it.
    await Promise.all([request("for amount 1", 20), request("for amount 100", 1)]);
    expect(shown).toBe("for amount 100");
  });

  it("loadGas goes through the gate", () => {
    const src = read("SendModal.tsx");
    const at = src.indexOf("const loadGas = useCallback(");
    const body = src.slice(at, src.indexOf("}, [adapter, fromAddress, sendTo, sendAmount", at));
    expect(body).toContain("const stamp = gasGate.begin();");
    expect(body).toContain("if (gasGate.isCurrent(stamp)) setGas(r);");
    expect(body).toContain("if (gasGate.isCurrent(stamp)) setGas(null);");
  });
});

describe("useSend carries the memo to the send and forgets it with the tag", () => {
  const src = read("useSend.ts");

  it("passes the per-send options to the session override too", () => {
    expect(src).toContain("await sendOverride(sendTo, sendAmount, sendOpts)");
    expect(src).toContain("parseSendMemo(memoField.raw, memoField.type, adapter.memo.textMaxBytes)");
    expect(src).toContain("if (memoInput.error) throw new Error(memoInput.error);");
  });

  it("every place the tag is cleared clears the memo", () => {
    const tags = src.split('setSendDestinationTag("");').length - 1;
    const memos = src.split("resetSendMemo();").length - 1;
    expect(tags).toBeGreaterThanOrEqual(4); // open, close, success, unknown outcome
    expect(memos).toBe(tags);
  });
});
