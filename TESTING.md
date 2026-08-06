# Smoke test

Roughly 15 minutes. The order matters: each step depends only on the ones
before it, so the first failure points at one subsystem instead of leaving you
guessing across the whole app.

Generate the test file first:

```powershell
npm run sample
```

That writes `sample.pdf` at the project root: 6 pages, one landscape, one
pre-rotated 90 degrees, real selectable text, and the word **annotate**
appearing exactly **7 times**.

Keep the browser console and the server terminal visible the whole time.

---

## 0. It starts

```powershell
npm run dev
```

Expect `[db] connected` and `[api] http://localhost:5174` in the terminal, and
the library page at http://localhost:5173.

| Symptom | Look at |
|---|---|
| Server exits complaining about MongoDB | The service is stopped. `Start-Service MongoDB` |
| Page loads but the library is empty and the console shows failed `/api` calls | The Vite proxy in `client/vite.config.ts` |
| Blank page, console mentions the worker | Reinstall `client/node_modules` |

## 1. Upload and thumbnail

Drop `sample.pdf` on the drop zone.

- A card appears saying **6 pages**.
- Within a second or two the grey placeholder becomes a real page image.

If the card appears but the thumbnail never does, `makeThumbnail` in
`Library.tsx` threw. The console logs it as `[thumbnail] skipped` and it is
non-fatal, so keep going.

## 2. Render and scroll

Open it.

- All six pages render, page numbers on the left run 1 to 6.
- Page 3 is wider than tall. Page 4 is also wider than tall, because its
  90 degree rotation is folded into the viewport.
- Scroll to the bottom and back. Nothing goes blank permanently.

Pages far from the viewport release their canvas on purpose, so a page you
scroll past may flash white for a moment before redrawing. That is intended.

## 3. Ink, and the coordinate contract

This is the single most important check in the file.

1. Press `P`, draw a squiggle across the middle of page 1.
2. Press `Ctrl` and scroll up to about 300%.
3. **The ink must stay exactly on the same words.**
4. Zoom back to 100%. Still exact.
5. Resize the browser window. Still exact.

If the ink drifts, something stored screen pixels instead of PDF points. Every
write has to pass through `toPdf` or `rectToPdf` in `client/src/lib/geometry.ts`.

Then repeat all of it on **page 4**, the rotated one. Rotation is where
coordinate bugs hide.

## 4. Ink quality

- Draw slowly with a mouse: the line should be smooth, not visibly polygonal.
- Draw at 300% zoom, then zoom out. The stroke should not look chunkier than
  one drawn at 100%. If it does, the simplify tolerance is not being scaled.
- With a pen or touchscreen, pressing harder should visibly widen the stroke.

## 5. Highlight, both modes

- Press `H`, drag across a sentence on page 1. The highlight snaps to the line,
  not to your drag path. Text underneath stays readable.
- Press `R`, drag a box anywhere. That one is freeform.

If `H` produces nothing, the text layer is not being found. If it produces a
rectangle matching your drag exactly, `onTextSelectionEnd` fell through to the
wrong branch.

## 6. Text, notes, images

- `T`, click page 2, type. The box should focus automatically.
- `N`, click, type in the popover.
- Take a screenshot with `Win+Shift+S`, then press `Ctrl+V`. The image lands
  centered on the current page.
- `I`, click, pick an image file from disk.

Then, with the select tool (`V`):

- Drag the image. A pink guide line appears when an edge lines up with the text
  box or the page center.
- Hold `Alt` while dragging. Snapping turns off.
- Drag the corner handle. The image keeps its aspect ratio; the text box
  does not.

## 7. Selection

- Click empty space and drag: a marquee appears and selects what it touches.
- `Shift`+click adds to the selection.
- `Ctrl+A` selects everything on the current page.
- Arrow keys nudge, `Shift`+arrows nudge further.
- With several things selected, change the color. All of them change at once.

Drag the width slider back and forth. The network tab should show a handful of
requests, not one per pixel.

## 8. Undo

- Draw three strokes, `Ctrl+Z` three times. All three go.
- `Ctrl+Shift+Z` three times. All three come back.
- **Drag something across the page in one motion, then `Ctrl+Z` once.** It
  should jump back to where it started, not creep back one frame at a time.
- Draw a stroke and immediately drag it before the save indicator says Saved.
  Then refresh the page. It must be where you dragged it, not where you drew it.

That last one is the optimistic-write reconciliation. It is the subtlest thing
in the app.

## 9. Erase

Press `E`, then drag across several strokes. Each disappears as the cursor
crosses it. `Ctrl+Z` brings them back.

## 10. Search

Press `Ctrl+F`, type `annotate`.

- The counter reads **7**.
- Every match is highlighted in amber.
- `Enter` and `Shift+Enter` walk forward and backward, and the view scrolls to
  each specific match, not just to its page.

A count of 7 with the arrows landing in the wrong place means the scanner and
the highlighter built their text differently. Both live in
`client/src/lib/search.ts` and both must use the same joiner.

## 11. Page operations

This is where annotations can silently land on the wrong page, so annotate
first and check after.

1. Put a distinct mark on pages 1, 2, and 3.
2. Insert a blank page before page 2. Marks stay on their own content.
3. Delete that blank page. Marks are still correct.
4. Delete page 2 itself. Its mark goes with it; the others are untouched.
5. Duplicate page 1. The copy is blank; the original keeps its mark.
6. Drag page 5 above page 2 in the sidebar. Every mark follows its page.
7. Rotate page 3 from the sidebar. Its marks rotate with the content.
8. Insert a page after the landscape page. The new one is landscape too.

While any of these run, an amber bar reads *Rearranging pages*. Editing during
that window is blocked on purpose.

## 12. Export

Press `Ctrl+S`.

Open the downloaded file in any PDF reader that is not this app, and check:

- Ink is smooth vector, not a blurry bitmap.
- Highlights are transparent and the text under them is readable.
- Text boxes and notes are in the right place.
- Images are present and correctly sized.
- Page count matches, including pages you added.

Non-Latin text will be missing unless you put a font in `server/fonts/`. The
server logs a warning saying so.

## 13. Reload

Refresh the browser. Everything is still there except undo history, which is
in-memory by design.

## 14. Shortcuts

Press `?` for the sheet, `Ctrl+K` for the palette.

Two specific regressions to confirm are gone:

- **`Ctrl+V` must not switch to the select tool** while pasting.
- **`Ctrl+P` must not switch to the pen** while opening the print dialog.

Then: hold `Space` and drag to pan. Release. Panning stops. Hold `Space`,
`Alt+Tab` away, come back. Panning is not stuck on.

---

## What to send me if something breaks

The step number, the exact console error, and the server terminal output around
it. The step number alone usually narrows it to one file.
