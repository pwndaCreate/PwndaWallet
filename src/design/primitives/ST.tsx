/**
 * <ST> — scramble-on-mount text wrapper + the two scramble hooks.
 *
 * See src/design/BEHAVIORS.md — "Scramble decode-on-mount" and
 * "Scramble-on-hover" rows. Apply selectively: titles, hero numbers,
 * section eyebrow labels, mining status. NOT asset rows.
 *
 * Per-row stagger for lists: <ST delay={base + idx * 55} speed={20} />
 */

import {
  CSSProperties,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { tokens } from "../tokens";

export const GLITCH_CHARS =
  "!<>-_\\/[]{}—=+*^?#@$%&|~`0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function useLoadScramble(
  text: string,
  {
    delay = 0,
    speed = tokens.motion.scramble.mount.speed,
  }: { delay?: number; speed?: number } = {}
) {
  const [display, setDisplay] = useState(() =>
    text
      .split("")
      .map((c) =>
        c === " "
          ? " "
          : GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)]
      )
      .join("")
  );
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const chars = text.split("");
    const total = chars.length;
    let iter = 0;
    let last = 0;
    const lockRate = tokens.motion.scramble.mount.lockRate;

    const tick = (ts: number) => {
      if (ts - last < speed) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      last = ts;
      const locked = Math.floor(iter / lockRate);
      setDisplay(
        chars
          .map((c, i) => {
            if (c === " ") return " ";
            if (i < locked) return c;
            return GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
          })
          .join("")
      );
      iter++;
      if (locked < total) frameRef.current = requestAnimationFrame(tick);
      else setDisplay(text);
    };

    const t = window.setTimeout(() => {
      frameRef.current = requestAnimationFrame(tick);
    }, delay);
    return () => {
      clearTimeout(t);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [text, delay, speed]);

  return display;
}

export function useScramble(text: string) {
  const [display, setDisplay] = useState(text);
  const [active, setActive] = useState(false);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  const scramble = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    iterRef.current = 0;
    setActive(true);
    const chars = text.split("");
    const total = chars.length;
    const SPEED = tokens.motion.scramble.hover.speed;
    const lockRate = tokens.motion.scramble.hover.lockRate;
    let last = 0;

    const tick = (ts: number) => {
      if (ts - last < SPEED) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      last = ts;
      const locked = Math.floor(iterRef.current / lockRate);
      const next = chars
        .map((c, i) => {
          if (c === " ") return " ";
          if (i < locked) return c;
          return GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
        })
        .join("");
      setDisplay(next);
      iterRef.current++;
      if (locked < total) frameRef.current = requestAnimationFrame(tick);
      else {
        setDisplay(text);
        setActive(false);
      }
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [text]);

  const reset = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    setDisplay(text);
    setActive(false);
  }, [text]);

  useEffect(() => {
    setDisplay(text);
  }, [text]);
  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  return { display, active, scramble, reset };
}

export function ST({
  children,
  delay = 0,
  speed = tokens.motion.scramble.mount.speed,
  color,
  style,
  block = false,
}: {
  children: ReactNode;
  delay?: number;
  speed?: number;
  color?: string;
  style?: CSSProperties;
  block?: boolean;
}) {
  const text = String(children ?? "");
  const display = useLoadScramble(text, { delay, speed });
  return (
    <span
      style={{
        fontFamily: "inherit",
        fontSize: "inherit",
        letterSpacing: "inherit",
        display: block ? "block" : "inline",
        color,
        ...style,
      }}
    >
      {display}
    </span>
  );
}
