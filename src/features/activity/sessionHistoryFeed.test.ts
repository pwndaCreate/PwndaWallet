/**
 * Zano and Xelis history: one reader each, one mapping each.
 *
 * Found by the portrait/landscape parity audit (2026-09-16) and fixed the
 * same day:
 *
 *  - `App.tsx` polled Zano and Xelis history through their adapters every 60s
 *    (for Activity), while each wallet session also read the same history for
 *    its own card. Two readers of one sidecar.
 *  - Zano's session read history ONCE, at start, although its poll comment
 *    said it kept history fresh. The Zano history card froze at unlock time
 *    while Activity kept moving, so the two surfaces disagreed.
 *
 * Now the sessions are the only readers: Zano's 30s tick refreshes history,
 * `App.tsx` stops polling both chains and builds their Activity rows from the
 * sessions' `txHistory`, through the same mapping each adapter uses. Monero
 * keeps the generic poll: its session reads only while Monero is on screen.
 *
 * The wiring checks read source (comments stripped); the mapping checks run.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(async () => null) }));

import { zanoTransfersToChainTx } from "../../wallets/zano-wallet";
import { xelisTransfersToChainTx } from "../../wallets/xelis-wallet";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const code = (rel: string) =>
  readFileSync(resolve(ROOT, rel), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const APP = code("src/App.tsx");
const ZANO_SESSION = code("src/features/zano/useZanoSession.ts");

describe("App.tsx reads Zano and Xelis history from their sessions", () => {
  it("does not hand Zano or Xelis to the generic poll", () => {
    const set = /SESSION_FED_HISTORY[^=]*=\s*new Set<ChainType>\(\[([^\]]*)\]\)/.exec(APP);
    expect(set, "SESSION_FED_HISTORY not found").not.toBeNull();
    const chains = set![1].match(/"[a-z-]+"/g) ?? [];
    expect(chains.sort()).toEqual(['"xelis"', '"zano"']);
    // Monero's session polls only while Monero is focused; Activity needs it always.
    expect(chains).not.toContain('"monero"');
    expect(APP).toMatch(/useTxHistory\(polledTxPairs,/);
    expect(APP).not.toMatch(/useTxHistory\(txPairs,/);
  });

  it("builds their rows from the sessions, with the adapters' own mapping", () => {
    expect(APP).toContain("zanoTransfersToChainTx(zanoTxHistory)");
    expect(APP).toContain("xelisTransfersToChainTx(xelisTxHistory)");
  });

  it("still lists both chains as owned (Activity's chain list comes from txPairs)", () => {
    expect(APP).toMatch(/ownedChains = useMemo\(\s*\(\) => txPairs\.map/);
  });

  it("routes a post-send history refresh to the session that owns the chain", () => {
    expect(APP).toMatch(/if \(chain === "zano"\)/);
    expect(APP).toMatch(/if \(chain === "xelis"\)/);
    expect(APP).toMatch(/refreshTxHistory,\s*\n\s*setError/);
  });
});

describe("Zano's session keeps its history fresh", () => {
  it("refreshes history on the ready tick, not only at start", () => {
    const tick = /const tick = async \(\) => \{([\s\S]*?)\n\s{4}\};/.exec(ZANO_SESSION);
    expect(tick, "ready tick not found").not.toBeNull();
    expect(tick![1]).toContain("refreshTxHistory()");
  });

  it("uses the read that throws, so a failed read keeps the list", () => {
    expect(ZANO_SESSION).toContain("readZanoTransactionHistory()");
    expect(ZANO_SESSION).not.toContain("getZanoTransactionHistory");
  });
});

describe("the adapters and the session feed map transfers the same way", () => {
  it("each adapter's getTransactionHistory goes through the shared mapper", () => {
    expect(code("src/wallets/zano-wallet.ts")).toMatch(
      /items: zanoTransfersToChainTx\(entries, limit\)/,
    );
    expect(code("src/wallets/xelis-wallet.ts")).toMatch(/items: xelisTransfersToChainTx\(entries\)/);
  });

  it("maps a Zano transfer: direction, native decimals, limit", () => {
    const rows = zanoTransfersToChainTx(
      [
        {
          isIncome: true,
          amount: 2_500_000_000_000,
          assetId: "d6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a",
          height: 100,
          txHash: "aa",
          timestamp: 1_700_000_000,
        },
        { isIncome: false, amount: 1, assetId: "x", height: 99, txHash: "bb" },
      ],
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chain: "zano", hash: "aa", direction: "in", height: 100 });
    expect(Number(rows[0].amount)).toBeCloseTo(2.5);
    expect(rows[0].timestamp).toBe(1_700_000_000);
  });

  it("maps a Xelis transfer: milliseconds become seconds, fee makes 'other' outgoing", () => {
    const rows = xelisTransfersToChainTx([
      {
        hash: "h1",
        kind: "incoming",
        amountAtomic: 150_000_000n,
        feeAtomic: null,
        topoheight: 7,
        timestamp: 1_700_000_000_500,
        counterparty: "xel:abc",
      },
      {
        hash: "h2",
        kind: "other",
        amountAtomic: 0n,
        feeAtomic: 1_000n,
        topoheight: 8,
        timestamp: null,
        counterparty: null,
      },
    ]);
    expect(rows[0]).toMatchObject({
      chain: "xelis",
      direction: "in",
      timestamp: 1_700_000_000,
      height: 7,
      counterparty: "xel:abc",
    });
    expect(Number(rows[0].amount)).toBeCloseTo(1.5);
    expect(rows[1].direction).toBe("out");
    expect(rows[1].timestamp).toBeUndefined();
  });
});
