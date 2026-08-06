import type { Tool } from '../types';

export type Ctx = {
  setTool: (t: Tool) => void;
  setStyle: (s: any) => void;
  style: any;
  palette: string[];
  applyPresetIndex: (i: number) => void;
  scale: number;
  setScale: (n: number) => void;
  fit: (mode: 'width' | 'page') => void;
  undo: () => void;
  redo: () => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  nudge: (dx: number, dy: number) => void;
  cycleSelection: (dir: 1 | -1) => void;
  stepAnnotation: (dir: 1 | -1) => void;
  selectAll: () => void;
  editSelected: () => void;
  deselect: () => void;
  goPage: (to: number | 'next' | 'prev' | 'first' | 'last') => void;
  promptGoPage: () => void;
  pageOp: (body: any) => void;
  movePage: (dir: -1 | 1) => void;
  rotate: (delta: -90 | 90) => void;
  exportPdf: () => void;
  exportJson: () => void;
  back: () => void;
  toggleSidebar: () => void;
  toggleList: () => void;
  toggleOutline: () => void;
  toggleHelp: () => void;
  toggleInvert: () => void;
  toggleSearch: () => void;
  togglePalette: () => void;
  currentPage: number;
};

export type Binding = {
  combo: string | string[];
  group: string;
  label: string;
  run: (c: Ctx) => void;
  /** fire even while a text box or input has focus */
  allowInInput?: boolean;
  /** let the browser also handle it, e.g. paste */
  keepDefault?: boolean;
  /**
   * Stand aside entirely: the binding does not run and the browser keeps the
   * event. Used where a shortcut has a native meaning that must win, such as
   * copying selected page text rather than the selected annotations.
   */
  standDown?: () => boolean;
};

/** True when the user has actually selected some text on the page. */
export function hasTextSelection(): boolean {
  const s = typeof window === 'undefined' ? null : window.getSelection();
  return !!s && !s.isCollapsed && s.toString().trim().length > 0;
}

/**
 * Physical keys, used when the layout in force does not produce a character we
 * have a binding for. `code` describes the key's position rather than what it
 * types, so a US keyboard's V is `KeyV` whether it is currently typing "v" or
 * an Arabic or Cyrillic letter.
 *
 * Punctuation carries its shifted twin, because the bindings are written for
 * the characters a US layout produces: `{` rather than `shift+[`.
 */
const BY_CODE: Record<string, [plain: string, shifted: string]> = {
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Backquote: ['`', '~'],
};

/**
 * What key was pressed, in the alphabet the bindings are written in.
 *
 * A shortcut has to keep working when the keyboard is set to another language,
 * so anything that is not already a plain ASCII character falls back to the
 * key's physical position.
 */
function keyOf(e: KeyboardEvent): string {
  const typed = (e.key || '').toLowerCase();
  if (typed === ' ') return 'space';
  // Named keys such as Escape and ArrowLeft are layout independent already.
  if (typed.length > 1) return typed;
  if (/^[a-z0-9]$/.test(typed)) return typed;

  const code = e.code || '';
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  const punct = BY_CODE[code];
  if (punct) return e.shiftKey ? punct[1] : punct[0];

  return typed;
}

/** Normalizes a KeyboardEvent into a lookup string like "mod+shift+z". */
export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');

  const key = keyOf(e);

  // Shift only counts as a modifier for letters and named keys. For punctuation
  // the shifted character is already the key, so "?" matches literally rather
  // than turning into "shift+/".
  const letterOrNamed = /^[a-z]$/.test(key) || key.length > 1;
  if (e.shiftKey && letterOrNamed) parts.push('shift');

  parts.push(key);
  return parts.join('+');
}

const PRETTY: Record<string, string> = {
  mod: 'Ctrl', alt: 'Alt', shift: 'Shift',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  pageup: 'PgUp', pagedown: 'PgDn', space: 'Space', escape: 'Esc',
  enter: 'Enter', delete: 'Del', backspace: 'Backspace',
  home: 'Home', end: 'End', tab: 'Tab',
};

export function pretty(combo: string): string {
  return combo.split('+').map((p) => PRETTY[p] || p.toUpperCase()).join(' + ');
}

