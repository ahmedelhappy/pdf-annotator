import { describe, expect, it } from 'vitest';
import {
  BINDINGS, BINDING_MAP, bindingId, buildBindingMap, clashWith, combosFor, comboOf,
  DEFAULT_ON, hasTextSelection, isEnabled, pretty,
} from '../lib/shortcuts';

const ev = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;

describe('comboOf', () => {
  it('reads a plain letter', () => {
    expect(comboOf(ev({ key: 'v', ctrlKey: false, altKey: false, shiftKey: false }))).toBe('v');
  });

  it('treats ctrl and cmd the same', () => {
    expect(comboOf(ev({ key: 'z', ctrlKey: true }))).toBe('mod+z');
    expect(comboOf(ev({ key: 'z', metaKey: true }))).toBe('mod+z');
  });

  it('orders modifiers consistently', () => {
    expect(comboOf(ev({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe('mod+shift+z');
  });

  it('matches punctuation literally instead of as a shifted key', () => {
    expect(comboOf(ev({ key: '?', shiftKey: true }))).toBe('?');
    expect(comboOf(ev({ key: '{', shiftKey: true }))).toBe('{');
  });

  it('names the space bar', () => {
    expect(comboOf(ev({ key: ' ' }))).toBe('space');
  });

  it('does not turn Ctrl+V into the letter V', () => {
    // the regression: a bare-letter lookup fired while Ctrl was held
    expect(comboOf(ev({ key: 'v', ctrlKey: true }))).not.toBe('v');
  });
});

describe('the binding table', () => {
  it('has no duplicate combos', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const b of BINDINGS) {
      for (const c of Array.isArray(b.combo) ? b.combo : [b.combo]) {
        if (seen.has(c)) dupes.push(c);
        seen.add(c);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('indexes every combo of every enabled binding', () => {
    const total = BINDINGS.filter((b) => isEnabled(b, {})).reduce(
      (n, b) => n + combosFor(b, {}).length,
      0
    );
    expect(BINDING_MAP.size).toBe(total);
  });

  it('gives every binding a group and a label', () => {
    for (const b of BINDINGS) {
      expect(b.group.length).toBeGreaterThan(0);
      expect(b.label.length).toBeGreaterThan(0);
    }
  });

  it('formats combos for the help sheet', () => {
    expect(pretty('mod+shift+z')).toBe('Ctrl + Shift + Z');
    expect(pretty('arrowleft')).toBe('Left');
  });
});

describe('standing down for native behaviour', () => {
  const withSelection = (text: string, collapsed = false) => {
    (globalThis as any).window = {
      getSelection: () => ({ isCollapsed: collapsed, toString: () => text }),
    };
  };

  it('copy hands the key back when page text is selected', () => {
    withSelection('some selected words');
    expect(BINDING_MAP.get('mod+c')?.standDown?.()).toBe(true);
  });

  it('copy keeps the binding when nothing is selected', () => {
    withSelection('', true);
    expect(BINDING_MAP.get('mod+c')?.standDown?.()).toBe(false);
  });

  it('a collapsed caret is not a selection', () => {
    withSelection('', true);
    expect(hasTextSelection()).toBe(false);
  });

  it('whitespace alone is not a selection', () => {
    withSelection('   \n  ');
    expect(hasTextSelection()).toBe(false);
  });

  it('only copy stands down, so other bindings still fire', () => {
    withSelection('some selected words');
    const standing = BINDINGS.filter((b) => b.standDown?.());
    expect(standing.map((b) => b.label)).toEqual(['Copy']);
  });
});

describe('layout independence', () => {
  // With a non-Latin keyboard, e.key is a letter we have no binding for, so
  // the physical key position has to decide instead.
  const arabic = (key: string, code: string, extra: Partial<KeyboardEvent> = {}) =>
    ev({ key, code, ctrlKey: false, altKey: false, shiftKey: false, ...extra });

  it('reads a letter from the key position when the layout is Arabic', () => {
    expect(comboOf(arabic('ر', 'KeyV'))).toBe('v');
    expect(comboOf(arabic('ح', 'KeyP'))).toBe('p');
  });

  it('reads a letter from the key position when the layout is Cyrillic', () => {
    expect(comboOf(arabic('т', 'KeyN'))).toBe('n');
  });

  it('keeps modifiers while falling back', () => {
    expect(comboOf(arabic('ز', 'KeyZ', { ctrlKey: true }))).toBe('mod+z');
    expect(comboOf(arabic('ز', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toBe('mod+shift+z');
  });

  it('reads Arabic-Indic digits from the key position', () => {
    expect(comboOf(arabic('١', 'Digit1'))).toBe('1');
    expect(comboOf(arabic('٥', 'Digit5'))).toBe('5');
  });

  it('reads punctuation from the key position, shifted twin included', () => {
    expect(comboOf(arabic('ج', 'BracketRight'))).toBe(']');
    expect(comboOf(arabic('چ', 'BracketLeft'))).toBe('[');
    expect(comboOf(arabic('چ', 'BracketLeft', { shiftKey: true }))).toBe('{');
    expect(comboOf(arabic('ذ', 'Backslash'))).toBe('\\');
  });

  it('leaves a Latin layout exactly as it was', () => {
    expect(comboOf(ev({ key: 'v', code: 'KeyV', ctrlKey: false, altKey: false, shiftKey: false }))).toBe('v');
    expect(comboOf(ev({ key: '?', code: 'Slash', ctrlKey: false, altKey: false, shiftKey: true }))).toBe('?');
    expect(comboOf(ev({ key: '[', code: 'BracketLeft', ctrlKey: false, altKey: false, shiftKey: false }))).toBe('[');
  });

  it('leaves named keys alone whatever the layout', () => {
    expect(comboOf(arabic('Escape', 'Escape'))).toBe('escape');
    expect(comboOf(arabic('ArrowLeft', 'ArrowLeft'))).toBe('arrowleft');
    expect(comboOf(arabic(' ', 'Space'))).toBe('space');
  });

  it('resolves every tool shortcut from a non-Latin layout', () => {
    const tools = { KeyV: 'v', KeyP: 'p', KeyE: 'e', KeyH: 'h', KeyR: 'r', KeyT: 't', KeyN: 'n', KeyI: 'i' };
    for (const [code, want] of Object.entries(tools)) {
      const combo = comboOf(arabic('ء', code));
      expect(combo).toBe(want);
      expect(BINDING_MAP.get(combo)).toBeDefined();
    }
  });
});

describe('editable shortcuts', () => {
  const find = (label: string) => BINDINGS.find((b) => b.label === label)!;

  it('gives every binding a unique name', () => {
    const ids = BINDINGS.map(bindingId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names in the default set all exist in the table', () => {
    const ids = new Set(BINDINGS.map(bindingId));
    for (const id of DEFAULT_ON) expect(ids.has(id)).toBe(true);
  });

  it('starts with a short set switched on, not everything', () => {
    const on = BINDINGS.filter((b) => isEnabled(b, {}));
    expect(on.length).toBe(DEFAULT_ON.size);
    expect(on.length).toBeLessThan(BINDINGS.length);
  });

  it('the tools and the usual editing keys are on by default', () => {
    for (const label of ['Select', 'Draw freehand', 'Undo', 'Redo', 'Copy', 'Find in document']) {
      expect(isEnabled(find(label), {})).toBe(true);
    }
  });

  it('a rebind replaces the original key', () => {
    const id = bindingId(find('Draw freehand'));
    const prefs = { [id]: { combo: 'mod+shift+j' } };
    expect(combosFor(find('Draw freehand'), prefs)).toEqual(['mod+shift+j']);
    const map = buildBindingMap(prefs);
    expect(map.get('mod+shift+j')?.label).toBe('Draw freehand');
    expect(map.get('p')).toBeUndefined();
    expect(map.get('b')).toBeUndefined();
  });

  it('switching one off takes its key out of the map', () => {
    const id = bindingId(find('Erase'));
    const map = buildBindingMap({ [id]: { off: true } });
    expect(map.get('e')).toBeUndefined();
  });

  it('switching one on that starts off puts its key in', () => {
    const off = BINDINGS.find((b) => !DEFAULT_ON.has(bindingId(b)))!;
    const map = buildBindingMap({ [bindingId(off)]: { off: false } });
    const key = combosFor(off, {})[0];
    expect(map.get(key)?.label).toBe(off.label);
  });

  it('reports a clash against a live binding', () => {
    const id = bindingId(find('Draw freehand'));
    expect(clashWith('v', id, {})?.label).toBe('Select');
    // k is Previous page, so it clashes too; this one is genuinely free
    expect(clashWith('mod+shift+j', id, {})).toBeNull();
  });

  it('does not report a clash against one that is switched off', () => {
    const select = bindingId(find('Select'));
    const id = bindingId(find('Draw freehand'));
    expect(clashWith('v', id, { [select]: { off: true } })).toBeNull();
  });

  it('does not count a binding clashing with itself', () => {
    const id = bindingId(find('Select'));
    expect(clashWith('v', id, {})).toBeNull();
  });

  it('the default map matches the default preferences', () => {
    expect([...BINDING_MAP.keys()].sort()).toEqual([...buildBindingMap({}).keys()].sort());
  });
});
