import type { InkPt, Pt } from '../types';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Ramer-Douglas-Peucker.
 *
 * `tol` must be expressed in the same space as the points. Callers working in
 * screen pixels pass `pixelTolerance * viewport.scale` so that a stroke drawn
 * at 300% zoom keeps the same density of points as one drawn at 100%.
 */
export function simplify(pts: InkPt[], tol = 0.7): InkPt[] {
  if (pts.length < 3) return pts;
  const sq = tol * tol;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];

  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = 0;
    let idx = -1;
    const ax = pts[a].x;
    const ay = pts[a].y;
    const dx = pts[b].x - ax;
    const dy = pts[b].y - ay;
    const len = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let t = len ? ((pts[i].x - ax) * dx + (pts[i].y - ay) * dy) / len : 0;
      t = clamp(t, 0, 1);
      const ex = ax + t * dx - pts[i].x;
      const ey = ay + t * dy - pts[i].y;
      const d = ex * ex + ey * ey;
      if (d > best) {
        best = d;
        idx = i;
      }
    }
    if (best > sq && idx > 0) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Variable-width stroke geometry. Mirrors server/src/lib/ink.js exactly.
 * src/test/ink-parity.test.ts imports both and asserts they agree, so drift
 * fails a test instead of silently making exports look different on paper.
 */
export function strokeOutline(pts: InkPt[], baseWidth: number): string {
  if (!pts.length) return '';

  if (pts.length === 1) {
    const p = pts[0];
    const r = (baseWidth * clamp(p.p ?? 0.5, 0.15, 1)) / 2;
    return `M ${p.x - r} ${p.y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
  }

  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[i - 1] || pts[i];
    const next = pts[i + 1] || pts[i];
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const r = (baseWidth * clamp(pts[i].p ?? 0.5, 0.15, 1)) / 2;
    left.push({ x: pts[i].x - dy * r, y: pts[i].y + dx * r });
    right.push({ x: pts[i].x + dy * r, y: pts[i].y - dx * r });
  }

  const out = [`M ${left[0].x} ${left[0].y}`, ...curveThrough(left)];
  const back = right.slice().reverse();
  out.push(`L ${back[0].x} ${back[0].y}`, ...curveThrough(back));
  out.push('Z');
  return out.join(' ');
}

/**
 * Runs a smooth curve along a list of points instead of joining them with
 * straight segments. Each original point becomes the control point of a
 * quadratic that passes through the midpoints either side of it, which is what
 * turns a hand-drawn polyline into something that reads as a single stroke.
 *
 * Mirrored in server/src/lib/ink.js. Change one, change both.
 */
function curveThrough(pts: Pt[]): string[] {
  if (pts.length < 3) return pts.slice(1).map((p) => `L ${p.x} ${p.y}`);
  const out: string[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    out.push(`Q ${pts[i].x} ${pts[i].y} ${mx} ${my}`);
  }
  const last = pts[pts.length - 1];
  out.push(`L ${last.x} ${last.y}`);
  return out;
}

/** Pen hardware reports real pressure. Mouse and touch report 0 or a flat 0.5. */
export function normalizePressure(e: { pressure: number; pointerType: string }): number {
  if (e.pointerType === 'pen' && e.pressure > 0) return clamp(e.pressure, 0.05, 1);
  return 0.5;
}