export const BINDINGS: Binding[] = [
  // Tools
  { combo: 'v', group: 'Tools', label: 'Select', run: (c) => c.setTool('select') },
  { combo: ['p', 'b'], group: 'Tools', label: 'Draw freehand', run: (c) => c.setTool('ink') },
  { combo: 'e', group: 'Tools', label: 'Erase', run: (c) => c.setTool('eraser') },
  { combo: 'h', group: 'Tools', label: 'Highlight text', run: (c) => c.setTool('highlight') },
  { combo: 'r', group: 'Tools', label: 'Highlight an area', run: (c) => c.setTool('rect') },
  { combo: 't', group: 'Tools', label: 'Add a text box', run: (c) => c.setTool('text') },
  { combo: 'n', group: 'Tools', label: 'Add a sticky note', run: (c) => c.setTool('note') },
  { combo: 'i', group: 'Tools', label: 'Place an image', run: (c) => c.setTool('image') },
  { combo: 'space', group: 'Tools', label: 'Hold to pan', run: () => {} },

  // Style
  ...['1', '2', '3', '4', '5'].map((k, idx) => ({
    combo: k,
    group: 'Style',
    label: `Color ${idx + 1}`,
    run: (c: Ctx) => c.setStyle({ color: c.palette[idx] }),
  })),
  ...['f1', 'f2', 'f3', 'f4'].map((k, idx) => ({
    combo: k,
    group: 'Style',
    label: `Preset ${idx + 1}`,
    run: (c: Ctx) => c.applyPresetIndex(idx),
  })),
  { combo: ']', group: 'Style', label: 'Thicker', run: (c) => c.setStyle({ width: Math.min(24, c.style.width + 1) }) },
  { combo: '[', group: 'Style', label: 'Thinner', run: (c) => c.setStyle({ width: Math.max(1, c.style.width - 1) }) },
  { combo: '}', group: 'Style', label: 'Much thicker', run: (c) => c.setStyle({ width: Math.min(24, c.style.width + 4) }) },
  { combo: '{', group: 'Style', label: 'Much thinner', run: (c) => c.setStyle({ width: Math.max(1, c.style.width - 4) }) },
  { combo: '.', group: 'Style', label: 'More opaque', run: (c) => c.setStyle({ opacity: Math.min(1, +(c.style.opacity + 0.1).toFixed(2)) }) },
  { combo: ',', group: 'Style', label: 'More transparent', run: (c) => c.setStyle({ opacity: Math.max(0.1, +(c.style.opacity - 0.1).toFixed(2)) }) },

  // View
  { combo: ['mod+=', 'mod++'], group: 'View', label: 'Zoom in', run: (c) => c.setScale(c.scale + 0.15) },
  { combo: 'mod+-', group: 'View', label: 'Zoom out', run: (c) => c.setScale(c.scale - 0.15) },
  { combo: 'mod+0', group: 'View', label: 'Zoom to 100%', run: (c) => c.setScale(1) },
  { combo: '\\', group: 'View', label: 'Fit width', run: (c) => c.fit('width') },
  { combo: '|', group: 'View', label: 'Fit whole page', run: (c) => c.fit('page') },
  { combo: 'mod+b', group: 'View', label: 'Page thumbnails', run: (c) => c.toggleSidebar() },
  { combo: 'mod+l', group: 'View', label: 'Annotation list', run: (c) => c.toggleList() },
  { combo: 'mod+shift+o', group: 'View', label: 'Document outline', run: (c) => c.toggleOutline() },
  { combo: 'mod+alt+i', group: 'View', label: 'Invert colors', run: (c) => c.toggleInvert() },

  // Navigate
  { combo: ['pagedown', 'j'], group: 'Navigate', label: 'Next page', run: (c) => c.goPage('next') },
  { combo: ['pageup', 'k'], group: 'Navigate', label: 'Previous page', run: (c) => c.goPage('prev') },
  { combo: 'home', group: 'Navigate', label: 'First page', run: (c) => c.goPage('first') },
  { combo: 'end', group: 'Navigate', label: 'Last page', run: (c) => c.goPage('last') },
  { combo: 'mod+g', group: 'Navigate', label: 'Go to page', run: (c) => c.promptGoPage() },
  // Walks the marks themselves rather than the pages, so a document with three
  // notes in two hundred pages does not have to be scrolled through.
  { combo: 'mod+alt+n', group: 'Navigate', label: 'Next annotation in document',
    run: (c) => c.stepAnnotation(1) },
  { combo: 'mod+alt+p', group: 'Navigate', label: 'Previous annotation in document',
    run: (c) => c.stepAnnotation(-1) },
  { combo: 'mod+f', group: 'Navigate', label: 'Find in document', run: (c) => c.toggleSearch(), allowInInput: true },
  { combo: 'tab', group: 'Navigate', label: 'Next annotation on page', run: (c) => c.cycleSelection(1) },
  { combo: 'shift+tab', group: 'Navigate', label: 'Previous annotation on page', run: (c) => c.cycleSelection(-1) },

  // Edit
  { combo: 'mod+z', group: 'Edit', label: 'Undo', run: (c) => c.undo(), allowInInput: true },
  { combo: ['mod+shift+z', 'mod+y'], group: 'Edit', label: 'Redo', run: (c) => c.redo(), allowInInput: true },
  { combo: ['delete', 'backspace'], group: 'Edit', label: 'Delete selection', run: (c) => c.deleteSelected() },
  { combo: 'escape', group: 'Edit', label: 'Clear selection', run: (c) => c.deselect(), allowInInput: true },
  { combo: 'enter', group: 'Edit', label: 'Edit selected text', run: (c) => c.editSelected() },
  { combo: 'mod+a', group: 'Edit', label: 'Select all on page', run: (c) => c.selectAll() },
  { combo: 'mod+d', group: 'Edit', label: 'Duplicate', run: (c) => c.duplicateSelected() },
  // Selected page text belongs to the browser, so copying it works exactly as
  // it does anywhere else. Only with nothing selected does this copy the
  // chosen annotations instead.
  {
    combo: 'mod+c',
    group: 'Edit',
    label: 'Copy',
    run: (c) => c.copySelected(),
    standDown: hasTextSelection,
  },
  { combo: 'mod+v', group: 'Edit', label: 'Paste image or copy', run: (c) => c.pasteClipboard(), keepDefault: true },
  { combo: 'arrowleft', group: 'Edit', label: 'Nudge left', run: (c) => c.nudge(-1, 0) },
  { combo: 'arrowright', group: 'Edit', label: 'Nudge right', run: (c) => c.nudge(1, 0) },
  { combo: 'arrowup', group: 'Edit', label: 'Nudge up', run: (c) => c.nudge(0, 1) },
  { combo: 'arrowdown', group: 'Edit', label: 'Nudge down', run: (c) => c.nudge(0, -1) },
  { combo: 'shift+arrowleft', group: 'Edit', label: 'Nudge left 10pt', run: (c) => c.nudge(-10, 0) },
  { combo: 'shift+arrowright', group: 'Edit', label: 'Nudge right 10pt', run: (c) => c.nudge(10, 0) },
  { combo: 'shift+arrowup', group: 'Edit', label: 'Nudge up 10pt', run: (c) => c.nudge(0, 10) },
  { combo: 'shift+arrowdown', group: 'Edit', label: 'Nudge down 10pt', run: (c) => c.nudge(0, -10) },

  // Pages
  { combo: 'mod+enter', group: 'Pages', label: 'Insert page after', run: (c) => c.pageOp({ op: 'insert', index: c.currentPage + 1 }) },
  { combo: 'mod+shift+enter', group: 'Pages', label: 'Insert page before', run: (c) => c.pageOp({ op: 'insert', index: c.currentPage }) },
  { combo: 'mod+alt+d', group: 'Pages', label: 'Duplicate page', run: (c) => c.pageOp({ op: 'duplicate', index: c.currentPage }) },
  { combo: 'mod+backspace', group: 'Pages', label: 'Delete page', run: (c) => c.pageOp({ op: 'delete', index: c.currentPage }) },
  { combo: 'alt+arrowup', group: 'Pages', label: 'Move page earlier', run: (c) => c.movePage(-1) },
  { combo: 'alt+arrowdown', group: 'Pages', label: 'Move page later', run: (c) => c.movePage(1) },
  { combo: 'mod+shift+arrowleft', group: 'Pages', label: 'Rotate page left', run: (c) => c.rotate(-90) },
  { combo: 'mod+shift+arrowright', group: 'Pages', label: 'Rotate page right', run: (c) => c.rotate(90) },

  // File
  { combo: 'mod+s', group: 'File', label: 'Export annotated PDF', run: (c) => c.exportPdf(), allowInInput: true },
  { combo: 'mod+shift+s', group: 'File', label: 'Export annotations as JSON', run: (c) => c.exportJson(), allowInInput: true },
  { combo: 'mod+o', group: 'File', label: 'Back to library', run: (c) => c.back() },
  { combo: 'mod+k', group: 'File', label: 'Command palette', run: (c) => c.togglePalette(), allowInInput: true },
  { combo: ['?', 'mod+/'], group: 'File', label: 'Show shortcuts', run: (c) => c.toggleHelp(), allowInInput: true },
];

