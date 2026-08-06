import { create } from 'zustand';
import { api } from './api';
import { translate } from './lib/geometry';
import type { ShortcutPrefs } from './lib/shortcuts';
import type { Annotation, Preset, SearchMatch, Style, Tool } from './types';

/**
 * Shipped swatches. Any of them can be redefined and the choice is kept. Five
 * and the automatic one: a longer row was more than the toolbar had room for.
 */
export const PALETTE = ['#e11d48', '#2563eb', '#16a34a', '#eab308', '#111827'];

const PALETTE_KEY = 'pdf-annotator.palette';

function loadPalette(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PALETTE_KEY) || 'null');
    if (!Array.isArray(saved)) return [...PALETTE];
    // Indexed against the built-in list so adding a swatch later still works.
    return PALETTE.map((c, i) => (typeof saved[i] === 'string' ? saved[i] : c));
  } catch {
    return [...PALETTE];
  }
}

const INITIAL_PALETTE = loadPalette();

/**
 * Stand-in for "work it out from what is underneath". Resolved to a real colour
 * the moment an annotation is created, so what gets stored and exported is
 * always an ordinary colour and nothing downstream has to know about this.
 */
export const AUTO_COLOR = 'auto';
/** What it resolves to: near-black over light paper, near-white over dark. */
export const AUTO_ON_LIGHT = '#111827';
export const AUTO_ON_DARK = '#f8fafc';
/** Highlighters need a wash, not ink: black over words would blot them out. */
export const AUTO_WASH_ON_LIGHT = '#facc15';
export const AUTO_WASH_ON_DARK = '#38bdf8';

/** Tools that already lay colour on the page, so a swatch leaves them alone. */
const COLOR_TOOLS = new Set<Tool>(['ink', 'highlight', 'rect', 'text', 'note']);

/**
 * What copying annotations leaves on the system clipboard. Recognised on paste
 * as "the last copy was in here", and plain enough to make sense if it is ever
 * pasted into something else.
 */
export const CLIP_MARKER = '[pdf annotator] annotations copied';

const SHORTCUT_KEY = 'pdf-annotator.shortcuts';

