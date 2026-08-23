import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { drawThumbnail, loadPdf, pageViewports } from '../pdf';
import { toPdf, toView } from '../lib/geometry';
import { textHeight } from '../lib/text';

import { api } from '../api';
import { CLIP_MARKER, onPagesRestored, PRESETS, useStore } from '../store';
import { useShortcuts } from '../hooks/useShortcuts';
import type { Ctx } from '../lib/shortcuts';
import type { Annotation, DocMeta, SearchMatch } from '../types';
import PdfPage from './PdfPage';
import Toolbar from './Toolbar';
import PageSidebar from './PageSidebar';
import AnnotationList from './AnnotationList';
import OutlinePanel from './OutlinePanel';
import ShortcutHelp from './ShortcutHelp';
import CommandPalette from './CommandPalette';
import SearchBar from './SearchBar';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** The space between two pages, and the room the insert strip has to live in. */
const GAP_PX = 34;

/** How long a page card stays pointed out, and how long one takes to leave. */
const FLASH_MS = 1400;
const LEAVE_MS = 280;

export type Flash = { kind: 'in' | 'out'; pages: number[] };

/**
 * The strip between two pages. Invisible until the pointer is over it, so the
 * document still reads as a document, and it never overlaps a page, or it would
 * swallow a stroke that starts near the top edge.
 */
function PageGap({
  at, busy, last, onInsert,
}: {
  at: number;
  busy: boolean;
  last?: boolean;
  onInsert: (at: number) => void;
}) {
  return (
    // The gap holds the space between two pages itself, rather than reaching
    // into the page margins. A strip laid over the margin sat on top of the
    // page below it, where the text layer swallowed every pointer.
    <div className="relative z-10" style={{ height: GAP_PX }}>
      <div
        className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity"
      >
        <span className="flex-1 h-px bg-sky-500/60 max-w-[40%]" />
        <button
          disabled={busy}
          title={last ? 'Add a blank page at the end' : `Add a blank page before page ${at + 1}`}
          aria-label={last ? 'Add a blank page at the end' : `Add a blank page before page ${at + 1}`}
          onClick={() => onInsert(at)}
          className="px-2 py-0.5 rounded-full bg-sky-600 text-white text-xs shadow hover:bg-sky-500 disabled:opacity-50"
        >
          + Add page
        </button>
        <span className="flex-1 h-px bg-sky-500/60 max-w-[40%]" />
      </div>
    </div>
  );
}

/**
 * Where new pages land, so they can be pointed out once the file comes back.
 * A duplicate's copy goes straight after its original, and every original with
 * a copy in front of it has moved along by that many.
 */
function arrivingPages(body: any): number[] {
  if (body.op === 'insert') return [Number(body.index) || 0];
  if (body.op === 'import') {
    const at = Number(body.at) || 0;
    return (body.indices || []).map((_: number, n: number) => at + n);
  }
  if (body.op === 'duplicate') {
    const raw: number[] = (body.indices?.length ? body.indices : [body.index]).map(Number);
    const wanted = [...new Set(raw)].sort((a, b) => a - b);
    return wanted.map((d, k) => d + k + 1);
  }
  return [];
}