/**
 * A stable name for a binding, used as the key for anything the user changes.
 * Derived from the table rather than hand-written so the two cannot drift, and
 * group plus label is already unique.
 */
export const bindingId = (b: Binding) => `${b.group}/${b.label}`;

/**
 * What is switched on out of the box. Deliberately short: the keys people
 * already know from other apps, plus the tools. Everything else is in the table
 * and in the shortcuts panel, waiting to be switched on by whoever wants it.
 */
export const DEFAULT_ON = new Set<string>([
  'Tools/Select', 'Tools/Draw freehand', 'Tools/Erase', 'Tools/Highlight text',
  'Tools/Highlight an area', 'Tools/Add a text box', 'Tools/Add a sticky note',
  'Tools/Place an image', 'Tools/Hold to pan',
  'View/Zoom in', 'View/Zoom out', 'View/Zoom to 100%', 'View/Fit width',
  'View/Page thumbnails', 'View/Annotation list',
  'Navigate/Next page', 'Navigate/Previous page', 'Navigate/First page',
  'Navigate/Last page', 'Navigate/Find in document',
  'Navigate/Next annotation in document', 'Navigate/Previous annotation in document',
  'Edit/Undo', 'Edit/Redo', 'Edit/Delete selection', 'Edit/Clear selection',
  'Edit/Select all on page', 'Edit/Copy', 'Edit/Paste image or copy',
  'Edit/Duplicate', 'Edit/Nudge left', 'Edit/Nudge right', 'Edit/Nudge up',
  'Edit/Nudge down',
  'File/Export annotated PDF', 'File/Command palette', 'File/Show shortcuts',
]);

