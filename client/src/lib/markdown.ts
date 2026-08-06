/**
 * The small slice of markdown a text box understands. Pure and free of both the
 * DOM and pdf-lib, because the page and the export both have to read a box the
 * same way: if they disagree about what a line is, what you typed and what you
 * print stop matching.
 *
 * Duplicated in server/src/lib/markdown.js so neither package needs a build
 * step. markdown.test.ts imports both and asserts identical output. Change one,
 * change both.
 *
 * One source line is one block. Markdown proper joins consecutive lines into a
 * paragraph; here a newline is a newline, which is what the box already did and
 * what someone typing into a box expects.
 *
 * Emphasis is `*italic*` and `**bold**` only. Underscores are left alone on
 * purpose: they turn up inside ordinary words like file_name far more often
 * than they are meant as emphasis.
 */

export type Run = { text: string; bold: boolean; italic: boolean };

export type BlockKind = 'h1' | 'h2' | 'h3' | 'p' | 'bullet' | 'number' | 'todo';

export type Block = {
  kind: BlockKind;
  /** List nesting, two spaces per level, capped so it cannot run off the box. */
  depth: number;
  /** What a numbered item prints in front of itself. */
  marker?: string;
  /** Whether a checkbox is ticked. */
  done?: boolean;
  runs: Run[];
};

/** Heading sizes, as a multiple of the box's own font size. */
export const HEADING_SCALE: Record<string, number> = { h1: 1.6, h2: 1.35, h3: 1.15 };
/** One level of list nesting, as a multiple of the font size. */
export const LIST_INDENT = 1.2;
/**
 * Room each kind of marker needs, as a multiple of the font size. A checkbox
 * spells out three characters and needs more than a bullet's one dot; with a
 * single width for all of them, `[x]` ran into the words beside it.
 */
export const MARKER_WIDTH: Record<string, number> = { bullet: 1.0, number: 1.7, todo: 2.1 };
/** Air above a heading, as a multiple of its own size, so it does not crowd. */
export const HEADING_GAP = 0.3;
export const MAX_DEPTH = 3;

/** Splits a line into runs of plain, bold and italic text. */
export function inlineRuns(s: string): Run[] {
  const runs: Run[] = [];
  let text = '';
  let bold = false;
  let italic = false;

  const push = () => {
    if (text) runs.push({ text, bold, italic });
    text = '';
  };

  let i = 0;
  while (i < s.length) {
    // A backslash hands the next character through untouched, so a literal
    // asterisk is still possible.
    if (s[i] === '\\' && i + 1 < s.length) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (s[i] === '*' && s[i + 1] === '*') {
      push();
      bold = !bold;
      i += 2;
      continue;
    }
    if (s[i] === '*') {
      push();
      italic = !italic;
      i += 1;
      continue;
    }
    text += s[i];
    i += 1;
  }
  push();
  return runs.length ? runs : [{ text: '', bold: false, italic: false }];
}

/** Everything in a block, joined back together. Used for measuring and search. */
export function blockText(b: Block): string {
  return b.runs.map((r) => r.text).join('');
}

/** The size a block is drawn at, given the box's own size. */
export function blockSize(b: Block, base: number): number {
  return base * (HEADING_SCALE[b.kind] ?? 1);
}

/**
 * What a list item prints in front of itself, or an empty string.
 *
 * A checkbox is spelled out rather than drawn as a ballot box glyph. Helvetica
 * is WinAnsi only, so it cannot set one, and an unencodable marker used to take
 * the whole box down with it at export. This way the page and the paper agree
 * and neither needs a font installing.
 */
export function markerFor(b: Block): string {
  if (b.kind === 'bullet') return '•';
  if (b.kind === 'number') return b.marker || '1.';
  if (b.kind === 'todo') return b.done ? '[x]' : '[ ]';
  return '';
}

/** How wide a column the marker holds open, in points. */
export function markerWidth(b: Block, base: number): number {
  return base * (MARKER_WIDTH[b.kind] ?? 0);
}

/** How far a block's text sits in from the left, in points. */
export function indentFor(b: Block, base: number): number {
  const w = MARKER_WIDTH[b.kind];
  if (!w) return 0;
  return base * (b.depth * LIST_INDENT + w);
}

export function parseMarkdown(text: string): Block[] {
  const src = String(text ?? '');
  return src.split('\n').map((raw): Block => {
    const lead = (/^[ \t]*/.exec(raw) || [''])[0].replace(/\t/g, '  ').length;
    const depth = Math.min(MAX_DEPTH, Math.floor(lead / 2));
    const line = raw.trim();

    const head = /^(#{1,3})\s+(.*)$/.exec(line);
    if (head) {
      const kind = `h${head[1].length}` as BlockKind;
      return { kind, depth: 0, runs: inlineRuns(head[2]) };
    }

    // A checkbox with or without a bullet in front of it, since both get typed.
    const todo = /^(?:[-*+]\s+)?\[([ xX])\]\s*(.*)$/.exec(line);
    if (todo) {
      return { kind: 'todo', depth, done: todo[1] !== ' ', runs: inlineRuns(todo[2]) };
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) return { kind: 'bullet', depth, runs: inlineRuns(bullet[1]) };

    const num = /^(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (num) return { kind: 'number', depth, marker: `${num[1]}.`, runs: inlineRuns(num[2]) };

    // Leading spaces stay in a plain line, the way the box has always shown
    // them. Only lists read an indent as nesting.
    return { kind: 'p', depth: 0, runs: inlineRuns(raw.replace(/\s+$/, '')) };
  });
}

/** Whether a box holds anything markdown would treat as more than plain text. */
export function hasMarkup(text: string): boolean {
  return parseMarkdown(text).some(
    (b) => b.kind !== 'p' || b.runs.some((r) => r.bold || r.italic)
  );
}
