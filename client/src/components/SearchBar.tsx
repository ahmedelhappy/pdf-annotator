import { useEffect, useMemo, useRef, useState } from 'react';
import { SearchIndex } from '../lib/search';
import { useStore } from '../store';
import type { SearchMatch } from '../types';

type Props = {
  pdf: any;
  onGoToMatch: (m: SearchMatch) => void;
  onClose: () => void;
};

export default function SearchBar({ pdf, onGoToMatch, onClose }: Props) {
  const searchQuery = useStore((s) => s.searchQuery);
  const searchMatches = useStore((s) => s.searchMatches);
  const searchCursor = useStore((s) => s.searchCursor);
  const setSearch = useStore((s) => s.setSearch);
  const stepSearch = useStore((s) => s.stepSearch);

  const [text, setText] = useState(searchQuery);
  const [progress, setProgress] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const signal = useRef({ cancelled: false });

  // One index per document, so retyping does not rescan pages already read.
  const index = useMemo(() => new SearchIndex(pdf), [pdf]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    signal.current.cancelled = true;
    const mine = { cancelled: false };
    signal.current = mine;

    if (text.trim().length < 2) {
      setSearch(text, []);
      setProgress(null);
      return;
    }

    const t = setTimeout(async () => {
      setProgress(0);
      const matches = await index.find(
        text,
        (done, total) => setProgress(Math.round((done / total) * 100)),
        mine
      );
      if (mine.cancelled) return;
      setSearch(text, matches);
      setProgress(null);
      if (matches.length) onGoToMatch(matches[0]);
    }, 250);

    return () => clearTimeout(t);
  }, [text, index, setSearch]);

  function step(dir: 1 | -1) {
    const m = stepSearch(dir);
    if (m) onGoToMatch(m);
  }

  const status =
    progress !== null
      ? `Scanning ${progress}%`
      : text.trim().length < 2
        ? 'Type at least two characters'
        : searchMatches.length
          ? `${searchCursor + 1} of ${searchMatches.length}`
          : 'No matches';

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800 border-b border-neutral-700 text-neutral-200">
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Find in document"
        className="bg-neutral-900 rounded px-2 py-1 text-sm outline-none w-64"
      />
      <span className="text-xs text-neutral-400 tabular-nums">{status}</span>
      <button className="px-2 hover:bg-neutral-700 rounded" title="Previous match"
        onClick={() => step(-1)}>↑</button>
      <button className="px-2 hover:bg-neutral-700 rounded" title="Next match"
        onClick={() => step(1)}>↓</button>
      <button className="ml-auto px-2 py-1 text-sm hover:bg-neutral-700 rounded" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