/** What the user has changed: a different key, or switched off entirely. */
export type ShortcutPrefs = Record<string, { combo?: string; off?: boolean }>;

/** Whether a binding is live, taking the user's choice over the default. */
export function isEnabled(b: Binding, prefs: ShortcutPrefs): boolean {
  const p = prefs[bindingId(b)];
  if (p?.off !== undefined) return !p.off;
  return DEFAULT_ON.has(bindingId(b));
}

/** The keys a binding answers to, taking the user's choice over the default. */
export function combosFor(b: Binding, prefs: ShortcutPrefs): string[] {
  const custom = prefs[bindingId(b)]?.combo;
  if (custom) return [custom];
  return Array.isArray(b.combo) ? b.combo : [b.combo];
}

/**
 * Lookup table for the bindings currently in force. Later entries win a clash,
 * which matches the table order, so a key someone just assigned takes effect
 * rather than silently doing nothing.
 */
export function buildBindingMap(prefs: ShortcutPrefs = {}): Map<string, Binding> {
  const map = new Map<string, Binding>();
  for (const b of BINDINGS) {
    if (!isEnabled(b, prefs)) continue;
    for (const k of combosFor(b, prefs)) map.set(k, b);
  }
  return map;
}

/** Which other binding already answers to this key, if any. */
export function clashWith(combo: string, id: string, prefs: ShortcutPrefs): Binding | null {
  for (const b of BINDINGS) {
    if (bindingId(b) === id || !isEnabled(b, prefs)) continue;
    if (combosFor(b, prefs).includes(combo)) return b;
  }
  return null;
}

/** The defaults, for anything that needs a map without asking the store. */
export const BINDING_MAP = buildBindingMap();
