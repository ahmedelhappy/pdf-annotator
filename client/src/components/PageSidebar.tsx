import { memo, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { rectToBox, toView } from '../lib/geometry';
import { strokeOutline } from '../lib/ink';
import { useStore } from '../store';
import type { Flash } from './Viewer';
import type { Annotation } from '../types';

const EMPTY: Annotation[] = [];

/**
 * One button, two states. A plain eye means the page is showing, a crossed out
 * one means it is skipped, the way a mute button shows what you would get.
 */
const EyeIcon = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 block" aria-hidden
    fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M1.5 10S4.6 4.5 10 4.5 18.5 10 18.5 10 15.4 15.5 10 15.5 1.5 10 1.5 10Z" />
    <circle cx="10" cy="10" r="2.5" />
    {off && <path d="M3 17 17 3" />}
  </svg>
);

/** Thumbnail width in layout pixels, and how many real pixels each one gets. */
const THUMB_W = 160;
const THUMB_DENSITY = Math.min(window.devicePixelRatio || 1, 2) * 2;

/** Roughly how big the right click menu is, for keeping it on screen. */
const MENU_W = 208;
const MENU_H = 300;

/** Placed pictures, kept across repaints so a thumbnail does not flicker. */
const imageCache = new Map<string, HTMLImageElement>();

