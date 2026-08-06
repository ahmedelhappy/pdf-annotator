import type { Box, SearchMatch } from '../types';

/**
 * Both halves of search must agree on how page text is stitched together, or
 * the Nth match found by the scanner will not be the Nth rectangle drawn.
 *
 * The scanner joins getTextContent items with a single space. The highlighter
 * joins the text layer's leaf spans the same way, because pdf.js emits exactly
 * one span per text item in the same order. Change one, change both.
 */
const JOINER = ' ';

const normalize = (s: string) => s.toLowerCase();

export type PageScan = { text: string; matchCount: number };

/** Cached per document so retyping a query does not rescan every page. */
export class SearchIndex {
  private cache = new Map<number, string>();

  constructor(private pdf: any) {}

  async pageText(pageIndex: number): Promise<string> {
    const hit = this.cache.get(pageIndex);
    if (hit !== undefined) return hit;
    const page = await this.pdf.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    const text = content.items.map((it: any) => it.str ?? '').join(JOINER);
    this.cache.set(pageIndex, text);
    return text;
  }

  async find(
    query: string,
    onProgress: (done: number, total: number) => void,
    signal: { cancelled: boolean }
  ): Promise<SearchMatch[]> {
    const needle = normalize(query.trim());
    if (needle.length < 2) return [];

    const out: SearchMatch[] = [];
    for (let i = 0; i < this.pdf.numPages; i++) {
      if (signal.cancelled) return out;
      const hay = normalize(await this.pageText(i));
      let from = 0;
      let ordinal = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at === -1) break;
        out.push({ pageIndex: i, ordinal: ordinal++ });
        from = at + needle.length;
      }
      onProgress(i + 1, this.pdf.numPages);
    }
    return out;
  }
}

/** Leaf spans only. pdf.js may wrap items in a markedContent span. */
function leafSpans(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('span')).filter(
    (el) => el.childElementCount === 0 && el.textContent !== null
  ) as HTMLElement[];
}

export type Hit = { ordinal: number; boxes: Box[] };

/**
 * Rectangles for every match on one rendered page. Pages that are scrolled far
 * away have no text layer, so they simply return nothing, which is fine
 * because they are off screen.
 */
export function hitsInTextLayer(
  container: HTMLElement,
  shell: HTMLElement,
  query: string
): Hit[] {
  const needle = normalize(query.trim());
  if (needle.length < 2) return [];

  const spans = leafSpans(container);
  if (!spans.length) return [];

  // Build the same haystack the scanner built, remembering where each span
  // starts so a global offset can be mapped back to a DOM position.
  const starts: number[] = [];
  let full = '';
  spans.forEach((sp, i) => {
    if (i > 0) full += JOINER;
    starts.push(full.length);
    full += sp.textContent ?? '';
  });

  const hay = normalize(full);
  const shellRect = shell.getBoundingClientRect();
  const hits: Hit[] = [];
  let from = 0;
  let ordinal = 0;

  const locate = (offset: number): { node: Text; at: number } | null => {
    for (let i = spans.length - 1; i >= 0; i--) {
      if (starts[i] <= offset) {
        const node = spans[i].firstChild as Text | null;
        if (!node || node.nodeType !== Node.TEXT_NODE) return null;
        return { node, at: Math.min(offset - starts[i], node.length) };
      }
    }
    return null;
  };

  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    from = at + needle.length;

    const start = locate(at);
    const end = locate(at + needle.length);
    const mine = ordinal++;
    if (!start || !end) continue;

    try {
      const range = document.createRange();
      range.setStart(start.node, start.at);
      range.setEnd(end.node, end.at);
      const boxes = Array.from(range.getClientRects())
        .filter((r) => r.width >= 1 && r.height >= 1)
        .map((r) => ({
          left: r.left - shellRect.left,
          top: r.top - shellRect.top,
          width: r.width,
          height: r.height,
        }));
      if (boxes.length) hits.push({ ordinal: mine, boxes });
    } catch {
      // a match straddling a separator has no single range, skip its highlight
    }
  }
  return hits;
}
