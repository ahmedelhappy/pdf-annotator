import { useEffect, useState } from 'react';
import { AUTO_COLOR, MAX_FONT, MIN_FONT, PRESETS, useStore } from '../store';
import type { Tool } from '../types';

/**
 * One 20x20 glyph per tool, drawn inline so the app still works offline and
 * nothing extra has to be bundled. `currentColor` lets the active state and
 * hover colour come from the button.
 */
const ICONS: Record<Tool, JSX.Element> = {
  select: <path d="M5 3l10 8-4.2.9 2.3 4.7-1.9.9-2.3-4.8L5 15.6z" />,
  ink: <path d="M3 16.2l1-3 8-8 2.9 2.9-8 8zM13.2 3.9l1.3-1.3a1 1 0 011.4 0l1.5 1.5a1 1 0 010 1.4l-1.3 1.3z" />,
  eraser: (
    <path d="M8.6 3.6a1.4 1.4 0 012 0l5.8 5.8a1.4 1.4 0 010 2l-5 5H17v1.8H8.2l-4.6-4.6a1.4 1.4 0 010-2zm-.3 3.1l-3.3 3.3 4.3 4.3 3.3-3.3z" />
  ),
  highlight: <path d="M4 14.5l6.6-9.7 4.6 3.1-6.6 9.7H6.3zM3 18.2h14V20H3z" />,
  rect: (
    <path d="M2.5 3h5v1.8h-5zm7 0h5v1.8h-5zM2.5 15.2h5V17h-5zm7 0h5V17h-5zM2.5 4.8h1.8v4H2.5zm0 5.4h1.8v4H2.5zM15.7 4.8h1.8v4h-1.8zm0 5.4h1.8v4h-1.8z" />
  ),
  text: <path d="M4 3h12v2.6h-4.6V17H8.6V5.6H4z" />,
  note: <path d="M3.5 3h13v9.5L12 17H3.5zm7.6 12.4l3.9-3.9h-3.9z" />,
  image: (
    <path d="M2.5 3.5h15v13h-15zm1.8 1.8v7.3l3.4-3.4 2.6 2.6 2.6-2.6 2.8 2.8V5.3zm8.4 1.4a1.4 1.4 0 110 2.8 1.4 1.4 0 010-2.8z" />
  ),
};

const clampFont = (n: number) => Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, n)));

const TOOLS: [Tool, string, string][] = [
  ['select', 'Select', 'V'],
  ['ink', 'Draw', 'P'],
  ['eraser', 'Erase', 'E'],
  ['highlight', 'Highlight', 'H'],
  ['rect', 'Area', 'R'],
  ['text', 'Text', 'T'],
  ['note', 'Note', 'N'],
  ['image', 'Image', 'I'],
];

type Props = {
  name: string;
  /** 1-based page currently in view, and how many there are. */
  page: number;
  pageCount: number;
  onGoToPage: (index: number) => void;
  /** Routed through the viewer so a zoom holds the middle of the page still. */
  onZoom: (scale: number) => void;
  onBack: () => void;
  onExport: () => void;
  onExportJson: () => void;
  onHelp: () => void;
  onSearch: () => void;
  exporting: boolean;
};