function imageFor(assetId: string, onLoad: () => void) {
  let img = imageCache.get(assetId);
  if (!img) {
    img = new Image();
    img.src = api.assetUrl(assetId);
    img.addEventListener('load', onLoad, { once: true });
    imageCache.set(assetId, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

/**
 * Paints the cached page bitmap, then the annotations over it. Rendering the
 * PDF again on every edit would be far too slow, so the page is drawn once and
 * only this compositing step repeats.
 */
function paint(
  el: HTMLCanvasElement,
  base: HTMLCanvasElement,
  vp: any,
  anns: Annotation[],
  onLoad: () => void
) {
  const g = el.getContext('2d');
  if (!g) return;
  el.width = base.width;
  el.height = base.height;
  g.drawImage(base, 0, 0);

  for (const a of anns) {
    g.save();
    g.globalAlpha = a.style?.opacity ?? 1;
    g.fillStyle = a.style?.color || '#e11d48';

    if (a.type === 'ink') {
      const pts = (a.data?.points || []).map((p: any) => {
        const v = toView(vp, p.x, p.y);
        return { x: v.x, y: v.y, p: p.p };
      });
      if (pts.length) g.fill(new Path2D(strokeOutline(pts, (a.style?.width ?? 2) * vp.scale)));
    } else if (a.type === 'note') {
      const v = toView(vp, a.data.x, a.data.y);
      g.beginPath();
      g.arc(v.x, v.y, 3, 0, Math.PI * 2);
      g.fill();
    } else {
      const b = rectToBox(vp, a.data);
      if (a.type === 'image') {
        const img = a.data.assetId ? imageFor(a.data.assetId, onLoad) : null;
        if (img) g.drawImage(img, b.left, b.top, b.width, b.height);
      } else if (a.type === 'highlight') {
        // One box per line for a highlight that spanned several.
        for (const r of a.data.rects?.length ? a.data.rects : [a.data]) {
          const q = rectToBox(vp, r);
          g.fillRect(q.left, q.top, q.width, q.height);
        }
      } else {
        // Text is far too small to read here, so it reads as a tinted band.
        g.globalAlpha = (a.style?.opacity ?? 1) * 0.5;
        g.fillRect(b.left, b.top, b.width, Math.max(2, b.height));
      }
    }
    g.restore();
  }
}

// Memoised because the sidebar re-renders on every page turn, and a long
// document has hundreds of these. Nothing here changes unless the file or the
// page number does; the annotations come from the store on their own.
const Thumb = memo(function Thumb({ pdf, index }: { pdf: any; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const vpRef = useRef<any>(null);
  // Which pdf this canvas was painted from. A page op reloads the file, so the
  // identity changes and the thumbnail has to be repainted. Tracking it as a
  // boolean instead would latch on and leave the old page showing forever.
  const drawnFor = useRef<any>(null);
  const [baseReady, setBaseReady] = useState(0);

  const anns = useStore((s) => s.byPage[index]) ?? EMPTY;

  // Rendered only once the thumbnail scrolls into the sidebar, so a 400 page
  // document does not render 400 canvases on open.
  useEffect(() => {
    const el = ref.current;
    if (!el || drawnFor.current === pdf) return;
    let dead = false;

    const io = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting || dead) return;
      io.disconnect();
      try {
        const page = await pdf.getPage(index + 1);
        const natural = page.getViewport({ scale: 1 });
        // Rendered denser than it is shown, so the thumbnail is crisp rather
        // than a blur of enlarged pixels. The canvas is laid out at w-full, so
        // the browser scales it back down.
        const vp = page.getViewport({ scale: (THUMB_W * THUMB_DENSITY) / natural.width });
        if (dead) return;
        const base = document.createElement('canvas');
        base.width = vp.width;
        base.height = vp.height;
        await page.render({ canvasContext: base.getContext('2d'), viewport: vp }).promise;
        if (dead) return;
        baseRef.current = base;
        vpRef.current = vp;
        drawnFor.current = pdf;
        setBaseReady((n) => n + 1);
      } catch {
        /* page vanished during a reorder, the parent will remount us */
      }
    }, { threshold: 0.05 });

    io.observe(el);
    return () => {
      dead = true;
      io.disconnect();
    };
  }, [pdf, index]);

  // Debounced so a drag redraws once at the end rather than on every frame.
  useEffect(() => {
    const el = ref.current;
    if (!el || !baseRef.current) return;
    const repaint = () => paint(el, baseRef.current!, vpRef.current, anns, () => setBaseReady((n) => n + 1));
    const t = setTimeout(repaint, 300);
    return () => clearTimeout(t);
  }, [anns, baseReady]);

  // Fills the shape its card reserved, so it never changes the list's height.
  return <canvas ref={ref} className="w-full h-full block bg-white rounded" />;
});

/**
 * Right click menu for a page. Same manners as the annotation one: it closes on
 * the next pointer down anywhere, on any key, and on a scroll. The listener is
 * deferred by a tick, or the pointerup of the right click that opened it closes
 * it again straight away.
 */
function PageMenu({
  at, count, hidden, onPick, onClose,
}: {
  at: { x: number; y: number };
  /** How many pages the menu acts on, which is what makes the copy plural. */
  count: number;
  hidden: boolean;
  onPick: (what: 'hide' | 'left' | 'right' | 'duplicate' | 'above' | 'below' | 'delete') => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const bye = useRef(onClose);
  bye.current = onClose;

  useEffect(() => {
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) bye.current();
    };
    const key = () => bye.current();
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', away, true);
      window.addEventListener('keydown', key, true);
      window.addEventListener('wheel', key, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', key, true);
    };
  }, []);

  const many = count > 1;
  const noun = many ? `${count} selected pages` : 'page';
  const item = 'block w-full text-left px-3 py-1 text-sm hover:bg-neutral-100';

  return (
    <div
      ref={box}
      className="fixed bg-white rounded shadow-lg py-1 text-neutral-800 w-52 z-[3000]"
      style={{ left: at.x, top: at.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-3 pb-1 text-[11px] text-neutral-500">
        {many ? `${count} pages selected` : 'This page'}
      </div>
      <button className={item} onClick={() => onPick('hide')}>
        {hidden ? `Show ${noun}` : `Hide ${noun}`}
      </button>
      <div className="h-px bg-neutral-200 my-1" />
      <button className={item} onClick={() => onPick('left')}>Rotate {noun} left</button>
      <button className={item} onClick={() => onPick('right')}>Rotate {noun} right</button>
      <button className={item} onClick={() => onPick('duplicate')}>Duplicate {noun}</button>
      <div className="h-px bg-neutral-200 my-1" />
      {/* Inserting is about one spot, so it stays singular however many are
          picked: the blank page goes above or below the one right clicked. */}
      <button className={item} onClick={() => onPick('above')}>Insert blank page above</button>
      <button className={item} onClick={() => onPick('below')}>Insert blank page below</button>
      <div className="h-px bg-neutral-200 my-1" />
      <button className={`${item} text-rose-600`} onClick={() => onPick('delete')}>
        Delete {noun}
      </button>
    </div>
  );
}

type Props = {
  pdf: any;
  pageCount: number;
  current: number;
  /** Pages kept in the file but skipped in the viewer and at export. */
  hidden: number[];
  /** Pages to point out after a page op, arriving or leaving. */
  flash: Flash | null;
  /** Every page's size at scale 1, so a card can reserve its shape. */
  sizes: { w: number; h: number }[];
  onGo: (i: number) => void;
  onOp: (body: any) => void;
  onReorder: (order: number[]) => void;
  onSetHidden: (pages: number[]) => void;
  onCollapse: () => void;
};

export default function PageSidebar({
  pdf, pageCount, current, hidden, flash, sizes, onGo, onOp, onReorder, onSetHidden, onCollapse,
}: Props) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const width = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const picked = useStore((s) => s.selectedPages);
  const selectPages = useStore((s) => s.selectPages);
  const rootRef = useRef<HTMLDivElement>(null);
  const grab = useRef(false);
  /** Where a shift click measures its range from. */
  const anchor = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Pointing out a card off screen shows nobody anything, so the first one is
  // scrolled to. Instant, because the card is already partway through its own
  // animation by the time this runs.
  useEffect(() => {
    const first = flash?.pages.length ? Math.min(...flash.pages) : null;
    if (first === null) return;
    listRef.current
      ?.querySelector(`[data-thumb="${first}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [flash]);

  // The sidebar follows the reader. On page 20 of a long document the list
  // would otherwise still be sitting at page 1, with no thumbnail of anything
  // nearby. `nearest` is what keeps this from fighting you: a card already in
  // view is left exactly where it is.
  useEffect(() => {
    listRef.current?.querySelector(`[data-thumb="${current}"]`)?.scrollIntoView({
      block: 'nearest',
      // Instant, not smooth. The document scroll is already the animation, and
      // an animated sidebar restarts its own tween on every page turn, so it
      // never catches up and arrives a second behind the page you are reading.
      behavior: 'auto',
    });
  }, [current]);

  const isHidden = (i: number) => hidden.includes(i);
  const isPicked = (i: number) => picked.includes(i);

  /**
   * What a per-page button acts on. Pressing one inside a multiple selection
   * takes the whole selection, which is the point of picking several. Pressing
   * one outside it means that page alone.
   */
  const targets = (i: number) => (picked.length > 1 && isPicked(i) ? [...picked] : [i]);

  function pick(i: number, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      selectPages(isPicked(i) ? picked.filter((n) => n !== i) : [...picked, i]);
      anchor.current = i;
      return;
    }
    if (e.shiftKey) {
      const [lo, hi] = anchor.current < i ? [anchor.current, i] : [i, anchor.current];
      selectPages(Array.from({ length: hi - lo + 1 }, (_, k) => lo + k));
      return;
    }
    anchor.current = i;
    selectPages([i]);
    onGo(i);
  }

  /** Which page was right clicked, and where to draw its menu. */
  const [menu, setMenu] = useState<{ x: number; y: number; page: number } | null>(null);

  function openMenu(i: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Right clicking outside the selection acts on that page alone, so the
    // selection is dropped to match what the menu is about to say.
    if (!(picked.length > 1 && isPicked(i))) selectPages([i]);
    // Kept clear of the window edges, since the menu is taller than a card.
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - MENU_W - 8),
      y: Math.min(e.clientY, window.innerHeight - MENU_H - 8),
      page: i,
    });
  }

  function runMenu(what: string) {
    const i = menu?.page ?? 0;
    const list = targets(i);
    setMenu(null);
    if (what === 'hide') toggleHidden(list);
    else if (what === 'left') onOp({ op: 'rotate', indices: list, delta: -90 });
    else if (what === 'right') onOp({ op: 'rotate', indices: list, delta: 90 });
    else if (what === 'duplicate') onOp({ op: 'duplicate', indices: list });
    else if (what === 'above') onOp({ op: 'insert', index: i });
    else if (what === 'below') onOp({ op: 'insert', index: i + 1 });
    else if (what === 'delete') onOp({ op: 'delete', indices: list });
  }

  /** Hides the pages if any is still showing, otherwise brings them all back. */
  function toggleHidden(pages: number[]) {
    const showing = pages.some((i) => !isHidden(i));
    const next = showing
      ? [...new Set([...hidden, ...pages])]
      : hidden.filter((i) => !pages.includes(i));
    onSetHidden(next.sort((a, b) => a - b));
  }

  function drop(to: number) {
    const from = dragging;
    setDragging(null);
    setOver(null);
    if (from === null || from === to) return;
    const order = Array.from({ length: pageCount }, (_, i) => i);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    onReorder(order);
  }

  // Padding kept small so five controls and the page number still fit the row
  // at the narrowest the sidebar goes.
  const tiny = 'hover:text-white px-0.5';

  return (
    <div ref={rootRef} className="relative shrink-0 flex" style={{ width }}>
      {/*
        The resize grip lives outside the scrolling area, or it would slide up
        the page along with the thumbnails. Dragged narrow enough the store
        closes the sidebar instead, so one gesture both shrinks and hides it.
      */}
      <div
        title="Drag to resize. Drag it shut to hide."
        aria-label="Resize page thumbnails"
        role="separator"
        className="absolute top-0 bottom-0 right-0 w-1.5 cursor-col-resize hover:bg-sky-600/50 z-30"
        onPointerDown={(e) => {
          e.preventDefault();
          // Window listeners rather than pointer capture: the grip is pinned to
          // the sidebar's right edge, so it slides out from under the pointer as
          // the sidebar grows and the drag would stall after one step.
          const left = rootRef.current?.getBoundingClientRect().left ?? 0;
          const onMove = (ev: PointerEvent) => setSidebarWidth(ev.clientX - left);
          const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            grab.current = false;
          };
          grab.current = true;
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        }}
      />

      <div ref={listRef} className="flex-1 min-w-0 overflow-y-auto bg-neutral-900 border-r border-neutral-800 p-2 text-neutral-300">
      <div className="flex items-center justify-between mb-2 px-0.5 text-[11px] text-neutral-500">
        <span>
          {pageCount} {pageCount === 1 ? 'page' : 'pages'}
          {hidden.length > 0 && `, ${hidden.length} hidden`}
        </span>
        <button
          className="px-1 hover:text-white"
          title="Hide page thumbnails (Ctrl+B)"
          aria-label="Hide page thumbnails"
          onClick={onCollapse}
        >
          «
        </button>
      </div>

      {/* Ctrl or shift click picks several pages and this bar acts on all of
          them at once. It only appears once there is more than one. */}
      {picked.length > 1 && (
        <div className="mb-2 rounded bg-sky-950 border border-sky-800 p-1.5 text-[11px]">
          <div className="flex items-center justify-between text-sky-200">
            <span>{picked.length} pages selected</span>
            <button className="hover:text-white px-1" title="Clear the selection"
              onClick={() => selectPages([])}>✕</button>
          </div>
          <div className="flex flex-wrap gap-1 mt-1 text-sky-300">
            <button className="hover:text-white" onClick={() => toggleHidden([...picked])}>
              {picked.some((i) => !isHidden(i)) ? 'Hide' : 'Show'}
            </button>
            <span className="text-sky-700">|</span>
            <button className="hover:text-white"
              onClick={() => onOp({ op: 'rotate', indices: [...picked], delta: -90 })}>Rotate left</button>
            <button className="hover:text-white"
              onClick={() => onOp({ op: 'rotate', indices: [...picked], delta: 90 })}>right</button>
            <span className="text-sky-700">|</span>
            <button className="hover:text-white"
              onClick={() => onOp({ op: 'duplicate', indices: [...picked] })}>Duplicate</button>
            <span className="text-sky-700">|</span>
            <button className="hover:text-rose-400"
              onClick={() => onOp({ op: 'delete', indices: [...picked] })}>Delete</button>
          </div>
        </div>
      )}

      {Array.from({ length: pageCount }, (_, i) => (
        <div
          key={i}
          data-thumb={i}
          draggable
          onDragStart={() => setDragging(i)}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(i);
          }}
          onDrop={() => drop(i)}
          onDragEnd={() => {
            setDragging(null);
            setOver(null);
          }}
          onClick={(e) => pick(i, e)}
          onContextMenu={(e) => openMenu(i, e)}
          aria-selected={isPicked(i)}
          aria-current={i === current}
          /*
            The two states have to read differently: the fill says what is
            picked, the outline says which page you are looking at. Sharing one
            colour left you unable to tell a selection from your own position.
          */
          className={`mb-2 rounded p-1.5 cursor-pointer border ${
            isPicked(i) ? 'bg-sky-700 border-sky-300' : 'hover:bg-neutral-800 border-transparent'
          } ${i === current ? 'border-amber-400 bg-neutral-800' : ''} ${
            over === i && dragging !== null ? 'border-t-2 border-t-pink-400' : ''
          } ${
            flash?.pages.includes(i) ? (flash.kind === 'in' ? 'page-arrive' : 'page-leave') : ''
          }`}
        >
          {/* A hidden page stays here, faded, so it can be brought back. Only
              the viewer and the exported copy skip it. The ring goes round the
              page itself, since a border on the card alone is easy to miss. */}
          {/*
            The card reserves the page's shape up front. A thumbnail renders
            only once it scrolls into the sidebar, so without this the cards
            below are the wrong height until they draw, the list keeps growing
            underneath itself, and following the reader lands short by however
            much everything above has since expanded.
          */}
          <div
            style={{ aspectRatio: sizes[i] ? sizes[i].w / sizes[i].h : 1 / 1.414 }}
            className={`rounded ${isHidden(i) ? 'opacity-30' : ''} ${
              i === current ? 'ring-2 ring-amber-400' : ''
            }`}
          >
            {pdf && <Thumb pdf={pdf} index={i} />}
          </div>
          {/* Wraps rather than spills: the sidebar can be dragged down to
              SIDEBAR_MIN, which is narrower than this row wants to be. */}
          <div className="flex flex-wrap justify-between items-center gap-x-1 mt-1 text-[11px]">
            <span className={i === current ? 'text-amber-400' : 'text-neutral-400'}>{i + 1}</span>
            <span className="flex flex-wrap items-center justify-end text-neutral-400">
              <button title={isHidden(i) ? 'Show this page' : 'Hide this page'}
                aria-label={isHidden(i) ? 'Show this page' : 'Hide this page'}
                aria-pressed={isHidden(i)}
                className={isHidden(i) ? 'px-1 text-amber-400 hover:text-white' : tiny}
                onClick={(e) => { e.stopPropagation(); toggleHidden(targets(i)); }}>
                <EyeIcon off={isHidden(i)} />
              </button>
              <button title="Rotate left" className={tiny}
                onClick={(e) => { e.stopPropagation(); onOp({ op: 'rotate', indices: targets(i), delta: -90 }); }}>↺</button>
              <button title="Rotate right" className={tiny}
                onClick={(e) => { e.stopPropagation(); onOp({ op: 'rotate', indices: targets(i), delta: 90 }); }}>↻</button>
              <button title="Duplicate page" className={tiny}
                onClick={(e) => { e.stopPropagation(); onOp({ op: 'duplicate', indices: targets(i) }); }}>⧉</button>
              <button title="Delete page" className="hover:text-rose-400 px-0.5"
                onClick={(e) => { e.stopPropagation(); onOp({ op: 'delete', indices: targets(i) }); }}>✕</button>
            </span>
          </div>
          <div className="flex flex-wrap gap-x-2 text-[10px] text-neutral-500 mt-0.5">
            <button className="hover:text-white"
              onClick={(e) => { e.stopPropagation(); onOp({ op: 'insert', index: i }); }}>Add above</button>
            <button className="hover:text-white"
              onClick={(e) => { e.stopPropagation(); onOp({ op: 'insert', index: i + 1 }); }}>below</button>
          </div>
        </div>
      ))}
      </div>

      {menu && (
        <PageMenu
          at={menu}
          count={targets(menu.page).length}
          hidden={isHidden(menu.page)}
          onPick={runMenu}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
