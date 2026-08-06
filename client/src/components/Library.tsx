import { useEffect, useState } from 'react';
import { api } from '../api';
import { loadPdf } from '../pdf';
import type { DocMeta } from '../types';

/**
 * Thumbnails are rendered here rather than on the server, because running
 * pdf.js in Node needs the native canvas package, which is a rough install on
 * Windows. A failure is non-fatal, the card just shows a placeholder.
 */
async function makeThumbnail(docId: string, file: File) {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(file);
    const pdf = await loadPdf(url);
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 240 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const { assetId } = await api.uploadAsset(blob, 'thumb.png');
    await api.setThumbnail(docId, assetId);
  } catch (e) {
    console.warn('[thumbnail] skipped', e);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

export default function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [trash, setTrash] = useState<DocMeta[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const refresh = () =>
    Promise.all([api.listDocs(), api.listDocs(true)])
      .then(([live, gone]) => {
        setDocs(live);
        setTrash(gone);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    refresh();
  }, []);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    for (const f of Array.from(files)) {
      if (f.type !== 'application/pdf') {
        setError(`${f.name} is not a PDF, so it was skipped.`);
        continue;
      }
      try {
        const doc = await api.uploadDoc(f);
        await makeThumbnail(doc._id, f);
      } catch (e: any) {
        setError(e.message);
      }
    }
    setBusy(false);
    refresh();
  }

  return (
    <div className="p-8 text-neutral-200 max-w-5xl mx-auto">
      <h1 className="text-2xl mb-1">PDF Annotator</h1>
      <p className="text-sm text-neutral-500 mb-6">
        Everything stays on this machine. Nothing is uploaded anywhere.
      </p>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          upload(e.dataTransfer.files);
        }}
        className={`block border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
          dragOver ? 'border-sky-500 bg-sky-950/30' : 'border-neutral-700 hover:border-sky-600'
        }`}
      >
        {busy ? 'Uploading' : 'Drop PDFs here, or click to choose'}
        <input
          type="file"
          accept="application/pdf"
          multiple
          className="hidden"
          onChange={(e) => upload(e.target.files)}
        />
      </label>

      {error && (
        <div className="mt-4 px-3 py-2 bg-rose-900/60 text-rose-100 rounded text-sm flex justify-between">
          <span>{error}</span>
          <button className="underline" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {!docs.length && !busy && (
        <p className="mt-8 text-sm text-neutral-500">
          No documents yet. Add one above to start annotating.
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8">
        {docs.map((d) => (
          <div key={d._id} className="bg-neutral-800 rounded p-3">
            <button className="text-left w-full" onClick={() => onOpen(d._id)}>
              <div className="h-32 bg-neutral-700 rounded mb-2 overflow-hidden flex items-center justify-center">
                {d.thumbnailAssetId ? (
                  <img
                    src={api.assetUrl(d.thumbnailAssetId)}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-xs text-neutral-500">No preview</span>
                )}
              </div>
              <div className="text-sm truncate" title={d.originalName}>{d.originalName}</div>
              <div className="text-xs text-neutral-400">
                {d.pageCount} {d.pageCount === 1 ? 'page' : 'pages'}
              </div>
            </button>
            <button
              className="text-xs text-rose-400 hover:text-rose-300 mt-2"
              title="Move to trash. You can restore it later."
              onClick={async () => {
                try {
                  await api.deleteDoc(d._id);
                } catch (e: any) {
                  setError(e.message);
                }
                refresh();
              }}
            >
              Move to trash
            </button>
          </div>
        ))}
      </div>

      {trash.length > 0 && (
        <div className="mt-10 border-t border-neutral-800 pt-4">
          <button
            className="text-sm text-neutral-400 hover:text-neutral-200"
            onClick={() => setShowTrash((v) => !v)}
          >
            {showTrash ? 'Hide' : 'Show'} trash ({trash.length})
          </button>

          {showTrash && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              {trash.map((d) => (
                <div key={d._id} className="bg-neutral-800/60 rounded p-3">
                  <div className="text-sm truncate text-neutral-400" title={d.originalName}>
                    {d.originalName}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {d.pageCount} {d.pageCount === 1 ? 'page' : 'pages'}
                  </div>
                  <div className="flex gap-3 mt-2">
                    <button
                      className="text-xs text-sky-400 hover:text-sky-300"
                      onClick={async () => {
                        try {
                          await api.restoreDoc(d._id);
                        } catch (e: any) {
                          setError(e.message);
                        }
                        refresh();
                      }}
                    >
                      Restore
                    </button>
                    <button
                      className="text-xs text-rose-400 hover:text-rose-300"
                      onClick={async () => {
                        if (
                          !confirm(
                            `Permanently delete ${d.originalName}? This cannot be undone.`
                          )
                        )
                          return;
                        try {
                          await api.purgeDoc(d._id);
                        } catch (e: any) {
                          setError(e.message);
                        }
                        refresh();
                      }}
                    >
                      Delete forever
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
