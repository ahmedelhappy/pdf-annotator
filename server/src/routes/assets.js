import { Router } from 'express';
import path from 'node:path';
import { uploadAsset, ASSET_DIR } from '../lib/storage.js';

const r = Router();

r.post('/', uploadAsset.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });
  res.status(201).json({ assetId: req.file.filename, mime: req.file.mimetype });
});

r.get('/:assetId', (req, res) => {
  // basename strips any path traversal attempt
  res.sendFile(path.join(ASSET_DIR, path.basename(req.params.assetId)), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'That image is gone.' });
  });
});

export default r;
