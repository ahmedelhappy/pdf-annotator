# CLAUDE.md

Local-first PDF annotator. React + Vite + TS client (port 5173), Express +
Mongoose server (port 5174, loopback only), pdf.js renders, pdf-lib writes.
Two npm workspaces driven from the root: `client/` and `server/`.

## Commands

```powershell
npm run setup                    # install root + server + client
npm run dev                      # concurrently: server on 5174, client on 5173
npm run sample                   # writes sample.pdf at repo root, 6 pages
npm test                         # 44 server tests + 92 client tests
npm --prefix client run typecheck   # tsc --noEmit, must be clean
```

MongoDB must be running (`Get-Service MongoDB` / `Start-Service MongoDB`).
Config is `server/.env`: PORT, MONGO_URI, STORAGE_DIR.

`server/nodemon.json` ignores `storage/`. Page-op snapshots write `.json`
sidecars there, and nodemon watches `.json`: without the ignore every page op
restarted the API server in the middle of its own request, which looks like a
blank viewer and an empty response body.

## Invariants. Breaking one is a regression, not a refactor.

**1. Coordinates.** Annotations are stored in PDF user space only: points,
origin bottom-left, unrotated. Screen pixels never reach the store, the API, or
Mongo. The only conversion is at the boundary, through `toPdf`, `toView`,
`rectToPdf`, `rectToBox` in [geometry.ts](client/src/lib/geometry.ts), all of
which take the pdf.js viewport. Page rotation lives inside the PDF and pdf.js
folds it into that viewport, so annotations rotate with their page for free.
Hand-written rotation math means the bug is somewhere else.

**2. Non-destructive.** Annotations are JSON in Mongo; the PDF on disk is never
modified. Export builds a new file per request. The one exception is page
operations, which rewrite the file and must renumber every annotation. That
renumbering is pure and tested in [remap.js](server/src/lib/remap.js) — add a
new page op there with a test *before* touching any UI.

Deleting a document sets `deletedAt` and nothing else; the file and its
annotations stay put. Only `DELETE ?purge=1`, reachable solely from the trash,
unlinks anything. Do not add a code path that destroys a document without going
through the trash.

A page op is undoable because the server keeps the old file. `snapshot` in
[pdfOps.js](server/src/lib/pdfOps.js) copies the PDF and every annotation
before each op, `UNDO_DEPTH` of them; `POST /:id/pages/undo` puts both back.
Deleted page *content* only exists in that snapshot, so a page op that skips
`snapshot` is not undoable at all.

