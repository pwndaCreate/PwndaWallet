/**
 * Mining-local subset of the full wallet's `FeatureFocus` type
 * (`src/state/featureFocus.ts`). The mining hook only gates its
 * lifecycle effects on three values:
 *
 *  - `"mining"`      — user is on the mining view (hashrate poller,
 *                      pool-stats poller, dev-fee accounting poll all
 *                      run here)
 *  - `"miner-setup"` — user is on the setup screen (miner-status
 *                      checks run here)
 *  - `"other"`       — everything else; pollers idle
 *
 * Defining the type inside the mining folder keeps the hook decoupled
 * from the full wallet's landscape/View enum. The full wallet's
 * `deriveFeatureFocus` returns the wider type and narrows to this
 * subset when passing to the mining hook (any non-mining value collapses
 * to `"other"`). PwndaLite imports this directly — its own root state
 * stores `LiteFocus = "mining" | "miner-setup"`, mapped 1:1.
 */
export type MiningFocus = "mining" | "miner-setup" | "other";

/**
 * Coerce a wider focus value (the full wallet's `FeatureFocus` union)
 * into the mining-local subset. Anything that's not literally
 * `"mining"` or `"miner-setup"` becomes `"other"` so the gates in
 * `useMiner` collapse to one "idle" branch.
 */
export function toMiningFocus(focus: string): MiningFocus {
  if (focus === "mining") return "mining";
  if (focus === "miner-setup") return "miner-setup";
  return "other";
}
