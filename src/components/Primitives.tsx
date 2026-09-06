/**
 * src/components/Primitives.tsx — back-compat barrel.
 *
 * The real implementations live under `src/design/primitives/` and
 * `src/design/shell/`. This file is a re-export shim so existing
 * imports like `import { Card, Btn, ST } from "../components/Primitives"`
 * continue to compile. New code should import from `src/design/`
 * directly.
 *
 * Dead v1 components (`ScrambleBtn`, `PixelScrambleBtn`, `TitlebarBrand`)
 * are NOT re-exported — they had zero JSX call sites as of 2026-05-15
 * and are removed. Any future hit on those names should be migrated to
 * <Btn> or <TitleBar>.
 */

export {
  ST,
  useScramble,
  useLoadScramble,
  GLITCH_CHARS,
  Dot,
  Glow,
  PwndaWordmark,
  Mono,
  Px,
  Card,
  AsciiDivider,
  MiniSpark,
  ProgressBar,
  BlinkCursor,
  Btn,
  Box,
} from "../design/primitives";

export { TitleBar, BottomNav, Panel } from "../design/shell";

export type { BtnVariant, BtnSize } from "../design/primitives";
export type { TabId } from "../design/shell";
