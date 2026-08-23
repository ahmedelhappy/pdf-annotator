import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import Doc from '../models/Document.js';
import Annotation from '../models/Annotation.js';
import { uploadPdf, PDF_DIR, ASSET_DIR } from '../lib/storage.js';
import { buildAnnotatedPdf } from '../lib/exportPdf.js';
import * as ops from '../lib/pdfOps.js';

const r = Router();
const fileOf = (doc) => path.join(PDF_DIR, doc.filename);

/** Every asset a document owns: its thumbnail plus any pasted or placed image. */
const assetIdsOf = (doc, anns) =>
  [doc.thumbnailAssetId, ...anns.map((a) => a?.data?.assetId)].filter(Boolean);

// One page op per document at a time. The stale clause releases a lock left
// behind by a server crash mid-operation.
async function withDocLock(id, fn) {
  const stale = new Date(Date.now() - 30_000);
  const doc = await Doc.findOneAndUpdate(
    { _id: id, $or: [{ busy: { $ne: true } }, { busySince: { $lt: stale } }] },
    { $set: { busy: true, busySince: new Date() } },
    { new: true }
  );
  if (!doc) {
    const e = new Error('This document is being reorganized. Try again in a moment.');
    e.status = 409;
    throw e;
  }
  try {
    return await fn(doc);
  } finally {
    await Doc.updateOne({ _id: id }, { $set: { busy: false } });
  }
}

r.post('/', uploadPdf.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    const abs = path.join(PDF_DIR, req.file.filename);
    const pdf = await PDFDocument.load(await fs.readFile(abs), { ignoreEncryption: true });
    res.status(201).json(
      await Doc.create({
        originalName: req.file.originalname,
        filename: req.file.filename,
        pageCount: pdf.getPageCount(),
      })
    );
  } catch (e) {
    next(e);
  }
});

/**
 * A document with nothing in it: one white page, ready to be drawn on. This is
 * a whiteboard as much as it is a PDF reader, and until now there was no way in
 * without a PDF to open first.
 *
 * A4 at 72dpi, the same shape the "+ Add page" strip inserts, so a second page
 * matches the first.
 */
