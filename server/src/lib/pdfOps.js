import fs from 'node:fs/promises';
import { PDFDocument, degrees } from 'pdf-lib';
import Annotation from '../models/Annotation.js';
import Doc from '../models/Document.js';
import {
  afterDeleteMany, afterDuplicateMany, afterImport, afterInsert, afterReorder, planRemap,
} from './remap.js';

// Standalone MongoDB has no transactions, so the file write is what we make
// recoverable: back it up, write it, then apply the DB remap. If the DB step
// throws we roll the file back so the two never drift apart.
async function guarded(file, fn) {
  const bak = `${file}.bak`;
  await fs.copyFile(file, bak);
  try {
    const result = await fn();
    await fs.unlink(bak).catch(() => {});
    return result;
  } catch (err) {
    await fs.copyFile(bak, file).catch(() => {});
    await fs.unlink(bak).catch(() => {});
    throw err;
  }
}

async function applyRemap(documentId, remap) {
  const anns = await Annotation.find({ documentId }).select('_id pageIndex').lean();
  const { remove, move } = planRemap(anns, remap);
  if (remove.length) await Annotation.deleteMany({ _id: { $in: remove } });
  if (move.length) {
    await Annotation.bulkWrite(
      move.map((m) => ({
        updateOne: { filter: { _id: m._id }, update: { pageIndex: m.pageIndex } },
      })),
      { ordered: false }
    );
  }
  // Hidden pages and the reader's last place are page numbers too, so they move
  // exactly as annotations do. Miss this and hiding page 3 then deleting page 1
  // hides the wrong page.
  const doc = await Doc.findById(documentId).select('hiddenPages lastPage').lean();
  const set = {};

  const hidden = doc?.hiddenPages || [];
  if (hidden.length) {
    const next = hidden.map(remap).filter((i) => i !== null);
    set.hiddenPages = [...new Set(next)].sort((a, b) => a - b);
  }

  if (Number.isInteger(doc?.lastPage)) {
    // If the page someone was reading is the one that went, put them on the
    // page that took its place rather than back at the front.
    const next = remap(doc.lastPage);
    set.lastPage = next === null ? Math.max(0, doc.lastPage - 1) : next;
  }

  if (Object.keys(set).length) await Doc.updateOne({ _id: documentId }, { $set: set });
}

/** How many page ops can be taken back. Older snapshots are dropped. */
const UNDO_DEPTH = 10;

/**
 * Remembers the file and every annotation before a page op runs, so the op can
 * be taken back. The file has to be kept, not just the database rows: a page op
 * rewrites the PDF, and once a page is out of it the content is gone.
 */
export async function snapshot(file, doc, label, pages = []) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const shot = { file: `${file}.undo-${stamp}.pdf`, anns: `${file}.undo-${stamp}.json` };
  await fs.copyFile(file, shot.file);
  const anns = await Annotation.find({ documentId: doc._id }).lean();
  await fs.writeFile(shot.anns, JSON.stringify(anns));

  const kept = [
    ...(doc.pageUndo || []),
    {
      ...shot,
      label,
      pages,
      pageCount: doc.pageCount,
      hiddenPages: doc.hiddenPages || [],
      lastPage: doc.lastPage || 0,
    },
  ];
  // Drop the oldest once the stack is full, files and all.
  while (kept.length > UNDO_DEPTH) {
    const old = kept.shift();
    await fs.unlink(old.file).catch(() => {});
    await fs.unlink(old.anns).catch(() => {});
  }
  await Doc.updateOne({ _id: doc._id }, { $set: { pageUndo: kept } });
}

/** Puts the document back as it was before the last page op. */
export async function undoPageOp(file, doc) {
  const stack = doc.pageUndo || [];
  const shot = stack[stack.length - 1];
  if (!shot) return null;

  await fs.copyFile(shot.file, file);
  const saved = JSON.parse(await fs.readFile(shot.anns, 'utf8'));
  await Annotation.deleteMany({ documentId: doc._id });
  if (saved.length) await Annotation.insertMany(saved);

  await fs.unlink(shot.file).catch(() => {});
  await fs.unlink(shot.anns).catch(() => {});
  await Doc.updateOne(
    { _id: doc._id },
    {
      $set: {
        pageCount: shot.pageCount,
        hiddenPages: shot.hiddenPages || [],
        lastPage: shot.lastPage || 0,
        pageUndo: stack.slice(0, -1),
      },
    }
  );
  // The pages are handed back so the viewer can point out what returned.
  return { pageCount: shot.pageCount, label: shot.label, pages: shot.pages || [] };
}

