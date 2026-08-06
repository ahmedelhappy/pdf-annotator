import { describe, it, expect } from 'vitest';
import {
  blockSize, hasMarkup, HEADING_SCALE, indentFor, inlineRuns, MARKER_WIDTH, markerFor,
  markerWidth, parseMarkdown, type Block,
} from '../lib/markdown';
// The server's copy, imported here so the two can be held against each other.
import * as server from '../../../server/src/lib/markdown.js';

const SAMPLES = [
  '',
  'plain text',
  '# Heading one',
  '## Heading two',
  '### Heading three',
  '#### four hashes is not a heading',
  '#no space is not a heading',
  '- a bullet',
  '* also a bullet',
  '+ and a plus',
  '  - nested once',
  '    - nested twice',
  '            - deeper than the cap',
  '1. numbered',
  '12) numbered with a bracket',
  '[ ] unticked',
  '[x] ticked',
  '[X] ticked with a capital',
  '- [ ] bullet and a box',
  'plain **bold** here',
  'plain *italic* here',
  '***both at once***',
  'a\\*literal\\* asterisk',
  'file_name_with_underscores',
  'trailing spaces   ',
  '  leading spaces on a plain line',
  '# Heading with **bold** in it',
  '- bullet with *italic*',
  'unclosed **bold',
  '*',
  '**',
  'a\nb\nc',
  '# one\n- two\n[x] three',
];

describe('markdown parity between the client and the server', () => {
  it('parses every sample identically', () => {
    for (const s of SAMPLES) {
      expect(server.parseMarkdown(s), `parseMarkdown(${JSON.stringify(s)})`)
        .toEqual(parseMarkdown(s));
    }
  });

  it('splits inline runs identically', () => {
    for (const s of SAMPLES) {
      expect(server.inlineRuns(s), `inlineRuns(${JSON.stringify(s)})`).toEqual(inlineRuns(s));
    }
  });

  it('agrees on sizes, markers and indents', () => {
    for (const s of SAMPLES) {
      for (const b of parseMarkdown(s)) {
        expect(server.blockSize(b, 14)).toBe(blockSize(b, 14));
        expect(server.markerFor(b)).toBe(markerFor(b));
        expect(server.indentFor(b, 14)).toBe(indentFor(b, 14));
        expect(server.markerWidth(b, 14)).toBe(markerWidth(b, 14));
      }
    }
  });

  it('agrees on the heading scale and the marker widths', () => {
    expect(server.HEADING_SCALE).toEqual(HEADING_SCALE);
    expect(server.MARKER_WIDTH).toEqual(MARKER_WIDTH);
  });
});

const one = (s: string): Block => parseMarkdown(s)[0];

describe('markdown blocks', () => {
  it('reads one to three hashes as a heading', () => {
    expect(one('# a').kind).toBe('h1');
    expect(one('## a').kind).toBe('h2');
    expect(one('### a').kind).toBe('h3');
  });

  it('needs a space after the hashes', () => {
    expect(one('#nope').kind).toBe('p');
  });

  it('leaves four hashes as plain text', () => {
    expect(one('#### a').kind).toBe('p');
  });

  it('takes any of the three bullet characters', () => {
    for (const c of ['-', '*', '+']) expect(one(`${c} item`).kind).toBe('bullet');
  });

  it('reads two spaces as one level of nesting', () => {
    expect(one('- a').depth).toBe(0);
    expect(one('  - a').depth).toBe(1);
    expect(one('    - a').depth).toBe(2);
  });

  it('caps nesting so a list cannot run off the box', () => {
    expect(one('                    - a').depth).toBe(3);
  });

  it('reads a checkbox with or without a bullet', () => {
    expect(one('[ ] a').kind).toBe('todo');
    expect(one('- [ ] a').kind).toBe('todo');
    expect(one('* [x] a').kind).toBe('todo');
  });

  it('knows a ticked box from an empty one', () => {
    expect(one('[ ] a').done).toBe(false);
    expect(one('[x] a').done).toBe(true);
    expect(one('[X] a').done).toBe(true);
  });

  it('keeps a numbered item its own number', () => {
    expect(one('7. a').marker).toBe('7.');
    expect(one('7) a').marker).toBe('7.');
  });

  it('gives every source line its own block', () => {
    expect(parseMarkdown('a\nb\nc')).toHaveLength(3);
  });

  it('keeps an empty line as an empty block, not nothing', () => {
    const bs = parseMarkdown('a\n\nb');
    expect(bs).toHaveLength(3);
    expect(bs[1].kind).toBe('p');
  });

  it('strips the marker from the text it keeps', () => {
    expect(one('- item').runs[0].text).toBe('item');
    expect(one('## head').runs[0].text).toBe('head');
    expect(one('[x] done').runs[0].text).toBe('done');
  });

  it('leaves leading spaces in a plain line alone', () => {
    expect(one('  indented').runs[0].text).toBe('  indented');
  });
});

