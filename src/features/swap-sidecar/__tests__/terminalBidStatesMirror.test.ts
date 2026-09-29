/**
 * `scripts/swap/terminal-bid-states.json` must stay equal to what
 * `bidStates.ts` calls terminal.
 *
 * The JSON exists because `Publish-ParticlSnapshot.ps1` has to decide whether a
 * swap is still live before it stops the Particl node, and PowerShell cannot
 * import a TypeScript table. So the table is mirrored — and this is the test
 * that stops the mirror from drifting, the same shape as the dev-fee wallet
 * registry check (`src-tauri/src/dev_fee/wallets.rs` ↔ `mining/pools.ts`).
 *
 * Why drift here is worth a test rather than a comment: the script's gate is
 * fail-closed, so a MISSING terminal label only costs a refused publish. The
 * dangerous direction is the other one — a label listed here as terminal that
 * `bidStates.ts` considers live would let the script stop the node under a swap
 * that still has a refund deadline to meet. The equality assertion below covers
 * both directions, and the second test states the dangerous one on its own so a
 * future edit cannot weaken it to a subset check without noticing.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ALL_BID_STATE_NAMES,
  BID_STATE_IDS,
  BID_STATE_WIRE_LABELS,
  isTerminal,
} from "../bidStates";

const JSON_PATH = path.join("scripts", "swap", "terminal-bid-states.json");

function fromDisk(): string[] {
  const raw = JSON.parse(fs.readFileSync(JSON_PATH, "utf8")) as {
    terminal: string[];
  };
  return raw.terminal;
}

function fromSource(): string[] {
  return ALL_BID_STATE_NAMES.filter((n) => isTerminal(BID_STATE_IDS[n])).map(
    (n) => BID_STATE_WIRE_LABELS[n],
  );
}

describe("terminal-bid-states.json", () => {
  it("matches bidStates.ts exactly", () => {
    // Sorted, because the JSON is generated in declaration order and neither
    // side should care about that.
    expect([...fromDisk()].sort()).toEqual([...fromSource()].sort());
  });

  it("never calls a live state terminal", () => {
    // The direction that could cost someone a refund: the script stops the node
    // believing nothing is in flight. Stated separately so it survives any
    // future loosening of the equality above.
    const live = new Set(
      ALL_BID_STATE_NAMES.filter((n) => !isTerminal(BID_STATE_IDS[n])).map(
        (n) => BID_STATE_WIRE_LABELS[n],
      ),
    );
    for (const label of fromDisk()) {
      expect(live.has(label), `"${label}" is still live in bidStates.ts`).toBe(
        false,
      );
    }
  });

  it("lists real wire labels, not invented ones", () => {
    // A typo would silently make a terminal state read as in-flight — safe, but
    // it would refuse every publish forever with no obvious cause.
    const known = new Set(Object.values(BID_STATE_WIRE_LABELS));
    for (const label of fromDisk()) {
      expect(known.has(label), `"${label}" is not a BasicSwap bid state`).toBe(
        true,
      );
    }
  });
});
