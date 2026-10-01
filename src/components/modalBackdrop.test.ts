/**
 * Where the shared modal backdrop sits in the window (2026-09-30).
 *
 * Found in the sandbox, portrait, on the Activity transaction sheet: the
 * bottom nav painted over the sheet's "Copy hash" / "View on explorer"
 * buttons. Every modal was rendered inside `.app`, a stacking context of its
 * own at z-index 1, so no z-index on the modal could lift it over the nav,
 * which sits outside `.app` at 10 — and the nav stayed clickable behind every
 * swap modal, so a tab switch could unmount one mid-flow.
 *
 * The backdrop now renders into `document.body` at `MODAL_BACKDROP_Z`. The
 * source checks below pin the order against the files that set the other
 * layers, so moving one of them fails here rather than on screen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, isValidElement } from "react";
import { MODAL_BACKDROP_Z, ModalBackdrop } from "./ModalBackdrop";
import { AppAlerts } from "./AppAlerts";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

afterEach(() => vi.unstubAllGlobals());

describe("the modal backdrop's layer", () => {
  it("sits above the page and the portrait bottom nav, below the landscape title bar", () => {
    const nav = Number(/zIndex:\s*(\d+)/.exec(read("../design/shell/BottomNav.tsx"))?.[1]);
    const landscapeTitle = Number(
      /zIndex:\s*(\d+),\s*\n\s*userSelect: "none"/.exec(read("../features/landscape/LandscapeShell.tsx"))?.[1],
    );
    const app = Number(/\.app \{[^}]*z-index:\s*(\d+)/.exec(read("../design/styles/chrome.css"))?.[1]);
    expect([nav, landscapeTitle, app].every(Number.isFinite)).toBe(true);
    expect(MODAL_BACKDROP_Z).toBeGreaterThan(app);
    expect(MODAL_BACKDROP_Z).toBeGreaterThan(nav);
    expect(MODAL_BACKDROP_Z).toBeLessThan(landscapeTitle);
  });

  it("the portrait title bar has no layer, so the backdrop's own strip moves the window there", () => {
    // If TitleBar ever gains a z-index above the backdrop, its window buttons
    // become usable over a modal and this strip is redundant: revisit both.
    expect(read("../design/shell/TitleBar.tsx")).not.toMatch(/zIndex/);
    expect(read("ModalBackdrop.tsx")).toContain("data-tauri-drag-region");
  });

  it("renders into document.body when there is a DOM", () => {
    const body = { nodeType: 1, nodeName: "BODY" };
    vi.stubGlobal("document", { body });
    const out = ModalBackdrop({ children: createElement("span") }) as unknown as {
      $$typeof: symbol;
      containerInfo: unknown;
    };
    expect(out.$$typeof).toBe(Symbol.for("react.portal"));
    expect(out.containerInfo).toBe(body);
  });

  it("renders in place without one (so the unit tests can drive its handlers)", () => {
    const out = ModalBackdrop({ children: null });
    expect(isValidElement(out)).toBe(true);
  });
});

/**
 * 2026-10-01. The app's error lines rendered inside `.app` in portrait, so an
 * error raised with a backdrop modal open sat behind it; they render at the
 * page root now, above every backdrop. And the last `.modal-overlay` popups
 * (Send, the Zephyr conversion, three Mine-tab dialogs) were the ones the
 * bottom nav still painted over: none may come back.
 */
describe("what sits above and below the backdrop", () => {
  it("the app's error lines render into document.body, above the backdrop", () => {
    const body = { nodeType: 1, nodeName: "BODY" };
    vi.stubGlobal("document", { body });
    const out = AppAlerts({ error: "boom", success: "", setError: () => {} }) as unknown as {
      $$typeof: symbol;
      containerInfo: unknown;
      children: { props: { style: { zIndex: number } } };
    };
    expect(out.$$typeof).toBe(Symbol.for("react.portal"));
    expect(out.containerInfo).toBe(body);
    expect(out.children.props.style.zIndex).toBeGreaterThan(MODAL_BACKDROP_Z);
  });

  it("no component renders the retired .modal-overlay class", () => {
    const root = resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = resolve(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx$/.test(name) && /className="modal-overlay"/.test(readFileSync(p, "utf8"))) {
          offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
