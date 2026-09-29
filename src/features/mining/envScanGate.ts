/**
 * When the Mining view may start the MSR environment scan on its own, and when
 * `startMining` may ask for the Defender exclusion (2026-09-25).
 *
 * # Why this exists
 *
 * The scan ran from the same effect as the miner/Defender status check, keyed on
 * `scanningEnv` and `hashrateFixPlan`. The scan never succeeded on Windows — its
 * script emitted `seLockMemoryGranted` as a list, which `serde` rejected — so
 * `hashrateFixPlan` stayed null, `scanningEnv` flipped true→false, and the effect
 * re-armed itself: a new scan AND a new Defender check (a PowerShell each) every
 * ~2.5 s for as long as the Mine tab was open. Measured on the operator's machine:
 * five PowerShells alive at all times, ~70 launched a minute. The script is fixed
 * in `miners.rs`; this module keeps a failing scan from ever looping again.
 */

/** Start the env scan automatically? Once per session, on the Mining tab. */
export function shouldAutoScanEnv(s: {
  focus: string;
  hasPlan: boolean;
  scanning: boolean;
  attempted: boolean;
}): boolean {
  return s.focus === "mining" && !s.hasPlan && !s.scanning && !s.attempted;
}

/**
 * Ask for the Defender exclusion (a UAC prompt) before a mining start?
 *
 * `excluded` is `check_defender_exclusions`' answer — which, since 2026-09-25,
 * is `true` once the elevated script has confirmed the exclusion, even though a
 * non-elevated process cannot read Defender's lists. `declinedThisSession` stops
 * a user who said no from being asked again on every start until they restart.
 */
export function shouldPromptDefender(s: {
  supported: boolean;
  excluded: boolean | null;
  declinedThisSession: boolean;
}): boolean {
  return s.supported && s.excluded !== true && !s.declinedThisSession;
}