r.post('/blank', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 200) || 'Untitled';
    const pdf = await PDFDocument.create();
    pdf.addPage([595.28, 841.89]);
    const filename = `${crypto.randomUUID()}.pdf`;
    await fs.writeFile(path.join(PDF_DIR, filename), await pdf.save());
    res.status(201).json(
      await Doc.create({
        originalName: name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`,
        filename,
        pageCount: 1,
        blank: true,
      })
    );
  } catch (e) {
    next(e);
  }
});

r.get('/', async (req, res, next) => {
  try {
    const trashed = req.query.trashed === '1';
    res.json(
      await Doc.find({ deletedAt: trashed ? { $ne: null } : null })
        .sort(trashed ? { deletedAt: -1 } : { updatedAt: -1 })
    );
  } catch (e) {
    next(e);
  }
});

r.get('/:id', async (req, res, next) => {
  try {
    const doc = await Doc.findByIdAndUpdate(
      req.params.id,
      { lastOpenedAt: new Date() },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'That document is gone.' });
    res.json(doc);
  } catch (e) {
    next(e);
  }
});

r.patch('/:id', async (req, res, next) => {
  try {
    // Only the fields that were actually sent, so setting one does not wipe
    // the other.
    const set = {};
    if (req.body.thumbnailAssetId) {
      set.thumbnailAssetId = req.body.thumbnailAssetId;
      // Stamped with the revision the picture was drawn from, so a later
      // rewrite of the file can be seen to have left it behind.
      if (Number.isInteger(req.body.fileRev)) set.thumbnailRev = req.body.fileRev;
    }
    if (Number.isInteger(req.body.lastPage) && req.body.lastPage >= 0)
      set.lastPage = req.body.lastPage;
    if (typeof req.body.originalName === 'string') {
      // A name is what the reader calls the document, not where it lives: the
      // file on disk keeps the stored filename whatever this says.
      const name = req.body.originalName.trim().slice(0, 200);
      if (!name) return res.status(400).json({ error: 'A name cannot be empty.' });
      set.originalName = name;
    }

    const doc = await Doc.findByIdAndUpdate(req.params.id, set, { new: true });
    if (!doc) return res.status(404).json({ error: 'That document is gone.' });
    res.json(doc);
  } catch (e) {
    next(e);
  }
});

r.get('/:id/file', async (req, res, next) => {
  try {
    const doc = await Doc.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'That document is gone.' });
    res.sendFile(fileOf(doc), { headers: { 'Content-Type': 'application/pdf' } });
  } catch (e) {
    next(e);
  }
});

// Flattening happens here so a 400 page file is never held twice in the tab.
r.get('/:id/export', async (req, res, next) => {
  try {
    const doc = await Doc.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'That document is gone.' });
    const anns = await Annotation.find({ documentId: doc._id }).lean();
    const bytes = await buildAnnotatedPdf(fileOf(doc), anns, doc.hiddenPages || []);
    const name = doc.originalName.replace(/\.pdf$/i, '') + '-annotated.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.end(Buffer.from(bytes));
  } catch (e) {
    next(e);
  }
});

// Deleting moves the document to the trash. The file and its annotations stay
// exactly where they are, so restoring is a field change and nothing else.
// Only `?purge=1` destroys anything, and that is not reachable from the UI
// without going through the trash first.
r.delete('/:id', async (req, res, next) => {
  try {
    const doc = await Doc.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'That document is gone.' });

    if (req.query.purge !== '1') {
      doc.deletedAt = new Date();
      await doc.save();
      return res.json({ ok: true, trashed: true });
    }

    await fs.unlink(fileOf(doc)).catch(() => {});
    await ops.dropSnapshots(doc);
    for (const id of assetIdsOf(doc, await Annotation.find({ documentId: doc._id }).lean()))
      await fs.unlink(path.join(ASSET_DIR, id)).catch(() => {});
    await Annotation.deleteMany({ documentId: doc._id });
    await doc.deleteOne();
    res.json({ ok: true, purged: true });
  } catch (e) {
    next(e);
  }
});

r.post('/:id/restore', async (req, res, next) => {
  try {
    const doc = await Doc.findByIdAndUpdate(
      req.params.id,
      { $unset: { deletedAt: 1 } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'That document is gone.' });
    res.json(doc);
  } catch (e) {
    next(e);
  }
});

r.get('/:id/annotations', async (req, res, next) => {
  try {
    res.json(await Annotation.find({ documentId: req.params.id }));
  } catch (e) {
    next(e);
  }
});

r.post('/:id/annotations', async (req, res, next) => {
  try {
    const doc = await Doc.findById(req.params.id).select('busy');
    if (!doc) return res.status(404).json({ error: 'That document is gone.' });
    if (doc.busy)
      return res.status(409).json({ error: 'This document is being reorganized.' });
    const { pageIndex, type, data, style } = req.body;
    res.status(201).json(
      await Annotation.create({ documentId: req.params.id, pageIndex, type, data, style })
    );
  } catch (e) {
    next(e);
  }
});

const handlers = {
  insert: ops.insertBlank,
  delete: ops.deletePage,
  duplicate: ops.duplicatePage,
  reorder: ops.reorderPages,
  rotate: ops.rotatePage,
  import: ops.importPages,
};

r.post('/:id/pages', async (req, res, next) => {
  try {
    const fn = handlers[req.body.op];
    if (!fn) return res.status(400).json({ error: `Unknown page action: ${req.body.op}` });
    const pageCount = await withDocLock(req.params.id, async (doc) => {
      // Remember how things were before touching the file, so this can be
      // taken back. Snapshots are only worth keeping for ops that change the
      // pages themselves.
      const touched = req.body.indices?.length
        ? req.body.indices.map(Number)
        : Number.isInteger(req.body.index) ? [Number(req.body.index)] : [];
      await ops.snapshot(fileOf(doc), doc, req.body.op, touched);
      const count = await fn(fileOf(doc), doc._id, req.body);
      await Doc.updateOne(
        { _id: doc._id },
        { $set: { pageCount: count }, $inc: { fileRev: 1 } }
      );
      return count;
    });
    res.json({ pageCount });
  } catch (e) {
    next(e);
  }
});

/** Takes back the last page op, content and annotations together. */
r.post('/:id/pages/undo', async (req, res, next) => {
  try {
    const result = await withDocLock(req.params.id, (doc) => ops.undoPageOp(fileOf(doc), doc));
    if (!result) return res.status(409).json({ error: 'There is no page change left to undo.' });
    // Putting the old file back is as much a change as the op was.
    await Doc.updateOne({ _id: req.params.id }, { $inc: { fileRev: 1 } });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

/**
 * Hiding keeps the page in the file but skips it in the viewer and in the
 * exported copy. Nothing is destroyed, so unhiding brings it straight back.
 */
r.patch('/:id/hidden', async (req, res, next) => {
  try {
    const pages = [...new Set((req.body.hiddenPages || []).map(Number))]
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);
    const doc = await Doc.findByIdAndUpdate(
      req.params.id,
      { hiddenPages: pages },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'That document is gone.' });
    res.json(doc);
  } catch (e) {
    next(e);
  }
});

export default r;