function loadShortcuts(): ShortcutPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(SHORTCUT_KEY) || 'null');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveShortcuts(prefs: ShortcutPrefs): ShortcutPrefs {
  try {
    localStorage.setItem(SHORTCUT_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode, the change still applies for this session */
  }
  return prefs;
}

/** The range the font size control offers, in PDF points. */
export const MIN_FONT = 6;
export const MAX_FONT = 96;

const STYLE_KEY = 'pdf-annotator.style';

const DEFAULT_STYLE: Style = { color: INITIAL_PALETTE[0], width: 2, opacity: 1, fontSize: 14 };

/**
 * The pen you were last using, brought back on the next visit. Only the four
 * fields are read back and each is checked, so an old or hand-edited entry
 * cannot put the toolbar into a state it has no controls for.
 */
function loadStyle(): Style {
  try {
    const raw = JSON.parse(localStorage.getItem(STYLE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STYLE };
    const num = (v: unknown, lo: number, hi: number, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
    return {
      color: typeof raw.color === 'string' ? raw.color : DEFAULT_STYLE.color,
      width: num(raw.width, 1, 20, DEFAULT_STYLE.width),
      opacity: num(raw.opacity, 0.05, 1, DEFAULT_STYLE.opacity),
      fontSize: num(raw.fontSize, MIN_FONT, MAX_FONT, DEFAULT_STYLE.fontSize),
    };
  } catch {
    return { ...DEFAULT_STYLE };
  }
}

function saveStyle(style: Style) {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(style));
  } catch {
    /* private mode, the choice still holds for this session */
  }
}

const SIDEBAR_KEY = 'pdf-annotator.sidebarWidth';
/** Dragged narrower than this and the sidebar closes instead. */
export const SIDEBAR_MIN = 120;
export const SIDEBAR_MAX = 420;

function loadNumber(key: string, fallback: number): number {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const PRESETS: Preset[] = [
  { name: 'Red pen', tool: 'ink', style: { color: '#e11d48', width: 2, opacity: 1, fontSize: 14 } },
  { name: 'Yellow highlighter', tool: 'highlight', style: { color: '#facc15', width: 2, opacity: 0.35, fontSize: 14 } },
  { name: 'Blue marker', tool: 'ink', style: { color: '#2563eb', width: 6, opacity: 0.8, fontSize: 14 } },
  { name: 'Black text', tool: 'text', style: { color: '#111827', width: 2, opacity: 1, fontSize: 14 } },
];

type Placed = { pageIndex: number; data: any };

type UndoEntry =
  | { kind: 'add'; anns: Annotation[] }
  | { kind: 'delete'; anns: Annotation[] }
  | { kind: 'update'; ids: string[]; before: any[]; after: any[] }
  | { kind: 'move'; id: string; before: Placed; after: Placed }
  // A page op is undone by the server: it holds the file as it was, which is
  // the only place the removed page content still exists.
  | { kind: 'pageop'; label: string };

const addEntry = (anns: Annotation[]): UndoEntry => ({ kind: 'add', anns });
const delEntry = (anns: Annotation[]): UndoEntry => ({ kind: 'delete', anns });
const updEntry = (ids: string[], before: any[], after: any[]): UndoEntry =>
  ({ kind: 'update', ids, before, after });

let tmpSeq = 0;
const nextTmpId = () => `tmp_${Date.now()}_${tmpSeq++}`;
export const isTmp = (id: string) => id.startsWith('tmp_');

/**
 * Rebuilds the page index while preserving array identity for pages whose
 * contents did not change, so a component subscribed to one page does not
 * re-render when a different page is edited.
 */
function reindex(
  prev: Record<number, Annotation[]>,
  anns: Annotation[]
): Record<number, Annotation[]> {
  const next: Record<number, Annotation[]> = {};
  for (const a of anns) (next[a.pageIndex] ||= []).push(a);
  // Paint order. Stable, so annotations that share a z keep the order they
  // arrived in and an untouched document looks exactly as it did.
  for (const key of Object.keys(next)) next[Number(key)].sort((p, q) => (p.z ?? 0) - (q.z ?? 0));
  for (const key of Object.keys(next)) {
    const k = Number(key);
    const before = prev[k];
    const after = next[k];
    if (
      before &&
      before.length === after.length &&
      before.every((x, i) => x === after[i])
    ) {
      next[k] = before;
    }
  }
  return next;
}

type State = {
  docId: string | null;
  annotations: Annotation[];
  byPage: Record<number, Annotation[]>;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  tool: Tool;
  style: Style;
  palette: string[];
  selectedIds: string[];
  /** Pages picked in the thumbnail bar, for acting on several at once. */
  selectedPages: number[];
  editingId: string | null;
  clipboard: Annotation[];
  scale: number;
  pendingCount: number;
  lastError: string | null;

  invert: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  shortcuts: ShortcutPrefs;
  listOpen: boolean;
  outlineOpen: boolean;

  searchQuery: string;
  searchMatches: SearchMatch[];
  searchCursor: number;

  load: (docId: string) => Promise<void>;
  setTool: (t: Tool) => void;
  setStyle: (s: Partial<Style>) => void;
  pickColor: (color: string) => void;
  setPaletteColor: (index: number, color: string) => void;
  applyPreset: (p: Preset) => void;
  setScale: (s: number) => void;
  select: (ids: string[] | string | null, additive?: boolean) => void;
  setEditing: (id: string | null) => void;
  selectPages: (pages: number[]) => void;
  pushPageOp: (label: string) => void;
  toggle: (k: 'invert' | 'sidebarOpen' | 'listOpen' | 'outlineOpen') => void;
  setSidebarWidth: (px: number) => void;
  setShortcut: (id: string, combo: string | null) => void;
  toggleShortcut: (id: string, on: boolean) => void;
  resetShortcuts: () => void;
  setError: (msg: string | null) => void;
  setSearch: (q: string, matches?: SearchMatch[]) => void;
  stepSearch: (dir: 1 | -1) => SearchMatch | null;

  add: (a: Partial<Annotation>) => Promise<Annotation | undefined>;
  update: (id: string, data: any) => void;
  moveToPage: (id: string, pageIndex: number, data: any) => void;
  setLayer: (id: string, where: 'front' | 'back' | 'forward' | 'backward') => void;
  toggleLock: (id: string) => void;
  updateStyle: (ids: string[], patch: Partial<Style>) => void;
  remove: (ids?: string[]) => Promise<void>;
  nudge: (dx: number, dy: number) => void;
  duplicateSelected: () => Promise<void>;
  copySelected: () => void;
  pasteAnnotations: (pageIndex: number) => Promise<boolean>;
  cycleSelection: (pageIndex: number, dir: 1 | -1) => void;
  selectAllOnPage: (pageIndex: number) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  flushPending: () => Promise<void>;
};

const dataTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dataBefore = new Map<string, any>();
let styleTimer: ReturnType<typeof setTimeout> | null = null;
const styleDirty = new Set<string>();
const inflight = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  p.catch(() => {}).finally(() => inflight.delete(p));
  return p;
}

export const useStore = create<State>((set, get) => ({
  docId: null,
  annotations: [],
  byPage: {},
  undoStack: [],
  redoStack: [],

  tool: 'select',
  style: loadStyle(),
  palette: INITIAL_PALETTE,
  selectedIds: [],
  selectedPages: [],
  editingId: null,
  clipboard: [],
  scale: 1.25,
  pendingCount: 0,
  lastError: null,

  invert: false,
  sidebarOpen: true,
  sidebarWidth: loadNumber(SIDEBAR_KEY, 176),
  shortcuts: loadShortcuts(),
  listOpen: false,
  outlineOpen: false,

  searchQuery: '',
  searchMatches: [],
  searchCursor: 0,

  async load(docId) {
    const annotations = await api.listAnnotations(docId);
    set((s) => ({
      docId,
      annotations,
      byPage: reindex({}, annotations),
      // A page op reloads the document, so this runs straight after one. Page
      // entries are kept, because the state they take back is on the server and
      // outlives the reload. Annotation entries are not: a renumber may have
      // moved or dropped whatever they point at.
      undoStack: s.docId === docId ? s.undoStack.filter((u) => u.kind === 'pageop') : [],
      redoStack: [],
      selectedIds: [],
      editingId: null,
      lastError: null,
    }));
  },

  setTool: (tool) =>
    set((s) => ({ tool, editingId: null, selectedIds: tool === 'select' ? s.selectedIds : [] })),

  setStyle: (patch) => {
    set((s) => {
      const style = { ...s.style, ...patch };
      saveStyle(style);
      return { style };
    });
    const { selectedIds, updateStyle } = get();
    if (selectedIds.length) updateStyle(selectedIds, patch);
  },

  /**
   * Picking a colour with nothing selected means you are about to draw, so it
   * reaches for the pen. Tools that already put colour on the page keep it:
   * changing the shade of a highlighter should leave you highlighting, not
   * drawing. With annotations selected it only recolours them.
   */
  pickColor: (color) => {
    const { selectedIds, tool, setStyle, setTool } = get();
    setStyle({ color });
    if (!selectedIds.length && !COLOR_TOOLS.has(tool)) setTool('ink');
  },

  // Swatches outlive the session, so a palette someone tuned is still theirs
  // after a restart.
  setPaletteColor: (index, color) =>
    set((s) => {
      const palette = s.palette.map((c, i) => (i === index ? color : c));
      try {
        localStorage.setItem(PALETTE_KEY, JSON.stringify(palette));
      } catch {
        /* private mode or a full quota, the colour still applies this session */
      }
      return { palette };
    }),

  applyPreset: (p) => {
    saveStyle(p.style);
    set({ tool: p.tool, style: { ...p.style } });
  },
  setScale: (scale) => set({ scale: Math.min(6, Math.max(0.2, +scale.toFixed(2))) }),

  // Additive follows the usual convention: shift or ctrl adds, and clicking
  // something already in the selection takes it back out again.
  select: (ids, additive = false) => {
    const list = ids === null ? [] : Array.isArray(ids) ? ids : [ids];
    set((s) => {
      // Reaching into the document lets go of any pages picked in the sidebar,
      // so Delete never has to guess which of the two you meant.
      if (!additive) return { selectedIds: list, editingId: null, selectedPages: [] };
      const next = new Set(s.selectedIds);
      for (const id of list) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return { selectedIds: Array.from(next), editingId: null };
    });
  },

  setEditing: (editingId) => set({ editingId }),
  selectPages: (selectedPages) => set({ selectedPages }),

  // Recorded so Ctrl+Z reaches page changes too. The entry carries only a name:
  // the state itself lives on the server, which kept the file.
  pushPageOp: (label) =>
    set((s) => ({
      undoStack: [...s.undoStack, { kind: 'pageop', label } as UndoEntry].slice(-50),
      redoStack: [],
    })),
  toggle: (k) => set((s) => ({ [k]: !s[k] }) as any),

  // Whatever the user rebinds or switches off, kept between sessions.
  setShortcut: (id, combo) =>
    set((s) => {
      const at = { ...(s.shortcuts[id] || {}) };
      if (combo) at.combo = combo;
      else delete at.combo;
      return { shortcuts: saveShortcuts({ ...s.shortcuts, [id]: at }) };
    }),

  toggleShortcut: (id, on) =>
    set((s) => ({
      shortcuts: saveShortcuts({
        ...s.shortcuts,
        [id]: { ...(s.shortcuts[id] || {}), off: !on },
      }),
    })),

  resetShortcuts: () => set({ shortcuts: saveShortcuts({}) }),

  // Dragging past the narrow end closes the sidebar rather than leaving a
  // useless sliver, and the width it was at is what comes back next time.
  setSidebarWidth: (px) => {
    if (px < SIDEBAR_MIN) return set({ sidebarOpen: false });
    const sidebarWidth = Math.min(SIDEBAR_MAX, Math.round(px));
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth));
    } catch {
      /* private mode, the width still applies for this session */
    }
    set({ sidebarWidth, sidebarOpen: true });
  },
  setError: (lastError) => set({ lastError }),

  setSearch: (searchQuery, searchMatches) =>
    set({ searchQuery, searchMatches: searchMatches ?? [], searchCursor: 0 }),

  stepSearch(dir) {
    const { searchMatches, searchCursor } = get();
    if (!searchMatches.length) return null;
    const next = (searchCursor + dir + searchMatches.length) % searchMatches.length;
    set({ searchCursor: next });
    return searchMatches[next];
  },

  // Renders immediately under a temporary id, then the real id from the server
  // replaces it everywhere, including inside the undo stacks.
  async add(a) {
    const { docId, style } = get();
    if (!docId) return;

    const optimistic: Annotation = {
      _id: nextTmpId(),
      documentId: docId,
      pageIndex: a.pageIndex!,
      type: a.type!,
      data: a.data,
      style: (a.style as Style) || style,
    };

    set((s) => {
      const annotations = [...s.annotations, optimistic];
      return {
        annotations,
        byPage: reindex(s.byPage, annotations),
        undoStack: [...s.undoStack, addEntry([optimistic])].slice(-50),
        redoStack: [],
        pendingCount: s.pendingCount + 1,
      };
    });

    try {
      const real = await track(
        api.createAnnotation(docId, {
          pageIndex: optimistic.pageIndex,
          type: optimistic.type,
          data: optimistic.data,
          style: optimistic.style,
        })
      );
      swapId(set, optimistic._id, real);

      // The create call carried the data as it was at creation time. If the
      // user already dragged or typed since then, push the newer version.
      const latest = get().annotations.find((x) => x._id === real._id);
      if (latest && JSON.stringify(latest.data) !== JSON.stringify(optimistic.data)) {
        track(api.patchAnnotation(real._id, { data: latest.data })).catch(() => {});
      }

      set((s) => ({ pendingCount: s.pendingCount - 1 }));
      return { ...optimistic, _id: real._id };
    } catch (e: any) {
      set((s) => {
        const annotations = s.annotations.filter((x) => x._id !== optimistic._id);
        return {
          annotations,
          byPage: reindex(s.byPage, annotations),
          undoStack: s.undoStack.filter(
            (u) => !(u.kind === 'add' && u.anns[0]._id === optimistic._id)
          ),
          pendingCount: s.pendingCount - 1,
          lastError: e.message,
        };
      });
      return undefined;
    }
  },

  // Repeated calls inside the debounce window collapse into one undo entry, so
  // a drag or a burst of arrow-key nudges undoes as a single action.
  update(id, data) {
    const prev = get().annotations.find((a) => a._id === id);
    if (!prev) return;
    if (!dataBefore.has(id)) dataBefore.set(id, prev.data);

    set((s) => {
      const annotations = s.annotations.map((a) => (a._id === id ? { ...a, data } : a));
      return { annotations, byPage: reindex(s.byPage, annotations) };
    });

    clearTimeout(dataTimers.get(id));
    dataTimers.set(
      id,
      setTimeout(() => {
        const before = dataBefore.get(id);
        dataBefore.delete(id);
        dataTimers.delete(id);
        const current = get().annotations.find((a) => a._id === id);
        if (!current) return;

        set((s) => ({
          undoStack: [...s.undoStack, updEntry([id], [before], [current.data])].slice(-50),
          redoStack: [],
        }));

        // A temporary id has no server row yet. add() reconciles once the real
        // id arrives, so nothing is lost by skipping the request here.
        if (isTmp(id)) return;

        set((s) => ({ pendingCount: s.pendingCount + 1 }));
        track(api.patchAnnotation(id, { data: current.data }))
          .catch((e) => set({ lastError: e.message }))
          .finally(() => set((s) => ({ pendingCount: s.pendingCount - 1 })));
      }, 700)
    );
  },

  // Dropping an annotation on a different page. Written straight through
  // rather than debounced: the caller has already converted the geometry into
  // the target page's user space, so a later debounced write carrying the old
  // page's coordinates would land it in the wrong place.
  moveToPage(id, pageIndex, data) {
    const prev = get().annotations.find((a) => a._id === id);
    if (!prev) return;
    if (prev.pageIndex === pageIndex) return get().update(id, data);

    clearTimeout(dataTimers.get(id));
    dataTimers.delete(id);
    dataBefore.delete(id);

    const entry: UndoEntry = {
      kind: 'move',
      id,
      before: { pageIndex: prev.pageIndex, data: prev.data },
      after: { pageIndex, data },
    };

    set((s) => {
      const annotations = s.annotations.map((a) =>
        a._id === id ? { ...a, pageIndex, data } : a
      );
      return {
        annotations,
        byPage: reindex(s.byPage, annotations),
        undoStack: [...s.undoStack, entry].slice(-50),
        redoStack: [],
      };
    });

    // A temporary id has no server row yet. add() reconciles the data once the
    // real id lands, and the page index went out with the create call.
    if (isTmp(id)) return;

    set((s) => ({ pendingCount: s.pendingCount + 1 }));
    track(api.patchAnnotation(id, { pageIndex, data }))
      .catch((e) => set({ lastError: e.message }))
      .finally(() => set((s) => ({ pendingCount: s.pendingCount - 1 })));
  },

  // Paint order, relative to the other annotations on the same page. Front and
  // back jump clear of every neighbour; forward and back step one place.
  setLayer(id, where) {
    const me = get().annotations.find((a) => a._id === id);
    if (!me) return;
    const peers = (get().byPage[me.pageIndex] || []).filter((a) => a._id !== id);
    const zs = peers.map((a) => a.z ?? 0);
    const mine = me.z ?? 0;
    const z =
      where === 'front' ? Math.max(mine, ...zs, 0) + 1
      : where === 'back' ? Math.min(mine, ...zs, 0) - 1
      : where === 'forward' ? mine + 1
      : mine - 1;
    if (z === mine) return;

    set((s) => {
      const annotations = s.annotations.map((a) => (a._id === id ? { ...a, z } : a));
      return { annotations, byPage: reindex(s.byPage, annotations) };
    });
    if (isTmp(id)) return;
    track(api.patchAnnotation(id, { z } as any)).catch(() => {});
  },

  toggleLock(id) {
    const me = get().annotations.find((a) => a._id === id);
    if (!me) return;
    const locked = !me.locked;
    set((s) => {
      const annotations = s.annotations.map((a) => (a._id === id ? { ...a, locked } : a));
      return { annotations, byPage: reindex(s.byPage, annotations) };
    });
    if (isTmp(id)) return;
    track(api.patchAnnotation(id, { locked } as any)).catch(() => {});
  },

  // Debounced, otherwise dragging the width slider fires one request per pixel.
  updateStyle(ids, patch) {
    set((s) => {
      const annotations = s.annotations.map((a) =>
        ids.includes(a._id) ? { ...a, style: { ...a.style, ...patch } } : a
      );
      return { annotations, byPage: reindex(s.byPage, annotations) };
    });

    ids.forEach((id) => styleDirty.add(id));
    if (styleTimer) clearTimeout(styleTimer);
    styleTimer = setTimeout(() => {
      const dirty = Array.from(styleDirty).filter((id) => !isTmp(id));
      styleDirty.clear();
      styleTimer = null;
      if (!dirty.length) return;
      const updates = get()
        .annotations.filter((a) => dirty.includes(a._id))
        .map((a) => ({ _id: a._id, style: a.style }));
      if (updates.length) track(api.patchMany(updates)).catch(() => {});
    }, 300);
  },

  async remove(ids) {
    const asked = ids ?? get().selectedIds;
    if (!asked.length) return;
    // A locked annotation survives everything short of being unlocked, so the
    // guarantee holds no matter which path asked for the delete.
    const anns = get().annotations.filter((a) => asked.includes(a._id) && !a.locked);
    if (!anns.length) return;
    const targets = anns.map((a) => a._id);

    set((s) => {
      const annotations = s.annotations.filter((a) => !targets.includes(a._id));
      return {
        annotations,
        byPage: reindex(s.byPage, annotations),
        selectedIds: [],
        editingId: null,
        undoStack: [...s.undoStack, delEntry(anns)].slice(-50),
        redoStack: [],
      };
    });

    const real = targets.filter((id) => !isTmp(id));
    if (real.length) await track(api.deleteMany(real)).catch(() => {});
  },

  nudge(dx, dy) {
    const { selectedIds, annotations, update } = get();
    for (const id of selectedIds) {
      const ann = annotations.find((a) => a._id === id);
      // Locked means locked whichever way you push it. The arrow keys used to
      // go around the pointer's check and move it anyway.
      if (ann && !ann.locked) update(id, translate(ann.type, ann.data, dx, dy));
    }
  },

  async duplicateSelected() {
    const { selectedIds, annotations, add, select } = get();
    const created: string[] = [];
    for (const id of selectedIds) {
      const ann = annotations.find((a) => a._id === id);
      if (!ann) continue;
      const copy = await add({
        pageIndex: ann.pageIndex,
        type: ann.type,
        style: ann.style,
        data: translate(ann.type, ann.data, 12, -12),
      });
      if (copy) created.push(copy._id);
    }
    if (created.length) select(created);
  },

  /**
   * Copying annotations also claims the system clipboard, so there is only ever
   * one most recent copy. Without this, copying a mark and then copying text
   * somewhere else left both waiting, and Ctrl+V pasted the two together.
   * The marker is recognised on paste and is readable if it lands elsewhere.
   */
  copySelected() {
    const { annotations, selectedIds } = get();
    const picked = annotations.filter((a) => selectedIds.includes(a._id));
    set({ clipboard: picked });
    if (!picked.length) return;
    navigator.clipboard?.writeText(CLIP_MARKER).catch(() => {
      /* no clipboard permission, the in-app copy still works on its own */
    });
  },

  async pasteAnnotations(pageIndex) {
    const { clipboard, add, select } = get();
    if (!clipboard.length) return false;
    const created: string[] = [];
    for (const c of clipboard) {
      const copy = await add({
        pageIndex,
        type: c.type,
        style: c.style,
        data: translate(c.type, c.data, 14, -14),
      });
      if (copy) created.push(copy._id);
    }
    if (created.length) select(created);
    return true;
  },

  cycleSelection(pageIndex, dir) {
    const list = get().byPage[pageIndex] || [];
    if (!list.length) return;
    const at = list.findIndex((a) => a._id === get().selectedIds[0]);
    const next = list[(at + dir + list.length * 2) % list.length];
    set({ selectedIds: [next._id], editingId: null });
  },

  selectAllOnPage(pageIndex) {
    set({ selectedIds: (get().byPage[pageIndex] || []).map((a) => a._id), editingId: null });
  },

  async undo() {
    const entry = get().undoStack.at(-1);
    if (!entry) return;

    // A page change is undone by the server, which kept the file. There is no
    // redo for it: once the old file is back the newer one is gone.
    if (entry.kind === 'pageop') {
      set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: [] }));
      try {
        const back = await api.undoPageOp(get().docId!);
        reloadPages?.(back);
      } catch (e: any) {
        set({ lastError: e.message });
      }
      return;
    }

    set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, entry] }));
    if (entry.kind === 'add') await hardDelete(entry.anns, set);
    if (entry.kind === 'delete') await recreate(entry.anns, set);
    if (entry.kind === 'update') await applyData(entry.ids, entry.before, set);
    if (entry.kind === 'move') await applyPlacement(entry.id, entry.before, set);
  },

  async redo() {
    const entry = get().redoStack.at(-1);
    if (!entry) return;
    set((s) => ({ redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, entry] }));
    if (entry.kind === 'add') await recreate(entry.anns, set);
    if (entry.kind === 'delete') await hardDelete(entry.anns, set);
    if (entry.kind === 'update') await applyData(entry.ids, entry.after, set);
    if (entry.kind === 'move') await applyPlacement(entry.id, entry.after, set);
  },

  // Called before any page op, so no write is in flight while the server
  // renumbers pages underneath it.
  async flushPending() {
    for (const [id, t] of Array.from(dataTimers)) {
      clearTimeout(t);
      dataTimers.delete(id);
      dataBefore.delete(id);
      const ann = get().annotations.find((a) => a._id === id);
      if (ann && !isTmp(id)) await api.patchAnnotation(id, { data: ann.data }).catch(() => {});
    }
    if (styleTimer) {
      clearTimeout(styleTimer);
      styleTimer = null;
      const dirty = Array.from(styleDirty).filter((id) => !isTmp(id));
      styleDirty.clear();
      const updates = get()
        .annotations.filter((a) => dirty.includes(a._id))
        .map((a) => ({ _id: a._id, style: a.style }));
      if (updates.length) await api.patchMany(updates).catch(() => {});
    }
    await Promise.allSettled(Array.from(inflight));
  },
}));

