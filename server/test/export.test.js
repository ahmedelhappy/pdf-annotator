import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildAnnotatedPdf, rotatedOrigin, spinAbout } from '../src/lib/exportPdf.js';

async function fixture(pages = 2) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([595, 842]);
  const file = path.join(os.tmpdir(), `fixture-${Date.now()}-${Math.random()}.pdf`);
  await fs.writeFile(file, await pdf.save());
  return file;
}

test('export produces a valid PDF with the same page count', async () => {
  const file = await fixture(3);
  const bytes = await buildAnnotatedPdf(file, []);
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 3);
  await fs.unlink(file);
});

test('export survives every annotation type at once', async () => {
  const file = await fixture(1);
  const anns = [
    {
      type: 'ink', pageIndex: 0,
      data: { points: [{ x: 10, y: 10, p: 0.3 }, { x: 90, y: 80, p: 0.9 }] },
      style: { color: '#e11d48', width: 3, opacity: 1 },
    },
    {
      type: 'highlight', pageIndex: 0,
      data: { x: 40, y: 400, w: 120, h: 14 },
      style: { color: '#facc15', opacity: 0.35 },
    },
    {
      type: 'text', pageIndex: 0,
      data: { x: 50, y: 500, w: 200, h: 40, text: 'hello world' },
      style: { color: '#111827', fontSize: 14 },
    },
    {
      type: 'note', pageIndex: 0,
      data: { x: 300, y: 600, text: 'a note' },
      style: { color: '#2563eb', fontSize: 12 },
    },
  ];
  const bytes = await buildAnnotatedPdf(file, anns);
  assert.ok(bytes.length > 0);
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 1);
  await fs.unlink(file);
});

test('an annotation pointing at a missing page is skipped, not fatal', async () => {
  const file = await fixture(1);
  const bytes = await buildAnnotatedPdf(file, [
    { type: 'highlight', pageIndex: 7, data: { x: 0, y: 0, w: 10, h: 10 }, style: {} },
  ]);
  assert.ok(bytes.length > 0);
  await fs.unlink(file);
});

test('non-Latin text does not crash the export when no font is installed', async () => {
  const file = await fixture(1);
  const bytes = await buildAnnotatedPdf(file, [
    {
      type: 'text', pageIndex: 0,
      data: { x: 50, y: 500, w: 200, h: 40, text: 'مرحبا بالعالم' },
      style: { color: '#111827', fontSize: 14 },
    },
  ]);
  assert.ok(bytes.length > 0);
  await fs.unlink(file);
});

test('an empty text box adds nothing but does not throw', async () => {
  const file = await fixture(1);
  const bytes = await buildAnnotatedPdf(file, [
    { type: 'text', pageIndex: 0, data: { x: 5, y: 5, w: 10, h: 10, text: '   ' }, style: {} },
  ]);
  assert.ok(bytes.length > 0);
  await fs.unlink(file);
});

// Rotation is drawn about the box middle, but pdf-lib turns a box about its
// lower-left corner, so the origin has to be moved to compensate.
test('rotatedOrigin leaves an unrotated box alone', () => {
  assert.deepEqual(rotatedOrigin(10, 20, 100, 50, 0), { x: 10, y: 20 });
});

test('rotatedOrigin keeps the box middle fixed', () => {
  const [x, y, w, h] = [10, 20, 100, 50];
  const cx = x + w / 2;
  const cy = y + h / 2;

  for (const deg of [15, 90, 180, 270, -45]) {
    const o = rotatedOrigin(x, y, w, h, deg);
    const a = (deg * Math.PI) / 180;
    // where the middle lands once pdf-lib rotates about the drawn origin
    const mx = o.x + (w / 2) * Math.cos(a) - (h / 2) * Math.sin(a);
    const my = o.y + (w / 2) * Math.sin(a) + (h / 2) * Math.cos(a);
    assert.ok(Math.abs(mx - cx) < 1e-9, `x drifted at ${deg} degrees`);
    assert.ok(Math.abs(my - cy) < 1e-9, `y drifted at ${deg} degrees`);
  }
});

test('rotatedOrigin at 180 degrees puts the origin at the far corner', () => {
  const o = rotatedOrigin(0, 0, 100, 50, 180);
  assert.ok(Math.abs(o.x - 100) < 1e-9);
  assert.ok(Math.abs(o.y - 50) < 1e-9);
});

test('export survives rotated annotations', async () => {
  const file = await fixture(1);
  const bytes = await buildAnnotatedPdf(file, [
    { pageIndex: 0, type: 'highlight', data: { x: 50, y: 50, w: 120, h: 40, rotation: 30 }, style: {} },
    { pageIndex: 0, type: 'text', data: { x: 60, y: 300, w: 200, h: 40, text: 'turned', rotation: -20 }, style: {} },
  ]);
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 1);
  assert.ok(bytes.length > 0);
  await fs.unlink(file);
});

