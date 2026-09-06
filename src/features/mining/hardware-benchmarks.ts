/**
 * Hardware benchmark database — Phase 2 of the device-prediction work.
 *
 * Static seed dataset mapping `(device_model, algorithm)` → expected
 * H/s. Sourced from public benchmarks at hashrate.no, minerstat.com,
 * the xmrig RandomX hashrate thread, and SRBMiner / lolMiner release
 * notes (collected ~2026-04-30; numbers will drift with driver +
 * algorithm updates).
 *
 * The lookup is fuzzy — `lookupHashrate(name, algo)` strips trademark
 * decorations (`(R)`, `(TM)`, `Generation`, etc.), normalises spacing,
 * and tries an exact match first, then an architecture-class fallback
 * (e.g. any unknown "RTX 50xx Ti" gets the median of the family). The
 * fallback returns `confidence: "class"`; an exact hit returns
 * `confidence: "exact"`. Truly unknown devices get
 * `confidence: "unknown"` and a null hashrate so the UI can render `—`
 * with a "Calibrate" CTA.
 */

import type { ChainType } from "../../wallets";

export type BenchAlgorithm = "randomx" | "kawpow" | "octopus";
export type Confidence = "exact" | "class" | "calibrated" | "unknown";

/* ─────────── CPU table ─────────────────────────────────────────────
   RandomX hashrates at **stock configuration, no MSR mod, default
   xmrig auto-config**. These match what most users see on first run
   without any tuning. Tuned boxes (MSR mod applied, huge pages, P-
   cores-only, dialed memory timings) routinely hit 1.5–2× these
   numbers — calibration via the Mine Setup panel will overwrite the
   prediction with the user's actual measurement.
   Calibrated 2026-04-30 against Kryptex's 13900K = 11.75 KH/s figure.
   ───────────────────────────────────────────────────────────────── */

export const CPU_BENCHMARKS: Record<
  string,
  Partial<Record<BenchAlgorithm, number>>
> = {
  // Intel — Raptor Lake / Raptor Lake Refresh (13th & 14th gen)
  "Intel Core i9-14900K":   { randomx: 12_500 },
  "Intel Core i9-14900KS":  { randomx: 13_000 },
  "Intel Core i9-13900K":   { randomx: 11_750 }, // ← matches Kryptex baseline
  "Intel Core i9-13900KS":  { randomx: 12_200 },
  "Intel Core i7-14700K":   { randomx: 10_500 },
  "Intel Core i7-13700K":   { randomx:  9_500 },
  "Intel Core i5-14600K":   { randomx:  7_500 },
  "Intel Core i5-13600K":   { randomx:  7_000 },
  // Intel — Alder Lake (12th gen)
  "Intel Core i9-12900K":   { randomx: 10_500 },
  "Intel Core i9-12900KS":  { randomx: 11_000 },
  "Intel Core i7-12700K":   { randomx:  8_500 },
  "Intel Core i5-12600K":   { randomx:  6_500 },
  // Intel — older
  "Intel Core i9-11900K":   { randomx:  6_000 },
  "Intel Core i9-10900K":   { randomx:  5_500 },
  // AMD — Zen 4 (Ryzen 7000) — Zen 4 punches above Intel on RandomX
  "AMD Ryzen 9 7950X":      { randomx: 16_500 },
  "AMD Ryzen 9 7950X3D":    { randomx: 14_500 },
  "AMD Ryzen 9 7900X":      { randomx: 13_500 },
  "AMD Ryzen 9 7900":       { randomx: 12_500 },
  "AMD Ryzen 7 7800X3D":    { randomx: 10_500 },
  "AMD Ryzen 7 7700X":      { randomx:  9_500 },
  "AMD Ryzen 5 7600X":      { randomx:  6_500 },
  // AMD — Zen 5 (Ryzen 9000)
  "AMD Ryzen 9 9950X":      { randomx: 17_500 },
  "AMD Ryzen 9 9950X3D":    { randomx: 15_500 },
  "AMD Ryzen 9 9900X":      { randomx: 14_500 },
  "AMD Ryzen 7 9800X3D":    { randomx: 11_000 },
  "AMD Ryzen 7 9700X":      { randomx: 10_000 },
  "AMD Ryzen 5 9600X":      { randomx:  7_500 },
  // AMD — Zen 3 (Ryzen 5000)
  "AMD Ryzen 9 5950X":      { randomx: 15_500 },
  "AMD Ryzen 9 5900X":      { randomx: 11_000 },
  "AMD Ryzen 7 5800X3D":    { randomx: 10_500 },
  "AMD Ryzen 7 5800X":      { randomx:  9_500 },
  "AMD Ryzen 5 5600X":      { randomx:  6_000 },
  // AMD — Zen 2 (Ryzen 3000)
  "AMD Ryzen 9 3950X":      { randomx: 12_500 },
  "AMD Ryzen 9 3900X":      { randomx: 10_500 },
  "AMD Ryzen 7 3700X":      { randomx:  6_500 },
  // Threadripper (PRO + classic) — popular in mining rigs
  "AMD Ryzen Threadripper 7980X":     { randomx: 60_000 },
  "AMD Ryzen Threadripper 7970X":     { randomx: 45_000 },
  "AMD Ryzen Threadripper PRO 7995WX": { randomx: 70_000 },
  "AMD Ryzen Threadripper 3990X":     { randomx: 38_000 },
  "AMD Ryzen Threadripper 3970X":     { randomx: 32_000 },
};

