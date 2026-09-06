import type { ChainType } from "../../../wallets";

/**
 * Decimal places per coin for the four currently mineable chains.
 * Used to convert atomic-unit balance strings (returned by `pool_stats.rs`
 * as decimal strings to dodge JS precision) into human-readable display.
 *
 * Other chains aren't represented here because no pool adapter currently
 * targets them — extend if/when that changes.
 */
const COIN_DECIMALS: Partial<Record<ChainType, number>> = {
  monero: 12,
  zephyr: 12,
  ravencoin: 8,
  conflux: 18,
  // ERG = 1e9 nanoErg per ERG (Sigmaverse / EIP-26 atomic unit).
  ergo: 9,
};

/**
 * Convert an atomic-unit decimal string (e.g. "523388500000000") into a
 * trimmed decimal display (e.g. "0.523389") with up to `displayDecimals`
 * fractional digits. Returns "—" for unknown/missing inputs.
 */
export function formatAtomic(
  atomic: string | null | undefined,
  coin: ChainType,
  displayDecimals = 6
): string {
  if (!atomic) return "—";
  const decimals = COIN_DECIMALS[coin];
  if (decimals === undefined) return atomic;

  // Handle the value as a digit string so f64 precision can't truncate
  // the long XMR/CFX integers.
  const digits = atomic.replace(/\D/g, "");
  if (digits.length === 0) return "0";

  let intPart: string;
  let fracPart: string;
  if (digits.length <= decimals) {
    intPart = "0";
    fracPart = digits.padStart(decimals, "0");
  } else {
    intPart = digits.slice(0, digits.length - decimals);
    fracPart = digits.slice(digits.length - decimals);
  }

  // Truncate (don't round — over-stating pending balance is a worse UX
  // than understating it by a fraction of a satoshi).
  const truncFrac = fracPart.slice(0, displayDecimals).replace(/0+$/, "");
  return truncFrac.length > 0 ? `${intPart}.${truncFrac}` : intPart;
}

/**
 * Auto-scale a hashrate-style number into the most readable unit. The base
 * unit defaults to "H" (hashes/sec) but pass "Sol" for Equihash-family
 * algorithms which are conventionally measured in solutions/sec
 * (Sol/s, KSol/s, MSol/s, …).
 *
 * Examples (baseUnit="H"):
 *   1500          → "1.50 KH/s"
 *   2_300_000     → "2.30 MH/s"
 *   43_592_843    → "43.6 MH/s"
 *
 * Examples (baseUnit="Sol"):
 *   45_000        → "45.0 KSol/s"
 *
 * Returns `"—"` for nullish, and `"0 <unit>/s"` for zero so the UI
 * distinguishes "miner connected, no shares yet" from "no data".
 */
export function formatHashrate(
  hs: number | null | undefined,
  baseUnit: string = "H"
): string {
  const { value, unit } = formatHashrateParts(hs, baseUnit);
  return value === "—" ? "—" : `${value} ${unit}`;
}

/**
 * Same scaling logic as `formatHashrate`, but returns the value and unit
 * separately so the UI can render them with distinct typography (e.g.
 * a large number next to a small unit label).
 */
export function formatHashrateParts(
  hs: number | null | undefined,
  baseUnit: string = "H"
): { value: string; unit: string } {
  if (hs === null || hs === undefined) {
    return { value: "—", unit: `${baseUnit}/s` };
  }
  if (hs === 0) {
    return { value: "0", unit: `${baseUnit}/s` };
  }
  const abs = Math.abs(hs);
  const [div, prefix] =
    abs >= 1e12 ? [1e12, "T"]
      : abs >= 1e9 ? [1e9, "G"]
        : abs >= 1e6 ? [1e6, "M"]
          : abs >= 1e3 ? [1e3, "K"]
            : [1, ""];
  const v = hs / div;
  // Two decimals for sub-1000 of base unit; one for 10–99; integer for ≥100
  const fracs = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return { value: v.toFixed(fracs), unit: `${prefix}${baseUnit}/s` };
}

/**
 * Map a mining algorithm name to the conventional hashrate unit symbol.
 * Equihash and Equihash-derivative algorithms (BeamHash) report in
 * Sol/s (solutions/sec); everything else uses H/s (hashes/sec).
 *
 * PwndaWallet currently ships only RandomX / KawPow / Octopus, all of
 * which are H/s — the Sol/s branch is here so a future Equihash
 * adapter (Zcash, Beam, Aleo) gets the right unit label automatically.
 */
export function algorithmHashUnit(algo: string | null | undefined): string {
  if (!algo) return "H";
  const a = algo.toLowerCase();
  if (a.startsWith("equihash") || a.startsWith("beamhash") || a === "zhash") {
    return "Sol";
  }
  return "H";
}

/** "12s ago", "3m ago", "1h ago", "2d ago". Null in → "never". */
export function formatRelative(unixSecs: number | null | undefined, now = Date.now() / 1000): string {
  if (unixSecs === null || unixSecs === undefined || unixSecs <= 0) return "never";
  const delta = Math.max(0, Math.floor(now - unixSecs));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}
