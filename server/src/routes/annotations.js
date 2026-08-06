import { Router } from 'express';
import Annotation from '../models/Annotation.js';
import Doc from '../models/Document.js';

const r = Router();

r.patch('/:id', async (req, res, next) => {
  try {
    const existing = await Annotation.findById(req.params.id).select('documentId');
    if (!existing) return res.status(404).json({ error: 'That annotation is gone.' });

    const doc = await Doc.findById(existing.documentId).select('busy');
    if (doc?.busy)
      return res.status(409).json({ error: 'This document is being reorganized.' });

    const { data, style, pageIndex, z, locked } = req.body;
    const patch = {};
    if (data !== undefined) patch.data = data;
    if (style !== undefined) patch.style = style;
    if (pageIndex !== undefined) patch.pageIndex = pageIndex;
    if (z !== undefined) patch.z = z;
    if (locked !== undefined) patch.locked = locked;
    res.json(await Annotation.findByIdAndUpdate(req.params.id, patch, { new: true }));
  } catch (e) {
    next(e);
  }
});

// One round trip for multi-select style changes and group nudges
r.patch('/', async (req, res, next) => {
  try {
    const updates = req.body.updates || [];
    if (!updates.length) return res.json({ ok: true });
    await Annotation.bulkWrite(
      updates.map((u) => ({
        updateOne: {
          filter: { _id: u._id },
          update: {
            $set: {
              ...(u.data !== undefined && { data: u.data }),
              ...(u.style !== undefined && { style: u.style }),
            },
          },
        },
      })),
      { ordered: false }
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

r.delete('/:id', async (req, res, next) => {
  try {
    await Annotation.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

r.post('/bulk-delete', async (req, res, next) => {
  try {
    await Annotation.deleteMany({ _id: { $in: req.body.ids || [] } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default r;
