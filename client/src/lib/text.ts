/**
 * Text box layout. One definition of the face and leading, shared by the page,
 * the measuring done here, and the export, so a line that wraps on screen wraps
 * in the same place on paper.
 *
 * pdf-lib has Helvetica built in; Arial is the metric-compatible stand-in for
 * when it is missing.
 */
export const TEXT_FONT = 'Helvetica, Arial, sans-serif';
export const TEXT_LEADING = 1.35;

/** One offscreen element, reused: creating one per measurement thrashes layout. */
let ruler: HTMLDivElement | null = null;

function rulerFor(w: number, fontSize: number): HTMLDivElement | null {
  if (typeof document === 'undefined') return null;
  if (!ruler) {
    ruler = document.createElement('div');
    ruler.setAttribute('aria-hidden', 'true');
    Object.assign(ruler.style, {
      position: 'fixed',
      left: '-9999px',
      top: '0',
      visibility: 'hidden',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
      fontFamily: TEXT_FONT,
      padding: '0',
      margin: '0',
      border: '0',
    });
    document.body.appendChild(ruler);
  }
  ruler.style.width = `${w}px`;
  ruler.style.fontSize = `${fontSize}px`;
  ruler.style.lineHeight = String(TEXT_LEADING);
  return ruler;
}

/**
 * Zero width, so the empty line a trailing newline opens is still measured. A
 * block drops that line; a textarea keeps it, because the caret can sit there.
 * Pressing Enter has to lengthen the box, and without this the frame stayed one
 * line behind the caret every time a new line was opened.
 */
const TAIL = '​';

/**
 * How tall a run of text needs to be at a given width, in PDF points. Measured
 * rather than counted: a pasted paragraph is often one long line that wraps into
 * many, so counting newlines gives a box one line tall and text spilling out of
 * the bottom of it.
 */
export function textHeight(text: string, w: number, fontSize: number): number {
  const oneLine = fontSize * TEXT_LEADING;
  const el = rulerFor(Math.max(1, w), fontSize);
  if (!el) return Math.max(oneLine, (text.split('\n').length || 1) * oneLine);
  el.textContent = (text || '') + TAIL;
  return Math.max(oneLine, el.scrollHeight);
}