type Setter = (fn: (s: State) => Partial<State>) => void;

/**
 * Viewer registers how to reload the document here. Undoing a page change
 * replaces the file on disk, so the whole thing has to be read again, and the
 * store has no way to do that itself.
 */
export type PagesRestored = { pageCount: number; label: string; pages: number[] };

let reloadPages: ((back: PagesRestored) => void) | null = null;
export const onPagesRestored = (fn: ((back: PagesRestored) => void) | null) => {
  reloadPages = fn;
};

function fixStacks(stack: UndoEntry[], oldId: string, replacement: Annotation): UndoEntry[] {
  return stack.map((u): UndoEntry =>
    u.kind === 'pageop'
      ? u
      : u.kind === 'update'
      ? updEntry(u.ids.map((x) => (x === oldId ? replacement._id : x)), u.before, u.after)
      : u.kind === 'move'
        ? { ...u, id: u.id === oldId ? replacement._id : u.id }
        : u.kind === 'add'
          ? addEntry(u.anns.map((x) => (x._id === oldId ? replacement : x)))
          : delEntry(u.anns.map((x) => (x._id === oldId ? replacement : x)))
  );
}

function swapId(set: Setter, tmpId: string, real: Annotation) {
  set((s) => {
    const annotations = s.annotations.map((a) =>
      a._id === tmpId ? { ...a, _id: real._id, documentId: real.documentId } : a
    );
    return {
      annotations,
      byPage: reindex(s.byPage, annotations),
      selectedIds: s.selectedIds.map((x) => (x === tmpId ? real._id : x)),
      editingId: s.editingId === tmpId ? real._id : s.editingId,
      undoStack: fixStacks(s.undoStack, tmpId, real),
      redoStack: fixStacks(s.redoStack, tmpId, real),
    };
  });
}

