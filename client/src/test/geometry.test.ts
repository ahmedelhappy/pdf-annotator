import { describe, expect, it } from 'vitest';
import {
  bboxOf, computeSnap, FLAG_SIZE, intersects, NOTE_SIZE, rectToBox, rectToPdf,
  rotatePoint, scaleData, toPdf, toView, translate, unionBox,
} from '../lib/geometry';
import type { Annotation } from '../types';

/**
 * A stand-in for the pdf.js viewport implementing the same affine transform,
 * so these tests exercise our composition of it rather than re-testing pdf.js.
 * transform is [a, b, c, d, e, f] applied as x' = a*x + c*y + e.
 */
function fakeViewport(scale: number, height = 800, rotation = 0) {
  const width = 600;
  const t =
    rotation === 90
      ? [0, scale, scale, 0, 0, 0]
      : [scale, 0, 0, -scale, 0, height * scale];
  return {
    scale,
    width: rotation === 90 ? height * scale : width * scale,
    height: rotation === 90 ? width * scale : height * scale,
    convertToViewportPoint(x: number, y: number) {
      return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
    },
    convertToPdfPoint(x: number, y: number) {
      const det = t[0] * t[3] - t[1] * t[2];
      const px = x - t[4];
      const py = y - t[5];
      return [(px * t[3] - py * t[2]) / det, (py * t[0] - px * t[1]) / det];
    },
  };
}

describe('coordinate round trips', () => {
  for (const scale of [0.5, 1, 1.25, 3]) {
    it(`survives a round trip at ${scale}x`, () => {
      const vp = fakeViewport(scale);
      for (const [x, y] of [[0, 0], [17.5, 233.25], [595, 842]]) {
        const v = toView(vp, x, y);
        const back = toPdf(vp, v.x, v.y);
        expect(back.x).toBeCloseTo(x, 6);
        expect(back.y).toBeCloseTo(y, 6);
      }
    });
  }

  it('survives a round trip on a rotated page', () => {
    const vp = fakeViewport(1.5, 800, 90);
    const v = toView(vp, 100, 250);
    const back = toPdf(vp, v.x, v.y);
    expect(back.x).toBeCloseTo(100, 6);
    expect(back.y).toBeCloseTo(250, 6);
  });

  it('gives the same PDF rect no matter which corners are dragged', () => {
    const vp = fakeViewport(1.25);
    const a = { x: 40, y: 60 };
    const b = { x: 180, y: 200 };
    const forward = rectToPdf(vp, a, b);
    const backward = rectToPdf(vp, b, a);
    expect(forward).toEqual(backward);
    expect(forward.w).toBeGreaterThan(0);
    expect(forward.h).toBeGreaterThan(0);
  });

  it('places a stored rect at the same spot after a zoom change', () => {
    const rect = { x: 100, y: 500, w: 120, h: 40 };
    const a = rectToBox(fakeViewport(1), rect);
    const b = rectToBox(fakeViewport(2), rect);
    // doubling the scale doubles every screen measurement
    expect(b.left).toBeCloseTo(a.left * 2, 6);
    expect(b.width).toBeCloseTo(a.width * 2, 6);
    expect(b.height).toBeCloseTo(a.height * 2, 6);
  });
});

