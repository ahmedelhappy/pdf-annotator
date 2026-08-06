import { describe, expect, it } from 'vitest';
import { normalizePressure, simplify, strokeOutline } from '../lib/ink';
// The server has its own copy for export. If these two drift, exported ink
// stops matching what was drawn on screen, so parity is asserted below.
import { strokeOutline as serverStrokeOutline } from '../../../server/src/lib/ink.js';

describe('simplify', () => {
  it('keeps the endpoints', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
    const out = simplify(pts, 1);
    expect(out[0]).toEqual(pts[0]);
    expect(out.at(-1)).toEqual(pts.at(-1));
  });

  it('collapses a straight line to two points', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
    expect(simplify(pts, 1)).toHaveLength(2);
  });

  it('keeps detail on a jagged line', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i % 2 ? 20 : 0 }));
    expect(simplify(pts, 1).length).toBeGreaterThan(10);
  });

  it('drops more points as tolerance grows', () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ x: i, y: Math.sin(i / 3) * 10 }));
    expect(simplify(pts, 4).length).toBeLessThan(simplify(pts, 0.5).length);
  });

  it('leaves very short strokes untouched', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(simplify(pts, 5)).toHaveLength(2);
  });
});

describe('strokeOutline', () => {
  it('returns nothing for no points', () => {
    expect(strokeOutline([], 3)).toBe('');
  });

  it('draws a dot for a single point', () => {
    const d = strokeOutline([{ x: 10, y: 10, p: 1 }], 4);
    expect(d).toContain('M');
    expect(d.endsWith('Z')).toBe(true);
  });

  it('produces a closed polygon', () => {
    const d = strokeOutline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 5 }], 3);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });

  it('gets wider as pressure rises', () => {
    const light = strokeOutline([{ x: 0, y: 0, p: 0.2 }, { x: 10, y: 0, p: 0.2 }], 10);
    const heavy = strokeOutline([{ x: 0, y: 0, p: 1 }, { x: 10, y: 0, p: 1 }], 10);
    expect(light).not.toBe(heavy);
  });

  it('matches the server copy exactly', () => {
    const cases = [
      [{ x: 0, y: 0, p: 0.3 }, { x: 10, y: 4, p: 0.9 }, { x: 25, y: 1, p: 0.5 }],
      [{ x: 5, y: 5 }],
      [{ x: 1, y: 1 }, { x: 1, y: 1 }],
    ];
    for (const pts of cases) {
      for (const width of [1, 3, 12]) {
        expect(strokeOutline(pts as any, width)).toBe(serverStrokeOutline(pts, width));
      }
    }
  });
});

describe('normalizePressure', () => {
  it('trusts a pen', () => {
    expect(normalizePressure({ pressure: 0.8, pointerType: 'pen' })).toBeCloseTo(0.8);
  });

  it('gives a mouse a constant width', () => {
    expect(normalizePressure({ pressure: 0, pointerType: 'mouse' })).toBe(0.5);
    expect(normalizePressure({ pressure: 0.5, pointerType: 'touch' })).toBe(0.5);
  });

  it('never returns zero for a pen barely touching', () => {
    expect(normalizePressure({ pressure: 0.001, pointerType: 'pen' })).toBeGreaterThan(0);
  });
});

describe('smooth strokes', () => {
  const wiggle = [
    { x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: 0 }, { x: 30, y: 8 }, { x: 40, y: 0 },
  ];

  it('draws curves rather than straight segments', () => {
    const d = strokeOutline(wiggle, 4);
    expect(d).toContain('Q ');
    // one quadratic per interior point, on each side of the stroke
    expect(d.match(/Q /g)!.length).toBe((wiggle.length - 2) * 2);
  });

  it('still closes into a single filled outline', () => {
    expect(strokeOutline(wiggle, 4).trim().endsWith('Z')).toBe(true);
    expect(strokeOutline(wiggle, 4).startsWith('M ')).toBe(true);
  });

  it('keeps two point strokes straight', () => {
    const d = strokeOutline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 4);
    expect(d).not.toContain('Q ');
  });

  it('a single point is still a dot', () => {
    expect(strokeOutline([{ x: 5, y: 5 }], 4)).toContain('a ');
  });

  it('client and server agree on the curved form', () => {
    expect(strokeOutline(wiggle, 4)).toBe(serverStrokeOutline(wiggle, 4));
  });
});