/* ─────────── GPU table ─────────────────────────────────────────────
   Per-card hashrates. Multi-GPU scaling is near-linear for the algos
   we run (KawPoW + Octopus); the JS side multiplies by detected card
   count. KawPoW prefers high memory bandwidth (so high-end Ada beats
   even Hopper here); Octopus is similar but more sensitive to clock.
   ───────────────────────────────────────────────────────────────── */

export const GPU_BENCHMARKS: Record<
  string,
  Partial<Record<BenchAlgorithm, number>>
> = {
  // NVIDIA — Blackwell (RTX 50-series)
  "NVIDIA GeForce RTX 5090":      { kawpow: 70_000_000, octopus: 175_000_000 },
  "NVIDIA GeForce RTX 5080":      { kawpow: 50_000_000, octopus: 110_000_000 },
  "NVIDIA GeForce RTX 5070 Ti":   { kawpow: 40_000_000, octopus:  85_000_000 },
  "NVIDIA GeForce RTX 5070":      { kawpow: 36_000_000, octopus:  75_000_000 },
  "NVIDIA GeForce RTX 5060 Ti":   { kawpow: 25_930_000, octopus:  51_940_000 },
  "NVIDIA GeForce RTX 5060":      { kawpow: 22_500_000, octopus:  45_000_000 },
  // NVIDIA — Ada Lovelace (RTX 40-series)
  "NVIDIA GeForce RTX 4090":      { kawpow: 62_000_000, octopus: 115_000_000 },
  "NVIDIA GeForce RTX 4080 Super":{ kawpow: 50_000_000, octopus:  90_000_000 },
  "NVIDIA GeForce RTX 4080":      { kawpow: 48_000_000, octopus:  85_000_000 },
  "NVIDIA GeForce RTX 4070 Ti Super": { kawpow: 42_000_000, octopus: 75_000_000 },
  "NVIDIA GeForce RTX 4070 Ti":   { kawpow: 40_000_000, octopus:  70_000_000 },
  "NVIDIA GeForce RTX 4070 Super":{ kawpow: 35_000_000, octopus:  65_000_000 },
  "NVIDIA GeForce RTX 4070":      { kawpow: 32_000_000, octopus:  60_000_000 },
  "NVIDIA GeForce RTX 4060 Ti":   { kawpow: 25_000_000, octopus:  52_000_000 },
  "NVIDIA GeForce RTX 4060":      { kawpow: 22_000_000, octopus:  46_000_000 },
  // NVIDIA — Ampere (RTX 30-series)
  "NVIDIA GeForce RTX 3090 Ti":   { kawpow: 53_000_000, octopus: 105_000_000 },
  "NVIDIA GeForce RTX 3090":      { kawpow: 50_000_000, octopus: 100_000_000 },
  "NVIDIA GeForce RTX 3080 Ti":   { kawpow: 47_000_000, octopus:  92_000_000 },
  "NVIDIA GeForce RTX 3080":      { kawpow: 42_000_000, octopus:  85_000_000 },
  "NVIDIA GeForce RTX 3070 Ti":   { kawpow: 35_000_000, octopus:  68_000_000 },
  "NVIDIA GeForce RTX 3070":      { kawpow: 32_000_000, octopus:  62_000_000 },
  "NVIDIA GeForce RTX 3060 Ti":   { kawpow: 28_000_000, octopus:  56_000_000 },
  "NVIDIA GeForce RTX 3060":      { kawpow: 22_000_000, octopus:  46_000_000 },
  "NVIDIA GeForce RTX 3050":      { kawpow: 16_000_000, octopus:  32_000_000 },
  // NVIDIA — Turing
  "NVIDIA GeForce RTX 2080 Ti":   { kawpow: 32_000_000, octopus:  62_000_000 },
  "NVIDIA GeForce RTX 2080 Super":{ kawpow: 28_000_000, octopus:  55_000_000 },
  "NVIDIA GeForce RTX 2070 Super":{ kawpow: 26_000_000, octopus:  50_000_000 },
  "NVIDIA GeForce RTX 2060 Super":{ kawpow: 23_000_000, octopus:  44_000_000 },
  // AMD — RDNA 3 (RX 7000)
  "AMD Radeon RX 7900 XTX":       { kawpow: 38_000_000, octopus: 120_000_000 },
  "AMD Radeon RX 7900 XT":        { kawpow: 34_000_000, octopus: 105_000_000 },
  "AMD Radeon RX 7800 XT":        { kawpow: 32_000_000, octopus:  80_000_000 },
  "AMD Radeon RX 7700 XT":        { kawpow: 28_000_000, octopus:  65_000_000 },
  "AMD Radeon RX 7600 XT":        { kawpow: 18_000_000, octopus:  35_000_000 },
  "AMD Radeon RX 7600":           { kawpow: 15_000_000, octopus:  30_000_000 },
  // AMD — RDNA 3.5 (RX 9000)
  "AMD Radeon RX 9070 XT":        { kawpow: 36_000_000, octopus:  90_000_000 },
  "AMD Radeon RX 9070":           { kawpow: 32_000_000, octopus:  80_000_000 },
  "AMD Radeon RX 9060 XT":        { kawpow: 22_000_000, octopus:  48_000_000 },
  // AMD — RDNA 2 (RX 6000)
  "AMD Radeon RX 6950 XT":        { kawpow: 32_000_000, octopus:  78_000_000 },
  "AMD Radeon RX 6900 XT":        { kawpow: 30_000_000, octopus:  70_000_000 },
  "AMD Radeon RX 6800 XT":        { kawpow: 28_000_000, octopus:  62_000_000 },
  "AMD Radeon RX 6800":           { kawpow: 26_000_000, octopus:  56_000_000 },
  "AMD Radeon RX 6700 XT":        { kawpow: 23_900_000, octopus:  46_340_000 },
  "AMD Radeon RX 6700":           { kawpow: 21_000_000, octopus:  42_000_000 },
  "AMD Radeon RX 6600 XT":        { kawpow: 16_000_000, octopus:  32_000_000 },
  "AMD Radeon RX 6600":           { kawpow: 14_000_000, octopus:  28_000_000 },
  // AMD — RDNA (RX 5000)
  "AMD Radeon RX 5700 XT":        { kawpow: 22_000_000, octopus:  50_000_000 },
  "AMD Radeon RX 5700":           { kawpow: 20_000_000, octopus:  45_000_000 },
  "AMD Radeon RX 5600 XT":        { kawpow: 16_000_000, octopus:  32_000_000 },
};

