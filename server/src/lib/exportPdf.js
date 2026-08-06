import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, rgb, StandardFonts, BlendMode, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { strokeOutline } from './ink.js';
import { ASSET_DIR } from './storage.js';

const FONT_DIR = path.resolve('./fonts');
let fontBytes = null;
let fontChecked = false;

// Drop any .ttf or .otf into server/fonts and non-Latin text exports as real
// glyphs. Without one we only have Helvetica, which is WinAnsi only.
async function unicodeFontBytes() {
  if (fontChecked) return fontBytes;
  fontChecked = true;
  try {
    const files = await fs.readdir(FONT_DIR);
    const face = files.find((f) => /\.(ttf|otf)$/i.test(f));
    if (face) fontBytes = await fs.readFile(path.join(FONT_DIR, face));
    else console.warn('[export] No font in server/fonts, non-Latin text will be skipped.');
  } catch {
    console.warn('[export] server/fonts is missing, non-Latin text will be skipped.');
  }
  return fontBytes;
}

function color(hex) {
  const h = (hex || '#e11d48').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n)) return rgb(0.88, 0.11, 0.28);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * pdf-lib rotates a drawn box about its lower-left corner, but on screen an
 * annotation turns about its own middle. This returns the corner to draw from
 * so that the middle ends up where it started.
 *
 * Angle is degrees counter-clockwise, matching pdf-lib's `degrees()` and the
 * `rotation` stored on an annotation.
 */
export function rotatedOrigin(x, y, w, h, deg) {
  if (!deg) return { x, y };
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    x: cx - (w / 2) * cos + (h / 2) * sin,
    y: cy - (w / 2) * sin - (h / 2) * cos,
  };
}

/** Turns a point about another point, degrees counter-clockwise. */
export function spinAbout(p, about, deg) {
  if (!deg) return { x: p.x, y: p.y };
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos };
}

/**
 * Hidden pages are dropped from the exported copy. Hiding is meant to take a
 * page out of the document you hand over without destroying it, so it has to
 * apply here as well as on screen.
 */
export async function buildAnnotatedPdf(filePath, annotations, hiddenPages = []) {
  const pdf = await PDFDocument.load(await fs.readFile(filePath), { ignoreEncryption: true });
  pdf.registerFontkit(fontkit);

  const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
  let unicode = null;
  const bytes = await unicodeFontBytes();
  if (bytes) {
    try {
      unicode = await pdf.embedFont(bytes, { subset: true });
    } catch (e) {
      console.warn('[export] Font could not be embedded:', e.message);
    }
  }

  const pages = pdf.getPages();
  const assetCache = new Map();
  const hidden = new Set(hiddenPages);

  // Explicit layer order wins. Within one z, types keep their natural stacking
  // so an untouched document exports exactly as it always did.
  const layer = { highlight: 0, image: 1, ink: 2, text: 3, note: 4 };
  const sorted = [...annotations].sort(
    (a, b) => (a.z ?? 0) - (b.z ?? 0) || (layer[a.type] ?? 9) - (layer[b.type] ?? 9)
  );

  for (const a of sorted) {
    const page = pages[a.pageIndex];
    if (!page) continue;
    const H = page.getHeight();
    const col = color(a.style?.color);

    if (a.type === 'ink') {
      const pts = a.data?.points || [];
      if (!pts.length) continue;
      // drawSvgPath uses a y-down space anchored at the given origin, so
      // anchor at the page top and flip every y on the way in.
      const flipped = pts.map((p) => ({ x: p.x, y: H - p.y, p: p.p }));
      page.drawSvgPath(strokeOutline(flipped, a.style?.width ?? 2), {
        x: 0,
        y: H,
        color: col,
        opacity: a.style?.opacity ?? 1,
        borderWidth: 0,
      });
    }

    if (a.type === 'highlight') {
      const rot = a.data.rotation || 0;
      // A highlight dragged across several lines is one annotation carrying a
      // box per line. They all turn about the middle of the whole thing.
      const lines = a.data.rects?.length ? a.data.rects : [a.data];
      const mid = { x: a.data.x + a.data.w / 2, y: a.data.y + a.data.h / 2 };
      for (const r of lines) {
        const c = spinAbout({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, mid, rot);
        const o = rotatedOrigin(c.x - r.w / 2, c.y - r.h / 2, r.w, r.h, rot);
        page.drawRectangle({
          x: o.x,
          y: o.y,
          width: r.w,
          height: r.h,
          rotate: degrees(rot),
          color: col,
          opacity: a.style?.opacity ?? 0.35,
          blendMode: BlendMode.Multiply,
        });
      }
    }

    if (a.type === 'text' || a.type === 'note') {
      const size = a.style?.fontSize || 14;
      const text = a.data?.text || '';
      if (a.type === 'note') {
        page.drawCircle({ x: a.data.x - 6, y: a.data.y + size / 2, size: 4, color: col });
      }
      if (!text.trim()) continue;

      const x = a.data.x;
      const y = a.type === 'note' ? a.data.y : a.data.y + a.data.h - size;
      const opts = { x, y, size, color: col, lineHeight: size * 1.35 };
      if (a.data.w) opts.maxWidth = a.data.w;

      // Text turns about the middle of its box, like it does on screen.
      const rot = a.data.rotation || 0;
      if (rot && a.type === 'text') {
        const o = rotatedOrigin(a.data.x, a.data.y, a.data.w, a.data.h, rot);
        opts.x = x + (o.x - a.data.x);
        opts.y = y + (o.y - a.data.y);
        opts.rotate = degrees(rot);
      }

      try {
        page.drawText(text, { ...opts, font: helvetica });
      } catch {
        if (unicode) {
          try {
            page.drawText(text, { ...opts, font: unicode });
          } catch (e) {
            console.warn('[export] Text skipped:', e.message);
          }
        } else {
          console.warn('[export] Skipped non-Latin text. Add a font to server/fonts.');
        }
      }
    }

    if (a.type === 'image') {
      let img = assetCache.get(a.data.assetId);
      if (!img) {
        const raw = await fs
          .readFile(path.join(ASSET_DIR, path.basename(a.data.assetId)))
          .catch(() => null);
        if (!raw) continue;
        const isPng = raw[0] === 0x89 && raw[1] === 0x50;
        const isJpg = raw[0] === 0xff && raw[1] === 0xd8;
        if (!isPng && !isJpg) {
          console.warn('[export] Image is neither PNG nor JPEG, skipped.');
          continue;
        }
        img = isPng ? await pdf.embedPng(raw) : await pdf.embedJpg(raw);
        assetCache.set(a.data.assetId, img);
      }
      const rot = a.data.rotation || 0;
      const o = rotatedOrigin(a.data.x, a.data.y, a.data.w, a.data.h, rot);
      page.drawImage(img, {
        x: o.x,
        y: o.y,
        width: a.data.w,
        height: a.data.h,
        rotate: degrees(rot),
        opacity: a.style?.opacity ?? 1,
      });
    }
  }

  // Removed last, so every annotation above was placed against the page numbers
  // it was stored with.
  for (const i of [...hidden].sort((a, b) => b - a)) {
    if (i >= 0 && i < pdf.getPageCount() && pdf.getPageCount() > 1) pdf.removePage(i);
  }

  return pdf.save();
}