async function hardDelete(anns: Annotation[], set: Setter) {
  const ids = anns.map((a) => a._id);
  set((s) => {
    const annotations = s.annotations.filter((a) => !ids.includes(a._id));
    return { annotations, byPage: reindex(s.byPage, annotations), selectedIds: [] };
  });
  const real = ids.filter((id) => !isTmp(id));
  if (real.length) await api.deleteMany(real).catch(() => {});
}

async function recreate(anns: Annotation[], set: Setter) {
  for (const ann of anns) {
    const created = await api
      .createAnnotation(ann.documentId, {
        pageIndex: ann.pageIndex,
        type: ann.type,
        data: ann.data,
        style: ann.style,
      })
      .catch(() => null);
    if (!created) continue;
    set((s) => {
      const annotations = [...s.annotations, created];
      return {
        annotations,
        byPage: reindex(s.byPage, annotations),
        undoStack: fixStacks(s.undoStack, ann._id, created),
        redoStack: fixStacks(s.redoStack, ann._id, created),
      };
    });
  }
}

/** Puts one annotation back on a given page with a given shape. */
async function applyPlacement(id: string, at: Placed, set: Setter) {
  set((s) => {
    const annotations = s.annotations.map((a) =>
      a._id === id ? { ...a, pageIndex: at.pageIndex, data: at.data } : a
    );
    return { annotations, byPage: reindex(s.byPage, annotations) };
  });
  if (isTmp(id)) return;
  await api.patchAnnotation(id, { pageIndex: at.pageIndex, data: at.data }).catch(() => {});
}

async function applyData(ids: string[], datas: any[], set: Setter) {
  set((s) => {
    const annotations = s.annotations.map((a) => {
      const at = ids.indexOf(a._id);
      return at === -1 ? a : { ...a, data: datas[at] };
    });
    return { annotations, byPage: reindex(s.byPage, annotations) };
  });
  const updates = ids
    .map((id, i) => ({ _id: id, data: datas[i] }))
    .filter((u) => !isTmp(u._id));
  if (updates.length) await api.patchMany(updates).catch(() => {});
}
