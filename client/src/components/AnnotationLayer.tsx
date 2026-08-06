import { useEffect, useMemo, useRef, useState } from 'react';
import { AUTO_COLOR, AUTO_ON_DARK, AUTO_ON_LIGHT, AUTO_WASH_ON_DARK, AUTO_WASH_ON_LIGHT, useStore } from '../store';
import { api } from '../api';
import {
  bboxOf, computeSnap, intersects, localPoint, NOTE_SIZE,
  rectToBox, rectToPdf, rotatePoint, scaleData, toPdf, toView, translate, unionBox,
  type Guide,
} from '../lib/geometry';
import { normalizePressure, simplify, strokeOutline } from '../lib/ink';
import { TEXT_FONT, TEXT_LEADING } from '../lib/text';
import { pageViewports } from '../pdf';
import type { Annotation, AnnType, Box, InkPt, Pt, Rect } from '../types';

/** Pixels of slack before a drag snaps to a neighbour. */
const SNAP_PX = 6;
/** Ramer-Douglas-Peucker tolerance, in screen pixels. */
const SIMPLIFY_PX = 0.9;
/** Gap between a note's dot and its popover, and the popover's own size. */
const NOTE_GAP = 24;
const POPOVER_W = 224;
const POPOVER_H = 140;
const POPOVER_MIN_W = 140;
const POPOVER_MIN_H = 90;
/** Narrowest a text box may be scaled, in PDF points. */
const MIN_TEXT_W = 24;
/** Slack around a text box's words, so clicking one needs no precision. */
const HIT_SLACK = 4;
/** How far a press may wander and still count as a click, not a drag. */
const CLICK_SLOP = 4;


type Props = {
  pageIndex: number;
  viewport: any;
  textLayerEl: HTMLElement | null;
  pageSize: { width: number; height: number };
};