export default function Viewer({ docId, onBack }: { docId: string; onBack: () => void }) {
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [pdf, setPdf] = useState<any>(null);
  const [current, setCurrent] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showHelp, setShowHelp] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [panning, setPanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  /** A paste was asked for and the clipboard has not answered yet. */
  const wantsPaste = useRef(false);
  /** Read from a timer that outlives the render it was scheduled in. */
  const currentRef = useRef(0);
  currentRef.current = current;
  /** True once the document has been opened, so a reload is not a fresh open. */
  const opened = useRef(false);
  /** The page to jump to as soon as the shells are laid out. */
  const restoreTo = useRef<number | null>(null);

  const scale = useStore((s) => s.scale);
  const tool = useStore((s) => s.tool);
  const invert = useStore((s) => s.invert);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const listOpen = useStore((s) => s.listOpen);
  const outlineOpen = useStore((s) => s.outlineOpen);
  const lastError = useStore((s) => s.lastError);
  const setError = useStore((s) => s.setError);

  const act = () => useStore.getState();

  /**
   * Every page's size at scale 1, measured once. Page shells then resize in the
   * same render as a zoom instead of trailing behind it one promise at a time.
   */
  const [pageSizes, setPageSizes] = useState<{ w: number; h: number }[]>([]);
  /** Pages skipped in the viewer. Still in the file, still in the sidebar. */
  const hiddenList = useMemo(() => meta?.hiddenPages || [], [meta]);
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  /** The pages actually laid out, hidden ones left out. */
  const shown = useMemo(
    () => Array.from({ length: pdf?.numPages ?? 0 }, (_, i) => i).filter((i) => !hidden.has(i)),
    [pdf, hidden]
  );

  /**
   * Which page cards to point out and whether they are arriving or leaving. A
   * page op rewrites the whole file, so without this the sidebar simply looks
   * different afterwards and you have to count to work out what moved.
   */
  const [flash, setFlash] = useState<Flash | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Held until the reloaded file is on screen, or it plays on the old cards. */
  const flashOnReload = useRef<Flash | null>(null);

  const pointOut = useCallback((next: Flash | null) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash(next && next.pages.length ? next : null);
    if (next?.pages.length)
      flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  const rename = useCallback(
    async (name: string) => {
      try {
        setMeta(await api.renameDoc(docId, name));
      } catch (e: any) {
        setError(e.message);
      }
    },
    [docId, setError]
  );

  const setHidden = useCallback(
    async (pages: number[]) => {
      try {
        setMeta(await api.setHiddenPages(docId, pages));
      } catch (e: any) {
        setError(e.message);
      }
    },
    [docId, setError]
  );

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const m = await api.getDoc(docId);
        if (dead) return;
        setMeta(m);
        await act().load(docId);
        const doc = await loadPdf(`${api.fileUrl(docId)}?v=${reloadKey}`);
        if (dead) return;
        const sizes = await Promise.all(
          Array.from({ length: doc.numPages }, async (_, i) => {
            const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
            return { w: vp.width, h: vp.height };
          })
        );
        if (dead) return;
        setPageSizes(sizes);
        setPdf(doc);
        // Opening picks up where you left off. A page-op reload is not an
        // opening, so it is left alone: you are already looking at the page.
        if (!opened.current) {
          opened.current = true;
          const want = Math.min(Math.max(0, m.lastPage ?? 0), doc.numPages - 1);
          if (want > 0) restoreTo.current = want;
        }
        // Held back until here so the animation plays on the cards that came
        // out of the rewrite, not on the ones about to be replaced.
        pointOut(flashOnReload.current);
        flashOnReload.current = null;

        /*
         * The library card's picture is of page one, and a page op rewrites the
         * file, so it has to be drawn again. Done here because this is the one
         * place the new file is already open: the library would otherwise be
         * fetching and parsing it a second time to find out what changed.
         *
         * Deliberately not awaited and not guarded by `dead`. Leaving the
         * document is the most likely moment for this to be running, and the
         * picture is just as wrong then. `drawThumbnail` keeps its own record of
         * what it has drawn, so a second pass over the same revision is free.
         */
        void drawThumbnail(docId, doc, m.fileRev ?? 0, api.setThumbnail, api.uploadAsset);
      } catch (e: any) {
        if (!dead) setLoadError(e.message);
      }
    })();
    return () => {
      dead = true;
    };
  }, [docId, reloadKey]);

  // Undoing a page change swaps the file on disk, so the document has to be
  // read again from scratch.
  useEffect(() => {
    onPagesRestored((back) => {
      // Undoing a delete puts pages back, and those are the ones worth
      // pointing at. Undoing an insert or a duplicate takes pages away again,
      // and by the time the file returns there is nothing left to show.
      if (back.label === 'delete') flashOnReload.current = { kind: 'in', pages: back.pages };
      setReloadKey((k) => k + 1);
    });
    return () => onPagesRestored(null);
  }, []);

  /**
   * Ctrl+V reaches here first and the browser's paste event follows in the same
   * gesture, so the decision waits a tick for it. If no paste event turns up,
   * which is how the command palette gets here, the annotations copied in the
   * app are the only candidate.
   */
  const pasteRequested = useCallback(() => {
    wantsPaste.current = true;
    setTimeout(() => {
      if (!wantsPaste.current) return;
      wantsPaste.current = false;
      act().pasteAnnotations(currentRef.current);
    }, 0);
  }, []);

  const goTo = useCallback((i: number) => {
    scrollRef.current
      ?.querySelector(`[data-page="${i}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Scrolls to the page first, then to the exact hit once that page has
  // rendered its text layer. A miss just leaves you on the right page.
  const goToMatch = useCallback(
    (m: SearchMatch) => {
      goTo(m.pageIndex);
      let tries = 0;
      const tick = () => {
        const el = document.querySelector(`[data-hit="${m.pageIndex}:${m.ordinal}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        if (tries++ < 12) setTimeout(tick, 120);
      };
      setTimeout(tick, 150);
    },
    [goTo]
  );

  /**
   * Scrolls an annotation into the middle of the view and selects it. The page
   * has to render first, since the only honest way from stored PDF points to a
   * screen offset is that page's live viewport.
   */
  const revealAnn = useCallback(
    (a: Annotation) => {
      act().select(a._id);
      goTo(a.pageIndex);
      let tries = 0;
      const tick = () => {
        const el = scrollRef.current;
        const shell = el?.querySelector(`[data-page="${a.pageIndex}"]`) as HTMLElement | null;
        const vp = pageViewports.get(a.pageIndex);
        if (el && shell && vp) {
          const p =
            a.type === 'ink' ? (a.data?.points?.[0] ?? { x: 0, y: 0 })
            : { x: a.data?.x ?? 0, y: a.data?.y ?? 0 };
          const v = toView(vp, p.x, p.y);
          el.scrollTo({
            top: shell.offsetTop + v.y - el.clientHeight / 2,
            behavior: 'smooth',
          });
          return;
        }
        if (tries++ < 15) setTimeout(tick, 120);
      };
      setTimeout(tick, 150);
    },
    [goTo]
  );

  /**
   * Walks the annotations in reading order, page by page and within a page in
   * paint order. From nothing selected it starts from the page you are on, so
   * it always moves away from where you are rather than back to the top. It
   * wraps, since running off the end silently would look like it stopped
   * working.
   */
  const stepAnnotation = useCallback(
    (dir: 1 | -1) => {
      const st = act();
      // Filtered down to the difficult pages when the panel is, so the arrows
      // and the list it sits above never disagree about what comes next.
      const hard = new Set(
        st.annotations.filter((x) => x.type === 'flag').map((x) => x.pageIndex)
      );
      const pool = st.marksHardOnly
        ? st.annotations.filter((x) => hard.has(x.pageIndex))
        : st.annotations;
      const list = [...pool].sort(
        (x, y) => x.pageIndex - y.pageIndex || (x.z ?? 0) - (y.z ?? 0)
      );
      if (!list.length) {
        setError(
          st.marksHardOnly
            ? 'No pages are flagged as difficult yet.'
            : 'There are no annotations in this document yet.'
        );
        return;
      }

      /*
       * By page, the arrows walk pages, not the marks on them. Stepping through
       * every mark while the list shows one row per page meant several presses
       * to leave a busy page, and the row you were on never changed.
       *
       * The selection is dropped rather than moved: no single mark is being
       * pointed at, and a stale one left the panel following it instead of the
       * page underneath.
       */
      if (st.marksByPage) {
        const pages = [...new Set(list.map((x) => x.pageIndex))].sort((x, y) => x - y);
        const on = pages.indexOf(current);
        const next =
          on >= 0 ? pages[(on + dir + pages.length) % pages.length]
          : dir === 1 ? (pages.find((n) => n > current) ?? pages[0])
          : ([...pages].reverse().find((n) => n < current) ?? pages[pages.length - 1]);
        st.select(null);
        goTo(next);
        return;
      }

      const at = list.findIndex((x) => x._id === st.selectedIds[0]);
      const next =
        at >= 0 ? list[(at + dir + list.length) % list.length]
        : dir === 1 ? (list.find((x) => x.pageIndex >= current) ?? list[0])
        : ([...list].reverse().find((x) => x.pageIndex <= current) ?? list[list.length - 1]);
      revealAnn(next);
    },
    [current, goTo, revealAnn, setError]
  );

  const runPageOp = useCallback(
    async (body: any) => {
      if (busy) return;
      if (body.op === 'delete') {
        const list: number[] = body.indices?.length ? body.indices : [body.index];
        const what =
          list.length === 1
            ? `page ${list[0] + 1} and everything on it`
            : `${list.length} pages and everything on them`;
        if (!confirm(`Delete ${what}? Ctrl+Z takes it back.`)) return;
      }
      setBusy(true);
      try {
        // Every debounced write must land before the server renumbers pages,
        // or an in-flight stroke arrives carrying a stale page index.
        await act().flushPending();
        // Pages on their way out are shown leaving before the file is
        // rewritten. Once the server answers they are gone from the sidebar
        // and there is nothing left to point at.
        if (body.op === 'delete') {
          const going: number[] = body.indices?.length ? body.indices : [body.index];
          pointOut({ kind: 'out', pages: going });
          await new Promise((r) => setTimeout(r, LEAVE_MS));
        }
        await api.pageOp(docId, body);
        // Recorded so Ctrl+Z reaches page changes as well as annotations.
        act().pushPageOp(body.op);
        // Page numbers have moved, so the old selection no longer means
        // anything.
        act().selectPages([]);
        flashOnReload.current = { kind: 'in', pages: arrivingPages(body) };
        setReloadKey((k) => k + 1);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    },
    [docId, busy, setError]
  );

  const reorder = useCallback(
    (order: number[]) => runPageOp({ op: 'reorder', order }),
    [runPageOp]
  );

  const insertAt = useCallback(
    (at: number) => runPageOp({ op: 'insert', index: at }),
    [runPageOp]
  );

  const movePage = useCallback(
    async (dir: -1 | 1) => {
      if (!pdf) return;
      const to = current + dir;
      if (to < 0 || to >= pdf.numPages) return;
      const order = Array.from({ length: pdf.numPages }, (_, i) => i);
      [order[current], order[to]] = [order[to], order[current]];
      setCurrent(to);
      await runPageOp({ op: 'reorder', order });
    },
    [pdf, current, runPageOp]
  );

  const fit = useCallback(
    async (mode: 'width' | 'page') => {
      if (!pdf || !scrollRef.current) return;
      const vp = (await pdf.getPage(current + 1)).getViewport({ scale: 1 });
      const box = scrollRef.current.getBoundingClientRect();
      const byWidth = (box.width - 80) / vp.width;
      act().setScale(mode === 'width' ? byWidth : Math.min(byWidth, (box.height - 40) / vp.height));
    },
    [pdf, current]
  );

  /** Where the pointer was when a zoom started, until the new layout lands. */
  const pendingZoom = useRef<{
    pageIndex: number;
    fx: number;
    fy: number;
    vx: number;
    vy: number;
  } | null>(null);

  const zoomAround = useCallback((next: number, clientX?: number, clientY?: number) => {
    const el = scrollRef.current;
    const st = useStore.getState();
    if (!el) return st.setScale(next);

    const r = el.getBoundingClientRect();
    // Default to the middle of the viewport, which is what a keyboard or button
    // zoom should hold still.
    const ax = clientX === undefined ? r.left + r.width / 2 : clientX;
    const ay = clientY === undefined ? r.top + r.height / 2 : clientY;

    // Remember the anchor as a fraction of the page it sits on. Fractions do
    // not care what the scale becomes, and scaling the old scroll offset by the
    // zoom ratio would be wrong anyway: page margins are a fixed size and a
    // page narrower than the viewport stays centred, so neither axis grows by
    // the ratio.
    for (const shell of Array.from(el.querySelectorAll('[data-page]')) as HTMLElement[]) {
      const s = shell.getBoundingClientRect();
      if (ay < s.top || ay > s.bottom) continue;
      pendingZoom.current = {
        pageIndex: Number(shell.dataset.page),
        fx: s.width ? (ax - s.left) / s.width : 0.5,
        fy: s.height ? (ay - s.top) / s.height : 0.5,
        vx: ax - r.left,
        vy: ay - r.top,
      };
      break;
    }
    st.setScale(next);
  }, []);

  /**
   * Put the anchor back under the cursor. This runs before the browser paints,
   * and every page shell already has its new size in this same commit, so there
   * is one jump-free reflow rather than a scramble spread over several frames.
   */
  useLayoutEffect(() => {
    const z = pendingZoom.current;
    pendingZoom.current = null;
    const el = scrollRef.current;
    if (!z || !el) return;
    const shell = el.querySelector(`[data-page="${z.pageIndex}"]`) as HTMLElement | null;
    if (!shell) return;
    el.scrollLeft = shell.offsetLeft + z.fx * shell.offsetWidth - z.vx;
    el.scrollTop = shell.offsetTop + z.fy * shell.offsetHeight - z.vy;
  }, [scale]);

  // Ctrl + wheel zooms the document rather than the browser chrome. Deltas are
  // gathered and applied once per frame: a trackpad fires these faster than the
  // pages can redraw, and one zoom per event made it lurch.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let steps = 0;
    let at: { x: number; y: number } | null = null;
    let queued = 0;

    function flush() {
      queued = 0;
      const n = steps;
      steps = 0;
      if (!n || !at) return;
      const st = useStore.getState();
      // Multiplicative, so each notch feels the same at any zoom level.
      zoomAround(st.scale * Math.pow(1.12, n), at.x, at.y);
    }

    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      steps += e.deltaY < 0 ? 1 : -1;
      at = { x: e.clientX, y: e.clientY };
      if (!queued) queued = requestAnimationFrame(flush);
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (queued) cancelAnimationFrame(queued);
    };
  }, [pdf, zoomAround]);

  // Where the pointer last was over a page, so a paste lands there rather than
  // always in the middle. Kept in a ref: this changes constantly and no part
  // of the view depends on it.
  const dropAt = useRef<{ pageIndex: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onMove(e: PointerEvent) {
      const shell = (e.target as HTMLElement)?.closest?.('[data-page]') as HTMLElement | null;
      if (!shell) return;
      const vp = pageViewports.get(Number(shell.dataset.page));
      if (!vp) return;
      const r = shell.getBoundingClientRect();
      const p = toPdf(vp, e.clientX - r.left, e.clientY - r.top);
      dropAt.current = { pageIndex: Number(shell.dataset.page), x: p.x, y: p.y };
    }
    el.addEventListener('pointermove', onMove);
    return () => el.removeEventListener('pointermove', onMove);
  }, [pdf]);

  /**
   * Ctrl+V used to run two paths at once: the shortcut pasted the annotations
   * copied inside the app, and the browser's own paste event pasted whatever
   * was on the system clipboard, so you got both. Now the shortcut only asks
   * for a paste and this handler decides, because it is the one that can see
   * what the clipboard actually holds. Whatever was copied last wins: copying
   * annotations claims the clipboard with CLIP_MARKER, so finding that marker
   * means nothing newer has been copied since.
   */
  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      if (!pdf) return;
      // Already typing in a text box or a note: the caret is where the text
      // belongs, so let the browser drop it in there. Pasting used to open a
      // second box beside the one you were working in.
      const caret = document.activeElement as HTMLElement | null;
      const typing =
        !!caret && (caret instanceof HTMLTextAreaElement || caret.isContentEditable);
      if (typing && act().editingId) {
        wantsPaste.current = false;
        return;
      }

      const items = Array.from(e.clipboardData?.items || []);
      const image = items.find((i) => i.type.startsWith('image/'));
      const raw = e.clipboardData?.getData('text/plain')?.trim();
      const text = raw === CLIP_MARKER ? '' : raw;

      if (!image && !text) {
        // Nothing newer than the annotations copied in the app.
        e.preventDefault();
        wantsPaste.current = false;
        act().pasteAnnotations(current);
        return;
      }
      // Something outside the app was copied more recently, so it wins alone.
      wantsPaste.current = false;
      e.preventDefault();

      try {
        const at = dropAt.current;
        const onPage = at && at.pageIndex < pdf.numPages ? at.pageIndex : current;
        const vp = (await pdf.getPage(onPage + 1)).getViewport({ scale: 1 });

        if (image) {
          const blob = image.getAsFile()!;
          const { assetId } = await api.uploadAsset(blob, 'paste.png');
          const bmp = await createImageBitmap(blob);
          const w = Math.min(bmp.width, vp.width * 0.5);
          const h = (bmp.height / bmp.width) * w;
          // Centred under the cursor, then nudged back inside the page so a
          // paste near an edge is never dropped half off the paper.
          const x = clamp(at ? at.x - w / 2 : (vp.width - w) / 2, 0, Math.max(0, vp.width - w));
          const y = clamp(at ? at.y - h / 2 : (vp.height - h) / 2, 0, Math.max(0, vp.height - h));
          await act().add({
            pageIndex: onPage,
            type: 'image',
            // A picture is not ink. It ships opaque whatever the pen is set to.
            style: { ...act().style, opacity: 1 },
            data: { x, y, w, h, assetId },
          });
          return;
        }

        // The width is the same for any paste; only the height follows the
        // text. Counting newlines gave a one line box for a pasted paragraph,
        // which is a single long line that wraps into many, so it is measured.
        const size = act().style.fontSize || 14;
        const w = Math.min(320, vp.width * 0.6);
        const h = textHeight(text!, w, size) + 4;
        const x = clamp(at ? at.x : (vp.width - w) / 2, 0, Math.max(0, vp.width - w));
        const y = clamp(at ? at.y - h : (vp.height - h) / 2, 0, Math.max(0, vp.height - h));
        const made = await act().add({
          pageIndex: onPage,
          type: 'text',
          data: { x, y, w, h, text },
        });
        if (made) act().select(made._id);
      } catch (err: any) {
        setError(err.message);
      }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [pdf, current, setError]);

  async function exportPdf() {
    if (!meta || exporting) return;
    setExporting(true);
    try {
      await api.downloadExport(
        docId,
        meta.originalName.replace(/\.pdf$/i, '') + '-annotated.pdf'
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  }

  function exportJson() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(act().annotations, null, 2)], { type: 'application/json' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = (meta?.originalName || 'document').replace(/\.pdf$/i, '') + '-annotations.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const ctx = useMemo<Ctx>(
    () => ({
      setTool: (t) => act().setTool(t),
      setStyle: (s) => act().setStyle(s),
      get style() {
        return useStore.getState().style;
      },
      get palette() {
        return useStore.getState().palette;
      },
      applyPresetIndex: (i) => PRESETS[i] && act().applyPreset(PRESETS[i]),
      get scale() {
        return useStore.getState().scale;
      },
      // Keyboard zoom holds the middle of the view, not the top-left corner.
      setScale: (n) => zoomAround(n),
      fit,
      undo: () => act().undo(),
      redo: () => act().redo(),
      // Delete means the pages when pages are what is picked, and the marks on
      // them otherwise. Selecting an annotation drops the page selection, so
      // the two never both apply.
      deleteSelected: () => {
        const pages = act().selectedPages;
        if (pages.length && !act().selectedIds.length) runPageOp({ op: 'delete', indices: pages });
        else act().remove();
      },
      duplicateSelected: () => act().duplicateSelected(),
      copySelected: () => act().copySelected(),
      pasteClipboard: pasteRequested,
      nudge: (dx, dy) => act().nudge(dx, dy),
      cycleSelection: (d) => act().cycleSelection(current, d),
      stepAnnotation,
      selectAll: () => act().selectAllOnPage(current),
      editSelected: () => {
        const id = act().selectedIds[0];
        if (id) act().setEditing(id);
      },
      deselect: () => {
        setShowHelp(false);
        setShowPalette(false);
        if (showSearch) {
          setShowSearch(false);
          act().setSearch('', []);
        }
        act().select(null);
        act().setTool('select');
      },
      goPage: (to) => {
        const last = (pdf?.numPages ?? 1) - 1;
        // Stepping walks past hidden pages, since there is nothing there to
        // land on. Jumping straight to a number still goes where it is told.
        if (to === 'next' || to === 'prev') {
          const step = to === 'next' ? 1 : -1;
          let i = current + step;
          while (i >= 0 && i <= last && hidden.has(i)) i += step;
          if (i >= 0 && i <= last) goTo(i);
          return;
        }
        const i = to === 'first' ? 0 : to === 'last' ? last : (to as number);
        goTo(Math.max(0, Math.min(last, i)));
      },
      promptGoPage: () => {
        const n = Number(prompt(`Go to page (1 to ${pdf?.numPages})`));
        if (n >= 1 && n <= (pdf?.numPages ?? 1)) goTo(n - 1);
      },
      pageOp: runPageOp,
      movePage,
      rotate: (delta) => runPageOp({ op: 'rotate', index: current, delta }),
      exportPdf,
      exportJson,
      back: onBack,
      toggleSidebar: () => act().toggle('sidebarOpen'),
      toggleList: () => act().toggle('listOpen'),
      toggleOutline: () => act().toggle('outlineOpen'),
      toggleHelp: () => setShowHelp((v) => !v),
      toggleInvert: () => act().toggle('invert'),
      toggleSearch: () => setShowSearch((v) => !v),
      togglePalette: () => setShowPalette((v) => !v),
      currentPage: current,
    }),
    [current, pdf, fit, runPageOp, movePage, goTo, showSearch, meta, exporting, zoomAround,
     hidden, stepAnnotation]
  );

  useShortcuts(ctx, setPanning);

  /**
   * Which page you are on, measured from where the pages actually sit. This
   * used to come from each page's IntersectionObserver, but that observer
   * carries a 700px rootMargin for canvas retention, so pages well off screen
   * reported as visible; and during a fast scroll its entries arrive in one
   * batch in no particular order, so whichever fired last won. Between the two
   * the sidebar could settle five or ten pages away from the screen.
   */
  const readCurrent = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    // A little above the middle, which is where a reader's eye sits, so the
    // page turns over about when the next one takes the screen.
    const mark = box.top + box.height * 0.45;

    let best = -1;
    let bestGap = Infinity;
    for (const shell of Array.from(el.querySelectorAll('[data-page]')) as HTMLElement[]) {
      const r = shell.getBoundingClientRect();
      // Zero once the mark is inside this page, otherwise how far away it is.
      const gap = r.top > mark ? r.top - mark : r.bottom < mark ? mark - r.bottom : 0;
      if (gap < bestGap) {
        bestGap = gap;
        best = Number(shell.dataset.page);
      }
      if (gap === 0) break;
    }
    if (best >= 0) setCurrent((c) => (c === best ? c : best));
  }, []);

  // Coalesced to one reading per frame: a fast scroll fires far more events
  // than there are frames to show them in.
  const scrollTick = useRef(0);
  const onScroll = useCallback(() => {
    if (scrollTick.current) return;
    scrollTick.current = requestAnimationFrame(() => {
      scrollTick.current = 0;
      readCurrent();
    });
  }, [readCurrent]);

  useEffect(() => () => {
    if (scrollTick.current) cancelAnimationFrame(scrollTick.current);
  }, []);

  // Zooming, hiding a page and reloading the file all move the pages under a
  // scroll position that did not itself change.
  useEffect(() => {
    readCurrent();
  }, [pdf, scale, hidden, readCurrent]);

  /**
   * Jumps to the remembered page once the shells are laid out. `pageSizes` gives
   * every shell its height up front, so one jump lands: waiting for the pages to
   * render would mean scrolling into a document that was still growing.
   */
  useLayoutEffect(() => {
    const want = restoreTo.current;
    if (want === null || !pdf || !pageSizes.length) return;
    restoreTo.current = null;
    const el = scrollRef.current;
    const shell = el?.querySelector(`[data-page="${want}"]`) as HTMLElement | null;
    if (!el || !shell) return;
    el.scrollTop = shell.offsetTop - GAP_PX;
    setCurrent(want);
  }, [pdf, pageSizes]);

  // Remembered as you read, debounced, so the write is one page behind at worst
  // and a fast scroll through fifty pages is not fifty requests.
  useEffect(() => {
    if (!opened.current) return;
    const t = setTimeout(() => {
      api.setLastPage(docId, current).catch(() => {
        /* the place is a convenience, not worth an error banner */
      });
    }, 600);
    return () => clearTimeout(t);
  }, [docId, current]);

  function startPan(e: React.PointerEvent) {
    const el = scrollRef.current!;
    const sx = e.clientX;
    const sy = e.clientY;
    const left = el.scrollLeft;
    const top = el.scrollTop;
    function move(ev: PointerEvent) {
      el.scrollLeft = left - (ev.clientX - sx);
      el.scrollTop = top - (ev.clientY - sy);
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  if (loadError) {
    return (
      <div className="p-8 text-neutral-300">
        <p className="mb-3">This document could not be opened: {loadError}</p>
        <button className="px-3 py-1.5 bg-sky-600 rounded text-sm text-white" onClick={onBack}>
          Back to library
        </button>
      </div>
    );
  }

  if (!meta || !pdf) return <div className="p-8 text-neutral-400">Opening document</div>;

  return (
    <div className="h-full flex flex-col">
      <Toolbar
        name={meta.originalName}
        onRename={rename}
        page={current + 1}
        pageCount={pdf.numPages}
        onGoToPage={goTo}
        onZoom={(n) => zoomAround(n)}
        onBack={onBack}
        onHelp={() => setShowHelp(true)}
        onSearch={() => setShowSearch(true)}
        onExport={exportPdf}
        onExportJson={exportJson}
        exporting={exporting}
      />

      {showSearch && (
        <SearchBar
          pdf={pdf}
          onGoToMatch={goToMatch}
          onClose={() => {
            setShowSearch(false);
            act().setSearch('', []);
          }}
        />
      )}

      {busy && (
        <div className="px-3 py-1 bg-amber-700 text-amber-50 text-xs">
          Rearranging pages. Editing is paused until this finishes.
        </div>
      )}

      {lastError && (
        <div className="px-3 py-1 bg-rose-800 text-rose-50 text-xs flex justify-between">
          <span>{lastError}</span>
          <button className="underline" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {outlineOpen && <OutlinePanel pdf={pdf} onGo={goTo} />}

        {/* With the sidebar away, this strip is the way back to it. The toolbar
            button does the same job but is easy to miss among the tools. */}
        {!sidebarOpen && (
          <button
            className="shrink-0 w-5 bg-neutral-900 border-r border-neutral-800 text-neutral-500 hover:bg-neutral-800 hover:text-white text-xs"
            title="Show page thumbnails (Ctrl+B)"
            aria-label="Show page thumbnails"
            onClick={() => act().toggle('sidebarOpen')}
          >
            »
          </button>
        )}

        {sidebarOpen && (
          <PageSidebar
            pdf={pdf}
            pageCount={pdf.numPages}
            current={current}
            hidden={hiddenList}
            flash={flash}
            sizes={pageSizes}
            onGo={goTo}
            onOp={runPageOp}
            onReorder={reorder}
            onSetHidden={setHidden}
            onCollapse={() => act().toggle('sidebarOpen')}
          />
        )}

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={`flex-1 overflow-auto pl-10 relative ${tool === 'eraser' ? 'tool-eraser' : ''}`}
          style={{ filter: invert ? 'invert(1) hue-rotate(180deg)' : undefined }}
        >
          {/*
            Flattened rather than wrapped: a page shell has to stay a direct
            child of this scroller, since that is what everything measuring the
            document reaches for. A gap sits above every page, so a blank one
            can go in wherever you are reading instead of only from the
            thumbnail bar.
          */}
          {shown.flatMap((i, n) => {
            const row = [
              <PageGap key={`gap-${reloadKey}-${i}`} at={i} busy={busy} onInsert={insertAt} />,
              <PdfPage
                key={`${reloadKey}-${i}`}
                pdf={pdf}
                pageIndex={i}
                scale={scale}
                natural={pageSizes[i]}
              />,
            ];
            if (n === shown.length - 1)
              row.push(
                <PageGap
                  key={`gap-end-${reloadKey}`}
                  at={pdf.numPages}
                  busy={busy}
                  onInsert={insertAt}
                  last
                />
              );
            return row;
          })}

          {panning && (
            <div
              className="fixed inset-0 z-40 cursor-grab active:cursor-grabbing"
              onPointerDown={startPan}
            />
          )}
        </div>

        {listOpen && (
          <AnnotationList onGo={goTo} onStep={stepAnnotation} current={current} />
        )}
      </div>

      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
      {showPalette && <CommandPalette ctx={ctx} onClose={() => setShowPalette(false)} />}
    </div>
  );
}
