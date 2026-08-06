# PDF Annotator

A local-first PDF annotation app. Upload a PDF, draw on it freehand, highlight
text, drop notes, paste screenshots, add and reorder pages, then export a
flattened copy. Everything runs on your own machine and nothing leaves it.

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

## Layout

```
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
```

## The two ideas worth knowing

**Coordinates.** Every annotation is stored in PDF user space: points, origin
bottom-left, unrotated. Screen pixels are never stored. Conversion happens only
at the boundary, through the viewport pdf.js hands back. Because page rotation
is baked into that viewport, annotations rotate with their page for free and
nothing stored ever needs migrating. All of this lives in
`client/src/lib/geometry.ts`.

**Non-destructive editing.** Annotations are JSON in MongoDB. The original PDF
on disk is never touched. Export builds a new file on demand. The exception is
page operations, which rewrite the file and therefore have to renumber every
annotation. That renumbering is pure and tested in `server/test/remap.test.js`,
and the file write is backed up first so a database failure rolls the file back
rather than leaving the two out of sync.

---

## Keyboard

Press `?` in the viewer for the full sheet, or `Ctrl+K` for a searchable
command palette. Highlights:

| | |
|---|---|
| `V` `P` `E` `H` `R` `T` `N` `I` | select, draw, erase, highlight, area, text, note, image |
| `1`–`5`, `F1`–`F4` | colors, style presets |
| `[` `]` | thinner, thicker |
| Hold `Space` | pan |
| `Ctrl` + wheel | zoom |
| `\` | fit width |
| `Ctrl+F` | find in document |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo, redo |
| `Ctrl+Enter` | insert a page after this one |
| `Ctrl+S` | export the annotated PDF |

Ctrl+1 through Ctrl+8 belong to the browser for tab switching and cannot be
intercepted, which is why the zoom presets use backslash.

---

## Tests

```powershell
npm test                    # both suites
npm --prefix server test    # remap logic and export, 16 tests
npm --prefix client test    # geometry, ink, shortcuts, 40 tests
```

The client suite includes a parity test that imports the server's copy of the
stroke geometry and asserts both produce identical paths. If they ever drift,
exported ink would stop matching what you drew, so that test fails first.

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

**Annotations land on the wrong page after inserting one.** A write was in
flight during the renumber. `Viewer.runPageOp` calls `flushPending()` first, so
check that any new write path is covered by it.

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
- Image annotations cannot be rotated, only moved and resized.
