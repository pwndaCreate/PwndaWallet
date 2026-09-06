import type { ComponentType } from "react";
import type { FeatureFocus } from "./featureFocus";
import type { View } from "../types/view";
import type { LandscapeTab } from "../features/landscape/LandscapeShell";

/**
 * Feature manifest — design-time contract that every user-reachable
 * feature satisfies. Adding a manifest entry forces you to think about
 * both layouts at once, which is the whole point.
 *
 * Status: **scaffold**. The runtime currently mounts features through
 * the hand-written branches in `App.tsx`. The manifest exists so:
 *
 *   1. New features can be authored as one entry rather than two
 *      mount sites + a parity-matrix row.
 *   2. The eventual conversion of App.tsx to iterate over a manifest
 *      list (rather than chained ifs) has somewhere to land.
 *   3. Running checks against `ALL_FEATURES` can detect an entry that
 *      forgot a portrait or landscape mount before it ships.
 *
 * For now the only consumer is documentation + the parity-matrix lint
 * (future). The runtime mount in App.tsx still uses bespoke branches.
 *
 * Source-of-truth doc: [[layout-parity-plan]] §2c, [[feature-parity-matrix]].
 */
export interface FeatureManifest<P = unknown> {
  /** Unique kebab-case id used by the parity matrix. */
  id: string;
  /** Display name for matrix / debug. */
  name: string;
  /** What focus this feature owns when mounted. */
  focus: FeatureFocus;
  /** Portrait route value (`view` enum). Null for landscape-only features. */
  portraitView: View | null;
  /** Landscape sidebar tab. Null for portrait-only or sub-views. */
  landscapeTab: LandscapeTab | null;
  /**
   * Where the user enters this feature from in each layout. Free-form
   * description used by `feature-parity-matrix.md` and the future
   * lint check. `"by-design-omitted"` when one mode intentionally
   * lacks the feature (e.g. Activity is landscape-only).
   */
  portraitEntry: string;
  landscapeEntry: string;
  /** Component used when mounted in portrait. Null when portrait-omitted. */
  PortraitComponent?: ComponentType<P> | null;
  /** Component used when mounted in landscape. Null when landscape-omitted. */
  LandscapeComponent?: ComponentType<P> | null;
}

/**
 * Example manifest entry for the Mining feature. Demonstrates how every
 * future feature should be authored — one source of truth that names
 * both layouts. Existing features will be back-filled into manifests in
 * a later refactor without disrupting the current App.tsx mount sites.
 */
export const MINING_FEATURE: FeatureManifest = {
  id: "mining",
  name: "Mining (live console)",
  focus: "mining",
  portraitView: "mining",
  landscapeTab: "mine",
  portraitEntry: "BottomNav `mine` → setView('mining')",
  landscapeEntry: "Sidebar `mine` tab → focus derives 'mining'",
  // PortraitComponent / LandscapeComponent left undefined here — the
  // existing App.tsx branches still own the mount. Future PRs that wire
  // a manifest-driven router fill these in.
};

/**
 * The single list of features. Append a new manifest here when you ship
 * a new user-facing feature. The future parity-matrix lint will diff
 * this against the wiki page and fail CI on drift.
 */
export const ALL_FEATURES: FeatureManifest[] = [
  MINING_FEATURE,
  // TODO: backfill remaining features as they're touched. Order matches
  // the parity-matrix wiki page so audit-time is straight-forward.
];
