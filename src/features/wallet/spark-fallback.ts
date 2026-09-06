/**
 * Per-asset placeholder spark — a deterministic curve seeded from the
 * asset's ticker, used ONLY while real price history hasn't loaded yet (or a
 * fetch genuinely failed). Different assets get visibly different shapes
 * instead of one shared flat/zigzag placeholder — fixing both the "all
 * charts look identical across assets" and the "portrait charts are flat"
 * complaints with one shared implementation so portrait (AccountCard) and
 * landscape (WalletLandscapeView) behave identically.
 *
 * `MiniSpark` normalises by min/max, so only the SHAPE matters here — the
 * absolute values are irrelevant. Real history (batch-loaded in
 * `usd-prices.ts`) replaces this the moment it arrives.
 */
export function placeholderSparkFor(seed: string): number[] {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  const rand = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 0xffffffff;
  };
  const out: number[] = [];
  let v = 50;
  for (let i = 0; i < 16; i++) {
    v += (rand() - 0.45) * 12;
    out.push(Math.max(1, v));
  }
  return out;
}
