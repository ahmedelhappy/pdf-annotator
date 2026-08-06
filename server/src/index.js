import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { ensureDirs } from './lib/storage.js';
import documents from './routes/documents.js';
import annotations from './routes/annotations.js';
import assets from './routes/assets.js';

const app = express();
app.use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1):\d+$/ }));
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, db: mongoose.connection.readyState === 1 })
);

app.use('/api/documents', documents);
app.use('/api/annotations', annotations);
app.use('/api/assets', assets);

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

const port = Number(process.env.PORT) || 5174;

try {
  await ensureDirs();
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  console.log('[db] connected');
} catch (e) {
  console.error('\n[db] Could not reach MongoDB at', process.env.MONGO_URI);
  console.error('[db] Start it first. On Windows: Start-Service MongoDB');
  console.error('[db]', e.message, '\n');
  process.exit(1);
}

// Bound to loopback on purpose. Listening on 0.0.0.0 would let anyone on the
// same wifi list, download, and delete these documents.
app.listen(port, '127.0.0.1', () => console.log(`[api] http://localhost:${port}`));
