import { useState } from 'react';
import {
  BINDINGS, bindingId, clashWith, combosFor, comboOf, isEnabled, pretty,
} from '../lib/shortcuts';
import { useStore } from '../store';

/**
 * The shortcut sheet, and the place to change it. Every binding in the table is
 * listed whether or not it is switched on, so nothing is hidden: the short
 * default set is simply what starts out ticked.
 */
export default function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const prefs = useStore((s) => s.shortcuts);
  const setShortcut = useStore((s) => s.setShortcut);
  const toggleShortcut = useStore((s) => s.toggleShortcut);
  const resetShortcuts = useStore((s) => s.resetShortcuts);

  /** Which row is waiting for a keypress, and anything to warn about. */
  const [listening, setListening] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const groups: Record<string, typeof BINDINGS> = {};
  for (const b of BINDINGS) (groups[b.group] ||= []).push(b);

  /** Reads the next keypress as the new key for a binding. */
  function capture(e: React.KeyboardEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setListening(null);
      setNote(null);
      return;
    }
    // Wait for the real key: a lone modifier is on its way to one.
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;

    const combo = comboOf(e.nativeEvent);
    const taken = clashWith(combo, id, prefs);
    if (taken) {
      setNote(`${pretty(combo)} already runs ${taken.label}. Pick another.`);
      return;
    }
    setShortcut(id, combo);
    setListening(null);
    setNote(null);
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[4000] flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 text-neutral-200 rounded-lg max-w-4xl w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-1">
          <h2 className="text-lg">Keyboard shortcuts</h2>
          <div className="flex items-center gap-3">
            <button className="text-xs text-neutral-400 hover:text-white" onClick={resetShortcuts}>
              Reset to defaults
            </button>
            <button className="text-sm text-neutral-400 hover:text-white" onClick={onClose}>
              Close (Esc)
            </button>
          </div>
        </div>
        <p className="text-xs text-neutral-500 mb-4">
          Untick one to switch it off. Click a key to record a new one.
        </p>

        {note && (
          <div className="mb-3 px-3 py-1.5 bg-amber-700 text-amber-50 text-xs rounded">{note}</div>
        )}

        <div className="grid md:grid-cols-2 gap-x-8 gap-y-6">
          {Object.entries(groups).map(([group, items]) => (
            <div key={group}>
              <div className="text-xs uppercase tracking-wide text-sky-400 mb-2">{group}</div>
              {items.map((b) => {
                const id = bindingId(b);
                const on = isEnabled(b, prefs);
                const keys = combosFor(b, prefs).map(pretty).join('  /  ');
                return (
                  <div key={id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input
                      type="checkbox"
                      checked={on}
                      aria-label={`${b.label} enabled`}
                      className="accent-sky-500 shrink-0"
                      onChange={(e) => toggleShortcut(id, e.target.checked)}
                    />
                    <span className={`flex-1 truncate ${on ? 'text-neutral-300' : 'text-neutral-600'}`}>
                      {b.label}
                    </span>
                    <button
                      className={`font-mono text-xs px-1.5 py-0.5 rounded whitespace-nowrap ${
                        listening === id
                          ? 'bg-sky-600 text-white'
                          : 'text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200'
                      }`}
                      title="Click, then press the keys you want"
                      onClick={() => {
                        setListening(listening === id ? null : id);
                        setNote(null);
                      }}
                      onKeyDown={(e) => listening === id && capture(e, id)}
                    >
                      {listening === id ? 'press keys' : keys}
                    </button>
                    {prefs[id]?.combo && (
                      <button
                        className="text-[10px] text-neutral-500 hover:text-white shrink-0"
                        title="Back to the original key"
                        onClick={() => setShortcut(id, null)}
                      >
                        undo
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <p className="text-xs text-neutral-500 mt-6">
          Ctrl+1 through Ctrl+8 belong to the browser for tab switching and cannot be
          intercepted, which is why the zoom presets use backslash instead.
        </p>
      </div>
    </div>
  );
}
