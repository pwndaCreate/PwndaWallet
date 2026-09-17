/**
 * src/features/mining/minerSetupEntry.ts
 *
 * The one way any surface puts Miner Setup on screen.
 *
 * Miner Setup's first card is "which miner binaries exist". That answer is
 * read by `checkMinerStatus`, and until 2026-09-16 only landscape asked for it
 * when the setup wizard finished: portrait's wizard just changed the view. On
 * that path portrait relied on `useMiner`'s focus effect happening to fire
 * once the opt-in flag flipped, which is an ordering accident rather than a
 * contract. Landscape's own Mine START had no route to Miner Setup at all.
 *
 * Only the NAVIGATION differs between layouts (portrait sets a view; landscape
 * switches to the Settings tab and sets the same view), so that part is
 * injected and everything else is shared.
 *
 * Pure and dependency-free on purpose: `LandscapeRoot` and `ViewRouter`
 * import it, and PwndaLite never needs it.
 */

export interface MinerSetupEntryDeps {
  /** Re-read which miner binaries (and Defender exclusions) exist. */
  checkMinerStatus: () => unknown;
  /** Put Miner Setup on screen, in whatever way this layout does that. */
  showMinerSetup: () => void;
}

/** Refresh the miner status, then show Miner Setup. */
export function openMinerSetup(deps: MinerSetupEntryDeps): void {
  void deps.checkMinerStatus();
  deps.showMinerSetup();
}

/**
 * The mining setup wizard's "Set up mining": persist the opt-in, then open
 * Miner Setup with a fresh status read.
 *
 * The opt-in is awaited first, so a failed write rejects here and leaves the
 * user on the wizard, not on a setup screen behind a gate that is still shut.
 */
export async function enableMiningAndOpenSetup(
  deps: MinerSetupEntryDeps & { enableMining: () => Promise<void> },
): Promise<void> {
  await deps.enableMining();
  openMinerSetup(deps);
}