describe('markdown emphasis', () => {
  it('reads double asterisks as bold', () => {
    expect(inlineRuns('a **b** c')).toEqual([
      { text: 'a ', bold: false, italic: false },
      { text: 'b', bold: true, italic: false },
      { text: ' c', bold: false, italic: false },
    ]);
  });

  it('reads a single asterisk as italic', () => {
    expect(inlineRuns('*b*')).toEqual([{ text: 'b', bold: false, italic: true }]);
  });

  it('leaves underscores alone, since words contain them', () => {
    expect(inlineRuns('file_name_here')).toEqual([
      { text: 'file_name_here', bold: false, italic: false },
    ]);
  });

  it('lets a backslash through a literal asterisk', () => {
    expect(inlineRuns('2 \\* 3')).toEqual([{ text: '2 * 3', bold: false, italic: false }]);
  });

  it('never returns nothing, so an empty line still takes a line', () => {
    expect(inlineRuns('')).toHaveLength(1);
  });

  it('carries an unclosed marker to the end rather than dropping the text', () => {
    expect(inlineRuns('a **b').map((r) => r.text).join('')).toBe('a b');
    expect(inlineRuns('a **b').at(-1)).toEqual({ text: 'b', bold: true, italic: false });
  });
});

describe('markdown measurements', () => {
  it('makes a heading bigger than the body', () => {
    expect(blockSize(one('# a'), 14)).toBeGreaterThan(14);
    expect(blockSize(one('### a'), 14)).toBeGreaterThan(14);
  });

  it('leaves a plain line at the box size', () => {
    expect(blockSize(one('a'), 14)).toBe(14);
  });

  it('orders the heading sizes largest first', () => {
    expect(HEADING_SCALE.h1).toBeGreaterThan(HEADING_SCALE.h2);
    expect(HEADING_SCALE.h2).toBeGreaterThan(HEADING_SCALE.h3);
    expect(HEADING_SCALE.h3).toBeGreaterThan(1);
  });

  it('indents a list but not a paragraph or a heading', () => {
    expect(indentFor(one('a'), 14)).toBe(0);
    expect(indentFor(one('# a'), 14)).toBe(0);
    expect(indentFor(one('- a'), 14)).toBeGreaterThan(0);
  });

  it('indents each nesting level further than the last', () => {
    expect(indentFor(one('  - a'), 14)).toBeGreaterThan(indentFor(one('- a'), 14));
  });

  it('holds a wider column open for a checkbox than for a bullet', () => {
    // `[x]` is three characters where a bullet is one dot, and with one width
    // for both the checkbox ran into the words beside it.
    expect(markerWidth(one('[x] a'), 14)).toBeGreaterThan(markerWidth(one('- a'), 14));
    expect(markerWidth(one('1. a'), 14)).toBeGreaterThan(markerWidth(one('- a'), 14));
  });

  it('reserves no column where there is no marker', () => {
    expect(markerWidth(one('plain'), 14)).toBe(0);
    expect(markerWidth(one('# head'), 14)).toBe(0);
  });

  it('indents a list item by exactly the column it reserved', () => {
    for (const src of ['- a', '1. a', '[x] a']) {
      expect(indentFor(one(src), 14)).toBe(markerWidth(one(src), 14));
    }
  });

  it('tells markup apart from plain text', () => {
    expect(hasMarkup('just words')).toBe(false);
    expect(hasMarkup('line one\nline two')).toBe(false);
    expect(hasMarkup('# a heading')).toBe(true);
    expect(hasMarkup('- a bullet')).toBe(true);
    expect(hasMarkup('some **bold**')).toBe(true);
  });
});