/* ─────────── Architecture-class fallbacks ──────────────────────────
   When the user has a card we don't have an exact entry for, we
   match against the family name (`RTX 40`, `RX 7`, etc.) and return
   the median of the family. Ordered most-specific first.
   ───────────────────────────────────────────────────────────────── */

interface ClassFallback {
  match: (normalized: string) => boolean;
  bench: Partial<Record<BenchAlgorithm, number>>;
  reason: string;
}

const GPU_CLASS_FALLBACKS: ClassFallback[] = [
  { match: (n) => /\bRTX\s*50/.test(n), bench: { kawpow: 30_000_000, octopus: 65_000_000 }, reason: "Blackwell median" },
  { match: (n) => /\bRTX\s*40/.test(n), bench: { kawpow: 32_000_000, octopus: 65_000_000 }, reason: "Ada median" },
  { match: (n) => /\bRTX\s*30/.test(n), bench: { kawpow: 32_000_000, octopus: 62_000_000 }, reason: "Ampere median" },
  { match: (n) => /\bRTX\s*20/.test(n), bench: { kawpow: 26_000_000, octopus: 50_000_000 }, reason: "Turing median" },
  { match: (n) => /\bRX\s*9\d{3}/.test(n), bench: { kawpow: 28_000_000, octopus: 65_000_000 }, reason: "RDNA 3.5 median" },
  { match: (n) => /\bRX\s*7\d{3}/.test(n), bench: { kawpow: 26_000_000, octopus: 70_000_000 }, reason: "RDNA 3 median" },
  { match: (n) => /\bRX\s*6\d{3}/.test(n), bench: { kawpow: 22_000_000, octopus: 50_000_000 }, reason: "RDNA 2 median" },
  { match: (n) => /\bRX\s*5\d{3}/.test(n), bench: { kawpow: 18_000_000, octopus: 38_000_000 }, reason: "RDNA median" },
];

