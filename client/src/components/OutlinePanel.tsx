import { useEffect, useState } from 'react';

type Node = { title: string; pageIndex: number | null; children: Node[] };

// pdf.js gives a destination as either a named string or an explicit array.
// Both have to be resolved to a page index before they are useful.
async function resolve(pdf: any, item: any): Promise<number | null> {
  try {
    const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
    if (!dest) return null;
    return await pdf.getPageIndex(dest[0]);
  } catch {
    return null;
  }
}

async function walk(pdf: any, items: any[]): Promise<Node[]> {
  const out: Node[] = [];
  for (const it of items || []) {
    out.push({
      title: it.title,
      pageIndex: await resolve(pdf, it),
      children: await walk(pdf, it.items),
    });
  }
  return out;
}

export default function OutlinePanel({ pdf, onGo }: { pdf: any; onGo: (p: number) => void }) {
  const [tree, setTree] = useState<Node[] | null>(null);

  useEffect(() => {
    let dead = false;
    pdf.getOutline().then(async (items: any[]) => {
      const t = await walk(pdf, items || []);
      if (!dead) setTree(t);
    });
    return () => {
      dead = true;
    };
  }, [pdf]);

  const render = (nodes: Node[], depth = 0) =>
    nodes.map((n, i) => (
      <div key={`${depth}-${i}`}>
        <button
          className="block w-full text-left px-3 py-1 text-sm hover:bg-neutral-800 truncate disabled:text-neutral-600"
          style={{ paddingLeft: 12 + depth * 12 }}
          disabled={n.pageIndex === null}
          onClick={() => n.pageIndex !== null && onGo(n.pageIndex)}
        >
          {n.title}
        </button>
        {render(n.children, depth + 1)}
      </div>
    ));

  return (
    <div className="w-60 shrink-0 bg-neutral-900 border-r border-neutral-800 overflow-y-auto text-neutral-300">
      <div className="px-3 py-2 text-xs uppercase tracking-wide text-neutral-500 border-b border-neutral-800">
        Outline
      </div>
      {tree === null && <div className="p-3 text-sm text-neutral-500">Reading bookmarks</div>}
      {tree?.length === 0 && (
        <div className="p-3 text-sm text-neutral-500">This PDF has no bookmarks.</div>
      )}
      {tree && render(tree)}
    </div>
  );
}