describe('bounding boxes', () => {
  const ink = {
    _id: '1', documentId: 'd', pageIndex: 0, type: 'ink',
    data: { points: [{ x: 10, y: 20 }, { x: 60, y: 5 }, { x: 30, y: 90 }] },
    style: { color: '#000', width: 4, opacity: 1, fontSize: 14 },
  } as Annotation;

  it('wraps every ink point plus half the stroke width', () => {
    const b = bboxOf(ink);
    expect(b.x).toBeCloseTo(8);
    expect(b.y).toBeCloseTo(3);
    expect(b.w).toBeCloseTo(54);
    expect(b.h).toBeCloseTo(89);
  });

  it('returns an empty box for a stroke with no points', () => {
    const b = bboxOf({ ...ink, data: { points: [] } });
    expect(b).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('detects overlap in both directions', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(intersects(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(intersects(a, { x: 20, y: 0, w: 5, h: 5 })).toBe(false);
    expect(intersects({ x: 5, y: 5, w: 10, h: 10 }, a)).toBe(true);
  });
});

describe('translate', () => {
  it('moves every ink point and keeps pressure', () => {
    const out = translate('ink', { points: [{ x: 1, y: 2, p: 0.7 }] }, 10, -5);
    expect(out.points[0]).toEqual({ x: 11, y: -3, p: 0.7 });
  });

  it('moves the origin of a rect-shaped annotation', () => {
    const out = translate('image', { x: 5, y: 5, w: 20, h: 10 }, 3, 4);
    expect(out).toEqual({ x: 8, y: 9, w: 20, h: 10 });
  });
});

describe('snapping', () => {
  const page = { width: 600, height: 800 };

  it('pulls a near-miss onto a neighbour edge', () => {
    const moving = { x: 102, y: 300, w: 50, h: 20 };
    const neighbour = { x: 100, y: 500, w: 50, h: 20 };
    const snap = computeSnap(moving, [neighbour], page, 6);
    expect(snap.dx).toBeCloseTo(-2);
  });

  it('leaves a far-away rect alone', () => {
    // 250 keeps every edge clear of both the neighbour and the page centre
    const snap = computeSnap({ x: 250, y: 250, w: 10, h: 10 }, [{ x: 10, y: 10, w: 10, h: 10 }], page, 6);
    expect(snap.dx).toBe(0);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toHaveLength(0);
  });

  it('reports the guide at the matched target, not the moved edge', () => {
    const moving = { x: 102, y: 300, w: 50, h: 20 };
    const snap = computeSnap(moving, [{ x: 100, y: 500, w: 50, h: 20 }], page, 6);
    const xGuide = snap.guides.find((g) => g.axis === 'x');
    expect(xGuide?.at).toBeCloseTo(100);
  });

  it('still shows a guide when a rect is already aligned', () => {
    const snap = computeSnap({ x: 100, y: 10, w: 10, h: 10 }, [{ x: 100, y: 500, w: 10, h: 10 }], page, 6);
    expect(snap.dx).toBe(0);
    expect(snap.guides.some((g) => g.axis === 'x')).toBe(true);
  });

  it('snaps to the page center line', () => {
    // edges at 295 / 298 / 301, so the centre edge is 1pt short of 300
    const snap = computeSnap({ x: 295, y: 10, w: 6, h: 6 }, [], page, 6);
    expect(snap.dx).toBeCloseTo(-1);
    expect(snap.guides.find((g) => g.axis === 'x')?.at).toBeCloseTo(300);
  });
});

describe('unionBox', () => {
  it('returns null for nothing', () => {
    expect(unionBox([])).toBeNull();
  });

  it('wraps every rect given', () => {
    const b = unionBox([
      { x: 10, y: 10, w: 20, h: 20 },
      { x: 50, y: 5, w: 10, h: 40 },
    ])!;
    expect(b).toEqual({ x: 10, y: 5, w: 50, h: 40 });
  });

  it('is the rect itself for a single member', () => {
    const r = { x: 3, y: 4, w: 5, h: 6 };
    expect(unionBox([r])).toEqual(r);
  });
});

describe('scaleData', () => {
  const origin = { x: 100, y: 100 };

  it('leaves geometry untouched at scale 1', () => {
    const d = { x: 120, y: 140, w: 30, h: 10 };
    expect(scaleData('image', d, origin, 1, 1)).toEqual(d);
  });

  it('pins the origin corner', () => {
    const d = { x: 100, y: 100, w: 40, h: 20 };
    const s = scaleData('image', d, origin, 2, 2);
    expect(s.x).toBeCloseTo(100);
    expect(s.y).toBeCloseTo(100);
    expect(s.w).toBeCloseTo(80);
    expect(s.h).toBeCloseTo(40);
  });

  it('moves and grows a box away from the origin', () => {
    const s = scaleData('text', { x: 120, y: 110, w: 10, h: 10 }, origin, 2, 3);
    expect(s.x).toBeCloseTo(140);
    expect(s.y).toBeCloseTo(130);
    expect(s.w).toBeCloseTo(20);
    expect(s.h).toBeCloseTo(30);
  });

  it('scales every ink point and keeps pressure', () => {
    const s = scaleData(
      'ink',
      { points: [{ x: 100, y: 100, p: 0.4 }, { x: 110, y: 120, p: 0.9 }] },
      origin, 2, 0.5
    );
    expect(s.points[0]).toEqual({ x: 100, y: 100, p: 0.4 });
    expect(s.points[1].x).toBeCloseTo(120);
    expect(s.points[1].y).toBeCloseTo(110);
    expect(s.points[1].p).toBe(0.9);
  });

  it('moves a note but never resizes it', () => {
    const s = scaleData('note', { x: 110, y: 120, text: 'hi' }, origin, 3, 3);
    expect(s.x).toBeCloseTo(130);
    expect(s.y).toBeCloseTo(160);
    expect(s.w).toBeUndefined();
    expect(s.text).toBe('hi');
  });

  it('round trips through the inverse scale', () => {
    const d = { x: 137, y: 211, w: 44, h: 19 };
    const up = scaleData('image', d, origin, 2.5, 2.5);
    const back = scaleData('image', up, origin, 1 / 2.5, 1 / 2.5);
    expect(back.x).toBeCloseTo(d.x);
    expect(back.y).toBeCloseTo(d.y);
    expect(back.w).toBeCloseTo(d.w);
    expect(back.h).toBeCloseTo(d.h);
  });
});

describe('multi-line highlights', () => {
  // One annotation, one box per line, bounding box kept in x/y/w/h.
  const lines = {
    x: 10, y: 10, w: 100, h: 40,
    rects: [
      { x: 10, y: 30, w: 100, h: 20 },
      { x: 10, y: 10, w: 60, h: 20 },
    ],
  };

  it('moves every line box with the group', () => {
    const out = translate('highlight', lines, 5, -3);
    expect(out.x).toBe(15);
    expect(out.rects[0]).toEqual({ x: 15, y: 27, w: 100, h: 20 });
    expect(out.rects[1]).toEqual({ x: 15, y: 7, w: 60, h: 20 });
  });

  it('leaves a single box highlight untouched', () => {
    const out = translate('highlight', { x: 1, y: 2, w: 3, h: 4 }, 1, 1);
    expect(out.rects).toBeUndefined();
    expect(out).toEqual({ x: 2, y: 3, w: 3, h: 4 });
  });

  it('scales every line box with the group', () => {
    const out = scaleData('highlight', lines, { x: 10, y: 10 }, 2, 2);
    expect(out.w).toBeCloseTo(200);
    expect(out.rects[0]).toEqual({ x: 10, y: 50, w: 200, h: 40 });
    expect(out.rects[1]).toEqual({ x: 10, y: 10, w: 120, h: 40 });
  });

  it('keeps the bounding box in step with its lines', () => {
    const out = scaleData('highlight', lines, { x: 10, y: 10 }, 2, 2);
    const union = unionBox(out.rects)!;
    expect(union.x).toBeCloseTo(out.x);
    expect(union.y).toBeCloseTo(out.y);
    expect(union.w).toBeCloseTo(out.w);
    expect(union.h).toBeCloseTo(out.h);
  });
});

describe('rotatePoint', () => {
  const o = { x: 100, y: 100 };

  it('leaves a point alone at zero degrees', () => {
    expect(rotatePoint({ x: 5, y: 7 }, o, 0)).toEqual({ x: 5, y: 7 });
  });

  it('keeps the centre of rotation fixed', () => {
    const p = rotatePoint(o, o, 53);
    expect(p.x).toBeCloseTo(o.x);
    expect(p.y).toBeCloseTo(o.y);
  });

  it('turns a quarter circle counter-clockwise', () => {
    const p = rotatePoint({ x: 110, y: 100 }, o, 90);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(110);
  });

  it('undoes itself with the opposite angle', () => {
    const start = { x: 137, y: 42 };
    const there = rotatePoint(start, o, 37);
    const back = rotatePoint(there, o, -37);
    expect(back.x).toBeCloseTo(start.x);
    expect(back.y).toBeCloseTo(start.y);
  });

  it('preserves distance from the centre', () => {
    const start = { x: 130, y: 140 };
    const d0 = Math.hypot(start.x - o.x, start.y - o.y);
    const p = rotatePoint(start, o, 200);
    expect(Math.hypot(p.x - o.x, p.y - o.y)).toBeCloseTo(d0);
  });
});

/**
 * A flag is a point with a fixed size, like a note: it marks a hard part of a
 * page rather than covering an area, so nothing may give it a width of its own.
 */
describe('a flag is a point, not a box', () => {
  const flag = { type: 'flag', data: { x: 100, y: 200 } } as unknown as Annotation;

  it('has a box of its own fixed size', () => {
    expect(bboxOf(flag)).toEqual({ x: 100, y: 200, w: FLAG_SIZE, h: FLAG_SIZE });
  });

  it('is a size of its own, not a note size', () => {
    expect(FLAG_SIZE).not.toBe(NOTE_SIZE);
  });

  it('moves rather than stretches when it is scaled', () => {
    const out = scaleData('flag', flag.data, { x: 0, y: 0 }, 2, 3);
    expect(out).toEqual({ x: 200, y: 600 });
    expect(out.w).toBeUndefined();
    expect(out.h).toBeUndefined();
  });

  it('translates like anything else', () => {
    expect(translate('flag', flag.data, 5, -7)).toEqual({ x: 105, y: 193 });
  });

  it('keeps its size at any scale, so its frame stays over it', () => {
    const big = scaleData('flag', flag.data, { x: 0, y: 0 }, 10, 10);
    expect(bboxOf({ type: 'flag', data: big } as unknown as Annotation).w).toBe(FLAG_SIZE);
  });
});
