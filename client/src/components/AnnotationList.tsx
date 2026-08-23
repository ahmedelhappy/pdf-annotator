import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store';
import type { Annotation } from '../types';

const LABEL: Record<string, string> = {
  ink: 'Drawing',
  highlight: 'Highlight',
  text: 'Text',
  note: 'Note',
  image: 'Image',
  flag: 'Difficult',
};

function preview(a: Annotation) {
  if (a.type === 'text' || a.type === 'note')
    return (a.data?.text || '').slice(0, 60) || 'Empty';
  if (a.type === 'ink') return `${a.data?.points?.length ?? 0} points`;
  if (a.type === 'image') return 'Placed image';
  if (a.type === 'flag') return 'Marked as difficult';
  return '';
}

/** What a page's worth of marks adds up to, for the one-row-per-page view. */
function summarise(list: Annotation[]) {
  const counts = new Map<string, number>();
  for (const a of list) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  return [...counts]
    .map(([t, n]) => `${n} ${LABEL[t]?.toLowerCase() ?? t}${n > 1 ? 's' : ''}`)
    .join(', ');
}

export default function AnnotationList({
  onGo, onStep, current,
}: {
  onGo: (page: number) => void;
  onStep: (dir: 1 | -1) => void;
  /** The page being read, so the panel can follow it. */
  current: number;
}) {
  const annotations = useStore((s) => s.annotations);
  const selectedIds = useStore((s) => s.selectedIds);
  const select = useStore((s) => s.select);
  const remove = useStore((s) => s.remove);
  const byPageOnly = useStore((s) => s.marksByPage);
  const hardOnly = useStore((s) => s.marksHardOnly);
  const toggle = useStore((s) => s.toggle);

  const listRef = useRef<HTMLDivElement>(null);

  /** Flagged pages, so the difficult filter can keep a page's other marks too. */
  const hardPages = useMemo(
    () => new Set(annotations.filter((a) => a.type === 'flag').map((a) => a.pageIndex)),
    [annotations]
  );

  const shown = useMemo(() => {
    const list = hardOnly ? annotations.filter((a) => hardPages.has(a.pageIndex)) : annotations;
    return [...list].sort((a, b) => a.pageIndex - b.pageIndex || (a.z ?? 0) - (b.z ?? 0));
  }, [annotations, hardOnly, hardPages]);

  /** One row per page, holding that page's marks, in page order. */
  const pages = useMemo(() => {
    const byPage = new Map<number, Annotation[]>();
    for (const a of shown) {
      const at = byPage.get(a.pageIndex);
      if (at) at.push(a);
      else byPage.set(a.pageIndex, [a]);
    }
    return [...byPage.entries()].sort((a, b) => a[0] - b[0]);
  }, [shown]);

  /**
   * The panel follows whatever you are looking at: the page you have scrolled
   * to, or the mark you stepped onto with the arrows. Without this the list
   * stayed at the top and you had to find your place in it by hand.
   *
   * `nearest` so a row already on screen does not move, and instant rather than
   * smooth, because the document scroll is already the animation and a tween
   * that restarts on every page turn never catches up.
   */
  useEffect(() => {
    // By page there are no mark rows to aim at, only page rows, so the page
    // being read is the only thing to follow. Looking for the selected mark
    // there found nothing and the panel simply stopped keeping up.
    const pick =
      byPageOnly || !selectedIds[0]
        ? `[data-mark-page="${current}"]`
        : `[data-mark="${selectedIds[0]}"]`;
    const row = listRef.current?.querySelector(pick) as HTMLElement | null;
    row?.scrollIntoView({ block: 'nearest' });
  }, [current, selectedIds, byPageOnly, hardOnly]);

  const step = 'px-1.5 rounded hover:bg-neutral-700 disabled:opacity-40';
  const chip = (on: boolean) =>
    `px-1.5 rounded text-[11px] ${on ? 'bg-sky-600 text-white' : 'hover:bg-neutral-700'}`;

  return (
    <div
      ref={listRef}
      className="w-64 shrink-0 bg-neutral-900 border-l border-neutral-800 overflow-y-auto text-neutral-300"
    >
      <div className="sticky top-0 bg-neutral-900 border-b border-neutral-800">
        <div className="px-3 pt-2 text-xs uppercase tracking-wide text-neutral-500 flex items-center justify-between">
          <span>Marks ({shown.length})</span>
          {/* Walks the marks in reading order, however far apart they are. The
              same thing Ctrl+Alt+N and Ctrl+Alt+P do. */}
          <span className="flex gap-1">
            <button className={step} disabled={!annotations.length}
              title={byPageOnly ? 'Previous page with marks' : 'Previous annotation (Ctrl+Alt+P)'}
              aria-label={byPageOnly ? 'Previous page with marks' : 'Previous annotation'}
              onClick={() => onStep(-1)}>↑</button>
            <button className={step} disabled={!annotations.length}
              title={byPageOnly ? 'Next page with marks' : 'Next annotation (Ctrl+Alt+N)'}
              aria-label={byPageOnly ? 'Next page with marks' : 'Next annotation'}
              onClick={() => onStep(1)}>↓</button>
          </span>
        </div>
        {/* Two filters, both off by default, so the panel still opens as the
            plain list it always was. */}
        <div className="px-3 py-1.5 flex gap-1">
          <button
            className={chip(byPageOnly)}
            aria-pressed={byPageOnly}
            title="One line per page instead of one per mark"
            onClick={() => toggle('marksByPage')}
          >
            By page
          </button>
          <button
            className={chip(hardOnly)}
            aria-pressed={hardOnly}
            title="Only pages you have flagged as difficult"
            onClick={() => toggle('marksHardOnly')}
          >
            Difficult
          </button>
        </div>
      </div>

      {byPageOnly
        ? pages.map(([page, list]) => (
            <div
              key={page}
              data-mark-page={page}
              onClick={() => onGo(page)}
              className={`px-3 py-2 border-b border-neutral-800 cursor-pointer text-sm ${
                page === current ? 'bg-sky-900' : 'hover:bg-neutral-800'
              }`}
            >
              <div className="flex justify-between items-center">
                <span className="flex items-center gap-2">
                  {hardPages.has(page) && <span title="Flagged as difficult">⚑</span>}
                  Page {page + 1}
                </span>
                <span className="text-xs text-neutral-500">{list.length}</span>
              </div>
              <div className="text-xs text-neutral-400 truncate mt-0.5">{summarise(list)}</div>
            </div>
          ))
        : shown.map((a) => (
            <div
              key={a._id}
              data-mark={a._id}
              data-mark-page={a.pageIndex}
              onClick={() => {
                select(a._id);
                onGo(a.pageIndex);
              }}
              className={`px-3 py-2 border-b border-neutral-800 cursor-pointer text-sm ${
                selectedIds.includes(a._id) ? 'bg-sky-900' : 'hover:bg-neutral-800'
              }`}
            >
              <div className="flex justify-between items-center">
                <span className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full inline-block border border-black/30"
                    style={{ background: a.style?.color }} />
                  {LABEL[a.type]}
                </span>
                <span className="text-xs text-neutral-500">p{a.pageIndex + 1}</span>
              </div>
              <div className="text-xs text-neutral-400 truncate mt-0.5">{preview(a)}</div>
              <button
                className="text-[11px] text-rose-400 mt-1 hover:text-rose-300"
                onClick={(e) => {
                  e.stopPropagation();
                  remove([a._id]);
                }}
              >
                Delete
              </button>
            </div>
          ))}

      {!shown.length && (
        <div className="p-4 text-sm text-neutral-500">
          {hardOnly
            ? 'No pages are flagged yet. Pick the flag tool and click a hard part of a page.'
            : 'Nothing here yet. Draw, highlight, or drop a note on the page and it will show up in this list.'}
        </div>
      )}
    </div>
  );
}
