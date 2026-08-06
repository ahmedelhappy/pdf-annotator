import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';

export const ROOT = path.resolve(process.env.STORAGE_DIR || './storage');
export const PDF_DIR = path.join(ROOT, 'pdfs');
export const ASSET_DIR = path.join(ROOT, 'assets');

export async function ensureDirs() {
  await fs.mkdir(PDF_DIR, { recursive: true });
  await fs.mkdir(ASSET_DIR, { recursive: true });
}

function diskStorage(dir) {
  return multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, dir),
    filename: (_r, file, cb) =>
      cb(null, crypto.randomUUID() + path.extname(file.originalname || '')),
  });
}

export const uploadPdf = multer({
  storage: diskStorage(PDF_DIR),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_r, file, cb) =>
    file.mimetype === 'application/pdf'
      ? cb(null, true)
      : cb(new Error('That file is not a PDF.')),
});

export const uploadAsset = multer({
  storage: diskStorage(ASSET_DIR),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_r, file, cb) =>
    file.mimetype.startsWith('image/')
      ? cb(null, true)
      : cb(new Error('That file is not an image.')),
});
