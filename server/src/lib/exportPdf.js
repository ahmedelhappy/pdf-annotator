import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, rgb, StandardFonts, BlendMode, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { strokeOutline } from './ink.js';
import {
  blockSize, blockText, HEADING_GAP, indentFor, markerFor, markerWidth, parseMarkdown,
} from './markdown.js';
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

/** The face a run wants, from the four Helvetica variants. */
export function faceFor(run, heading, faces) {
  const bold = run.bold || heading;
  if (bold && run.italic) return faces.boldItalic;
  if (bold) return faces.bold;
  if (run.italic) return faces.italic;
  return faces.plain;
}

/**
 * Greedy word wrap over a block's runs, keeping each run's face. Returns lines
 * of `{ text, font }` pieces. pdf-lib can wrap a plain string on its own, but
 * not one where the face changes partway along, and not with a marker holding a
 * column open on the left.
 */
export function wrapRuns(runs, width, size, heading, faces) {
  const lines = [];
  let line = [];
  let used = 0;

  const room = width > 0 ? width : Infinity;

  for (const run of runs) {
    const font = faceFor(run, heading, faces);
    // Split on spaces but keep them, so wrapping does not eat the gaps.
    for (const piece of String(run.text).split(/(\s+)/)) {
      if (!piece) continue;
      let w;
      try {
        w = font.widthOfTextAtSize(piece, size);
      } catch {
        // A glyph Helvetica has no place for. Leave it out rather than throw:
        // the caller falls back to an embedded face for the whole box.
        throw new RangeError('unsupported glyph');
      }
      const blank = /^\s+$/.test(piece);
      if (used + w > room && line.length && !blank) {
        lines.push(line);
        line = [];
        used = 0;
      }
      // A run of spaces at the start of a fresh line is dropped, the way a
      // wrapped paragraph reads.
      if (blank && !line.length) continue;
      line.push({ text: piece, font });
      used += w;
    }
  }
  lines.push(line);
  // Neighbouring pieces in the same face become one draw. Wrapping works word by
  // word, but drawing word by word puts every word in the file as its own text
  // item, so selecting or copying from the exported PDF comes out in pieces.
  return lines.map(coalesce);
}

/** Joins adjacent pieces that share a font. */
export function coalesce(line) {
  const out = [];
  for (const piece of line) {
    const last = out[out.length - 1];
    if (last && last.font === piece.font) last.text += piece.text;
    else out.push({ text: piece.text, font: piece.font });
  }
  return out;
}

/**
 * Draws a text box as markdown: headings larger and bold, bullets, numbers and
 * checkboxes in a column of their own, and bold and italic runs inside a line.
 * The same parse the page reads, so a box looks the same on paper as on screen.
 *
 * Anything Helvetica cannot set falls back to the embedded unicode face for the
 * whole box, with the markdown flattened, which is the old behaviour and the
 * only one available without four faces of that font.
 */
function drawMarkdown(page, o) {
  const { text, x, y, width, size, color, rotate, faces, unicode } = o;
  const blocks = parseMarkdown(text);

  try {
    let dy = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const heading = b.kind === 'h1' || b.kind === 'h2' || b.kind === 'h3';
      const fs = blockSize(b, size);
      const lead = fs * 1.35;
      if (heading && i > 0) dy += fs * HEADING_GAP;

      const marker = markerFor(b);
      const indent = indentFor(b, size);
      const lines = wrapRuns(b.runs, width - indent, fs, heading, faces);

      for (let n = 0; n < lines.length; n++) {
        // The first line of a list item carries the marker, in the column the
        // indent reserved, so a wrapped line sits under the words not the dot.
        if (marker && n === 0) {
          page.drawText(marker, {
            x: x + indent - markerWidth(b, size),
            y: y - dy,
            size: fs,
            font: faces.plain,
            color,
            rotate,
          });
        }
        let cursor = x + indent;
        for (const piece of lines[n]) {
          page.drawText(piece.text, {
            x: cursor,
            y: y - dy,
            size: fs,
            font: piece.font,
            color,
            rotate,
          });
          cursor += piece.font.widthOfTextAtSize(piece.text, fs);
        }
        dy += lead;
      }
      // An empty line still takes a line, the way it does in the box.
      if (!lines.length) dy += lead;
    }
    return;
  } catch (err) {
    if (!(err instanceof RangeError)) {
      console.warn('[export] Text skipped:', err.message);
      return;
    }
  }

  // Non-Latin: one face, no markdown, which is all the embedded font can do.
  if (!unicode) {
    console.warn('[export] Skipped non-Latin text. Add a font to server/fonts.');
    return;
  }
  const flat = blocks
    .map((b) => (markerFor(b) ? `${markerFor(b)} ${blockText(b)}` : blockText(b)))
    .join('\n');
  try {
    page.drawText(flat, {
      x,
      y,
      size,
      color,
      font: unicode,
      lineHeight: size * 1.35,
      rotate,
      ...(width > 0 ? { maxWidth: width } : {}),
    });
  } catch (e) {
    console.warn('[export] Text skipped:', e.message);
  }
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
  // Bold and italic for markdown emphasis, and bold for headings. All four are
  // built into every PDF reader, so nothing has to be embedded.
  const faces = {
    plain: helvetica,
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
  };
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

      // Text turns about the middle of its box, like it does on screen.
      const rot = a.data.rotation || 0;
      let ox = x;
      let oy = y;
      if (rot && a.type === 'text') {
        const o = rotatedOrigin(a.data.x, a.data.y, a.data.w, a.data.h, rot);
        ox = x + (o.x - a.data.x);
        oy = y + (o.y - a.data.y);
      }

      const width = a.data.w || 0;
      drawMarkdown(page, {
        text,
        x: ox,
        y: oy,
        width,
        size,
        color: col,
        rotate: rot && a.type === 'text' ? degrees(rot) : undefined,
        faces,
        unicode,
      });
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