export default function AnnotationLayer({ pageIndex, viewport, textLayerEl, pageSize }: Props) {
  // Narrow selectors: this component must not re-render when a different
  // page's annotations change, or when unrelated UI state toggles.
  const mine = useStore((s) => s.byPage[pageIndex]) ?? EMPTY;
  const tool = useStore((s) => s.tool);
  const style = useStore((s) => s.style);
  const selectedIds = useStore((s) => s.selectedIds);
  const editingId = useStore((s) => s.editingId);

  const shellRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingPt = useRef<Pt | null>(null);
  const shapeDrag = useRef<any>(null);
  const scaleDrag = useRef<any>(null);
  const spinDrag = useRef<any>(null);
  /** The colour settled on when the pointer went down, held for the stroke. */
  const penColor = useRef<string>(style.color);

  const [draftInk, setDraftInk] = useState<InkPt[] | null>(null);
  const [draftRect, setDraftRect] = useState<{ a: Pt; b: Pt } | null>(null);
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null);
  const marqueeRef = useRef<{ a: Pt; b: Pt } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  /** Whatever is being dragged rides above its neighbours for the drag. */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** Every selected annotation's starting data, while a group drag is running. */
  const groupDrag = useRef<{ id: string; type: AnnType; data: any }[] | null>(null);
  /** A press on a group member, waiting to see whether it becomes a drag. */
  const pressed = useRef<{ id: string; x: number; y: number } | null>(null);

  /**
   * Right click opens the layer menu. Inside a multiple selection it acts on all
   * of it and says so; outside one it narrows the selection to what the pointer
   * is actually on, so the menu never claims more than it will do.
   */
  function openMenu(e: React.MouseEvent, id: string) {
    if (tool !== 'select') return;
    e.preventDefault();
    e.stopPropagation();
    const many = selectedIds.length > 1 && selectedIds.includes(id);
    const ids = many ? [...selectedIds] : [id];
    if (!many) act().select(id, false);
    setMenu({ ...localPoint(shellRef.current!, e), ids });
  }

  const drawing = tool !== 'select';
  const isSelected = (id: string) => selectedIds.includes(id);

  /**
   * Every annotation goes inert while a drawing tool is active, so a pointer
   * lands on the page rather than on whatever happens to be lying there. That
   * is what lets you draw straight over a picture instead of grabbing it, and
   * what lets a highlight drag reach the text layer underneath.
   *
   * Select needs the shapes so they can be picked up; the eraser needs them so
   * it can rub them out. Everything else passes through.
   */
  const inert = tool !== 'select' && tool !== 'eraser';

  function act() {
    return useStore.getState();
  }

  /**
   * Drops a text box that was left with nothing in it. Deferred by a tick so
   * the click that moved focus has landed, and skipped while the box is still
   * selected: reaching for a resize handle blurs the textarea too, and that is
   * not abandoning it.
   */
  function removeIfAbandoned(id: string) {
    setTimeout(() => {
      const s = act();
      if (s.selectedIds.includes(id)) return;
      const cur = s.annotations.find((a) => a._id === id);
      if (cur && cur.type === 'text' && !String(cur.data?.text || '').trim()) s.remove([id]);
    }, 0);
  }

  /**
   * Reads the page underneath and answers with a colour that will show up on
   * it. Sampled from the rendered canvas on a coarse grid, which is plenty to
   * tell paper from a dark figure, and cheap enough to do per annotation.
   */
  function contrastFor(box: Box): string {
    const canvas = shellRef.current?.parentElement?.querySelector(
      'canvas'
    ) as HTMLCanvasElement | null;
    if (!canvas?.width) return AUTO_ON_LIGHT;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return AUTO_ON_LIGHT;

    // The backing store is denser than the CSS box on a retina screen.
    const dense = canvas.width / (parseFloat(canvas.style.width) || viewport.width);
    const x = Math.max(0, Math.round(box.left * dense));
    const y = Math.max(0, Math.round(box.top * dense));
    const w = Math.max(1, Math.min(Math.round(box.width * dense), canvas.width - x));
    const h = Math.max(1, Math.min(Math.round(box.height * dense), canvas.height - y));

    let sum = 0;
    let n = 0;
    try {
      const d = g.getImageData(x, y, w, h).data;
      // Every 16th pixel: the answer only has to be light or dark.
      for (let i = 0; i < d.length; i += 64) {
        sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        n++;
      }
    } catch {
      return AUTO_ON_LIGHT;
    }
    if (!n) return AUTO_ON_LIGHT;
    return sum / n > 140 ? AUTO_ON_LIGHT : AUTO_ON_DARK;
  }

  /** The style to draw with now, using the colour fixed at pointer down. */
  const drawStyle = () => ({ ...style, color: penColor.current });

  /**
   * The pen's style, with an automatic colour settled on if that is chosen.
   * A highlighter needs a different answer from a pen: near-black would blot
   * out the words it is meant to be drawing attention to, so it gets a wash
   * that reads on the background instead.
   */
  function styleOver(box: Box, wash = false): typeof style {
    if (style.color !== AUTO_COLOR) return style;
    const light = contrastFor(box) === AUTO_ON_LIGHT;
    if (wash) return { ...style, color: light ? AUTO_WASH_ON_LIGHT : AUTO_WASH_ON_DARK };
    return { ...style, color: light ? AUTO_ON_LIGHT : AUTO_ON_DARK };
  }

  const inkPath = (a: Annotation) =>
    strokeOutline(
      (a.data.points as InkPt[]).map((p) => {
        const v = toView(viewport, p.x, p.y);
        return { x: v.x, y: v.y, p: p.p };
      }),
      (a.style?.width ?? 2) * viewport.scale
    );

  // Erasing follows the live button state rather than a flag. The capture
  // surface is inert while the eraser is active, so its pointerup never fires
  // and any flag set on pointerdown would stay stuck on, turning a bare hover
  // into a delete.
  function eraseOnHover(e: React.PointerEvent, a: Annotation) {
    if (a.locked) return;
    if (tool === 'eraser' && e.buttons > 0 && ERASABLE.includes(a.type)) act().remove([a._id]);
  }

  function hit(e: React.PointerEvent, a: Annotation) {
    e.stopPropagation();
    if (tool === 'eraser') {
      // The eraser rubs out marks. Boxes, notes and pictures are objects: they
      // go through select and Delete, so a stray swipe cannot wipe out a note
      // you spent a minute writing.
      if (ERASABLE.includes(a.type)) act().remove([a._id]);
      return;
    }
    // Only the primary button changes what is selected. A right press used to
    // narrow a multiple selection down to one before the menu had even opened,
    // so the menu could never speak for the group.
    if (e.button !== 0) return;

    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!additive && selectedIds.length > 1 && selectedIds.includes(a._id)) {
      // Pressing something already in the selection keeps the selection: that
      // press is how dragging the group starts. Narrowing here is what made a
      // group come apart the moment you touched one of its members. If the
      // press turns out to be a click and not a drag, the listener below
      // narrows to this one after the fact.
      pressed.current = { id: a._id, x: e.clientX, y: e.clientY };
      return;
    }
    pressed.current = null;
    act().select(a._id, additive);
  }

  /**
   * Finishes the decision `hit` deferred. A press on a group member that never
   * moved was a click, and a click picks that one thing out of the group.
   */
  useEffect(() => {
    const up = (e: PointerEvent) => {
      const p = pressed.current;
      pressed.current = null;
      if (!p || e.button !== 0) return;
      if (Math.abs(e.clientX - p.x) < CLICK_SLOP && Math.abs(e.clientY - p.y) < CLICK_SLOP)
        act().select(p.id, false);
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  // Drawings live in SVG, so they get their own drag rather than the one
  // HtmlAnnotation uses. Strokes move point by point, highlights move a rect.
  function startShapeDrag(e: React.PointerEvent, a: Annotation) {
    hit(e, a);
    if (e.button !== 0 || tool !== 'select' || a.locked) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const box = rectToBox(viewport, bboxOf(a));
    shapeDrag.current = {
      id: a._id,
      type: a.type,
      sx: e.clientX,
      sy: e.clientY,
      data: a.data,
      // Where the pointer sits inside the drawing, so a drop onto another page
      // lands it under the cursor rather than by its corner.
      grabX: e.clientX - (shellRef.current!.getBoundingClientRect().left + box.left),
      grabY: e.clientY - (shellRef.current!.getBoundingClientRect().top + box.top),
      boxW: box.width,
      boxH: box.height,
    };
    setDraggingId(a._id);
    beginGroup();
    // Float this page over its neighbours, or a drawing dragged past the edge
    // slides underneath the next page and looks like it vanished.
    liftPage(shellRef.current, true);
  }

  function moveShape(e: React.PointerEvent) {
    const d = shapeDrag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / viewport.scale;
    const dy = (e.clientY - d.sy) / viewport.scale;
    if (groupDrag.current) return moveGroup(dx, -dy, e.altKey);
    let next = translate(d.type, d.data, dx, -dy);
    if (!e.altKey) {
      const box = bboxOf({ type: d.type, data: next, style: {} } as any);
      const snap = computeSnap(box, neighbours, pageSize, SNAP_PX / viewport.scale);
      if (snap.dx || snap.dy) next = translate(d.type, next, snap.dx, snap.dy);
      setGuides(snap.guides);
    } else {
      setGuides([]);
    }
    act().update(d.id, next);
  }

  /**
   * A drawing dropped over another page moves there, converted through that
   * page's own viewport so a page of a different size or rotation still gets it
   * in the right place. Same rule the boxes follow.
   */
  function endShape(e?: React.PointerEvent) {
    const d = shapeDrag.current;
    shapeDrag.current = null;
    setDraggingId(null);
    setGuides([]);
    liftPage(shellRef.current, false);
    // A group keeps its page. Re-homing is one annotation at a time, and half a
    // selection landing on the next page is worse than none of it.
    if (endGroup()) return;
    if (!d || !e) return;

    const shell = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((el) => (el as HTMLElement).dataset?.page !== undefined) as HTMLElement | undefined;
    if (!shell) return;
    const to = Number(shell.dataset.page);
    if (!Number.isFinite(to) || to === pageIndex) return;
    const tvp = pageViewports.get(to);
    if (!tvp) return;

    const r = shell.getBoundingClientRect();
    const lx = e.clientX - d.grabX - r.left;
    const ly = e.clientY - d.grabY - r.top;
    const landed = rectToPdf(tvp, { x: lx, y: ly }, { x: lx + d.boxW, y: ly + d.boxH });

    // Shift the whole thing by the difference between where it is and where it
    // should land, so strokes keep their shape and highlights keep their lines.
    const now = act().annotations.find((a) => a._id === d.id);
    if (!now) return;
    const here = bboxOf(now as Annotation);
    act().moveToPage(d.id, to, translate(d.type, now.data, landed.x - here.x, landed.y - here.y));
  }

  async function onDrawDown(e: React.PointerEvent) {
    const p = localPoint(shellRef.current!, e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    // Settle an automatic colour here, where the pointer went down, and keep it
    // for the whole stroke. Deciding on release meant drawing in one colour and
    // watching it change to another the moment you let go.
    penColor.current = styleOver(
      { left: p.x - 6, top: p.y - 6, width: 12, height: 12 },
      tool === 'rect' || tool === 'highlight'
    ).color;

    if (tool === 'ink') {
      setDraftInk([{ ...p, p: normalizePressure(e as any) }]);
      return;
    }
    // Both of these are drawn by dragging a box. Text falls back to a default
    // size on a plain click, so tapping the page still gets you a box.
    if (tool === 'rect' || tool === 'text') {
      setDraftRect({ a: p, b: p });
      return;
    }
    if (tool === 'note') {
      const pdfPt = toPdf(viewport, p.x, p.y);
      const created = await act().add({
        pageIndex,
        type: 'note',
        style: styleOver({
          left: p.x,
          top: p.y - NOTE_SIZE * viewport.scale,
          width: 12,
          height: 12,
        }),
        data: { ...pdfPt, text: '' },
      });
      if (created) {
        act().setTool('select');
        act().select(created._id);
        act().setEditing(created._id);
      }
      return;
    }
    if (tool === 'image') {
      pendingPt.current = p;
      fileRef.current?.click();
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!draftInk && !draftRect) return;
    const p = localPoint(shellRef.current!, e);
    if (draftInk) {
      // Shift rules a straight line: keep only where the stroke began and where
      // the pointer is now, so the preview snaps taut as you move.
      if (e.shiftKey) setDraftInk((d) => [d![0], { ...p, p: normalizePressure(e as any) }]);
      else setDraftInk((d) => [...d!, { ...p, p: normalizePressure(e as any) }]);
    }
    if (draftRect) setDraftRect((d) => ({ a: d!.a, b: p }));
  }

  async function onPointerUp() {
    if (draftInk) {
      const raw = draftInk;
      setDraftInk(null);
      // Tolerance is quoted in screen pixels, so scale it into the space the
      // points currently live in. Without this, a stroke drawn at 300% keeps
      // three times as many points per PDF unit as one drawn at 100%.
      const kept = simplify(raw, SIMPLIFY_PX * viewport.scale);
      const pdfPts = kept.map((p) => {
        const v = toPdf(viewport, p.x, p.y);
        return { x: v.x, y: v.y, p: p.p };
      });
      if (pdfPts.length > 1) {
        const xs = kept.map((q) => q.x);
        const ys = kept.map((q) => q.y);
        const box = {
          left: Math.min(...xs),
          top: Math.min(...ys),
          width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
          height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
        };
        await act().add({
          pageIndex,
          type: 'ink',
          style: drawStyle(),
          data: { points: pdfPts },
        });
      }
    }

    if (draftRect) {
      const drawn = draftRect;
      setDraftRect(null);

      if (tool === 'text') {
        // A drag sets the box; a click, or a drag too small to mean anything,
        // gets the default size.
        const dragged =
          Math.abs(drawn.b.x - drawn.a.x) > 12 && Math.abs(drawn.b.y - drawn.a.y) > 12;
        const r = dragged
          ? rectToPdf(viewport, drawn.a, drawn.b)
          : rectToPdf(viewport, drawn.a, { x: drawn.a.x + 180, y: drawn.a.y + 48 });
        const created = await act().add({
          pageIndex,
          type: 'text',
          style: drawStyle(),
          data: { ...r, text: '' },
        });
        if (created) {
          act().setTool('select');
          act().select(created._id);
          act().setEditing(created._id);
        }
        return;
      }

      const r = rectToPdf(viewport, drawn.a, drawn.b);
      if (r.w > 2 && r.h > 2) {
        await act().add({
          pageIndex,
          type: 'highlight',
          data: r,
          style: { ...drawStyle(), opacity: Math.min(style.opacity, 0.4) },
        });
      }
    }

  }

  // Text-mode highlight rides on the pdf.js text layer, so it snaps to real
  // glyph boxes instead of a hand-drawn rectangle.
  function onTextSelectionEnd() {
    if (tool !== 'highlight' || !textLayerEl) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!textLayerEl.contains(range.commonAncestorContainer)) return;

    const shell = shellRef.current!.getBoundingClientRect();

    // Collect and drop the selection before anything async. This can fire
    // twice for one selection, and any await in between let both runs see a
    // live selection and lay a second highlight over the first.
    const seen = new Set<string>();
    const rects = Array.from(range.getClientRects()).filter((r) => {
      if (r.width < 1 || r.height < 1) return false;
      // getClientRects can repeat a line when the range spans nested spans.
      const key = [r.left, r.top, r.right, r.bottom].map(Math.round).join();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    selection.removeAllRanges();
    if (!rects.length) return;

    // One annotation for the whole selection, carrying a box per line. Making
    // one annotation per line meant undo peeled the highlight off a line at a
    // time and the eraser only ever caught the line under the cursor.
    const boxes = rects.map((r) =>
      rectToPdf(
        viewport,
        { x: r.left - shell.left, y: r.top - shell.top },
        { x: r.right - shell.left, y: r.bottom - shell.top }
      )
    );
    const bounds = unionBox(boxes)!;

    act().add({
      pageIndex,
      type: 'highlight',
      // x/y/w/h stay the bounding box so everything that reasons about a
      // highlight's extent keeps working; rects is what actually gets painted.
      data: { ...bounds, rects: boxes.length > 1 ? boxes : undefined },
      style: { ...style, opacity: Math.min(style.opacity, 0.4) },
    });
  }

  async function onImageChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !pendingPt.current) return;
    try {
      const { assetId } = await api.uploadAsset(file);
      const bmp = await createImageBitmap(file);
      const w = Math.min(bmp.width, 260);
      const h = (bmp.height / bmp.width) * w;
      const p = pendingPt.current;
      pendingPt.current = null;
      const created = await act().add({
        pageIndex,
        type: 'image',
        // A picture is not ink. It ships opaque whatever the pen is set to.
        style: { ...style, opacity: 1 },
        data: { ...rectToPdf(viewport, p, { x: p.x + w, y: p.y + h }), assetId },
      });
      act().setTool('select');
      if (created) act().select(created._id);
    } catch (err: any) {
      act().setError(err.message);
    }
  }

  // The text layer is a sibling of this overlay, not a child, so a mouseup that
  // ends a text selection never bubbles through here. Listen on the window and
  // let the containment check in onTextSelectionEnd scope it to this page.
  const endSelection = useRef(onTextSelectionEnd);
  endSelection.current = onTextSelectionEnd;
  useEffect(() => {
    if (tool !== 'highlight') return;
    // Picking the highlighter with text already selected highlights it there
    // and then, which is how every reader behaves.
    endSelection.current();
    const onUp = () => endSelection.current();
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [tool]);

  /**
   * Marquee selection, driven from the page shell rather than from a surface
   * laid over the page. A drag that starts on a glyph belongs to the browser,
   * so selecting, copying and dragging the document's own text keep working.
   * Only a drag starting on blank page pulls a selection box.
   */
  useEffect(() => {
    if (tool !== 'select') return;
    const root = shellRef.current;
    const shell = root?.parentElement;
    if (!root || !shell) return;

    function onMove(e: PointerEvent) {
      const m = marqueeRef.current;
      if (!m || !root) return;
      marqueeRef.current = { a: m.a, b: localPoint(root, e) };
      setMarquee(marqueeRef.current);
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const m = marqueeRef.current;
      marqueeRef.current = null;
      setMarquee(null);
      if (!m) return;
      const box = rectToPdf(viewport, m.a, m.b);
      if (box.w <= 3 || box.h <= 3) return;
      const here = act().byPage[pageIndex] || [];
      act().select(here.filter((a) => intersects(bboxOf(a), box)).map((a) => a._id));
    }

    function onDown(e: PointerEvent) {
      if (e.button !== 0 || !root) return;
      const t = e.target as Node;
      if (root.contains(t)) return; // an annotation already handled this

      // Anything outside an annotation drops the selection, glyphs included.
      // Previously a click on text left the old selection standing.
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) act().select(null);
      act().setEditing(null);

      // Only a glyph belongs to the browser. The text layer container itself
      // covers the whole page, so treating a hit on it as text would mean the
      // marquee could never start anywhere.
      if (textLayerEl && t !== textLayerEl && textLayerEl.contains(t)) return;
      // Blank page clears any text selection too. preventDefault below stops
      // the browser doing it for us, so it has to be done by hand or a
      // selection made earlier just sits there highlighted.
      window.getSelection()?.removeAllRanges();
      e.preventDefault(); // no stray text selection while boxing
      const p = localPoint(root, e);
      marqueeRef.current = { a: p, b: p };
      setMarquee(marqueeRef.current);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    shell.addEventListener('pointerdown', onDown);
    return () => {
      shell.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [tool, textLayerEl, viewport, pageIndex]);

  const neighbours = useMemo(
    () => mine.filter((a) => !isSelected(a._id)).map(bboxOf),
    [mine, selectedIds]
  );

  const chosen = mine.filter((a) => isSelected(a._id));
  const frame = tool === 'select' && chosen.length ? unionBox(chosen.map(bboxOf)) : null;
  const only = chosen.length === 1 ? chosen[0] : null;

  /**
   * Dragging one of several selected annotations moves all of them. Each kind
   * owns its own pointer handling, drawings here and boxes in HtmlAnnotation,
   * so both ask this instead of moving the one thing they were grabbed by.
   * Locked members are left out rather than blocking the drag.
   */
  const movable = chosen.filter((a) => !a.locked);
  const isGroup = movable.length > 1;

  function beginGroup() {
    if (!isGroup) return false;
    groupDrag.current = movable.map((a) => ({ id: a._id, type: a.type, data: { ...a.data } }));
    return true;
  }

  function moveGroup(dx: number, dy: number, noSnap: boolean) {
    const items = groupDrag.current;
    if (!items) return;
    let ax = dx;
    let ay = dy;
    if (!noSnap) {
      // The group snaps as one box. Snapping each member on its own would send
      // them to different guides and pull the selection apart.
      const boxes = items.map((it) =>
        bboxOf({ type: it.type, data: translate(it.type, it.data, dx, dy), style: {} } as any)
      );
      const snap = computeSnap(unionBox(boxes), neighbours, pageSize, SNAP_PX / viewport.scale);
      ax += snap.dx;
      ay += snap.dy;
      setGuides(snap.guides);
    } else {
      setGuides([]);
    }
    for (const it of items) act().update(it.id, translate(it.type, it.data, ax, ay));
  }

  function endGroup() {
    const was = groupDrag.current;
    groupDrag.current = null;
    setGuides([]);
    return !!was;
  }
  // A locked selection shows its frame but offers nothing to grab.
  const anyLocked = chosen.some((a) => a.locked);
  // The frame turns with a single rotated annotation so the two never drift
  // apart. A mixed selection stays upright.
  const frameSpin = only?.data?.rotation || 0;
  const canResize = !anyLocked && chosen.some((a) => RESIZABLE.includes(a.type));

  /**
   * Scales everything selected about the corner opposite the handle, so that
   * corner stays put. Uniform by default; hold shift to stretch one axis
   * independently of the other.
   */
  function startScale(e: React.PointerEvent, corner: Corner) {
    if (!frame) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    const anchor = { x: corner.ax ? frame.x : frame.x + frame.w, y: corner.ay ? frame.y : frame.y + frame.h };
    const grabbed = { x: corner.ax ? frame.x + frame.w : frame.x, y: corner.ay ? frame.y + frame.h : frame.y };
    const span = { x: grabbed.x - anchor.x, y: grabbed.y - anchor.y };
    scaleDrag.current = {
      anchor,
      span,
      // A turned item is stored square and drawn rotated about its middle, so
      // the drag has to be unwound into that square space and the result put
      // back afterwards.
      spin: frameSpin,
      centre: { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 },
      // A text box is a container, so it stretches freely. Drawings and
      // pictures have a shape worth keeping, so they hold their ratio unless
      // shift says otherwise.
      locks: chosen.some((a) => a.type !== 'text'),
      before: chosen.map((a) => ({ id: a._id, type: a.type, data: a.data, style: a.style })),
    };
  }

  function moveScale(e: React.PointerEvent) {
    const d = scaleDrag.current;
    if (!d) return;
    const q = localPoint(shellRef.current!, e);
    // Unwind the pointer into the item's own square space, or the corner you
    // grabbed and the corner the maths thinks you grabbed are different ones.
    const p = rotatePoint(toPdf(viewport, q.x, q.y), d.centre, -d.spin);

    let sx = d.span.x ? (p.x - d.anchor.x) / d.span.x : 1;
    let sy = d.span.y ? (p.y - d.anchor.y) / d.span.y : 1;
    // A picture has a shape worth keeping, so it locks its ratio and shift
    // frees it. Everything else stretches freely and shift locks instead.
    if (d.locks !== e.shiftKey) {
      // Project the pointer onto the frame diagonal so a uniform drag tracks
      // the corner instead of favouring whichever axis moved further.
      const len = d.span.x * d.span.x + d.span.y * d.span.y;
      const s = len ? ((p.x - d.anchor.x) * d.span.x + (p.y - d.anchor.y) * d.span.y) / len : 1;
      sx = sy = s;
    }
    sx = Math.max(0.05, sx);
    sy = Math.max(0.05, sy);
    for (const b of d.before) {
      let next = scaleData(b.type, b.data, d.anchor, sx, sy);
      // A box shrunk below one line of its own text has nothing left to show
      // and becomes impossible to grab again, so it stops there.
      if (b.type === 'text') {
        const minH = (b.style?.fontSize ?? 14) * 1.35;
        next = {
          ...next,
          w: Math.max(MIN_TEXT_W, next.w),
          h: Math.max(minH, next.h),
          y: next.y + next.h - Math.max(minH, next.h),
        };
      }
      // Rotation is drawn about the middle of the box, and scaling moves that
      // middle, so the corner being pulled away from would drift across the
      // page as you resize. Put it back where it was on screen.
      if (d.spin) {
        const mid = { x: next.x + next.w / 2, y: next.y + next.h / 2 };
        const was = rotatePoint(d.anchor, d.centre, d.spin);
        const now = rotatePoint(d.anchor, mid, d.spin);
        next = translate(b.type, next, was.x - now.x, was.y - now.y);
      }
      act().update(b.id, next);
    }
  }

  // An empty box is still worth resizing: you often size it before typing.
  // It is removed when you click away from it without writing anything.
  function endScale() {
    scaleDrag.current = null;
  }

  // Rotation is offered for one box-shaped annotation at a time. Turning a
  // group would have to swing each member around the group's middle, and ink
  // would have to rewrite every stored point, so neither is offered here.
  const spinner =
    !anyLocked && chosen.length === 1 && ROTATABLE.includes(chosen[0].type) ? chosen[0] : null;

  function startSpin(e: React.PointerEvent) {
    if (!spinner || !frame) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const c = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
    const q = localPoint(shellRef.current!, e);
    const p = toPdf(viewport, q.x, q.y);
    spinDrag.current = {
      id: spinner._id,
      data: spinner.data,
      centre: c,
      from: Math.atan2(p.y - c.y, p.x - c.x),
      start: spinner.data.rotation || 0,
    };
  }

  function moveSpin(e: React.PointerEvent) {
    const d = spinDrag.current;
    if (!d) return;
    const q = localPoint(shellRef.current!, e);
    const p = toPdf(viewport, q.x, q.y);
    const now = Math.atan2(p.y - d.centre.y, p.x - d.centre.x);
    let deg = d.start + ((now - d.from) * 180) / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    act().update(d.id, { ...d.data, rotation: Math.round(deg * 10) / 10 });
  }

  function endSpin() {
    spinDrag.current = null;
  }

  return (
    <div ref={shellRef} className="ann-root">
      {/*
        Only drawing tools get a capture surface. Select mode deliberately has
        none: covering the text layer is what made the document's own text
        unselectable, so copy, drag to search and translate extensions all
        stopped working. Marquee selection is driven from the page shell
        instead, in the effect above.

        It comes first so it paints beneath the annotation layers. Put it last
        and it swallows every pointer event, which makes text boxes and images
        undraggable.
      */}
      {drawing && (
        <div
          className="capture"
          onPointerDown={onDrawDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            // highlight works through the text layer, eraser works by hovering
            // the shapes themselves, so both let pointers pass through
            pointerEvents: tool === 'highlight' || tool === 'eraser' ? 'none' : 'auto',
            cursor: tool === 'ink' ? 'crosshair' : 'copy',
          }}
        />
      )}

      {/*
        Every annotation gets its own node in one shared stacking order, so a
        stroke drawn over a picture sits above it. Splitting drawings into one
        SVG and boxes into a separate layer, as this used to, meant a picture
        always covered a drawing no matter which came first.
      */}
      <div className="ann-html">
        {mine.map((a, i) => (
          <div
            key={a._id}
            className="ann-node"
            style={{ zIndex: draggingId === a._id ? 9999 : i }}
          >
            {a.type === 'ink' || a.type === 'highlight' ? (
              <svg className="ann-svg" width={viewport.width} height={viewport.height}>
                {a.type === 'highlight' ? (
                  (() => {
                    const whole = rectToBox(viewport, a.data);
                    // A highlight that ran across several lines paints one box
                    // per line but stays a single annotation, so it selects,
                    // drags, erases and undoes as one thing.
                    const lines: Rect[] = a.data.rects?.length ? a.data.rects : [a.data];
                    return (
                      <g
                        transform={
                          a.data.rotation
                            ? `rotate(${-a.data.rotation} ${whole.left + whole.width / 2} ${whole.top + whole.height / 2})`
                            : undefined
                        }
                        fill={a.style.color}
                        opacity={a.style.opacity ?? 0.35}
                        style={{
                          pointerEvents: inert ? 'none' : 'fill',
                          mixBlendMode: 'multiply',
                          cursor: tool === 'select' ? 'move' : undefined,
                        }}
                        onPointerEnter={(e) => eraseOnHover(e, a)}
                        onPointerDown={(e) => startShapeDrag(e, a)}
                        onContextMenu={(e) => openMenu(e, a._id)}
                        onPointerMove={moveShape}
                        onPointerUp={(e) => endShape(e)}
                        onPointerCancel={() => endShape()}
                      >
                        {lines.map((r, k) => {
                          const b = rectToBox(viewport, r);
                          return (
                            <rect key={k} x={b.left} y={b.top} width={b.width} height={b.height} />
                          );
                        })}
                      </g>
                    );
                  })()
                ) : (
                  <path
                    d={inkPath(a)}
                    fill={a.style.color}
                    // A thin stroke is a very small target. While erasing, a
                    // fat invisible stroke widens the hit area so a swipe near
                    // the line still catches it.
                    stroke={tool === 'eraser' ? 'transparent' : 'none'}
                    strokeWidth={tool === 'eraser' ? 14 : 0}
                    opacity={a.style.opacity}
                    style={{
                      pointerEvents: inert ? 'none' : tool === 'eraser' ? 'all' : 'fill',
                      cursor: tool === 'select' ? 'move' : undefined,
                    }}
                    onPointerEnter={(e) => eraseOnHover(e, a)}
                    onPointerDown={(e) => startShapeDrag(e, a)}
                    onContextMenu={(e) => openMenu(e, a._id)}
                    onPointerMove={moveShape}
                    onPointerUp={(e) => endShape(e)}
                    onPointerCancel={() => endShape()}
                  />
                )}

                {/*
                  Once a drawing is picked, its whole box answers rather than
                  just the mark. Chasing a two point line with the pointer to
                  move it again is needless precision, and the same rule then
                  holds for drawings as for boxes.

                  A locked one keeps the box too. startShapeDrag refuses to move
                  it, but the right click has to land somewhere: without this,
                  unlocking meant hitting a stroke a couple of points wide.
                */}
                {isSelected(a._id) && tool === 'select' && (() => {
                  const g = rectToBox(viewport, bboxOf(a));
                  return (
                    <rect
                      x={g.left}
                      y={g.top}
                      width={g.width}
                      height={g.height}
                      fill="transparent"
                      style={{
                        pointerEvents: 'fill',
                        cursor: a.locked ? 'default' : 'move',
                      }}
                      onPointerDown={(e) => startShapeDrag(e, a)}
                      onContextMenu={(e) => openMenu(e, a._id)}
                      onPointerMove={moveShape}
                      onPointerUp={(e) => endShape(e)}
                      onPointerCancel={() => endShape()}
                    />
                  );
                })()}
              </svg>
            ) : (
              <HtmlAnnotation
                ann={a}
                viewport={viewport}
                pageSize={pageSize}
                neighbours={neighbours}
                inert={inert}
                erasing={tool === 'eraser'}
                selected={isSelected(a._id)}
                editing={editingId === a._id}
                onHit={(e: React.PointerEvent) => hit(e, a)}
                onMenu={(e: React.MouseEvent) => openMenu(e, a._id)}
                group={isGroup && isSelected(a._id)}
                onGroupStart={beginGroup}
                onGroupMove={moveGroup}
                onGroupEnd={endGroup}
                onGuides={setGuides}
                onDragging={(on: boolean) => setDraggingId(on ? a._id : null)}
                onChange={(data: any) => act().update(a._id, data)}
                onMoveToPage={(to: number, data: any) => act().moveToPage(a._id, to, data)}
                onEdit={() => act().setEditing(a._id)}
                onDelete={() => act().remove([a._id])}
                onBlurEmpty={() => removeIfAbandoned(a._id)}
              />
            )}
          </div>
        ))}
      </div>

      <svg className="ann-svg ann-overlay" width={viewport.width} height={viewport.height}>
        {draftInk && (
          <path
            // Simplified exactly as it will be when saved, so releasing the
            // button does not visibly nudge the corners you just drew.
            d={strokeOutline(
              simplify(draftInk, SIMPLIFY_PX * viewport.scale),
              style.width * viewport.scale
            )}
            fill={penColor.current}
            opacity={style.opacity}
          />
        )}

        {draftRect && (
          <rect
            x={Math.min(draftRect.a.x, draftRect.b.x)}
            y={Math.min(draftRect.a.y, draftRect.b.y)}
            width={Math.abs(draftRect.b.x - draftRect.a.x)}
            height={Math.abs(draftRect.b.y - draftRect.a.y)}
            // A text box is an outline while you size it; an area highlight is
            // the wash of colour it is about to become.
            fill={tool === 'text' ? 'none' : penColor.current}
            stroke={tool === 'text' ? penColor.current : 'none'}
            strokeDasharray={tool === 'text' ? '4 3' : undefined}
            opacity={tool === 'text' ? 0.9 : 0.3}
          />
        )}

        {marquee && (
          <rect
            x={Math.min(marquee.a.x, marquee.b.x)}
            y={Math.min(marquee.a.y, marquee.b.y)}
            width={Math.abs(marquee.b.x - marquee.a.x)}
            height={Math.abs(marquee.b.y - marquee.a.y)}
            fill="#38bdf8"
            fillOpacity={0.12}
            stroke="#38bdf8"
            strokeDasharray="4 3"
          />
        )}

        {guides.map((g, i) => {
          const p = g.axis === 'x' ? toView(viewport, g.at, 0) : toView(viewport, 0, g.at);
          return g.axis === 'x' ? (
            <line key={i} x1={p.x} y1={0} x2={p.x} y2={viewport.height}
              stroke="#f472b6" strokeDasharray="3 3" />
          ) : (
            <line key={i} x1={0} y1={p.y} x2={viewport.width} y2={p.y}
              stroke="#f472b6" strokeDasharray="3 3" />
          );
        })}

        {/* Selection chrome is the frame below, one box for the whole
            selection. A dashed outline per annotation on top of it read as two
            competing frames. */}
      </svg>

      {frame && (() => {
        const b = rectToBox(viewport, frame);
        return (
          <div className="ann-frame">
            {/* One box for the whole selection. It turns with the annotation
                it wraps, so frame and content never drift apart. */}
            <div
              className="absolute ann-selbox"
              style={{
                left: b.left - 1,
                top: b.top - 1,
                width: b.width + 2,
                height: b.height + 2,
                transform: frameSpin ? `rotate(${-frameSpin}deg)` : undefined,
                zIndex: 1000,
              }}
              // Handles sit on the corners, which is exactly where a text box
              // starts, so a right click there would otherwise be swallowed by
              // a handle and never reach the annotation's menu.
              onContextMenu={(e) => chosen.length > 0 && openMenu(e, (only ?? chosen[0])._id)}
            >
              {canResize &&
                CORNERS.map((c) => (
                  <div
                    key={c.key}
                    title="Drag to resize. Hold shift to stretch one side."
                    className="absolute ann-handle"
                    style={{
                      left: c.ax ? '100%' : 0,
                      top: c.ay ? 0 : '100%',
                      cursor: c.cursor,
                    }}
                    onPointerDown={(e) => startScale(e, c)}
                    onPointerMove={moveScale}
                    onPointerUp={endScale}
                    onPointerCancel={endScale}
                  />
                ))}

              {spinner && (
                <button
                  title="Drag to rotate. Hold shift for 15 degree steps."
                  className="absolute ann-spin"
                  style={{ left: '50%', top: -28 }}
                  onPointerDown={startSpin}
                  onPointerMove={moveSpin}
                  onPointerUp={endSpin}
                  onPointerCancel={endSpin}
                >
                  <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="currentColor" aria-hidden>
                    <path d="M10 3.6V1.2L6.2 4.3 10 7.4V5.4a4.6 4.6 0 11-4.6 4.6H3.6A6.4 6.4 0 1010 3.6z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {menu && (() => {
        const on = mine.filter((a) => menu.ids.includes(a._id));
        // Locked only when every one of them is, so a mixed selection offers to
        // lock the rest rather than quietly unlocking the locked ones.
        const allLocked = on.length > 0 && on.every((a) => a.locked);
        return (
          <LayerMenu
            at={menu}
            count={menu.ids.length}
            locked={allLocked}
            onPick={(where) => {
              for (const id of menu.ids) act().setLayer(id, where);
              setMenu(null);
            }}
            onLock={() => {
              for (const a of on) if (!!a.locked === allLocked) act().toggleLock(a._id);
              setMenu(null);
            }}
            onDelete={() => {
              act().remove(menu.ids);
              setMenu(null);
            }}
            onClose={() => setMenu(null)}
          />
        );
      })()}

      <input ref={fileRef} type="file" accept="image/*" className="hidden"
        onChange={onImageChosen} />
    </div>
  );
}

const EMPTY: Annotation[] = [];

/**
 * The four corners of a selection. `ax`/`ay` say whether this handle sits at
 * the far side of the frame on that axis, which is what decides the corner it
 * scales away from.
 */
type Corner = { key: string; ax: boolean; ay: boolean; cursor: string };
/** Types whose shape is a box, so turning them is just an angle. */
const ROTATABLE = ['image', 'text', 'highlight'];
/** What the eraser rubs out. Everything else is an object, not a mark. */
const ERASABLE = ['ink', 'highlight'];
/** A note is a fixed-size pin, so it has nothing to resize. */
const RESIZABLE = ['ink', 'highlight', 'image', 'text'];

const CORNERS: Corner[] = [
  { key: 'tl', ax: false, ay: true, cursor: 'nwse-resize' },
  { key: 'tr', ax: true, ay: true, cursor: 'nesw-resize' },
  { key: 'bl', ax: false, ay: false, cursor: 'nesw-resize' },
  { key: 'br', ax: true, ay: false, cursor: 'nwse-resize' },
];

type Where = 'front' | 'forward' | 'backward' | 'back';
const LAYER_ITEMS: [Where, string][] = [
  ['front', 'Bring to front'],
  ['forward', 'Bring forward'],
  ['backward', 'Send backward'],
  ['back', 'Send to back'],
];

/**
 * Layer menu for what is selected, one annotation or several. Closes on the
 * next pointer down anywhere.
 */
function LayerMenu({
  at, count, locked, onPick, onLock, onDelete, onClose,
}: {
  at: { x: number; y: number };
  /** How many annotations it acts on, which is what makes the copy plural. */
  count: number;
  locked: boolean;
  onPick: (w: Where) => void;
  onLock: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // onClose is a fresh closure every render, so keep it in a ref: with it in
  // the dependency list this effect tore itself down and rebuilt on every
  // render, and the deferred listener never got the chance to register.
  const bye = useRef(onClose);
  bye.current = onClose;

  useEffect(() => {
    // Capture phase, because a click landing on an annotation stops the event
    // before it ever reaches the window.
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) bye.current();
    };
    const key = () => bye.current();
    // Deferred, or the pointerup of the right click itself closes it at once.
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', away, true);
      window.addEventListener('keydown', key, true);
      window.addEventListener('wheel', key, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', key, true);
    };
  }, []);

  const many = count > 1;
  const item = 'block w-full text-left px-3 py-1 text-sm hover:bg-neutral-100';
  return (
    <div
      ref={box}
      className="absolute bg-white rounded shadow-lg py-1 text-neutral-800 w-48"
      // Above the selection frame, which sits at 1000 and would otherwise draw
      // its outline and handles across the menu.
      style={{ left: at.x, top: at.y, pointerEvents: 'auto', zIndex: 3000 }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {many && (
        <div className="px-3 pb-1 text-[11px] text-neutral-500">{count} selected</div>
      )}
      {!locked &&
        LAYER_ITEMS.map(([w, label]) => (
          <button key={w} className={item} onClick={() => onPick(w)}>{label}</button>
        ))}
      {!locked && <div className="h-px bg-neutral-200 my-1" />}
      <button className={item} onClick={onLock}>
        {locked ? (many ? `Unlock all ${count}` : 'Unlock')
          : many ? `Lock all ${count} in place` : 'Lock in place'}
      </button>
      {!locked && (
        <button className={`${item} text-rose-600`} onClick={onDelete}>
          {many ? `Delete ${count} items` : 'Delete'}
        </button>
      )}
    </div>
  );
}

/**
 * Floats an annotation's page above its neighbours for the length of a drag,
 * so something dragged past the page edge is not covered by the next page.
 * The annotation's own stacking is handled by React through `z`.
 */
function liftPage(el: HTMLElement | null | undefined, on: boolean) {
  el?.closest('[data-page]')?.classList.toggle('drag-layer', on);
}

function HtmlAnnotation({
  ann, viewport, pageSize, neighbours, selected, editing, inert, group,
  onGroupStart, onGroupMove, onGroupEnd,
  onHit, onChange, onDelete, onGuides, onMoveToPage, onEdit, onMenu, onDragging, erasing,
  onBlurEmpty,
}: any) {
  const drag = useRef<any>(null);
  const popDrag = useRef<any>(null);
  const [dragging, setDragging] = useState(false);
  const scale = viewport.scale;

  // autoFocus only fires on mount, and the optimistic add puts the annotation
  // on screen a tick before setEditing runs, so the box would mount unfocused
  // and every keystroke would go to the shortcut handler instead.
  // A box left with nothing in it goes as soon as it stops being the thing
  // you are working on. Blur alone is not enough: after resizing, focus has
  // already left the textarea, so nothing would fire when you finally click
  // away. Losing the selection is the moment that always happens.
  const wasSelected = useRef(false);
  useEffect(() => {
    if (selected || editing) {
      wasSelected.current = true;
      return;
    }
    if (!wasSelected.current) return;
    wasSelected.current = false;
    if (ann.type === 'text' && !String(ann.data?.text || '').trim()) onDelete();
  }, [selected, editing]);

  /**
   * Changing the font size of a box already on the page has to take the box with
   * it, or bigger text spills out the bottom. Measured rather than scaled by the
   * ratio: a larger size wraps into more lines, so the height it needs grows by
   * more than the size did. Only ever grows, so a size someone set by dragging
   * the corner is never taken away from them.
   */
  const blockRef = useRef<HTMLDivElement>(null);
  const shownAt = useRef(ann.style?.fontSize);
  useEffect(() => {
    const size = ann.style?.fontSize;
    if (ann.type !== 'text' || editing || size === shownAt.current) return;
    shownAt.current = size;
    const el = blockRef.current;
    if (!el) return;
    const need = (el.scrollHeight + 2) / scale;
    if (need > ann.data.h) onChange({ ...ann.data, h: need, y: ann.data.y + ann.data.h - need });
  }, [ann.style?.fontSize, editing]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
    // Clearing `editing` is not enough on its own: the textarea keeps DOM
    // focus, so the caret stays visible and blur, which is what removes an
    // empty box, never fires.
    else if (document.activeElement === inputRef.current) inputRef.current?.blur();
  }, [editing]);

  function start(e: React.PointerEvent, mode: 'move') {
    e.stopPropagation();
    onHit(e);
    // The eraser does not move things. Without this a swipe across a text box
    // drags it instead of passing over it. A locked annotation never moves, and
    // only the primary button drags at all.
    if (e.button !== 0 || erasing || ann.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // The grab offset is what makes a cross-page drop land under the cursor
    // rather than snapping its corner there.
    // The annotation's own root, which is a child of its `.ann-node` wrapper.
    // Matching `.ann-html > *` instead picks up the wrapper, and that is
    // `inset: 0` on the page, so a cross-page drop resized the annotation to
    // the whole page.
    const self = (e.currentTarget as HTMLElement).closest('.ann-node > *') as HTMLElement;
    const box = self.getBoundingClientRect();
    if (mode === 'move') {
      liftPage(self, true);
      setDragging(true);
      onDragging?.(true);
    }
    drag.current = {
      self,
      mode,
      sx: e.clientX,
      sy: e.clientY,
      data: { ...ann.data },
      grabX: e.clientX - box.left,
      grabY: e.clientY - box.top,
      boxW: box.width,
      boxH: box.height,
    };
    // Grabbing one of several selected annotations moves the whole selection.
    if (group) onGroupStart();
  }

  function move(e: React.PointerEvent) {
    if (!drag.current) return;
    const dx = (e.clientX - drag.current.sx) / scale;
    const dy = (e.clientY - drag.current.sy) / scale;
    if (group) return onGroupMove(dx, -dy, e.altKey);

    let next = translate(ann.type, drag.current.data, dx, -dy);
    if (!e.altKey) {
      const rect: Rect =
        ann.type === 'note'
          ? { x: next.x, y: next.y, w: NOTE_SIZE, h: NOTE_SIZE }
          : { x: next.x, y: next.y, w: next.w, h: next.h };
      const snap = computeSnap(rect, neighbours, pageSize, SNAP_PX / scale);
      if (snap.dx || snap.dy) next = translate(ann.type, next, snap.dx, snap.dy);
      onGuides(snap.guides);
    } else {
      onGuides([]);
    }
    onChange(next);
  }

  /**
   * Grows a text box downwards to fit what is in it. Width is left alone: text
   * wraps at whatever width you set, and only the height follows the content,
   * so a long line never pushes the box off the page. Dragging the corner
   * still sets both by hand, and this only ever grows, so that size sticks.
   */
  function grown(el: HTMLTextAreaElement, data: any) {
    const h = el.style.height;
    el.style.height = '0px';
    const needH = el.scrollHeight + 2;
    el.style.height = h;

    const nh = Math.max(data.h, needH / scale);
    if (nh <= data.h) return data;
    // y is the bottom edge, so growing downward keeps the top where it is.
    return { ...data, h: nh, y: data.y + data.h - nh };
  }

  /**
   * A move that finished over a different page re-homes the annotation. The
   * drop point is converted through the target page's own viewport, so a page
   * of another size or rotation still receives it in the right place.
   */
  function end(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    onGuides([]);
    if (!d) return;
    liftPage(d.self, false);
    setDragging(false);
    onDragging?.(false);
    // A group keeps its page: re-homing is one annotation at a time, and half a
    // selection landing on the next page is worse than none of it.
    if (group) {
      onGroupEnd();
      return;
    }
    if (d.mode !== 'move') return;

    const shell = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((el) => (el as HTMLElement).dataset?.page !== undefined) as HTMLElement | undefined;
    if (!shell) return;

    const to = Number(shell.dataset.page);
    if (!Number.isFinite(to) || to === ann.pageIndex) return;
    const tvp = pageViewports.get(to);
    if (!tvp) return;

    const r = shell.getBoundingClientRect();
    const lx = e.clientX - d.grabX - r.left;
    const ly = e.clientY - d.grabY - r.top;

    onMoveToPage(
      to,
      ann.type === 'note'
        ? { ...ann.data, ...toPdf(tvp, lx, ly + NOTE_SIZE) }
        : { ...ann.data, ...rectToPdf(tvp, { x: lx, y: ly }, { x: lx + d.boxW, y: ly + d.boxH }) }
    );
  }

  if (ann.type === 'note') {
    // The dot has to match its stored box exactly or the selection frame sits
    // off centre. NOTE_SIZE is in PDF points, so the drawn size has to scale
    // with the zoom rather than stay a fixed pixel width.
    const p = toView(viewport, ann.data.x, ann.data.y + NOTE_SIZE);
    const dot = NOTE_SIZE * scale;
    // The popover keeps its own size once you have set one, in screen pixels:
    // it is a panel you read, not part of the page, so it should not shrink as
    // you zoom out.
    const popW = ann.data.popW || POPOVER_W;
    const popH = ann.data.popH || POPOVER_H;
    // A note near an edge opens its popover back towards the page, otherwise
    // the text runs off and is unreachable.
    const openLeft = p.x + NOTE_GAP + popW > viewport.width;
    const openUp = p.y + popH > viewport.height;
    return (
      <div
        style={{
          position: 'absolute',
          left: p.x,
          top: p.y,
          width: dot,
          height: dot,
          pointerEvents: inert ? 'none' : 'auto',
        }}
        onPointerDown={(e) => start(e, 'move')}
        onPointerMove={move}
        onPointerUp={end}
        onContextMenu={onMenu}
      >
        <div
          className="w-full h-full rounded-full shadow cursor-move"
          style={{ background: ann.style.color, boxShadow: '0 0 0 1.5px #fff' }}
        />
        {selected && (
          <div
            className="absolute bg-white rounded shadow-lg p-2 z-20 flex flex-col"
            style={{
              width: popW,
              height: popH,
              // Anchored to the far side of the dot so it never sits on top
              // of it, and flipped back towards the page near an edge.
              ...(openLeft
                ? { right: '100%', marginRight: 8 }
                : { left: '100%', marginLeft: 8 }),
              ...(openUp ? { bottom: 0 } : { top: 0 }),
            }}
          >
            <textarea
              ref={inputRef}
              defaultValue={ann.data.text}
              className="flex-1 w-full text-sm outline-none resize-none text-neutral-900"
              placeholder="Write a note"
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => onChange({ ...ann.data, text: e.target.value })}
            />
            <div className="flex items-center justify-between shrink-0">
              <button className="text-xs text-rose-600" onClick={onDelete}>Delete</button>
            </div>

            {/*
              Drag to resize the panel. Stored in screen pixels rather than page
              points, because this is a piece of the interface rather than
              something printed on the paper.
            */}
            <div
              title="Drag to resize this note"
              className="absolute right-0 bottom-0 w-3.5 h-3.5 cursor-se-resize"
              style={{
                background:
                  'linear-gradient(135deg, transparent 45%, #cbd5e1 45%, #cbd5e1 58%, transparent 58%, transparent 70%, #cbd5e1 70%, #cbd5e1 83%, transparent 83%)',
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
                popDrag.current = { sx: e.clientX, sy: e.clientY, w: popW, h: popH };
              }}
              onPointerMove={(e) => {
                const d = popDrag.current;
                if (!d) return;
                const dir = openLeft ? -1 : 1;
                const up = openUp ? -1 : 1;
                onChange({
                  ...ann.data,
                  popW: Math.max(POPOVER_MIN_W, Math.round(d.w + (e.clientX - d.sx) * dir)),
                  popH: Math.max(POPOVER_MIN_H, Math.round(d.h + (e.clientY - d.sy) * up)),
                });
              }}
              onPointerUp={() => { popDrag.current = null; }}
              onPointerCancel={() => { popDrag.current = null; }}
            />
          </div>
        )}
      </div>
    );
  }

  const box = rectToBox(viewport, ann.data);
  return (
    <div
      style={{
        position: 'absolute',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        opacity: ann.style.opacity,
        // A picture fills its box, so the box is always the thing. A text box
        // mostly is not full: until it is picked, only the words themselves
        // answer, so blank space around one word cannot move it by accident.
        // Once picked the whole box answers, because by then you have said
        // which thing you mean and aiming at the letters is just fiddly.
        pointerEvents:
          inert ? 'none' : ann.type === 'image' || selected ? 'auto' : 'none',
        // Paint order, except while dragging, when it rides above everything.
        zIndex: dragging ? 999 : (ann.z ?? 0),
        // Stored counter-clockwise like the PDF; CSS turns the other way.
        transform: ann.data.rotation ? `rotate(${-ann.data.rotation}deg)` : undefined,
      }}
      onPointerDown={(e) => start(e, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      onContextMenu={onMenu}
      onDoubleClick={() => ann.type === 'text' && onEdit()}
    >
      {ann.type === 'image' ? (
        <img src={api.assetUrl(ann.data.assetId)} draggable={false} alt=""
          className="w-full h-full object-fill select-none" />
      ) : !editing ? (
        // Shown rather than edited: a block that hugs its own text, so only
        // the words are clickable. The padding gives a few pixels of slack so
        // you do not have to land exactly on a glyph.
        <div
          ref={blockRef}
          className="max-w-full whitespace-pre-wrap break-words select-none"
          style={{
            width: 'fit-content',
            color: ann.style.color,
            fontSize: ann.style.fontSize * scale,
            fontFamily: TEXT_FONT,
            lineHeight: TEXT_LEADING,
            padding: HIT_SLACK,
            margin: -HIT_SLACK,
            pointerEvents: 'auto',
            cursor: ann.locked ? 'default' : 'move',
          }}
        >
          {ann.data.text || ''}
        </div>
      ) : (
        <textarea
          ref={inputRef}
          defaultValue={ann.data.text}
          className="w-full h-full bg-transparent outline-none resize-none overflow-hidden"
          style={{
            color: ann.style.color,
            fontSize: ann.style.fontSize * scale,
            fontFamily: TEXT_FONT,
            lineHeight: TEXT_LEADING,
            pointerEvents: 'auto',
          }}
          placeholder="Type here"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => onChange(grown(e.target, { ...ann.data, text: e.target.value }))}
          // An empty box has nothing to show and nothing to click, so it goes
          // once you leave it alone. Deleting on change would remove it the
          // moment you cleared it to retype, and deleting on blur alone would
          // remove it the moment you reached for a resize handle, since that
          // takes focus too. So the check waits until it is deselected.
          onBlur={onBlurEmpty}
        />
      )}
      {/* No chrome of its own. The selection frame handles resizing and
          rotating, and Delete lives on the right click menu and the Del key,
          so a floating button here only collided with the rotate handle. */}
    </div>
  );
}
