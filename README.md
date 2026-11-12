# PDF Annotator

A local-first PDF annotation app. Open a PDF, draw on it freehand, highlight
text, drop notes, flag the hard parts, paste screenshots, reorganize the pages,
then export a flattened copy. Everything runs on your own machine and nothing
leaves it: the API binds to loopback only.

It is a reader as much as an annotator, and a whiteboard if you start a blank
document instead of opening one.

Stack: React + Vite + TypeScript, Express, MongoDB, pdf.js for rendering,
pdf-lib for writing.

---

## Setup on Windows

**1. Install MongoDB Community.** The installer registers it as a Windows
service. Check it is running:

```powershell
Get-Service MongoDB
```

If it says Stopped:

```powershell
Start-Service MongoDB
```

**2. Install dependencies.** From the project root:

```powershell
npm run setup
```

**3. Start it.**

```powershell
npm run dev
```

The app opens at http://localhost:5173. The API runs on port 5174 and is bound
to loopback only, so nothing on your network can reach your documents.

Configuration lives in `server/.env`, copied from `server/.env.example`: PORT,
MONGO_URI, STORAGE_DIR.

**4. Generate a test file.**

```powershell
npm run sample
```

Writes `sample.pdf` at the project root: six pages, one landscape, one
pre-rotated, real selectable text, and a known search-term count. Then work
through `TESTING.md`, which is ordered so the first failure points at one
subsystem instead of the whole app.

**5. Optional: non-Latin text in exports.** Helvetica cannot render Arabic or
any other non-WinAnsi script. Drop a single `.ttf` or `.otf` into
`server/fonts/` and exports will use it. Without one, that text still appears
on screen but is skipped at export time and the server logs a warning. Noto
Sans Arabic works well.

---

## What it does

**Annotating.** Freehand ink with pressure, text highlights that span lines as
one object, area highlights, text boxes that size themselves to their words,
sticky notes, pasted or placed images, and flags for marking a hard part of a
page. Anything on a box can be moved, scaled and rotated from one selection
frame; several at once move as a group and snap as one.

**Reading.** Continuous scroll, find in document, a document outline, page
thumbnails down the side that follow where you are reading, an annotation list
that can group by page or narrow to just the pages you flagged, and a document
that reopens on the page you left it on.

**Pages.** Insert, delete, duplicate, reorder and rotate, one page or several
selected at once. Pages can also be hidden, which skips them in the viewer and
leaves them out of the export without touching the file. Every page operation
is undoable, because the server keeps the previous file.

**Keeping things.** Deleting a document only sets a flag, and the trash restores
it. Only an explicit purge from the trash unlinks anything.

**Zooming.** A mouse wheel with Ctrl, the buttons and Ctrl+= all zoom the
document and redraw it sharply. A trackpad pinch instead magnifies what is on
screen through a single transform, the way pinching a web page does, so nothing
re-renders and pinching back out returns exactly to where you started.

---

## Layout

```
CLAUDE.md               why the code is the way it is, and what not to "fix"
HISTORY.md              what happened and when, append only
TESTING.md              ordered smoke test, start here after setup
server/
  scripts/make-sample.js  generates sample.pdf
  src/lib/remap.js      pure page-index remapping, fully unit tested
  src/lib/pdfOps.js     page insert / delete / duplicate / reorder / rotate
  src/lib/exportPdf.js  flattens annotations into a new PDF
  src/lib/ink.js        stroke geometry, mirrored on the client
  storage/pdfs/         the actual PDF files
  storage/assets/       pasted images and thumbnails
client/
  src/lib/geometry.ts   the coordinate contract, read this first
  src/lib/shortcuts.ts  every keyboard binding, one table
  src/store.ts          annotations, undo/redo, optimistic writes
  src/components/AnnotationLayer.tsx  all pointer interaction
  src/components/Viewer.tsx           scale, current page, page operations
```

## The two ideas worth knowing

**Coordinates.** Every annotation is stored in PDF user space: points, origin
bottom-left, unrotated. Screen pixels are never stored. Conversion happens only
at the boundary, through the viewport pdf.js hands back. Because page rotation
is baked into that viewport, annotations rotate with their page for free and
nothing stored ever needs migrating. All of this lives in
`client/src/lib/geometry.ts`.

A pinch adds a second scale on top, since it is a CSS transform the viewport
knows nothing about. Anything measuring the screen owes both, and `localPoint`
is the way in that handles it.

**Non-destructive editing.** Annotations are JSON in MongoDB. The original PDF
on disk is never touched. Export builds a new file on demand. The exception is
page operations, which rewrite the file and therefore have to renumber every
annotation. That renumbering is pure and tested in `server/test/remap.test.js`,
and the file write is backed up first so a database failure rolls the file back
rather than leaving the two out of sync.

