/**
 * <Dot> — pulsing status indicator with colored halo.
 *
 * See src/design/BEHAVIORS.md — "Status dot pulse" + "Status dot glow halo".
 */

export function Dot({
  color = "green",
  size = 6,
}: {
  color?: "green" | "red" | "amber" | "gray";
  size?: number;
}) {
  const bg =
    color === "green"
      ? "var(--accent)"
      : color === "red"
      ? "var(--danger)"
      : color === "amber"
      ? "var(--warn)"
      : "var(--text-dim)";
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        flexShrink: 0,
        background: bg,
        boxShadow: color === "gray" ? "none" : `0 0 ${size}px ${bg}`,
        animation:
          color === "gray" ? "none" : "pulse 1.4s ease-in-out infinite",
      }}
    />
  );
}