const CPU_CLASS_FALLBACKS: ClassFallback[] = [
  { match: (n) => /Ryzen\s*9\b/.test(n), bench: { randomx: 13_000 }, reason: "Ryzen 9 median" },
  { match: (n) => /Ryzen\s*7\b/.test(n), bench: { randomx:  9_500 }, reason: "Ryzen 7 median" },
  { match: (n) => /Ryzen\s*5\b/.test(n), bench: { randomx:  6_500 }, reason: "Ryzen 5 median" },
  { match: (n) => /Threadripper/.test(n), bench: { randomx: 38_000 }, reason: "Threadripper median" },
  { match: (n) => /Core\s*i9/.test(n), bench: { randomx: 11_000 }, reason: "i9 median" },
  { match: (n) => /Core\s*i7/.test(n), bench: { randomx:  9_000 }, reason: "i7 median" },
  { match: (n) => /Core\s*i5/.test(n), bench: { randomx:  6_500 }, reason: "i5 median" },
];

/* ─────────── Normalisation + lookup ────────────────────────────────
   WMI returns strings like
   `"13th Gen Intel(R) Core(TM) i9-13900K"`
   and
   `"NVIDIA GeForce RTX 5060 Ti"`.
   We strip trademark decorations + generation prefixes so they match
   the keys in the database above.
   ───────────────────────────────────────────────────────────────── */

export function normalizeDeviceName(raw: string): string {
  return raw
    .replace(/\(R\)|\(TM\)|\(C\)/gi, "") // trademark suffixes
    .replace(/\d+(?:st|nd|rd|th)\s*Gen(?:eration)?\s*/i, "") // "13th Gen"
    .replace(/\s+/g, " ")
    .trim();
}