export default function Toolbar({
  name, page, pageCount, onGoToPage, onZoom, onBack, onExport, onExportJson,
  onHelp, onSearch, exporting,
}: Props) {
  const tool = useStore((s) => s.tool);
  const style = useStore((s) => s.style);
  const palette = useStore((s) => s.palette);
  const scale = useStore((s) => s.scale);
  const pendingCount = useStore((s) => s.pendingCount);
  const setTool = useStore((s) => s.setTool);
  const setStyle = useStore((s) => s.setStyle);
  const pickColor = useStore((s) => s.pickColor);
  const listOpen = useStore((s) => s.listOpen);
  const selectedIds = useStore((s) => s.selectedIds);
  const annotations = useStore((s) => s.annotations);
  const toggle = useStore((s) => s.toggle);
  const setPaletteColor = useStore((s) => s.setPaletteColor);
  /**
   * Which swatch has its shade picker open, if any. The swatch itself is the
   * only thing that closes it, so picking a shade and carrying on drawing does
   * not make it vanish underneath you.
   */
  const [wheel, setWheel] = useState<number | null>(null);
  // Local so typing does not fight the number that scrolling keeps updating.
  const [pageBox, setPageBox] = useState(String(page));
  useEffect(() => setPageBox(String(page)), [page]);
  const applyPreset = useStore((s) => s.applyPreset);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);

  const btn = 'px-2 py-1 rounded text-sm hover:bg-neutral-800';

  /**
   * The size box is only there when it applies: the text and note tools, or a
   * selection that contains something with words in it, where changing the
   * number resizes what is already on the page through setStyle.
   */
  const withWords = annotations.filter(
    (a) => selectedIds.includes(a._id) && (a.type === 'text' || a.type === 'note')
  );
  const showFont = tool === 'text' || tool === 'note' || withWords.length > 0;

  /**
   * What the box reads. With something selected it is that annotation's own
   * size, not the pen's, or dragging a corner would scale the text on the page
   * while the number sat unchanged at whatever the pen happened to be.
   */
  const shownFont = withWords.length ? withWords[0].style?.fontSize ?? style.fontSize : style.fontSize;

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-neutral-900 text-neutral-200 border-b border-neutral-800 flex-wrap">
      <button className={btn} onClick={onBack}>Library</button>
      <span className="text-sm text-neutral-400 truncate max-w-40" title={name}>{name}</span>

      <span className="w-px h-5 bg-neutral-700 mx-1" />
      {TOOLS.map(([t, label, key]) => (
        <button
          key={t}
          title={`${label} (${key})`}
          aria-label={label}
          aria-pressed={tool === t}
          onClick={() => setTool(t)}
          className={`p-1.5 rounded ${
            tool === t ? 'bg-sky-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'
          }`}
        >
          <svg viewBox="0 0 20 20" className="w-5 h-5 block" fill="currentColor" aria-hidden>
            {ICONS[t]}
          </svg>
        </button>
      ))}

      <span className="w-px h-5 bg-neutral-700 mx-1" />
      {/*
        Auto reads the page under each new mark and picks something that shows
        up on it, so a dark figure gets light ink and paper gets dark. It is
        decided once per annotation, so what is stored stays an ordinary colour.
      */}
      <button
        title="Auto contrast. Each new mark takes a colour that shows up on what is under it."
        aria-label="Auto contrast colour"
        aria-pressed={style.color === AUTO_COLOR}
        onClick={() => pickColor(AUTO_COLOR)}
        className={`w-5 h-5 rounded-full border border-black/30 text-[9px] font-bold leading-none text-neutral-800 ${
          style.color === AUTO_COLOR ? 'ring-2 ring-white' : ''
        }`}
        style={{ background: 'linear-gradient(135deg,#f8fafc 0 50%,#111827 50% 100%)' }}
      >
        <span className="sr-only">Auto</span>
      </button>

      {palette.map((c, i) => (
        <span key={i} className="relative w-5 h-5">
          <button
            title={
              style.color === c
                ? `Color ${i + 1}. Click again to change the shade.`
                : `Color ${i + 1}. Right click to change the shade.`
            }
            // First click picks the colour. Clicking the one already in use
            // toggles the shade picker, so it opens and closes on repeat
            // clicks rather than reopening every time.
            onClick={() =>
              style.color === c
                ? setWheel((w) => (w === i ? null : i))
                : pickColor(c)
            }
            onContextMenu={(e) => {
              e.preventDefault();
              setWheel((w) => (w === i ? null : i));
            }}
            className={`w-5 h-5 rounded-full border border-black/30 ${
              style.color === c ? 'ring-2 ring-white' : ''
            }`}
            style={{ background: c }}
          />

          {wheel === i && (
            <div
              className="absolute left-1/2 -translate-x-1/2 top-7 z-50 bg-neutral-800 border border-neutral-700 rounded shadow-xl p-2"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <input
                type="color"
                value={c}
                autoFocus
                title="This shade is saved and comes back next time you open the app"
                className="w-28 h-8 bg-transparent cursor-pointer"
                onChange={(e) => {
                  setPaletteColor(i, e.target.value);
                  pickColor(e.target.value);
                }}
              />
            </div>
          )}
        </span>
      ))}
      <input
        type="range" min={1} max={20} value={style.width} className="w-20"
        title={`Stroke width ${style.width}`}
        onChange={(e) => setStyle({ width: +e.target.value })}
      />
      {/*
        Font size for text boxes and notes. Shown only for the tools it means
        anything to, or with a text box selected, where it resizes what is
        already on the page. Kept as a number box rather than a dropdown so any
        size can be typed, not just the handful worth listing.
      */}
      {showFont && (
        <span className="flex items-center gap-1 text-sm text-neutral-400">
          <span className="text-xs">Aa</span>
          <input
            type="number"
            min={MIN_FONT}
            max={MAX_FONT}
            step={1}
            value={Math.round(shownFont * 10) / 10}
            title={`Font size ${Math.round(shownFont * 10) / 10} points`}
            aria-label="Font size"
            className="w-14 bg-neutral-800 rounded px-1 py-1 text-sm text-neutral-200"
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setStyle({ fontSize: clampFont(n) });
            }}
          />
          <button className={btn} title="Smaller text"
            onClick={() => setStyle({ fontSize: clampFont(shownFont - 2) })}>A-</button>
          <button className={btn} title="Larger text"
            onClick={() => setStyle({ fontSize: clampFont(shownFont + 2) })}>A+</button>
        </span>
      )}

      <select
        className="bg-neutral-800 text-sm rounded px-1 py-1"
        value=""
        onChange={(e) => {
          const p = PRESETS[+e.target.value];
          if (p) applyPreset(p);
          e.target.value = '';
        }}
      >
        <option value="">Presets</option>
        {PRESETS.map((p, i) => (
          <option key={p.name} value={i}>{p.name}</option>
        ))}
      </select>

      {/* No sidebar toggle here. The strip down the left edge and Ctrl+B are
          both closer to hand, and the toolbar is busy enough. */}
      <span className="w-px h-5 bg-neutral-700 mx-1" />
      {/* Type a page number to go there. Shows where you are the rest of the
          time, and takes whatever you were reading back if you type nonsense. */}
      <span className="flex items-center gap-1 text-sm text-neutral-400">
        <input
          type="text"
          inputMode="numeric"
          aria-label="Page number"
          className="w-10 bg-neutral-800 rounded px-1 py-0.5 text-center text-neutral-100 tabular-nums"
          value={pageBox}
          onChange={(e) => setPageBox(e.target.value.replace(/[^0-9]/g, ''))}
          onFocus={(e) => e.target.select()}
          onBlur={() => setPageBox(String(page))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const n = Number(pageBox);
              if (n >= 1 && n <= pageCount) onGoToPage(n - 1);
              else setPageBox(String(page));
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'Escape') {
              setPageBox(String(page));
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className="whitespace-nowrap">of {pageCount}</span>
      </span>

      <span className="w-px h-5 bg-neutral-700 mx-1" />
      <button className={btn} title="Zoom out" onClick={() => onZoom(scale - 0.15)}>−</button>
      <span className="text-sm w-12 text-center tabular-nums">{Math.round(scale * 100)}%</span>
      <button className={btn} title="Zoom in" onClick={() => onZoom(scale + 0.15)}>+</button>
      <button className={btn} onClick={onSearch}>Find</button>

      <span className="w-px h-5 bg-neutral-700 mx-1" />
      <button className={btn} onClick={undo}>Undo</button>
      <button className={btn} onClick={redo}>Redo</button>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-xs text-neutral-500">
          {pendingCount > 0 ? 'Saving' : 'Saved'}
        </span>
        <button className={btn} title="Keyboard shortcuts" onClick={onHelp}>?</button>
        <button
          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 rounded text-sm text-white disabled:opacity-50"
          onClick={onExport}
          disabled={exporting}
        >
          {exporting ? 'Exporting' : 'Export PDF'}
        </button>
        <button className="px-2 py-1 text-xs hover:bg-neutral-800 rounded" onClick={onExportJson}>
          JSON
        </button>
        {/* Last on the row, next to the panel it opens. The annotation list had
            no way in but a shortcut that ships switched off, so a document's
            marks were only findable by scrolling to them. */}
        <button
          className={`${btn} ${listOpen ? 'bg-sky-600 text-white' : ''}`}
          title="List every annotation in this document (Ctrl+L)"
          aria-label="Annotation list"
          aria-pressed={listOpen}
          onClick={() => toggle('listOpen')}
        >
          Marks
        </button>
      </div>
    </div>
  );
}
