import { useEffect, useRef, type CSSProperties } from "react";

export function DitherCanvas({
  src,
  width = 360,
  height = 120,
  cell = 4,
  color = "#f2f2f2",
  dimColor = "rgba(242,242,242,0.35)",
  glitchRadius = 38,
  blendMode = "screen",
  opacity = 0.75,
  style,
}: {
  src: string;
  width?: number;
  height?: number;
  cell?: number;
  color?: string;
  dimColor?: string;
  glitchRadius?: number;
  blendMode?: string;
  opacity?: number;
  style?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<Uint8Array | null>(null);
  const cursorRef = useRef({ x: -9999, y: -9999, active: false });
  const rafRef = useRef<number | null>(null);
  const tRef = useRef(0);

  const cols = Math.floor(width / cell);
  const rows = Math.floor(height / cell);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const off = document.createElement("canvas");
      off.width = cols;
      off.height = rows;
      const octx = off.getContext("2d")!;
      const ir = img.width / img.height;
      const tr = cols / rows;
      let sw: number, sh: number, sx: number, sy: number;
      if (ir > tr) {
        sh = img.height;
        sw = img.height * tr;
        sx = (img.width - sw) / 2;
        sy = 0;
      } else {
        sw = img.width;
        sh = img.width / tr;
        sx = 0;
        sy = (img.height - sh) / 2;
      }
      octx.drawImage(img, sx, sy, sw, sh, 0, 0, cols, rows);
      const imgData = octx.getImageData(0, 0, cols, rows);
      const data = imgData.data;
      const gray = new Float32Array(cols * rows);
      for (let i = 0; i < cols * rows; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
      const grid = new Uint8Array(cols * rows);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          const old = gray[i];
          const nu = old < 128 ? 0 : 255;
          grid[i] = nu === 255 ? 1 : 0;
          const err = (old - nu) / 8;
          const spread: [number, number][] = [
            [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2],
          ];
          for (const [dx, dy] of spread) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < cols && ny < rows) gray[ny * cols + nx] += err;
          }
        }
      }
      gridRef.current = grid;
    };
    img.src = src;
  }, [src, cols, rows]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onMove = (e: PointerEvent) => {
      const r = wrap.getBoundingClientRect();
      cursorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top, active: true };
    };
    const onLeave = () => {
      cursorRef.current.active = false;
    };
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);
    return () => {
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const render = () => {
      tRef.current += 1;
      const grid = gridRef.current;
      ctx.clearRect(0, 0, width, height);
      if (!grid) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }
      const cur = cursorRef.current;
      const rSq = glitchRadius * glitchRadius;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          let v = grid[y * cols + x];
          const px = x * cell + cell / 2;
          const py = y * cell + cell / 2;
          let dx = 0, dy = 0;
          if (cur.active) {
            const ddx = px - cur.x, ddy = py - cur.y;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < rSq) {
              const falloff = 1 - Math.sqrt(d2) / glitchRadius;
              const ang =
                Math.atan2(ddy, ddx) +
                Math.sin(tRef.current * 0.08 + x * 0.3 + y * 0.2) * 1.5;
              const mag = falloff * cell * 2;
              dx = Math.round(Math.cos(ang) * mag);
              dy = Math.round(Math.sin(ang) * mag);
              if (Math.random() < falloff * 0.45) v = v ? 0 : 1;
              if (!v && Math.random() < falloff * 0.08) v = 1;
            }
          }
          if (v) {
            ctx.fillStyle = color;
            ctx.fillRect(x * cell + dx, y * cell + dy, cell - 1, cell - 1);
          } else {
            if (Math.random() < 0.004) {
              ctx.fillStyle = dimColor;
              ctx.fillRect(x * cell, y * cell, 1, 1);
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [width, height, cell, cols, rows, color, dimColor, glitchRadius]);

  return (
    <div ref={wrapRef} style={{ position: "relative", width, height, ...style }}>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width,
          height,
          mixBlendMode: blendMode as CSSProperties["mixBlendMode"],
          opacity,
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
}
