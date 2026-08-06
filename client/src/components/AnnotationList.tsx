import { useStore } from '../store';
import type { Annotation } from '../types';

const LABEL: Record<string, string> = {
  ink: 'Drawing',
  highlight: 'Highlight',
  text: 'Text',
  note: 'Note',
  image: 'Image',
};

function preview(a: Annotation) {
  if (a.type === 'text' || a.type === 'note')
    return (a.data?.text || '').slice(0, 60) || 'Empty';
  if (a.type === 'ink') return `${a.data?.points?.length ?? 0} points`;
  if (a.type === 'image') return 'Placed image';
  return '';
}

export default function AnnotationList({
  onGo, onStep,
}: {
  onGo: (page: number) => void;
  onStep: (dir: 1 | -1) => void;
}) {
  const annotations = useStore((s) => s.annotations);
  const selectedIds = useStore((s) => s.selectedIds);
  const select = useStore((s) => s.select);
  const remove = useStore((s) => s.remove);

  const sorted = [...annotations].sort(
    (a, b) => a.pageIndex - b.pageIndex || (a.z ?? 0) - (b.z ?? 0)
  );

  const step = 'px-1.5 rounded hover:bg-neutral-700 disabled:opacity-40';

  return (
    <div className="w-64 shrink-0 bg-neutral-900 border-l border-neutral-800 overflow-y-auto text-neutral-300">
      <div className="px-3 py-2 text-xs uppercase tracking-wide text-neutral-500 sticky top-0 bg-neutral-900 border-b border-neutral-800 flex items-center justify-between">
        <span>Annotations ({annotations.length})</span>
        {/* Walks the marks in reading order, however far apart they are. The
            same thing Ctrl+Alt+N and Ctrl+Alt+P do. */}
        <span className="flex gap-1">
          <button className={step} disabled={!annotations.length}
            title="Previous annotation (Ctrl+Alt+P)" aria-label="Previous annotation"
            onClick={() => onStep(-1)}>↑</button>
          <button className={step} disabled={!annotations.length}
            title="Next annotation (Ctrl+Alt+N)" aria-label="Next annotation"
            onClick={() => onStep(1)}>↓</button>
        </span>
      </div>

      {sorted.map((a) => (
        <div
          key={a._id}
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

      {!annotations.length && (
        <div className="p-4 text-sm text-neutral-500">
          Nothing here yet. Draw, highlight, or drop a note on the page and it will show up in
          this list.
        </div>
      )}
    </div>
  );
}