export interface BenchmarkLookup {
  hashrate: number | null;
  confidence: Confidence;
  reason?: string;
}

export function lookupHashrate(
  rawName: string,
  algo: BenchAlgorithm,
  /** Pass `gpu` to look in the GPU table, `cpu` for the CPU table.
   *  Auto-detects when omitted by checking both. */
  kind?: "cpu" | "gpu"
): BenchmarkLookup {
  const norm = normalizeDeviceName(rawName);
  const tables: Array<{
    table: typeof CPU_BENCHMARKS;
    fallbacks: ClassFallback[];
  }> = [];
  if (!kind || kind === "cpu") {
    tables.push({ table: CPU_BENCHMARKS, fallbacks: CPU_CLASS_FALLBACKS });
  }
  if (!kind || kind === "gpu") {
    tables.push({ table: GPU_BENCHMARKS, fallbacks: GPU_CLASS_FALLBACKS });
  }

  for (const { table, fallbacks } of tables) {
    // Exact (case-insensitive) match against keys.
    for (const [key, bench] of Object.entries(table)) {
      if (key.toLowerCase() === norm.toLowerCase()) {
        const v = bench[algo];
        if (v != null) {
          return { hashrate: v, confidence: "exact" };
        }
      }
    }
    // Substring match — many WMI strings include extra words ("Intel
    // Core i9-13900K Processor"). Walk all keys and pick the longest
    // one fully contained in the normalized name.
    let best: { key: string; bench: Partial<Record<BenchAlgorithm, number>> } | null = null;
    for (const [key, bench] of Object.entries(table)) {
      if (norm.toLowerCase().includes(key.toLowerCase())) {
        if (!best || key.length > best.key.length) {
          best = { key, bench };
        }
      }
    }
    if (best && best.bench[algo] != null) {
      return { hashrate: best.bench[algo]!, confidence: "exact" };
    }
    // Class fallback.
    for (const fb of fallbacks) {
      if (fb.match(norm)) {
        const v = fb.bench[algo];
        if (v != null) {
          return { hashrate: v, confidence: "class", reason: fb.reason };
        }
      }
    }
  }

  return { hashrate: null, confidence: "unknown" };
}

/* ─────────── Coin → algorithm + miner mapping ──────────────────────
   Each chain we mine maps to one algorithm and one miner family. The
   useDeviceProfile hook uses this to figure out which devices can
   mine which coins.
   ───────────────────────────────────────────────────────────────── */

export interface ChainMiningProfile {
  chain: ChainType;
  ticker: string;
  algo: BenchAlgorithm;
  /** Which hardware kinds can run this combo. Drives the device-card
   *  layout: CPU rows show `cpu`-eligible coins, GPU rows show `gpu`. */
  hardware: ("cpu" | "gpu")[];
  /** Miner binary the algo runs on. Used by the calibrate flow to pick
   *  the right `--bench` invocation. */
  miner: "xmrig" | "SRBMiner-MULTI" | "lolMiner";
}

export const CHAIN_MINING_PROFILES: ChainMiningProfile[] = [
  { chain: "monero",    ticker: "XMR",  algo: "randomx", hardware: ["cpu"], miner: "xmrig" },
  { chain: "zephyr",    ticker: "ZEPH", algo: "randomx", hardware: ["cpu"], miner: "xmrig" },
  { chain: "ravencoin", ticker: "RVN",  algo: "kawpow",  hardware: ["gpu"], miner: "SRBMiner-MULTI" },
  { chain: "conflux",   ticker: "CFX",  algo: "octopus", hardware: ["gpu"], miner: "lolMiner" },
];

/** Look up the mining profile for a chain. Returns null for chains
 *  PwndaWallet doesn't mine. */
export function getMiningProfile(chain: ChainType): ChainMiningProfile | null {
  return CHAIN_MINING_PROFILES.find((p) => p.chain === chain) ?? null;
}
