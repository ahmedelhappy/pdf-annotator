/**
 * Generates a sample PDF for smoke testing.
 *
 *   node scripts/make-sample.js
 *
 * Writes sample.pdf next to the project root. It deliberately contains things
 * that break naive implementations: several pages, real selectable text, a
 * repeated search term with a known count, a pre-rotated page, and a page in
 * landscape so page-size inheritance on insert can be checked.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

// Resolved against this file so the script works from any working directory.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const A4 = [595.28, 841.89];
const LANDSCAPE = [841.89, 595.28];

// "annotate" appears exactly 7 times across the document. Searching for it is
// the fastest way to tell whether the scanner and the highlighter agree.
const PAGES = [
  {
    size: A4,
    title: 'Page one: plain text',
    body: [
      'This page exists so you can test text selection and highlighting.',
      'Drag across this sentence with the highlight tool active and the',
      'highlight should snap to the line boxes rather than to a rectangle',
      'you drew by hand. If it snaps to your drag instead, the text layer',
      'is not being found. The word annotate appears here once.',
    ],
  },
  {
    size: A4,
    title: 'Page two: search targets',
    body: [
      'The word annotate appears twice on this page. annotate.',
      'Search for it and the counter should say 7 matches across the whole',
      'document. If the count is right but pressing the down arrow jumps to',
      'the wrong spot, the scanner and the highlighter disagree about how',
      'page text is stitched together.',
    ],
  },
  {
    size: LANDSCAPE,
    title: 'Page three: landscape',
    body: [
      'This page is landscape. Insert a blank page after it and the new page',
      'should inherit these dimensions rather than defaulting to A4.',
      'The word annotate appears here once.',
    ],
  },
  {
    size: A4,
    rotation: 90,
    title: 'Page four: pre-rotated',
    body: [
      'This page carries a rotation of 90 degrees inside the PDF itself.',
      'Draw on it. Then zoom to 300 percent and confirm the ink stays',
      'exactly where you put it. Then rotate the page again from the',
      'thumbnail sidebar and confirm the ink rotates with the content.',
      'The word annotate appears here once.',
    ],
  },
  {
    size: A4,
    title: 'Page five: dense text',
    body: [
      'Repetition below gives the simplifier something to chew on and gives',
      'you a long block to select across line breaks.',
      '',
      ...Array.from({ length: 14 }, (_, i) =>
        `Line ${i + 1}. Selection across many lines produces many client rects.`
      ),
      'The word annotate appears here once.',
    ],
  },
  {
    size: A4,
    title: 'Page six: last page',
    body: [
      'Delete this page and every annotation on it should disappear while',
      'nothing on earlier pages moves. Duplicate it instead and annotations',
      'on it should stay on the original only.',
      'The word annotate appears here once.',
    ],
  },
];

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

for (const spec of PAGES) {
  const page = pdf.addPage(spec.size);
  const { width, height } = page.getSize();

  page.drawText(spec.title, {
    x: 56, y: height - 80, size: 20, font: bold, color: rgb(0.1, 0.1, 0.12),
  });
  page.drawLine({
    start: { x: 56, y: height - 92 },
    end: { x: width - 56, y: height - 92 },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.82),
  });

  let y = height - 124;
  for (const line of spec.body) {
    if (line) {
      page.drawText(line, { x: 56, y, size: 12, font, color: rgb(0.15, 0.15, 0.18) });
    }
    y -= 20;
  }

  if (spec.rotation) page.setRotation(degrees(spec.rotation));
}

const out = path.join(PROJECT_ROOT, 'sample.pdf');
await fs.writeFile(out, await pdf.save());

const text = PAGES.flatMap((p) => p.body).join(' ');
const count = (text.match(/annotate/g) || []).length;
console.log(`Wrote ${out}`);
console.log(`${PAGES.length} pages, "annotate" appears ${count} times`);
