/**
 * src/features/zephyr/zephyrRoutes.ts
 *
 * Which Zephyr assets can convert into which, and via what.
 *
 * # Why this is a table and not a set of `if`s
 *
 * The operator's description is exact: Zephyr conversion "emulate[s] how rock
 * paper scissors works in the manner that you cannot swap certain zeph assets
 * straight to another but sometimes has to be gated through Zusd." Only some
 * pairs are a single on-chain mint/redeem; the rest need two legs through an
 * intermediate. Today that knowledge lives as three hard-coded sentences in
 * `ZephyrSwapModal.tsx` ("ZEPH has no direct path to ZEPHYRS — mint ZEPHUSD
 * first, then stake."), which means the picker can offer a pair the chain will
 * refuse, and nothing else in the app can reason about routing at all.
 *
 * Encoding it once makes it usable by the asset dropdown, by the AUTO
 * aggregator, and by any pre-flight check — and makes a wrong entry a test
 * failure rather than a rejected transaction.
 *
 * # The protocol, from `wiki/entities/Zephyr.md`
 *
 * Four assets. `ZPH` is the base coin; `ZSD` (ZEPHUSD) is the USD-pegged
 * stable; `ZRS` (ZEPHRSV) is the reserve share; `ZYS` (ZEPHYRS) is the
 * yield-bearing wrapper around the stable.
 *
 * Direct, one transaction:
 *   - ZPH ↔ ZSD — mint / redeem stable (0.1%)
 *   - ZPH ↔ ZRS — mint / redeem reserve (1%)
 *   - ZSD ↔ ZYS — stake / unstake yield
 *
 * Everything else needs two legs. The intermediate is whichever asset both
 * ends have a direct edge to:
 *   - ZPH  ↔ ZYS — via ZSD  (mint stable, then stake)
 *   - ZSD  ↔ ZRS — via ZPH  (redeem to base, then mint reserve)
 *   - ZRS  ↔ ZYS — via ZPH then ZSD, so THREE legs
 *
 * Two-leg orchestration is listed as deferred (Phase 3) in
 * `wiki/synthesis/zephyr-ecosystem-swap-plan.md`; this module describes the
 * routes so a surface can explain or sequence them, and does not itself
 * execute anything.
 *
 * # Reserve-ratio gates are NOT encoded here
 *
 * The protocol also halts certain conversions by reserve ratio (>800% blocks
 * ZRS minting; <400% halts ZSD minting and ZRS redemption). Those are
 * live-state gates, not topology, and belong to a pre-flight that reads
 * `get_reserve_info`. A route being STRUCTURALLY possible is not a promise
 * that it is currently permitted, and no caller should read it as one.
 */
import type { ZphAssetType } from "../../wallets/zph-rpc";

/** Pairs the chain converts in a single mint / redeem / stake transaction. */
const DIRECT: ReadonlyArray<readonly [ZphAssetType, ZphAssetType]> = [
  ["ZPH", "ZSD"],
  ["ZPH", "ZRS"],
  ["ZSD", "ZYS"],
];

export type ZephyrLegKind = "mint" | "redeem" | "stake" | "unstake";

export interface ZephyrLeg {
  from: ZphAssetType;
  to: ZphAssetType;
  kind: ZephyrLegKind;
}

export interface ZephyrRoute {
  from: ZphAssetType;
  to: ZphAssetType;
  /** Ordered legs. Length 1 is a direct conversion. */
  legs: ZephyrLeg[];
  /** Assets passed through, excluding the endpoints. */
  via: ZphAssetType[];
}

export function isDirect(from: ZphAssetType, to: ZphAssetType): boolean {
  if (from === to) return false;
  return DIRECT.some(
    ([a, b]) => (a === from && b === to) || (a === to && b === from),
  );
}

/**
 * What this single leg is called, in the protocol's own vocabulary.
 *
 * The verb matters to the user: "stake" and "mint" are different promises, and
 * the modal already switches its CTA between them. Derived rather than stored
 * so a new direct pair cannot arrive with a mislabelled verb.
 */
export function legKind(from: ZphAssetType, to: ZphAssetType): ZephyrLegKind {
  if (from === "ZSD" && to === "ZYS") return "stake";
  if (from === "ZYS" && to === "ZSD") return "unstake";
  // Everything else on the direct list is base-coin mint/redeem: leaving ZPH
  // mints the derived asset, returning to ZPH redeems it.
  return from === "ZPH" ? "mint" : "redeem";
}

/** Neighbours of an asset on the direct graph. */
export function directNeighbours(a: ZphAssetType): ZphAssetType[] {
  const out: ZphAssetType[] = [];
  for (const [x, y] of DIRECT) {
    if (x === a) out.push(y);
    else if (y === a) out.push(x);
  }
  return out;
}

/**
 * The shortest route between two assets, or `null` for a same-asset pair.
 *
 * Breadth-first over the direct graph, so the shortest path is found rather
 * than a hand-written case per pair — which is what keeps ZRS↔ZYS (three legs)
 * correct without anyone having to notice it is three.
 */
export function routeFor(
  from: ZphAssetType,
  to: ZphAssetType,
): ZephyrRoute | null {
  if (from === to) return null;

  const prev = new Map<ZphAssetType, ZphAssetType>();
  const seen = new Set<ZphAssetType>([from]);
  const queue: ZphAssetType[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) break;
    for (const nxt of directNeighbours(cur)) {
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      prev.set(nxt, cur);
      queue.push(nxt);
    }
  }
  if (!seen.has(to)) return null;

  const path: ZphAssetType[] = [to];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (!p) return null;
    path.unshift(p);
    cur = p;
  }

  const legs: ZephyrLeg[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    legs.push({ from: path[i], to: path[i + 1], kind: legKind(path[i], path[i + 1]) });
  }
  return { from, to, legs, via: path.slice(1, -1) };
}

/**
 * A sentence explaining a multi-leg route, for the picker.
 *
 * Replaces the three hard-coded strings in `ZephyrSwapModal.tsx`, which
 * covered only the pairs someone happened to write copy for — ZSD↔ZRS had
 * none, so that pair simply looked available.
 */
export function routeHint(route: ZephyrRoute | null): string | null {
  if (!route || route.legs.length <= 1) return null;
  const names = route.legs.map((l) => l.kind);
  return (
    `No direct path — this runs as ${route.legs.length} transactions ` +
    `(${names.join(" then ")}) via ${route.via.join(" then ")}.`
  );
}

/** Every asset reachable from `from`, with how many legs it takes. */
export function reachableFrom(
  from: ZphAssetType,
  all: readonly ZphAssetType[],
): Array<{ asset: ZphAssetType; legs: number }> {
  return all
    .filter((a) => a !== from)
    .map((a) => ({ asset: a, legs: routeFor(from, a)?.legs.length ?? 0 }))
    .filter((r) => r.legs > 0);
}
