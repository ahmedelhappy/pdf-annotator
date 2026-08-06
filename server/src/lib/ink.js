// Variable-width stroke geometry.
//
// This file is duplicated at client/src/lib/ink.ts so neither side needs a
// build step to share it. client/src/test/ink-parity.test.ts imports both and
// asserts they agree, so drift fails a test instead of silently changing how
// exports look compared to the screen.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Walks one side of the stroke and back along the other, producing a closed
// polygon whose half-width follows pen pressure at each sample.
export function strokeOutline(pts, baseWidth) {
  if (!pts.length) return '';

  if (pts.length === 1) {
    const p = pts[0];
    const r = (baseWidth * clamp(p.p ?? 0.5, 0.15, 1)) / 2;
    return `M ${p.x - r} ${p.y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
  }

  const left = [];
  const right = [];
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
 * Mirrored in client/src/lib/ink.ts. Change one, change both.
 */
function curveThrough(pts) {
  if (pts.length < 3) return pts.slice(1).map((p) => `L ${p.x} ${p.y}`);
  const out = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    out.push(`Q ${pts[i].x} ${pts[i].y} ${mx} ${my}`);
  }
  const last = pts[pts.length - 1];
  out.push(`L ${last.x} ${last.y}`);
  return out;
}
