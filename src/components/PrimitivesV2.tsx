/**
 * src/components/PrimitivesV2.tsx — back-compat barrel.
 *
 * Was the v2-primitive source file alongside Primitives.tsx. Both are
 * now barrels over src/design/primitives + src/design/shell. PwndaLite
 * imports Card/Btn from here; the barrel forwards to the real files.
 */

export { Card, Btn, AsciiDivider, MiniSpark, ProgressBar, BlinkCursor } from "../design/primitives";
export { TitleBar } from "../design/shell";
export type { BtnVariant, BtnSize } from "../design/primitives";
