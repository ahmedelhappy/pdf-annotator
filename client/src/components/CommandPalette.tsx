import { useMemo, useState } from 'react';
import { BINDINGS, pretty, type Ctx } from '../lib/shortcuts';
import { PRESETS } from '../store';

type Command = { label: string; hint: string; run: () => void };

export default function CommandPalette({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const presets = PRESETS.map((p, i) => ({
      label: `Preset: ${p.name}`,
      hint: `F${i + 1}`,
      run: () => ctx.applyPresetIndex(i),
    }));
    const bindings = BINDINGS.filter((b) => b.label !== 'Hold to pan').map((b) => ({
      label: b.label,
      hint: (Array.isArray(b.combo) ? b.combo : [b.combo]).map(pretty).join(' / '),
      run: () => b.run(ctx),
    }));
    return [...presets, ...bindings];
  }, [ctx]);

  const filtered = commands.filter((c) =>
    c.label.toLowerCase().includes(query.trim().toLowerCase())
  );
  const at = Math.min(cursor, Math.max(0, filtered.length - 1));
  const active = filtered[at];

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-24 px-4"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 rounded-lg w-full max-w-lg overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((n) => Math.min(n + 1, filtered.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((n) => Math.max(n - 1, 0));
            }
            if (e.key === 'Enter' && active) {
              e.preventDefault();
              onClose();
              active.run();
            }
            if (e.key === 'Escape') onClose();
          }}
          placeholder="Search commands"
          className="w-full px-4 py-3 bg-neutral-800 text-neutral-100 outline-none"
        />

        <div className="max-h-80 overflow-y-auto">
          {filtered.map((c, i) => (
            <button
              key={`${c.label}-${i}`}
              className={`flex justify-between w-full px-4 py-2 text-left text-sm ${
                i === at ? 'bg-sky-700 text-white' : 'text-neutral-300 hover:bg-neutral-800'
              }`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                onClose();
                c.run();
              }}
            >
              <span>{c.label}</span>
              <span className="text-xs text-neutral-400 font-mono">{c.hint}</span>
            </button>
          ))}
          {!filtered.length && (
            <div className="px-4 py-6 text-sm text-neutral-500">
              No command matches that. Try a shorter word.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