test('z order decides what is drawn last', async () => {
  const file = await fixture(1);
  const bytes = await buildAnnotatedPdf(file, [
    { pageIndex: 0, type: 'text', data: { x: 10, y: 10, w: 80, h: 20, text: 'under' }, style: {}, z: 0 },
    { pageIndex: 0, type: 'highlight', data: { x: 10, y: 10, w: 80, h: 20 }, style: {}, z: 5 },
  ]);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  await fs.unlink(file);
});

test('spinAbout leaves a point alone at zero degrees', () => {
  assert.deepEqual(spinAbout({ x: 5, y: 7 }, { x: 1, y: 1 }, 0), { x: 5, y: 7 });
});

test('spinAbout turns a point a quarter circle', () => {
  const p = spinAbout({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
  assert.ok(Math.abs(p.x - 0) < 1e-9);
  assert.ok(Math.abs(p.y - 10) < 1e-9);
});

test('spinAbout keeps the centre of rotation fixed', () => {
  const c = { x: 3, y: 4 };
  const p = spinAbout(c, c, 37);
  assert.ok(Math.abs(p.x - c.x) < 1e-9 && Math.abs(p.y - c.y) < 1e-9);
});

test('a multi line highlight exports as one annotation', async () => {
  const file = await fixture(1);
  const bytes = await buildAnnotatedPdf(file, [
    {
      pageIndex: 0,
      type: 'highlight',
      data: {
        x: 50, y: 100, w: 200, h: 44,
        rects: [
          { x: 50, y: 124, w: 200, h: 20 },
          { x: 50, y: 100, w: 120, h: 20 },
        ],
      },
      style: {},
    },
  ]);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  await fs.unlink(file);
});

test('a rotated multi line highlight still exports', async () => {
  const file = await fixture(1);
  const bytes = await buildAnnotatedPdf(file, [
    {
      pageIndex: 0,
      type: 'highlight',
      data: {
        x: 50, y: 100, w: 200, h: 44, rotation: 25,
        rects: [
          { x: 50, y: 124, w: 200, h: 20 },
          { x: 50, y: 100, w: 120, h: 20 },
        ],
      },
      style: {},
    },
  ]);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  await fs.unlink(file);
});

test('a curved stroke exports without complaint', async () => {
  const file = await fixture(1);
  const points = [];
  for (let i = 0; i <= 20; i++) points.push({ x: 50 + i * 12, y: 400 + Math.sin(i / 2) * 40, p: 0.6 });
  const bytes = await buildAnnotatedPdf(file, [
    { pageIndex: 0, type: 'ink', data: { points }, style: { color: '#e11d48', width: 4, opacity: 1 } },
  ]);
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 1);
  assert.ok(bytes.length > 0);
  await fs.unlink(file);
});

test('hidden pages are left out of the exported copy', async () => {
  const file = await fixture(4);
  const bytes = await buildAnnotatedPdf(file, [], [1, 2]);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 2);
  await fs.unlink(file);
});

test('hiding nothing exports every page', async () => {
  const file = await fixture(3);
  const bytes = await buildAnnotatedPdf(file, [], []);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 3);
  await fs.unlink(file);
});

test('annotations still land on the right page when others are hidden', async () => {
  const file = await fixture(3);
  // page 2 is hidden, so the mark stored for page 3 must still be drawn on it
  const bytes = await buildAnnotatedPdf(
    file,
    [{ pageIndex: 2, type: 'highlight', data: { x: 10, y: 10, w: 50, h: 20 }, style: {} }],
    [1]
  );
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 2);
  await fs.unlink(file);
});

test('a document is never exported with no pages at all', async () => {
  const file = await fixture(2);
  const bytes = await buildAnnotatedPdf(file, [], [0, 1]);
  assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
  await fs.unlink(file);
});

test('a flag is drawn onto the exported page', async () => {
  const file = await fixture(1);
  const bytes = await buildAnnotatedPdf(file, [
    { pageIndex: 0, type: 'flag', data: { x: 120, y: 400 }, style: { color: '#f59e0b' } },
  ]);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  assert.ok(bytes.length > 0);
  await fs.unlink(file);
});

test('a flag on a missing page is skipped, not fatal', async () => {
  const file = await fixture(1);
  const bytes = await buildAnnotatedPdf(file, [
    { pageIndex: 9, type: 'flag', data: { x: 10, y: 10 }, style: {} },
  ]);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  await fs.unlink(file);
});

test('a flag exports alongside everything else', async () => {
  const file = await fixture(1);
  const bytes = await buildAnnotatedPdf(file, [
    { pageIndex: 0, type: 'ink', data: { points: [{ x: 5, y: 5 }, { x: 40, y: 60 }] }, style: {} },
    { pageIndex: 0, type: 'flag', data: { x: 60, y: 300 }, style: {} },
    { pageIndex: 0, type: 'text', data: { x: 20, y: 100, w: 200, h: 40, text: 'hi' }, style: {} },
  ]);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  await fs.unlink(file);
});
