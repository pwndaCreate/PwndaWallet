/**
 * A transaction hash (or an address, or a memo) shown whole, with Copy and,
 * for a hash, a working "explorer" button. Shared by the confirm modal and the
 * details modal.
 *
 * # Why (the operator's report, 2026-09-30)
 *
 *   "I can't click on the source tx in the swap screen but it looks like I can
 *    click it as a hyperlink, also why is it truncated?"
 *
 * The confirm modal showed `truncate(hash)` (8 characters … 6 characters) as
 * an `<a href target="_blank">`. Found by reading the code path, not by a live
 * repro:
 *
 *  - Tauri's webview opens nothing for a `target="_blank"` link by itself:
 *    wry 0.55.1 answers the new-window request with `SetHandled(true)` when no
 *    handler is set (`webview2/mod.rs`), and this app sets none.
 *  - tauri-plugin-opener 2.5.4 makes such links work with a click listener on
 *    `window` (`src/init-iife.js`). The modal card had
 *    `onClick={e => e.stopPropagation()}` (so a click inside it would not
 *    reach the backdrop), and React stops the native event at its root, so
 *    that listener never heard the click.
 *
 * So the link looked live and did nothing, and the hash was cut. Here the hash
 * is printed in full and wraps, and the explorer is opened by a button that
 * calls `openExternal` directly, which nothing in between can swallow.
 */
import { useState, type CSSProperties } from "react";
import { openExternal } from "../../utils/openExternal";
import { isHttpUrl } from "./swap-details";

const SMALL_BTN: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--text-dim)",
  padding: "2px 6px",
  fontSize: 9,
  letterSpacing: 1,
  fontFamily: "var(--font-mono)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/** Open an explorer link in the OS browser. Anything but http(s) is ignored. */
export function openExplorer(url: string): Promise<void> {
  if (!isHttpUrl(url)) return Promise.resolve();
  return openExternal(url).catch((e: unknown) => {
    console.warn("[swap] could not open the explorer link", e);
  });
}

/** The explorer button. A plain button with its own handler: see the header
 *  for why an anchor inside a modal was not enough. */
export function ExplorerButton({ url, label = "explorer ↗" }: { url: string; label?: string }) {
  return (
    <button
      type="button"
      data-explorer-url={url}
      title={`Open in your browser: ${url}`}
      onClick={() => void openExplorer(url)}
      style={{ ...SMALL_BTN, color: "var(--accent)", borderColor: "var(--accent-mid)" }}
    >
      {label}
    </button>
  );
}

export function TxHashField({
  label,
  value,
  explorerUrl,
  hint,
}: {
  label: string;
  /** Shown in full. Never truncated: this is the string people paste into
   *  an explorer or a support ticket. */
  value: string;
  /** Built by the wallet from the hash. Omitted or null: Copy only. */
  explorerUrl?: string | null;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  const url = isHttpUrl(explorerUrl) ? explorerUrl : null;
  const onCopy = () => {
    const done = navigator.clipboard?.writeText(value);
    if (!done) return;
    void done
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        /* the value stays selectable on screen */
      });
  };
  return (
    <div
      data-hash-field={label}
      style={{
        padding: "8px 12px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        marginTop: 6,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            color: "var(--text-dim)",
            letterSpacing: 1,
            textTransform: "uppercase",
            fontSize: 9,
          }}
        >
          {label}
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={onCopy}
            title={`Copy ${label}`}
            style={{ ...SMALL_BTN, color: copied ? "var(--accent)" : "var(--text-dim)" }}
          >
            {copied ? "copied" : "copy"}
          </button>
          {url && <ExplorerButton url={url} />}
        </span>
      </div>
      <div
        className="tnum"
        data-hash-value
        style={{
          marginTop: 6,
          color: "var(--text)",
          wordBreak: "break-all",
          overflowWrap: "anywhere",
          userSelect: "text",
          lineHeight: 1.45,
        }}
      >
        {value}
      </div>
      {hint && (
        <div style={{ marginTop: 4, fontSize: 9, color: "var(--text-dim)", lineHeight: 1.45 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
