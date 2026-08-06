import * as pdfjsLib from 'pdfjs-dist';
// Bundled locally with ?url so the app works with no internet connection.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };

/**
 * Live viewports of the pages currently rendered, keyed by page index.
 *
 * Dragging an annotation onto another page has to convert the drop point using
 * that page's viewport, not the one the drag started in, or the annotation
 * lands wrong on any page with a different size or rotation. PdfPage keeps
 * this in step as pages render and release.
 */
export const pageViewports = new Map<number, any>();

export function loadPdf(url: string) {
  return pdfjsLib.getDocument({ url, enableXfa: false }).promise;
}

export async function buildTextLayer(page: any, container: HTMLElement, viewport: any) {
  container.replaceChildren();
  const lib: any = pdfjsLib;
  if (lib.TextLayer) {
    const layer = new lib.TextLayer({
      textContentSource: page.streamTextContent(),
      container,
      viewport,
    });
    await layer.render();
  } else {
    // pdfjs-dist v3 and earlier
    await lib.renderTextLayer({
      textContentSource: page.streamTextContent(),
      container,
      viewport,
    }).promise;
  }
  trackSelection(container);
}

/**
 * Text layer spans are absolutely positioned with gaps between the lines, so a
 * drag that passes through a gap lands on the container instead of a glyph and
 * the browser jumps the selection to the container's edge, grabbing the whole
 * page or a random block.
 *
 * pdf.js solves this in its own viewer with a spacer that follows the
 * selection anchor and swallows those gaps. We build the text layer from the
 * core library rather than the viewer, so that piece has to be wired here.
 * Trimmed to what we need from TextLayerBuilder in pdfjs-dist/web.
 */
const spacers = new Map<HTMLElement, HTMLElement>();
let selectionWired = false;

export function forgetTextLayer(container: HTMLElement | null) {
  if (container) spacers.delete(container);
}

function trackSelection(container: HTMLElement) {
  const end = document.createElement('div');
  end.className = 'endOfContent';
  container.append(end);
  // A rebuild replaces the spacer but must not stack another listener on a
  // container we are already tracking.
  const first = !spacers.has(container);
  spacers.set(container, end);
  if (first) {
    container.addEventListener('mousedown', () => container.classList.add('selecting'));
  }

  if (selectionWired) return;
  selectionWired = true;

  const reset = (spacer: HTMLElement, layer: HTMLElement) => {
    layer.append(spacer);
    spacer.style.width = '';
    spacer.style.height = '';
    layer.classList.remove('selecting');
  };
  const resetAll = () => spacers.forEach(reset);

  let down = false;
  document.addEventListener('pointerdown', () => { down = true; });
  document.addEventListener('pointerup', () => { down = false; resetAll(); });
  window.addEventListener('blur', () => { down = false; resetAll(); });
  document.addEventListener('keyup', () => { if (!down) resetAll(); });

  let previous: Range | null = null;
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return resetAll();

    // Only layers the selection actually touches stay armed.
    const touched = new Set<HTMLElement>();
    for (let i = 0; i < selection.rangeCount; i++) {
      const r = selection.getRangeAt(i);
      for (const layer of spacers.keys()) if (r.intersectsNode(layer)) touched.add(layer);
    }
    for (const [layer, spacer] of spacers) {
      if (touched.has(layer)) layer.classList.add('selecting');
      else reset(spacer, layer);
    }

    // Park the spacer beside whichever end of the selection is moving, so the
    // gap the pointer is crossing belongs to it rather than to the container.
    const range = selection.getRangeAt(0);
    const growingUp =
      !!previous &&
      (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
    let anchor: any = growingUp ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    const layer = anchor?.parentElement?.closest('.textLayer') as HTMLElement | null;
    const spacer = layer && spacers.get(layer);
    if (spacer && layer) {
      spacer.style.width = layer.style.width;
      spacer.style.height = layer.style.height;
      anchor.parentElement.insertBefore(spacer, growingUp ? anchor : anchor.nextSibling);
    }
    previous = range.cloneRange();
  });
}
