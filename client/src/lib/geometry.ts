import type { Annotation, Box, InkPt, Pt, Rect } from '../types';

/**
 * The whole coordinate contract lives here.
 *
 * Stored:  PDF user space. Points, origin bottom-left, unrotated.
 * Drawn:   viewport space. CSS pixels, origin top-left, rotation applied.
 *
 * pdf.js owns the transform between them via the viewport returned by
 * page.getViewport({ scale, rotation }). Because page rotation is baked into
 * that viewport, annotations rotate with their page for free and nothing
 * stored ever needs migrating.
 */

export function toPdf(vp: any, x: number, y: number): Pt {
  const [px, py] = vp.convertToPdfPoint(x, y);
  return { x: px, y: py };
}

export function toView(vp: any, x: number, y: number): Pt {
  const [vx, vy] = vp.convertToViewportPoint(x, y);
  return { x: vx, y: vy };
}

/** Two viewport-space corners in, one normalized PDF-space rect out. */
export function rectToPdf(vp: any, a: Pt, b: Pt): Rect {
  const p1 = toPdf(vp, a.x, a.y);
  const p2 = toPdf(vp, b.x, b.y);
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y),
  };
}

/** PDF rect to a CSS box for absolute positioning inside the page shell. */
export function rectToBox(vp: any, r: Rect): Box {
  const a = toView(vp, r.x, r.y + r.h);
  const b = toView(vp, r.x + r.w, r.y);
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * How much the document is being magnified on screen, over and above its zoom.
 * A pinch scales the whole page through one CSS transform, so everything drawn
 * on it grows together without anything re-rendering, but a rectangle measured
 * off the screen then comes back that many times too big.
 *
 * Module level rather than a prop because it has to be readable from a pointer
 * handler at the moment the event arrives, the same way `pageViewports` is.
 */
let magnified = 1;
export const setMagnified = (m: number) => {
  magnified = m;
};
export const magnification = () => magnified;

/**
 * Where a pointer is inside an element, in that element's own unmagnified
 * pixels. The rectangle comes back magnified, so the offset does too, and it is
 * divided back out here rather than at each of the dozen places that ask.
 */
export function localPoint(el: HTMLElement, e: { clientX: number; clientY: number }): Pt {
  const r = el.getBoundingClientRect();
  return { x: (e.clientX - r.left) / magnified, y: (e.clientY - r.top) / magnified };
}

export const NOTE_SIZE = 16;
/**
 * A flag marks a hard part of the page. Like a note it is a point rather than a
 * box, so it keeps one size whatever it is dropped on.
 */
export const FLAG_SIZE = 18;

/** Bounding box in PDF user space, whatever the annotation's shape. */
export function bboxOf(a: Annotation): Rect {
  if (a.type === 'ink') {
    const pts: InkPt[] = a.data?.points || [];
    if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = (a.style?.width ?? 2) / 2;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  if (a.type === 'note') return { x: a.data.x, y: a.data.y, w: NOTE_SIZE, h: NOTE_SIZE };
  if (a.type === 'flag') return { x: a.data.x, y: a.data.y, w: FLAG_SIZE, h: FLAG_SIZE };
  return { x: a.data.x, y: a.data.y, w: a.data.w, h: a.data.h };
}

export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** A guide line drawn at the coordinate that was actually matched. */
export type Guide = { axis: 'x' | 'y'; at: number };

/**
 * Snap a dragged rect to the edges and centers of its neighbours, plus the
 * page center. `tol` is in PDF points, so callers divide their pixel
 * tolerance by the current scale.
 *
 * The returned guides sit on the matched target coordinate, not on the moved
 * rect's left edge, so the line always appears where the alignment happened.
 */
export function computeSnap(
  moving: Rect,
  others: Rect[],
  page: { width: number; height: number },
  tol: number
): { dx: number; dy: number; guides: Guide[] } {
  const xTargets = [page.width / 2];
  const yTargets = [page.height / 2];
  for (const o of others) {
    xTargets.push(o.x, o.x + o.w / 2, o.x + o.w);
    yTargets.push(o.y, o.y + o.h / 2, o.y + o.h);
  }

  const xEdges = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const yEdges = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];

  let dx = 0;
  let dy = 0;
  let bestX = tol;
  let bestY = tol;
  let hitX: number | null = null;
  let hitY: number | null = null;

  for (const edge of xEdges) {
    for (const t of xTargets) {
      const d = Math.abs(t - edge);
      if (d < bestX) {
        bestX = d;
        dx = t - edge;
        hitX = t;
      }
    }
  }
  for (const edge of yEdges) {
    for (const t of yTargets) {
      const d = Math.abs(t - edge);
      if (d < bestY) {
        bestY = d;
        dy = t - edge;
        hitY = t;
      }
    }
  }

  const guides: Guide[] = [];
  if (hitX !== null) guides.push({ axis: 'x', at: hitX });
  if (hitY !== null) guides.push({ axis: 'y', at: hitY });
  return { dx, dy, guides };
}

/**
 * Turns a point about another point, degrees counter-clockwise, matching how
 * `rotation` is stored on an annotation.
 */
export function rotatePoint(p: Pt, about: Pt, deg: number): Pt {
  if (!deg) return { x: p.x, y: p.y };
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos };
}

/** The one box that contains every rect given, or null for an empty list. */
export function unionBox(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Scales an annotation about a fixed origin, in PDF user space.
 *
 * The origin is the corner of the selection that stays put, so dragging the
 * bottom-right handle pins the top-left. Notes keep their fixed size and only
 * their anchor moves; everything else scales its box as well as its position.
 */
export function scaleData(type: string, data: any, o: Pt, sx: number, sy: number) {
  const px = (v: number) => o.x + (v - o.x) * sx;
  const py = (v: number) => o.y + (v - o.y) * sy;

  if (type === 'ink')
    return {
      ...data,
      points: (data.points || []).map((p: InkPt) => ({ ...p, x: px(p.x), y: py(p.y) })),
    };
  // A note and a flag are points with a fixed size, so scaling only moves them.
  if (type === 'note' || type === 'flag') return { ...data, x: px(data.x), y: py(data.y) };

  const out = { ...data, x: px(data.x), y: py(data.y), w: data.w * sx, h: data.h * sy };
  // A highlight spanning several lines carries one box per line. They scale
  // with the whole, so the group stays a single annotation.
  if (Array.isArray(data.rects))
    out.rects = data.rects.map((r: Rect) => ({
      x: px(r.x),
      y: py(r.y),
      w: r.w * sx,
      h: r.h * sy,
    }));
  return out;
}

/** Geometry lives in a different shape per type, so moving is centralized. */
export function translate(type: string, data: any, dx: number, dy: number) {
  if (type === 'ink')
    return {
      ...data,
      points: (data.points || []).map((p: InkPt) => ({ ...p, x: p.x + dx, y: p.y + dy })),
    };
  const out = { ...data, x: data.x + dx, y: data.y + dy };
  // Every line box of a multi-line highlight travels with its group.
  if (Array.isArray(data.rects))
    out.rects = data.rects.map((r: Rect) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  return out;
}
