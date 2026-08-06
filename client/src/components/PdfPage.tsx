import { useEffect, useRef, useState } from 'react';
import { buildTextLayer, forgetTextLayer, pageViewports } from '../pdf';
import { hitsInTextLayer, type Hit } from '../lib/search';
import { useStore } from '../store';
import AnnotationLayer from './AnnotationLayer';

// Above 2x there is no visible gain and memory cost grows with the square.
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

type Props = {
  pdf: any;
  pageIndex: number;
  scale: number;
  /** This page's size at scale 1, measured once when the document loaded. */
  natural: { w: number; h: number } | undefined;
};

export default function PdfPage({ pdf, pageIndex, scale, natural }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<any>(null);
  /** Holds the last drawn bitmap so a re-render never shows a blank page. */
  const keep = useRef<HTMLCanvasElement>(document.createElement('canvas'));

  const [viewport, setViewport] = useState<any>(null);
  const [near, setNear] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);

  /**
   * Worked out here and now rather than fetched. Viewport dimensions are linear
   * in the scale, so multiplying the measured size is exact, rotation included.
   * Asking pdf.js for it per zoom step meant every page resized on its own
   * promise, so the document kept relaying out under the scrollbar for a few
   * frames after a zoom and whatever you were reading slid away.
   */
  const size = natural
    ? { w: natural.w * scale, h: natural.h * scale }
    : { w: 600 * scale, h: 800 * scale };

  const searchQuery = useStore((s) => s.searchQuery);

  // Only decides whether to keep this page's canvas. Which page you are *on* is
  // measured from the scroll position in Viewer: the generous rootMargin here
  // means a page 700px off screen still reports as intersecting, so this
  // observer is the wrong thing to ask.
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setNear(e.isIntersecting);
      },
      { rootMargin: '700px 0px' }
    );
    if (wrapRef.current) io.observe(wrapRef.current);
    return () => io.disconnect();
  }, [pageIndex]);

  // Give the backing store back when the page scrolls far away. Without this a
  // long document never releases any canvas memory.
  useEffect(() => {
    if (near) return;
    const c = canvasRef.current;
    if (c) {
      c.width = 0;
      c.height = 0;
    }
    // Releasing the canvas is the whole point here, so let the held copy go
    // too. A page scrolled far away is meant to come back blank for a moment.
    keep.current.width = 0;
    keep.current.height = 0;
    textRef.current?.replaceChildren();
    pageViewports.delete(pageIndex);
    setViewport(null);
    setHits([]);
  }, [near, pageIndex]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;

    (async () => {
      const page = await pdf.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale });
      if (cancelled) return;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ratio = dpr();

      // Resizing a canvas wipes it, and the fresh render is asynchronous, so
      // the page would flash white in between and look like it was reloading.
      // Keep the old picture, stretched to the new size, until the real one
      // arrives. Blurry for a frame or two beats blank.
      const held = keep.current;
      if (canvas.width && canvas.height) {
        held.width = canvas.width;
        held.height = canvas.height;
        held.getContext('2d')?.drawImage(canvas, 0, 0);
      }
      const stale = held.width > 0 && held.height > 0;

      canvas.width = Math.floor(vp.width * ratio);
      canvas.height = Math.floor(vp.height * ratio);
      if (stale) {
        const g = canvas.getContext('2d');
        g?.drawImage(held, 0, 0, held.width, held.height, 0, 0, canvas.width, canvas.height);
      }

      // Cancel any in-flight render first, or pdf.js throws
      // "Cannot use the same canvas during multiple render() operations".
      taskRef.current?.cancel();
      const task = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: vp,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      taskRef.current = task;

      try {
        await task.promise;
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') console.error(err);
        return;
      }
      if (cancelled) return;

      await buildTextLayer(page, textRef.current!, vp);
      pageViewports.set(pageIndex, vp);
      setViewport(vp);
    })();

    return () => {
      cancelled = true;
      taskRef.current?.cancel();
    };
  }, [pdf, pageIndex, scale, near]);

  useEffect(
    () => () => {
      pageViewports.delete(pageIndex);
      forgetTextLayer(textRef.current);
    },
    [pageIndex]
  );

  useEffect(() => {
    if (!viewport || !textRef.current || !wrapRef.current || !searchQuery.trim()) {
      setHits([]);
      return;
    }
    setHits(hitsInTextLayer(textRef.current, wrapRef.current, searchQuery));
  }, [viewport, searchQuery]);

  return (
    <div
      ref={wrapRef}
      data-page={pageIndex}
      className="page-shell mx-auto bg-white shadow-lg"
      style={{ width: size.w, height: size.h, ['--scale-factor' as any]: scale }}
    >
      {/*
        The CSS size comes from the shell, in the same commit as a zoom, so the
        old bitmap stretches to fill immediately. Leaving it to the async render
        to set left the canvas at its old size inside an already-resized shell,
        which is the white band you saw while zooming.
      */}
      <canvas
        ref={canvasRef}
        className="block"
        style={{ width: size.w, height: size.h }}
      />
      <div ref={textRef} className="textLayer absolute inset-0" />

      {hits.map((hit) =>
        hit.boxes.map((b, i) => (
          <div
            key={`${hit.ordinal}-${i}`}
            data-hit={i === 0 ? `${pageIndex}:${hit.ordinal}` : undefined}
            className="absolute bg-amber-400/40 pointer-events-none"
            style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
          />
        ))
      )}

      {viewport && (
        <AnnotationLayer
          pageIndex={pageIndex}
          viewport={viewport}
          textLayerEl={textRef.current}
          pageSize={{ width: size.w / scale, height: size.h / scale }}
        />
      )}

      <div className="absolute -left-9 top-1 text-xs text-neutral-500 select-none">
        {pageIndex + 1}
      </div>
    </div>
  );
}
