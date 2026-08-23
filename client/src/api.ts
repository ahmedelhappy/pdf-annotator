import type { Annotation, DocMeta } from './types';

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as any);
    const err: any = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const jsonPost = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const jsonPatch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  listDocs: (trashed = false) =>
    fetch(`/api/documents${trashed ? '?trashed=1' : ''}`).then(j<DocMeta[]>),
  getDoc: (id: string) => fetch(`/api/documents/${id}`).then(j<DocMeta>),
  fileUrl: (id: string) => `/api/documents/${id}/file`,
  exportUrl: (id: string) => `/api/documents/${id}/export`,
  assetUrl: (assetId: string) => `/api/assets/${assetId}`,

  uploadDoc(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/documents', { method: 'POST', body: fd }).then(j<DocMeta>);
  },
  /** Renames a document. The file on disk is untouched. */
  renameDoc: (id: string, originalName: string) =>
    fetch(`/api/documents/${id}`, jsonPatch({ originalName })).then(j<DocMeta>),
  /** A document with nothing in it but one white page. */
  createBlank: (name: string) =>
    fetch('/api/documents/blank', jsonPost({ name })).then(j<DocMeta>),
  /**
   * `fileRev` is the revision the picture was drawn from, so the library can
   * tell later that the file has been rewritten since and draw it again.
   */
  setThumbnail: (id: string, thumbnailAssetId: string, fileRev = 0) =>
    fetch(`/api/documents/${id}`, jsonPatch({ thumbnailAssetId, fileRev })).then(j<DocMeta>),
  /**
   * Remembers where the reader is, so the document opens there next time. Sent
   * with keepalive so a page turn just before the tab closes still lands.
   */
  setLastPage: (id: string, lastPage: number) =>
    fetch(`/api/documents/${id}`, { ...jsonPatch({ lastPage }), keepalive: true }),
  /** Moves the document to the trash. Nothing is destroyed. */
  deleteDoc: (id: string) =>
    fetch(`/api/documents/${id}`, { method: 'DELETE' }).then(j<{ ok: true }>),
  restoreDoc: (id: string) =>
    fetch(`/api/documents/${id}/restore`, { method: 'POST' }).then(j<DocMeta>),
  /** Unlinks the file and every asset. Only reachable from the trash. */
  purgeDoc: (id: string) =>
    fetch(`/api/documents/${id}?purge=1`, { method: 'DELETE' }).then(j<{ ok: true }>),

  listAnnotations: (id: string) =>
    fetch(`/api/documents/${id}/annotations`).then(j<Annotation[]>),
  createAnnotation: (id: string, body: Partial<Annotation>) =>
    fetch(`/api/documents/${id}/annotations`, jsonPost(body)).then(j<Annotation>),
  patchAnnotation: (annId: string, body: Partial<Annotation>) =>
    fetch(`/api/annotations/${annId}`, jsonPatch(body)).then(j<Annotation>),
  patchMany: (updates: any[]) =>
    fetch('/api/annotations', jsonPatch({ updates })).then(j<{ ok: true }>),
  deleteAnnotation: (annId: string) =>
    fetch(`/api/annotations/${annId}`, { method: 'DELETE' }).then(j<{ ok: true }>),
  deleteMany: (ids: string[]) =>
    fetch('/api/annotations/bulk-delete', jsonPost({ ids })).then(j<{ ok: true }>),

  uploadAsset(file: File | Blob, name = 'paste.png') {
    const fd = new FormData();
    fd.append('file', file, (file as File).name || name);
    return fetch('/api/assets', { method: 'POST', body: fd }).then(j<{ assetId: string }>);
  },

  pageOp: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/documents/${id}/pages`, jsonPost(body)).then(j<{ pageCount: number }>),
  /**
   * Takes back the last page op, page content and annotations together. The
   * pages it names are the ones the op had touched, so the viewer can point
   * out what came back.
   */
  undoPageOp: (id: string) =>
    fetch(`/api/documents/${id}/pages/undo`, { method: 'POST' })
      .then(j<{ pageCount: number; label: string; pages: number[] }>),
  setHiddenPages: (id: string, hiddenPages: number[]) =>
    fetch(`/api/documents/${id}/hidden`, jsonPatch({ hiddenPages })).then(j<DocMeta>),

  /** Fetched as a blob so a server error surfaces as a message, not a blank tab. */
  async downloadExport(id: string, filename: string) {
    const res = await fetch(`/api/documents/${id}/export`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      throw new Error(body.error || `Export failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
