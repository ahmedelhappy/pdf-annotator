import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { loadPdf } from '../pdf';
import type { DocMeta } from '../types';

/**
 * Thumbnails are rendered here rather than on the server, because running
 * pdf.js in Node needs the native canvas package, which is a rough install on
 * Windows. A failure is non-fatal, the card just shows a placeholder.
 */
async function makeThumbnail(docId: string, from: Blob | string, fileRev = 0) {
  let url: string | null = null;
  try {
    // Either the file just uploaded, which is already to hand, or the copy on
    // the server, which is the only way to see a document that has since been
    // rewritten by a page op.
    url = typeof from === 'string' ? null : URL.createObjectURL(from);
    const pdf = await loadPdf(url ?? (from as string));
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 240 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const { assetId } = await api.uploadAsset(blob, 'thumb.png');
    return await api.setThumbnail(docId, assetId, fileRev);
  } catch (e) {
    console.warn('[thumbnail] skipped', e);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
  return null;
}

export default function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [trash, setTrash] = useState<DocMeta[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** Which card is being renamed, and what has been typed into it. */
  const [naming, setNaming] = useState<{ id: string; text: string } | null>(null);
  /** Thumbnails already attempted this session, so a failure is not retried for ever. */
  const drawn = useRef(new Set<string>());

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

  /**
   * A card's picture is of a particular revision of the file. Page ops rewrite
   * the file, so without this a document that has been reorganized went on
   * showing the page it opened with the day it was added. Drawn here, one at a
   * time, because that is where pdf.js already runs.
   */
  useEffect(() => {
    const stale = docs.filter(
      (d) => (d.thumbnailRev ?? 0) !== (d.fileRev ?? 0) || !d.thumbnailAssetId
    );
    if (!stale.length) return;
    let dead = false;
    (async () => {
      let any = false;
      for (const d of stale) {
        const key = `${d._id}:${d.fileRev ?? 0}`;
        if (dead || drawn.current.has(key)) continue;
        drawn.current.add(key);
        // Cache busted, or the browser hands back the file as it was before
        // the rewrite and the new picture shows the old pages.
        const at = `${api.fileUrl(d._id)}?v=${d.fileRev ?? 0}`;
        if (await makeThumbnail(d._id, at, d.fileRev ?? 0)) any = true;
      }
      if (any && !dead) refresh();
    })();
    return () => {
      dead = true;
    };
  }, [docs]);

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
        await makeThumbnail(doc._id, f, doc.fileRev ?? 0);
      } catch (e: any) {
        setError(e.message);
      }
    }
    setBusy(false);
    refresh();
  }

  async function startBlank() {
    setBusy(true);
    setError(null);
    try {
      const doc = await api.createBlank('Untitled');
      onOpen(doc._id);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="p-8 text-neutral-200 max-w-5xl mx-auto">
      <h1 className="text-2xl mb-1">Annotator</h1>
      <p className="text-sm text-neutral-500 mb-6">
        Open a PDF or start a blank page. Everything stays on this machine.
      </p>

      <div className="flex gap-3 items-stretch">
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
        className={`flex-1 border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
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

      {/* Not everything starts from a PDF. A blank page is a whiteboard, and
          the "+ Add page" strip grows it from there. */}
      <button
        disabled={busy}
        onClick={startBlank}
        className="w-48 border-2 border-dashed border-neutral-700 hover:border-emerald-600 rounded-lg p-6 text-center transition-colors disabled:opacity-50"
      >
        <span className="block text-3xl leading-none mb-2 text-neutral-500">+</span>
        <span className="block text-sm">New blank page</span>
        <span className="block text-xs text-neutral-500 mt-1">Start a whiteboard</span>
      </button>
      </div>

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
            </button>

            {/* The name sits outside the open button so it can be typed in
                without opening the document underneath it. */}
            {naming?.id === d._id ? (
              <input
                className="w-full text-sm bg-neutral-700 rounded px-1 py-0.5 text-neutral-100"
                aria-label="Document name"
                autoFocus
                value={naming.text}
                onChange={(e) => setNaming({ id: d._id, text: e.target.value })}
                onFocus={(e) => e.target.select()}
                onBlur={() => setNaming(null)}
                onKeyDown={async (e) => {
                  if (e.key === 'Escape') setNaming(null);
                  if (e.key !== 'Enter') return;
                  const next = naming.text.trim();
                  setNaming(null);
                  if (!next || next === d.originalName) return;
                  try {
                    await api.renameDoc(d._id, next);
                  } catch (err: any) {
                    setError(err.message);
                  }
                  refresh();
                }}
              />
            ) : (
              // Still opens the document, like the picture above it. Only the
              // Rename action below turns it into a field.
              <button
                className="text-sm truncate block w-full text-left"
                title={d.originalName}
                onClick={() => onOpen(d._id)}
              >
                {d.originalName}
              </button>
            )}
            <div className="text-xs text-neutral-400">
              {d.pageCount} {d.pageCount === 1 ? 'page' : 'pages'}
            </div>

            <div className="flex gap-3 mt-2">
              <button
                className="text-xs text-sky-400 hover:text-sky-300"
                title="Rename this document"
                onClick={() => setNaming({ id: d._id, text: d.originalName })}
              >
                Rename
              </button>
              <button
                className="text-xs text-rose-400 hover:text-rose-300"
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