---

## Keyboard

Press `?` in the viewer for the full sheet, or `Ctrl+K` for a searchable
command palette. Bindings can be rebound or switched off from the sheet, and
some ship switched off. Highlights:

| | |
|---|---|
| `V` `P` `E` `H` `R` `T` `N` `I` `D` | select, draw, erase, highlight, area, text, note, image, flag |
| `1`–`5`, `F1`–`F4` | colors, style presets |
| `[` `]` | thinner, thicker |
| `{` `}` | much thinner, much thicker |
| `,` `.` | more transparent, more opaque |
| Hold `Space` | pan |
| `Ctrl` + wheel | zoom the document, or pinch a trackpad to magnify |
| `\` | fit width |
| <code>&#124;</code> | fit whole page |
| `Ctrl+B` / `Ctrl+L` | page thumbnails, annotation list |
| `Ctrl+F` | find in document |
| `Ctrl+Alt+N` / `Ctrl+Alt+P` | next, previous annotation in the document |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo, redo |
| `Ctrl+Enter` | insert a page after this one |
| `Ctrl+Shift+←` / `Ctrl+Shift+→` | rotate the page |
| `Ctrl+S` | export the annotated PDF |
| `Ctrl+Shift+S` | export the annotations as JSON |

Ctrl+1 through Ctrl+8 belong to the browser for tab switching and cannot be
intercepted, which is why the zoom presets use backslash.

---

## Tests

```powershell
npm test                    # both suites, 142 tests
npm --prefix server test    # remap, page ops and export, 44 tests
npm --prefix client test    # geometry, ink, shortcuts, 98 tests
npm --prefix client run typecheck
```

The client suite includes a parity test that imports the server's copy of the
stroke geometry and asserts both produce identical paths. If they ever drift,
exported ink would stop matching what you drew, so that test fails first.

Geometry, remap, ink, search and shortcut parsing are the tested core, and a
fix in any of them ships with a regression test. UI and interaction code is
verified by hand against `TESTING.md`.

---

## If something breaks

**Server exits with a MongoDB message.** The service is not running. See step 1.

**Blank page, console says `Cannot find module` for the worker.** Delete
`node_modules` under `client/` and reinstall. The worker is resolved with Vite's
`?url` suffix and needs a clean install to be copied.

**"Cannot use the same canvas during multiple render operations."** A render
task was not cancelled before a new one started. `PdfPage.tsx` cancels on
unmount and on scale change; if you see this, a new code path is rendering
without cancelling first.

**Annotations drift when you zoom.** Something is storing screen pixels. Every
write should pass through `toPdf` or `rectToPdf` first.

**Annotations are the wrong size while a pinch is held.** Something measured
the screen without dividing out `magnification()`. CLAUDE.md lists every place
that has to.

**Annotations land on the wrong page after inserting one.** A write was in
flight during the renumber. `Viewer.runPageOp` calls `flushPending()` first, so
check that any new write path is covered by it.

**Text selection stops working under a tool.** Something in the annotation
overlay took `pointer-events: auto` and is sitting above the text layer.

**Export downloads an empty or broken file.** Check the server console. Export
runs server-side, and skipped annotations are logged with a reason.

---

## Known gaps

- The undo stack lives in memory, so a refresh clears it. Persisting it means
  moving from annotation snapshots to an op log.
- `bulkWrite` in the page-op renumber is not atomic on standalone MongoDB. The
  file rollback covers the common failure, but a crash mid-write could still
  leave a few annotations on the wrong page. Running Mongo as a single-node
  replica set would allow a real transaction.
- No OCR, so scanned PDFs have no text layer and cannot be text-highlighted or
  searched.
- Importing pages from a second PDF has a working endpoint but no UI.
- Rotation is offered for images, text boxes and highlights, one at a time. Ink
  would have to rewrite every point and a group would have to swing each member
  about the group centre, so neither is offered.
- Changing layer order is not on the undo stack.
- A 404 fires on every page load and has not been tracked down yet.
- Steps 6 to 14 of `TESTING.md` have not been exercised end to end.

---

## Notes on how this was built

`CLAUDE.md` is the engineering record: the invariants, the behaviour that looks
like a bug and is not, and for most decisions the bug that forced it. It is
written for whoever works on this next, which in practice has meant an AI coding
assistant, and it is rewritten whenever something in it stops being true.

`HISTORY.md` is the companion to it, and only ever grows: one dated entry per
working session, what was done and what was left unfinished. It exists because
the first four sessions were held in chats that were deleted after 30 days, and
had to be reconstructed from commits and file timestamps.

---

## License

MIT. See [LICENSE](LICENSE).
