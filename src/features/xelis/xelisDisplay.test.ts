/**
 * The words the Xelis sync and history cards use. The two rules they pin came
 * from Zano in this repo: no percentage built from heights nobody turned into a
 * percentage, and a transfer's direction taken only from its own kind (Zano's
 * history once showed "Sent -0" over a received transfer).
 */
import { describe, it, expect } from "vitest";
import { describeXelisSync, xelisTransferRow } from "./xelisDisplay";
import type { XelisSyncStatus, XelisTransferEntry } from "../../wallets/xelis-rpc";

const entry = (over: Partial<XelisTransferEntry> = {}): XelisTransferEntry => ({
  hash: "ab".repeat(32),
  kind: "incoming",
  amountAtomic: BigInt(150_000_000), // 1.5 XEL
  feeAtomic: null,
  topoheight: 3_400_000,
  timestamp: Date.UTC(2026, 8, 15, 12),
  counterparty: null,
  ...over,
});

describe("describeXelisSync", () => {
  const scanning: XelisSyncStatus = {
    online: true,
    walletTopoheight: 100,
    daemonTopoheight: 250,
    synced: false,
  };

  it("never shows a percentage", () => {
    const states: XelisSyncStatus[] = [
      scanning,
      { ...scanning, daemonTopoheight: null },
      { ...scanning, walletTopoheight: 250, synced: true },
      { ...scanning, online: false },
    ];
    for (const s of states) {
      const v = describeXelisSync(s);
      expect(`${v.headline} ${v.detail}`).not.toContain("%");
    }
  });

  it("says how far behind the node the wallet is while scanning", () => {
    expect(describeXelisSync(scanning)).toEqual({
      tone: "progress",
      headline: "Scanning the chain…",
      detail: "Topoheight 100 of 250 (150 behind).",
    });
  });

  it("does not invent the node's height when the node has not reported one", () => {
    const v = describeXelisSync({ ...scanning, daemonTopoheight: null });
    expect(v.detail).toBe("At topoheight 100. The node has not reported its own height yet.");
  });

  it("reports synced and offline as such", () => {
    expect(describeXelisSync({ ...scanning, walletTopoheight: 250, synced: true })).toEqual({
      tone: "ok",
      headline: "Synced.",
      detail: "Topoheight 250 of 250.",
    });
    const offline = describeXelisSync({ ...scanning, online: false });
    expect(offline.tone).toBe("warn");
    expect(offline.headline).toBe("Not connected to a Xelis node.");
  });

  it("never reports a negative gap when the wallet reads past the node's height", () => {
    expect(describeXelisSync({ ...scanning, walletTopoheight: 260 }).detail).toContain("(0 behind)");
  });

  // 2026-09-16: a freshly restored wallet has no height until its first scan
  // ends. That is progress, not an error, and never "topoheight 0".
  it("describes a first scan without inventing a height", () => {
    const first = describeXelisSync({ ...scanning, walletTopoheight: null });
    expect(first).toEqual({
      tone: "progress",
      headline: "Scanning the chain…",
      detail:
        "First scan in progress; the node is at topoheight 250. The wallet records its height " +
        "when the scan finishes.",
    });
    expect(describeXelisSync({ ...scanning, walletTopoheight: null, daemonTopoheight: null }).detail).toBe(
      "First scan in progress. The wallet records its height when the scan finishes."
    );
    const offline = describeXelisSync({ ...scanning, walletTopoheight: null, online: false });
    expect(offline.detail).toBe("The wallet has not finished its first scan.");
    // `synced` can never be claimed without a height.
    expect(describeXelisSync({ ...scanning, walletTopoheight: null, synced: true }).tone).toBe("progress");
    for (const v of [first, offline]) expect(v.detail).not.toMatch(/0|NaN|null/);
  });
});

describe("xelisTransferRow", () => {
  it("signs received and sent amounts from the kind", () => {
    expect(xelisTransferRow(entry()).amount).toBe("+1.5 XEL");
    expect(xelisTransferRow(entry({ kind: "outgoing" })).amount).toBe("-1.5 XEL");
  });

  it("shows a fee only on outgoing entries that report one", () => {
    expect(xelisTransferRow(entry({ kind: "outgoing", feeAtomic: BigInt(10_000) })).fee).toBe(
      "fee 0.0001 XEL",
    );
    expect(xelisTransferRow(entry({ kind: "outgoing" })).fee).toBeNull();
    expect(xelisTransferRow(entry({ feeAtomic: BigInt(10_000) })).fee).toBeNull();
  });

  it("labels block rewards, burns and anything else", () => {
    expect(xelisTransferRow(entry({ kind: "coinbase" }))).toMatchObject({
      label: "Mined",
      direction: "in",
      amount: "+1.5 XEL",
    });
    expect(xelisTransferRow(entry({ kind: "burn" }))).toMatchObject({
      label: "Burned",
      direction: "out",
      amount: "-1.5 XEL",
    });
    expect(xelisTransferRow(entry({ kind: "other" }))).toMatchObject({
      label: "Other",
      direction: "neutral",
      amount: "1.5 XEL",
    });
  });

  it("takes the sign from the kind even if an amount arrives negative", () => {
    expect(xelisTransferRow(entry({ amountAtomic: BigInt(-150_000_000) })).amount).toBe("+1.5 XEL");
  });

  it("says the time is unknown rather than showing 1970", () => {
    expect(xelisTransferRow(entry({ timestamp: null })).when).toBe("time unknown");
  });

  it("names the topoheight and keeps keys distinct for repeated hashes", () => {
    expect(xelisTransferRow(entry()).where).toBe("topoheight 3,400,000");
    expect(xelisTransferRow(entry(), 0).key).not.toBe(xelisTransferRow(entry(), 1).key);
  });
});