**3. Flush before page ops.** `runPageOp` in
[Viewer.tsx:87](client/src/components/Viewer.tsx#L87) calls `store.flushPending()`
before hitting the server so no debounced write is in flight during a renumber.
Any new path that reorganizes pages must do the same.

**4. Ink parity.** `strokeOutline` is duplicated in
[client/src/lib/ink.ts](client/src/lib/ink.ts) and
[server/src/lib/ink.js](server/src/lib/ink.js), so neither package needs a build
step. [ink.test.ts](client/src/test/ink.test.ts) imports both copies and asserts
identical output. Change one, change both.

**5. Search haystack.** [search.ts](client/src/lib/search.ts) stitches page text
twice: `SearchIndex.pageText` joins `getTextContent` items, `hitsInTextLayer`
joins text-layer leaf spans. Both use the same `JOINER`. If they diverge, the
Nth match and the Nth highlight stop being the same thing.

**6. Loopback only.** The server binds 127.0.0.1 deliberately. Do not change it
to 0.0.0.0 and do not add a host flag.

## Intended behavior. Do not "fix" these.

- Distant pages release their canvas and flash white on the way back. Memory.
- A snap guide shows even at zero offset. Confirming alignment is the point.
- Undo history clears on refresh. In-memory by design.
- devicePixelRatio capped at 2.
- Ctrl+1..Ctrl+8 do nothing; the browser owns them.
- `store.add` renders under a `tmp_` id, then swaps the real id in everywhere
  including both undo stacks (`swapId` / `fixStacks`). Deliberate, not
  overcomplicated.

## Working rules

- `npm test` before and after every change; the count must not go down.
- Typecheck before declaring anything done.
- Any fix in remap, geometry, ink, search, or shortcut parsing ships with a
  regression test in the same commit. Those five are the tested core.
- UI and interaction code has no test harness and none should be built right
  now. Verify by hand against [TESTING.md](TESTING.md), which is ordered so the
  first failure points at one subsystem.
- Small commits, one concern, imperative subject lines.
- Prefer editing an existing file over adding one.
- Style: no em dashes in comments or UI copy. UI strings are sentence case,
  active voice, and name what happens rather than how it is built.

## Accepted limitations. Do not attempt without being asked.

- `bulkWrite` in the page-op renumber is not atomic on standalone MongoDB. The
  file is backed up and rolled back on failure. A real fix needs Mongo as a
  single-node replica set.
- Non-Latin text is skipped at export unless a `.ttf`/`.otf` sits in
  `server/fonts/`. The server logs a warning. Documented, not a bug.

## Git

The repository starts at one commit holding the project as it already was: that
work predates the repo and cannot be split back into the history it was built
in. Everything after is one commit per change.

## Orientation

- [store.ts](client/src/store.ts): undo/redo, optimistic writes, debounced
  persistence (`update` 700ms, `updateStyle` 300ms).
- [AnnotationLayer.tsx](client/src/components/AnnotationLayer.tsx): all pointer
  interaction. Viewer owns scale, current page, page ops, shortcut context.
- `comboOf` falls back to `e.code` whenever `e.key` is not plain ASCII, so
  shortcuts survive an Arabic or Cyrillic keyboard. Punctuation codes carry
  their US shifted twin, because the bindings are written that way (`{`, not
  `shift+[`).
- A re-render leaves the bitmap on screen alone and paints the new one over it
  when it is complete, so zooming never flashes white. A page scrolled far away
  drops it, because coming back blank is the point of releasing it.
- The ink preview is simplified with the same tolerance as the saved stroke, or
  releasing the button visibly nudges the corners you just drew.
- `strokeOutline` runs a quadratic through the midpoints between points rather
  than joining them straight, which is what makes a stroke read as one line
  instead of a chain of segments. Mirrored on the server, parity test covers it.
- An automatic colour is settled at pointer **down** and held in `penColor` for
  the whole stroke. Deciding on release meant drawing in one colour and watching
  it change to another as you let go.
- Text boxes are drawn in Helvetica at 1.35 leading, matching what the export
  uses, so a line that wraps on screen wraps in the same place on paper.
- The canvas takes its CSS size from the page shell, in the same commit as a
  zoom. Leaving it to the async render left the old canvas inside a resized
  shell, which is a white band around the page.
- Shift while drawing keeps only the first point and the current one, so the
  stroke is a ruled line.
- `AUTO_COLOR` is a sentinel, never stored. It is resolved once per annotation
  from the luminance of the page canvas underneath, so exports and everything
  downstream only ever see a real colour. Highlighters get a wash rather than
  near-black ink.
- Cross-page drags measure `.ann-node > *`, the annotation itself. Matching
  `.ann-html > *` picks up the wrapper, which is `inset: 0`, and the annotation
  arrives on the new page resized to the whole page.
- The sidebar width lives in the store and localStorage; dragged under
  `SIDEBAR_MIN` it closes rather than leaving a sliver. Its grip uses window
  listeners, not pointer capture: the grip is pinned to the edge it is moving,
  so it slides out from under the pointer and capture stalls after one step.
- Page sizes are measured **once** per document into `pageSizes` in Viewer, and
  PdfPage derives its shell from `natural * scale` synchronously. Asking pdf.js
  per zoom step meant each page resized on its own promise, so the document went
  on relaying out for several frames after a zoom and the reader slid onto
  another page. Do not reintroduce a per-scale `getViewport` for layout.
- `zoomAround` records the cursor as a *fraction of the page under it*, then a
  `useLayoutEffect` on `scale` restores it before paint, when every shell
  already has its new size. Scaling the old scroll offset by the zoom ratio is
  wrong: margins are fixed and a page narrower than the viewport stays centred,
  so neither axis grows by the ratio. Holding a point near a centred page's left
  edge needs a negative scroll offset, so the browser clamps it; Chrome's viewer
  does the same. Wheel deltas are gathered per frame and applied multiplicatively.
- A pinch magnifies rather than reloads. Two things make that so, and both were
  bugs first:
  - The zoom follows the **size** of the delta, `exp(-delta * ZOOM_RATE)` with
    the delta clamped to 60, not the count of events. A mouse notch arrives as
    100 or 120 and lands near a tenth, matching the buttons; a trackpad's few
    pixels per event read as continuous. Counting events took a gentle pinch
    from 100 to 600 percent in one gesture.
  - `zooming` holds every page's redraw until `ZOOM_SETTLE` after the last
    event, and PdfPage takes it as `defer`. The shells resize immediately, so
    the bitmap already on screen stretches to fill them and the page simply
    grows, like an image. Redrawing per step had pdf.js rendering the whole
    document seventeen times in one pinch.
  - While deferring, the **viewport still follows the scale**, synchronously,
    off the page object already in hand. Annotations are placed through it, so
    without that they kept the size they were last drawn at and slid off the
    page as it grew under them.
- A page is drawn into a scratch canvas and put on screen in one step, never
  drawn into the canvas being looked at. Resizing a canvas wipes it and the
  render that follows is asynchronous, so there was a frame with the canvas
  sized but empty. Holding the old bitmap and stretching it covered most of
  that but not that frame.
- Only the bindings named in `DEFAULT_ON` start switched on; the rest are in the
  table and listed in the shortcut sheet, waiting to be turned on. What the user
  rebinds or disables lives in `store.shortcuts` and localStorage, and
  `buildBindingMap` resolves the two. `BINDING_MAP` is only the defaults.
- A gap between every pair of pages holds the "+ Add page" strip, and it owns
  the vertical spacing rather than reaching into the page margins. Overlaying
  the margin put the strip on top of the page below, where the text layer ate
  every pointer. The gaps are rendered as siblings, not wrappers: a page shell
  has to stay a direct child of the scroller, since that is what everything
  measuring the document reaches for.
- Ctrl+V has one decision point, the window `paste` handler. The shortcut only
  asks, through `pasteRequested`, and a timer falls back to the in-app copy if
  no paste event turns up, which is how the command palette gets here. Both
  paths firing is what pasted an annotation and a screenshot together.
  `copySelected` writes `CLIP_MARKER` to the system clipboard so the newest
  copy always wins, whichever order the two happened in.
- Picking a colour switches to the pen through `store.pickColor`, but only from
  a tool that puts no colour on the page. Changing the shade of a highlighter
  has to leave you highlighting. Clicking the swatch already in use opens its
  shade picker, and anything pressed outside closes it, on a capture-phase
  window listener: the page swallows a pointerdown before it would ever bubble
  to the window.
- Ctrl+Alt+N and Ctrl+Alt+P walk the annotations across the whole document, not
  the pages: `stepAnnotation` sorts by page then `z` and `revealAnn` waits for
  the page to render before converting through its viewport. `alt+arrowup` and
  `alt+arrowdown` already move a page, and arrow keys normalise to `arrowup`,
  so `alt+up` would never have fired.
- A text box holds plain text. Markdown was tried and taken out again: the live
  editor it needed was a `contenteditable`, and rebuilding its nodes under the
  caret cost a run of bugs, the last of which was Enter opening two lines at a
  time on an empty line and the box running away down the page. What was there
  is in the history at `c5650be` and `97e26fe` if it is ever wanted again.
- A text box's height is its words'. There is no vertical resize: the side
  handles set the width, the corner handles scale the type, and the height
  follows the text. Dragging a height by hand left text either hanging out of
  the bottom or floating in empty space. A corner scales by the drag itself and
  keeps the font to a tenth of a point, since whole points are too coarse to
  hold the box's shape at small sizes.
- That height is measured through `textHeight`, never off whatever is on screen,
  and the same way whether the box is being typed in or not:
  - A textarea fills its box, so asking it how tall its content is hands the
    box's own height straight back. Every keystroke measured the box, added
    slack and grew it again, two points at a time, for ever.
  - The drawn block and the editor disagree about the empty line a trailing
    newline opens: a block drops it, a textarea keeps it, because the caret can
    sit there. So the ruler measures a zero-width `TAIL` after the text and
    counts that line. Without it the frame stayed one line behind the caret on
    every Enter, and the box lost a line on the way out.
  - The block's `max-width` is `100% + 2 * HIT_SLACK`, so its padding is slack
    rather than text and the words wrap where the textarea wraps them. At a
    plain `100%` a box that fitted while you were typing gained a line the
    moment you left it.
  The editor sets `outline: 'none'` itself. Tailwind's `outline-none` only makes
  the outline transparent, so the global `:focus-visible` rule painted one over
  it and the box wore two frames at once.
- Anything that must sit above the page uses z-index 4000. The selection frame
  is 1000 and its menu 3000, so Tailwind's `z-50` was not enough and a selection
  drew across the shortcut sheet.
- `TEXT_FONT` and `TEXT_LEADING` live in [text.ts](client/src/lib/text.ts) with
  `textHeight`, which measures wrapped height through one reused offscreen
  element. A pasted paragraph is one long line that wraps into many, so counting
  newlines gave a box one line tall with the text hanging out of it.
- Ctrl+V with the caret in a text box stands aside and lets the browser drop the
  text in at the caret. It used to open a second box beside the one you were in.
- Dragging one of several selected annotations moves all of them.
  `beginGroup`/`moveGroup`/`endGroup` in AnnotationLayer own that, and both
  pointer paths ask them. The group snaps as one box, or each member chases a
  different guide and the selection comes apart. A group keeps its page:
  `moveToPage` is one annotation at a time.
- `hit` does not narrow a multiple selection when you press a member of it; that
  press is how a group drag starts. A window `pointerup` narrows to the one
  thing only if the press never became a drag. Only button 0 changes a
  selection, or a right press collapsed the group before its menu opened.
- A locked annotation keeps its transparent hit box. Suppressing it left the
  right click, and so unlocking, needing a hit on a stroke two points wide.
  `store.nudge` filters locked ids the way `store.remove` does.
- The toolbar's font size box reads the *selected annotation's* size, not the
  pen's, or dragging a corner scaled the text on the page while the number sat
  unchanged at whatever the pen happened to be.
- `store.style` is persisted to localStorage and validated on the way back in.
  `lastPage` on the document row follows the reader on a debounce and is
  remapped by `applyRemap` and carried in the page-op snapshot, so undo puts the
  reader back too. Restoring happens in a layout effect against `pageSizes`,
  which gives every shell its height before anything renders, and only on a real
  open: a page-op reload is not an opening.
- Every keybinding is one table in [shortcuts.ts](client/src/lib/shortcuts.ts).
  Whole API surface is [api.ts](client/src/api.ts). A binding with `standDown`
  hands the key back to the browser: Ctrl+C does that whenever page text is
  selected, or copying selected text would silently copy annotations instead.
- `onTextSelectionEnd` grabs its rects and drops the selection *before* any
  await. StrictMode fires it twice, and an async gap let both runs highlight
  the same words twice.
- Page ops: `POST /api/documents/:id/pages` with `{ op, ... }` where op is
  insert, delete, duplicate, reorder, rotate, or import. Delete, rotate and
  duplicate also take `indices` for several pages at once: one file rewrite and
  one remap, not a loop of them. `afterDeleteMany` and `afterDuplicateMany`
  are the pure functions behind those.
- `hiddenPages` on a document is skipped in the viewer and left out of the
  export, but stays in the file and in the sidebar, so it is never destructive.
  It is a list of page numbers, so `applyRemap` renumbers it alongside the
  annotations. `PATCH /:id/hidden` is the only writer.
- `store.load` keeps `pageop` undo entries when it reloads the *same* document
  and drops everything else. A page op reloads the document, so clearing the
  whole stack there threw away the entry the op had just pushed and Ctrl+Z did
  nothing. There is no redo for a page op: restoring the old file discards the
  newer one.
- `store.select` clears `selectedPages`. Reaching into the document lets go of
  the sidebar's selection, so Delete never has to guess which one you meant.
- The sidebar says two things at once: a blue fill is what you have selected,
  an amber ring round the page image is where you are reading. One colour for
  both left you unable to tell them apart. It also follows the reader, with
  `scrollIntoView({ block: 'nearest' })` so a card already in view never moves.
  That scroll is **instant**, not smooth: the document scroll is already the
  animation, and a tween that restarts on every page turn never catches up.
- Each sidebar card reserves its page's shape through `aspectRatio` from
  `pageSizes`. A thumbnail only renders once it scrolls into the sidebar, so
  without this the cards below sit at the wrong height, the list grows
  underneath itself as they draw, and following the reader lands short by
  however much everything above has since expanded. `Thumb` is `memo`d, or
  every page turn reconciles hundreds of canvases.
- `current` is measured in `readCurrent` from where the page shells actually
  sit, on a scroll listener coalesced to one reading per frame. It used to come
  from each page's IntersectionObserver, but that carries a 700px `rootMargin`
  for canvas retention, so pages well off screen reported as visible; and a
  fast scroll delivers its entries in one batch in no particular order, so
  whichever fired last won and nothing fired again once you stopped. The
  sidebar could sit five or ten pages from the screen indefinitely. The
  observer in PdfPage now only decides whether to keep a canvas.
- `page-arrive` and `page-leave` in [index.css](client/src/index.css) point out
  which card a page op happened to. The leaving one has to play *before* the
  request goes, since afterwards the card is gone; the arriving one is held in
  `flashOnReload` until the rewritten file is on screen, or it plays on the
  cards that are about to be replaced.
- Right clicking a thumbnail opens the same actions the card's icons offer.
  Right clicking inside a multiple selection acts on all of it and says so;
  right clicking outside narrows the selection to that page first, so the menu
  never claims more than it will do.
- `pageViewports` in [pdf.ts](client/src/pdf.ts) holds the live viewport of
  every rendered page. Dropping an annotation on another page converts through
  the target's viewport, never by hand. `store.moveToPage` writes straight
  through instead of debouncing, so a stale write cannot land it on the old page.
- The palette is store state persisted to localStorage. Right click a swatch to
  redefine it. `PALETTE` is only the shipped default.
- A highlight dragged across several lines is **one** annotation: `x/y/w/h` is
  the bounding box and `data.rects` holds a box per line. One per line meant
  undo peeled it off a line at a time and the eraser only caught one line.
  `translate` and `scaleData` carry `rects` along; export and the sidebar
  thumbnails both paint every box.
- An empty text box is removed when it is **deselected**, not on blur. Blur
  alone fires when you reach for a resize handle, which deleted it mid-resize.
- A text box renders a `<textarea>` only while editing; otherwise it is a block
  that hugs its own words. Anything looking for one has to allow for both.
- Picking something up needs the content; once picked, its whole box answers.
  Unselected, a text box passes pointers through and only the words respond, so
  blank space around one word cannot move it by accident. Selected, the wrapper
  goes `auto` and drawings gain a transparent hit rect over their bounds, so
  dragging and right clicking work anywhere inside the frame.
- Scaling a rotated item unwinds the pointer into the item's square space with
  `rotatePoint`, then puts the anchor corner back where it was on screen.
  Rotation is drawn about the box middle and scaling moves that middle, so
  without both halves the item swings away as you resize it.
- `locked` on an annotation blocks moving, resizing, rotating, erasing and
  deleting. `store.remove` filters locked ids itself, so the guarantee holds
  whichever path asks. Toggle it from the right click menu.
- The selection frame handles right click itself: its corner handles sit over
  the top-left of the content, so they would otherwise swallow it.
- A flag marks a hard part of a page. It is a point with a fixed `FLAG_SIZE`,
  like a note, so `scaleData` only moves it and `bboxOf` gives it its own square.
  It is a real annotation, not a page property, so page ops renumber it for
  free and the export draws it. The marks panel groups by the pages carrying
  one, which is what the "Difficult" filter is.
- The marks panel has two filters, both off by default so it opens as the plain
  list it has always been. "By page" gives one row per page rather than one per
  mark; "Difficult" narrows to pages carrying a flag. `stepAnnotation` reads
  both, or the arrows would disagree with the list they sit above:
  `marksHardOnly` narrows what they walk, and under `marksByPage` they walk
  **pages** rather than the marks on them, dropping the selection as they go.
  Stepping through every mark while the list showed one row per page took
  several presses to leave a busy page and never moved the highlighted row.
  The panel follows the reader and the selection through one effect keyed on
  both, scrolling `nearest` and instantly, for the reason the page sidebar does.
  By page it follows the page only: there are no mark rows to aim at, and
  looking for the selected one found nothing and simply stopped keeping up.
- A document can be renamed from its card in the library or from the name at
  the top left of the toolbar. Only `originalName` changes; the file on disk
  keeps its stored `filename`, which is a UUID and never meant anything.
- `POST /api/documents/blank` writes a one page A4 PDF and a row to go with it.
  This is a whiteboard as much as a reader, and there was no way in without a
  PDF to open first. The page size matches what the "+ Add page" strip inserts.
- `fileRev` on a document counts rewrites of the file, which is what a page op
  and a page undo both do. `thumbnailRev` records which revision the library
  card's picture was drawn from. Without them a reorganized document went on
  showing the page it was added with.
  - `thumbnailRev` defaults to **-1**, not 0. Every document that predates the
    counters reads as -1 and so is stale by definition, which is right: nothing
    was tracking their rewrites. A default of 0 made them indistinguishable
    from a card drawn a moment ago, and a page deleted before any of this
    existed stayed on its card for ever.
  - `drawThumbnail` in [pdf.ts](client/src/pdf.ts) does the drawing, and the
    Viewer calls it whenever it loads the file, which is exactly when a rewrite
    has happened and the file is already open. The library only catches up
    documents that are behind for some other reason.
  - Its record of what has been drawn is a module-level `Set`, not a ref, and
    the write is never abandoned on unmount. React mounts an effect twice in
    development and throws the first run away: with the guard in a ref, the
    second run skipped work the first had claimed and then discarded, and the
    card kept its old picture.
  - Drawn on the client at all because running pdf.js in Node needs the native
    canvas package, which is a rough install on Windows.
- Annotation types: ink, highlight, text, note, image, flag. Ink stores `points`
  (optional pressure `p`), note stores `x, y` plus a fixed `NOTE_SIZE`, the
  rest store `x, y, w, h`. Box types may also carry `rotation`, in degrees
  counter-clockwise like the PDF; CSS turns the other way, so screen
  transforms negate it.
- `z` on an annotation is paint order within its page, higher on top. Ties keep
  insertion order. Export sorts by `z` first, then by the old per-type order.
- Selection frame in AnnotationLayer is the *only* selection chrome, and owns
  resizing for everything. Uniform by default, shift stretches one axis. It
  turns with a single rotated annotation so the two never drift apart. Rotation
  is offered for a single box type only: a group would have to swing each
  member about the group centre, and ink would have to rewrite every point.
  Text boxes stretch freely; drawings and pictures hold their ratio unless
  shift is held.
- A note's dot is drawn at `NOTE_SIZE * scale`, not a fixed pixel size, or its
  selection frame sits off centre at any zoom but 100%.
- The eraser rubs out ink and highlights only. Text, notes and images are
  objects, removed through select and Delete, so a stray swipe cannot wipe out
  a note. Ink gets a fat transparent stroke while erasing to widen the target.
- Sidebar thumbnails render the page once into an offscreen canvas, then
  composite annotations over it on a 300ms debounce. Re-rendering the PDF per
  edit would be far too slow.

## Pointer-event stacking. The source of most interaction bugs so far.

The page shell stacks canvas, text layer, then the annotation overlay. Anything
in the overlay that is `pointer-events: auto` sits above the text layer and
eats the drag, so text selection silently never forms. Rules that hold now:

- `.ann-root`, `.ann-svg`, `.ann-html`, `.ann-node` are all
  `pointer-events: none`. Only leaves opt back in.
- A leaf that opts back in stays opted in **whatever its parents say**, so every
  leaf has to answer for `inert` itself. A text box's words carried a plain
  `pointer-events: auto` and were the top thing on the page under every drawing
  tool: a stroke, an area highlight or a highlighter drag aimed at a text box
  picked the box up and dragged it instead of marking it.
- Every annotation is one `.ann-node` in a single stacking order, drawings and
  boxes alike, so whatever was added last sits on top. Do not split drawings
  back into a shared SVG: a picture then covers every stroke regardless of age.
- `inert` is on for every tool except select and eraser. That is what lets you
  draw across a picture instead of grabbing it. Select needs the shapes to pick
  them up, the eraser needs them to rub them out.
- `buildTextLayer` adds pdf.js's `endOfContent` spacer and the selectionchange
  plumbing that drives it. We build the text layer from the core library, not
  the viewer, so that piece is ours: without it a drag through the gap between
  two lines lands on the container and the selection jumps to the whole page.
- Select mode has **no** capture surface. Covering the text layer is what made
  the document's own text unselectable, breaking copy, drag to search and
  translate extensions. Marquee selection listens on the page shell and ignores
  drags that begin on a glyph. Note the text layer container fills the page, so
  test `target !== textLayerEl` as well as `contains`.
- While the highlight tool is active every annotation goes inert (`inert` in
  AnnotationLayer), or a drag crossing one collapses the selection. A text box
  is the one exception: its words take the pointer so they can be marked, and
  `start` refuses to begin a drag or change the selection while `marking`.
- The highlighter over a text box builds its range by hand, in `markInBox`,
  from `caretRangeFromPoint` at the two ends of the drag. The browser will not
  extend a drag selection into an overlay sitting above the text layer: the
  caret anchors on the press and then stays collapsed however far you drag,
  though a range built in code over the same words is fine. Both ends are
  clamped inside the words first, since dragging a little past the last one is
  how anybody marks to the end of a line. `markRects` is the shared tail that
  both this and the text layer's own selection go through, so a highlight is one
  annotation with a box per line either way.
- The text layer is a *sibling* of the overlay, so selection-end is a window
  `mouseup` listener, not a handler on the overlay. It is scoped per page by
  the `textLayerEl.contains(...)` check.
- Do not set a flag on pointerdown and clear it on the capture surface's
  pointerup. The capture surface is inert for highlight and eraser, so that
  pointerup never fires and the flag sticks. Read `e.buttons` instead.

## Optimistic add mounts before setEditing

`store.add` puts the annotation on screen under a `tmp_` id, so a new text box
or note mounts *before* `setEditing` runs. React `autoFocus` only fires on
mount, so it does nothing here. Focus with a ref plus an effect keyed on
`editing`, or keystrokes go to the shortcut handler instead of the box.

## Session log

- Steps 0 to 5 of TESTING.md verified in Chrome via Playwright. Ink holds its
  position under zoom on both page 1 and the rotated page 4.
- Fixed: text highlighting was completely dead (overlay swallowed pointers);
  eraser deleted on bare hover; empty text boxes could not be removed; new
  text boxes never took focus; pasted and placed images inherited the pen's
  opacity.
- Also fixed: sidebar thumbnails never repainted after a page op (the drawn
  flag latched on); note popovers ran off the right edge; area highlights could
  not be dragged; the eraser had no cursor of its own.
- Added since: trash with restore, cross-page dragging, layer order via right
  click, selection frame with scale and rotate, auto-growing text boxes, tool
  icons, editable persisted palette.
- Added later: page undo, hidden pages, multi-page select in the sidebar with
  bulk hide, rotate, duplicate and delete, a right click menu on thumbnails,
  and arrive/leave animation on page ops.
- Steps 6 to 14 not yet exercised end to end.
- Rotation is not offered for ink or for multi-selections. Layer changes are
  not on the undo stack.
- An unselected text box only takes a pointer on its own words, so anything
  aiming at the middle of one hits the text layer behind it instead.
- Rotation is offered for a single box type only, and a group drag does not
  cross pages.
- A 404 fires on every page load, source not identified. Page 4's sidebar
  thumbnail looks portrait while the page itself renders landscape.
- An image only a few pixels wide sits entirely under its own resize handle, so
  it can be resized but not moved. Not worth special casing yet.