/** Throws away every kept snapshot, for when a document is purged. */
export async function dropSnapshots(doc) {
  for (const shot of doc.pageUndo || []) {
    await fs.unlink(shot.file).catch(() => {});
    await fs.unlink(shot.anns).catch(() => {});
  }
}

const load = async (file) =>
  PDFDocument.load(await fs.readFile(file), { ignoreEncryption: true });

async function save(pdf, file) {
  await fs.writeFile(file, await pdf.save());
  return pdf.getPageCount();
}

export function insertBlank(file, documentId, { index, size }) {
  return guarded(file, async () => {
    const pdf = await load(file);
    const at = Math.max(0, Math.min(Number(index) || 0, pdf.getPageCount()));
    const neighbour = pdf.getPages()[Math.max(0, at - 1)] || pdf.getPages()[0];
    const dims = size || (neighbour ? neighbour.getSize() : { width: 595.28, height: 841.89 });
    pdf.insertPage(at, [dims.width, dims.height]);
    const count = await save(pdf, file);
    await applyRemap(documentId, afterInsert(at));
    return count;
  });
}

/** Takes one page or several. Several at once is one file rewrite, not many. */
export function deletePage(file, documentId, { index, indices }) {
  const wanted = [...new Set((indices?.length ? indices : [index]).map(Number))]
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);

  return guarded(file, async () => {
    const pdf = await load(file);
    const total = pdf.getPageCount();
    if (!wanted.length) throw new Error('No pages were given to delete.');
    if (wanted.some((i) => i < 0 || i >= total)) throw new Error('That page does not exist.');
    if (wanted.length >= total) throw new Error('A document needs at least one page.');

    // Highest first, so removing one does not shift the next one along.
    for (const i of [...wanted].reverse()) pdf.removePage(i);
    const count = await save(pdf, file);
    await applyRemap(documentId, afterDeleteMany(wanted));
    return count;
  });
}

/** Takes one page or several. Each copy lands straight after its original. */
export function duplicatePage(file, documentId, { index, indices }) {
  const wanted = [...new Set((indices?.length ? indices : [index]).map(Number))]
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);

  return guarded(file, async () => {
    const pdf = await load(file);
    if (!wanted.length) throw new Error('No pages were given to duplicate.');
    if (wanted.some((i) => i < 0 || i >= pdf.getPageCount()))
      throw new Error('That page does not exist.');

    const copies = await pdf.copyPages(pdf, wanted);
    // Highest first, so inserting one does not shift where the next one goes.
    for (let k = wanted.length - 1; k >= 0; k--) pdf.insertPage(wanted[k] + 1, copies[k]);
    const count = await save(pdf, file);
    await applyRemap(documentId, afterDuplicateMany(wanted));
    return count;
  });
}

export function reorderPages(file, documentId, { order }) {
  return guarded(file, async () => {
    const src = await load(file);
    if (!Array.isArray(order) || order.length !== src.getPageCount())
      throw new Error('The new page order does not match the page count.');
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, order);
    copied.forEach((p) => out.addPage(p));
    const count = await save(out, file);
    await applyRemap(documentId, afterReorder(order));
    return count;
  });
}

// Rotation is written into the PDF itself. pdf.js folds it into the viewport
// and convertToPdfPoint undoes it, so stored annotations need no migration and
// pdf-lib keeps drawing in unrotated user space at export time.
export function rotatePage(file, documentId, { index, indices, delta }) {
  const wanted = (indices?.length ? indices : [index]).map(Number);
  return guarded(file, async () => {
    const pdf = await load(file);
    for (const i of wanted) {
      const page = pdf.getPages()[i];
      if (!page) throw new Error('That page does not exist.');
      const next = (((page.getRotation().angle + Number(delta)) % 360) + 360) % 360;
      page.setRotation(degrees(next));
    }
    return save(pdf, file);
  });
}

export function importPages(file, documentId, { sourceFile, indices, at }) {
  return guarded(file, async () => {
    const pdf = await load(file);
    const src = await load(sourceFile);
    const pages = await pdf.copyPages(src, indices);
    pages.forEach((p, n) => pdf.insertPage(at + n, p));
    const count = await save(pdf, file);
    await applyRemap(documentId, afterImport(at, pages.length));
    return count;
  });
}
