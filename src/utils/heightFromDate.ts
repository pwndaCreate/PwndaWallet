/**
 * Calendar time → block height, for a wallet's restore height ("created
 * around"). Scanning starts at the returned height, so a height that is too
 * LOW only costs sync time, while one that is too HIGH hides funds. Both
 * callers therefore bias the time back (30 days here, one polyseed step in
 * `polyseed.ts`) before converting.
 *
 * Monero did NOT always have 2-minute blocks. It ran 60-second blocks from
 * genesis until the v2 hard fork at height 1,009,827 (2016-03-23). Until
 * 2026-09-13 this file (and `polyseed.ts`) divided the whole span since
 * genesis by 120 s, which puts every post-2016 date roughly 505,000 blocks
 * too early — at a typical 25–50 blocks/s that is 3–6 extra hours of scanning
 * blocks the wallet cannot own outputs in. See PwndaWalletVault/log.md
 * 2026-09-13.
 *
 * The conversion is piecewise-linear through real (height, timestamp) pairs,
 * read from xmrchain.net's block API on 2026-09-13, and extends at 120 s per
 * block past the last anchor.
 */
const MONERO_ANCHORS: ReadonlyArray<readonly [height: number, unix: number]> = [
  [0, 1397818193], // launch, 2014-04-18 (the genesis block itself carries timestamp 0)
  [1009827, 1458748658], // v2 hard fork, 2016-03-23 — 60 s → 120 s blocks
  [3000000, 1697813342], // 2023-10-20
];
const MONERO_BLOCK_SEC = 120;

// Unverified against an explorer (none reachable 2026-09-13); Zephyr has had
// 120 s blocks since launch, so the single-segment form is the right shape.
const ZEPHYR_GENESIS = 1685664000;
const ZEPHYR_BLOCK_SEC = 120;
const SAFETY_MARGIN_SEC = 30 * 86400;

/** Approximate Monero height at `unix` seconds. No safety margin applied. */
export function moneroHeightAtUnix(unix: number): number {
  if (!Number.isFinite(unix)) return 0;
  const [h0, t0] = MONERO_ANCHORS[0];
  if (unix <= t0) return h0;
  for (let i = 1; i < MONERO_ANCHORS.length; i++) {
    const [hPrev, tPrev] = MONERO_ANCHORS[i - 1];
    const [h, t] = MONERO_ANCHORS[i];
    if (unix < t) {
      return Math.floor(hPrev + ((unix - tPrev) * (h - hPrev)) / (t - tPrev));
    }
  }
  const [hLast, tLast] = MONERO_ANCHORS[MONERO_ANCHORS.length - 1];
  return Math.floor(hLast + (unix - tLast) / MONERO_BLOCK_SEC);
}

function parseDate(dateStr: string): number | null {
  const t = Date.parse(dateStr + "T00:00:00Z");
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function dateStringToMoneroHeight(dateStr: string): number {
  if (!dateStr) return 0;
  const unix = parseDate(dateStr);
  if (unix === null) return 0;
  return moneroHeightAtUnix(unix - SAFETY_MARGIN_SEC);
}

export function dateStringToZephyrHeight(dateStr: string): number {
  if (!dateStr) return 0;
  const unix = parseDate(dateStr);
  if (unix === null) return 0;
  const biased = unix - SAFETY_MARGIN_SEC;
  return Math.max(0, Math.floor((biased - ZEPHYR_GENESIS) / ZEPHYR_BLOCK_SEC));
}
