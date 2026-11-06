# HISTORY.md

A running log of how this project got here, one entry per working session.

**The rule: no session ends without an entry below.** Write it before the last
commit, so the log goes in with the work it describes. CLAUDE.md says *why the
code is the way it is* and is rewritten as the truth changes. This file says
*what happened and when*, and is only ever appended to. Nothing here gets
corrected after the fact; a later entry supersedes an earlier one.

Why it exists: the first four sessions were held in Claude Code chats that no
longer exist. Transcripts are kept for 30 days and then deleted, and the cleanup
for this project ran on 2026-11-05, so sessions 1 to 4 survive only as commits,
as CLAUDE.md, and as the browser-check scripts in `.scratch/`. Entries up to and
including session 4 were reconstructed from those on 2026-11-06, roughly ten
weeks after the fact. Dates, commits and file contents in them are exact,
because they come from git and from file timestamps. The accounts of *intent*
are inferred from commit messages and from what CLAUDE.md gained that day, and
are marked **(reconstructed)**. Session 5 onward is written as it happens.

## At a glance

| When | What | Record left |
|---|---|---|
| 2026-07-28 | Prototype, before any repo | A second copy on disk, one Copilot chat |
| 2026-08-06 | Repo opened. 12 commits in one afternoon | Commits `4c4f69a` to `4b5ce46` |
| 2026-08-09 | Text boxes: markdown in, then markdown out | Commits `8f2a969` to `25ca9ed` |
| 2026-08-23 | Flags, blank documents, page walking, thumbnails | Commits `72e5647`, `1bc8320` |
| 2026-08-24 to 08-25 | Pinch zoom. Ended mid-rewrite | Commit `1282f7d`, then an uncommitted tree |
| 2026-08-25 to 11-06 | Dormant, ten weeks | Nothing |
| 2026-11-06 | History recovered and written down. Pinch magnifier finished | This file, and the entry below |

## 2026-07-28: before the repo

Two copies of the project exist on this machine. The older one,
`C:\Users\Ahmed Elsaeed\Downloads\pdf-annotator\pdf-annotator`, has no `.git` at
all and its tracked files are stamped 05:03 that morning. It is the version that
arrived first.

What happened to it is recorded in a VS Code Copilot chat still sitting in that
folder's workspace storage. The whole conversation is one instruction, "run this
project, download the required packages.. and run it on the local host..",
followed by the terminal fighting back: `cd` failing on the space in "Ahmed
Elsaeed", `npm run setup` run from the wrong directory, then the server starting
and dying on `[db] Could not reach MongoDB at mongodb://127.0.0.1:27017`. The fix
attempted there was `mongodb-memory-server`, falling back to an in-memory Mongo
when the real one is unreachable.

**That fallback is not in the project today.** The server now requires a running
MongoDB and says so. Whether it was dropped deliberately or simply left behind in
the copy is not recorded **(reconstructed)**.

The working copy, `pdf-annotator_1\pdf-annotator`, was opened in the editor at
15:45 the same day, and `sample.pdf` was generated at 15:53. Everything after
happens there.

## 2026-08-06: the repo opens

Twelve commits between 15:42 and 17:57, the longest single stretch of work in the
project's life.

| Time | Commit | Subject |
|---|---|---|
| 15:42 | `4c4f69a` | Add local-first PDF annotator |
| 15:44 | `adb4e88` | Keep locked annotations still under the arrow keys |
| 15:45 | `f51e046` | Bring back the colour and pen you were last using |
| 16:01 | `31e82c2` | Move and act on a multiple selection as one group |
| 16:05 | `47e74cd` | Open a document where it was last left |
| 16:09 | `f452981` | Add a font size control for text and notes |
| 16:14 | `6766fdf` | Paste text into the box you are already in, and size it by measuring |
| 16:28 | `97e26fe` | Read markdown in a text box, on the page and on paper |
| 16:37 | `3a098d5` | Record the markdown parity rule and this session's decisions |
| 17:57 | `c5650be` | Give a text box its words' height, and render its markdown as you type |
| 17:57 | `8d85fa7` | Put the modals above the selection chrome, and cut the palette to five |
| 17:57 | `4b5ce46` | Note the text box height rule and the modal stacking level |

The initial commit is 61 files and 15,266 lines, and it already contains
CLAUDE.md at 347 lines, README.md, TESTING.md, and all five test files. So the
app was substantially built before the repo existed, which is what CLAUDE.md
means by "that work predates the repo and cannot be split back into the history
it was built in".

Two commits were made and then reset away the same afternoon. Both are still in
the object store as dangling commits and can be read with `git show`:

- `e9bd4fc` (15:43, `store.ts`, 51 insertions) a first pass at the locked
  annotation fix that landed two minutes later as `adb4e88`.
- `33d461c` (17:56, subject `x`) a scratch commit, reset away immediately. It
  carries `6f35434` underneath it, which is the version of "Put the modals above
  the selection chrome" that was redone as `8d85fa7`.

The three 17:57 commits all carry the same timestamp, which is a rebase or a
reset-and-recommit of the afternoon's tail rather than three minutes of work.

## 2026-08-09: markdown in a text box, and then out again

| Time | Commit | Subject |
|---|---|---|
| 12:05 | `8f2a969` | Stop the text box growing, and the markdown editor losing the caret |
| 13:04 | `99abec8` | Show one frame while editing, and scale a text box like an image |
| 13:24 | `0eff9ee` | Make the resize rules hold while a text box is being typed in |
| 15:34 | `f1493cf` | Take markdown out of a text box and give it back plain text |
| 15:56 | `25ca9ed` | Let a drawing tool mark a text box instead of dragging it |

The shape of the day is visible in the diffstats alone. Three commits spent the
morning trying to make a markdown text box behave, then `f1493cf` deleted 1,267
lines and put plain text back. CLAUDE.md records the reason: the live editor had
to be a `contenteditable`, and rebuilding its nodes under the caret produced a
run of bugs ending in Enter opening two lines at once on an empty line, with the
box running away down the page.

The markdown implementation is not lost. It is in `c5650be` and `97e26fe`, and
CLAUDE.md names both commits for anyone who wants it back.

`25ca9ed` closed the day by fixing something the text box work had exposed: a
text box's words carried a plain `pointer-events: auto`, which made them the top
thing on the page under every drawing tool, so a stroke aimed at a text box
picked the box up and dragged it instead.

## 2026-08-23: flags, blank documents, and catching the sidebar up

| Time | Commit | Subject |
|---|---|---|
| 18:29 | `72e5647` | Flag hard parts, name a document, and start a blank one |
| 18:55 | `1bc8320` | Walk pages by page, and draw a card's picture where the file changes |

`72e5647` is the broadest commit after the first: 19 files, 668 insertions,
reaching from `types.ts` through the store, the toolbar, the annotation list, the
library, the export and both Mongo models. Three features at once. The flag
annotation type and the marks panel filters that go with it; renaming a document
from its card or the toolbar, changing only `originalName` and leaving the UUID
filename alone; and `POST /api/documents/blank`, which writes a one page A4 PDF
so there is a way into the app without a PDF to open first.

`1bc8320` added `fileRev` and `thumbnailRev`, so a library card redraws its
picture when the file behind it has been rewritten, and reworked
`stepAnnotation` to walk pages rather than marks when the panel is grouped by
page.

This is also the session that built the browser-check harness. `.scratch/` is
gitignored, so it has no history of its own, but the file timestamps put
`harness.mjs` at 18:20 that evening, with `batch32` through `batch36` and `d1`
through `d4` written across the next 35 minutes. The numbering starting at 32 is
the tell that 31 earlier batches ran in sessions 1 and 2 and are no longer on
disk **(reconstructed)**.

`harness.mjs` carries one warning worth repeating here, because it is the only
place it is written down: an earlier version of the harness wiped the whole
library before each run and destroyed real uploads. It now never deletes
documents.

## 2026-08-24 to 08-25: the pinch, and where the work stopped

One commit, `1282f7d` at 18:51 on the 24th, "Make a pinch magnify the page
instead of reloading it". Three files, 123 insertions. It made zoom follow the
*size* of the wheel delta rather than the count of events, and added a `zooming`
flag that holds every page's redraw until 180ms after the last event, so the
shells resize and the bitmap already on screen stretches to fill them.

**Then the session kept going past the commit, and never came back.** The
working tree still holds that unfinished work, in four files:
`client/src/lib/geometry.ts`, `client/src/components/Viewer.tsx`,
`client/src/components/PdfPage.tsx` and
`client/src/components/AnnotationLayer.tsx`.

It is not a continuation of `1282f7d` but a replacement for it. The committed
version is still a zoom, just a deferred one: the document's scale changes and
pdf.js eventually redraws at the new scale. The uncommitted version makes a
trackpad pinch a true magnifier, one CSS transform over the whole document,
leaving the document's zoom alone the way pinching a web page does, while Ctrl
with a mouse notch keeps changing the zoom itself. The two are told apart by the
size of the delta, with `NOTCH = 50` as the boundary.

The written specification for it exists, and is `.scratch/batch38.mjs`, timed
19:28 on the 24th. Seven numbered groups of assertions: a pinch grows the page
without touching the zoom percentage or the canvas backing size; the page image,
a stroke and a picture all grow together; a hard pinch stops at six times and a
gentle one lands somewhere useful; pinching back out returns the page to exactly
its own size and never smaller; a note dropped while magnified lands under the
pointer; a drag moves by what was dragged rather than by the magnification; and
a mouse notch still zooms the document and still redraws sharply.

Last activity of the whole era: `batch37.mjs` and the screenshots `b37-ink.png`
and `b37-zoomed.png`, written 09:33 on 2026-08-25. Whether batch38 ever passed
is not recorded **(reconstructed)**. `b38-magnified.png` and `b38-drew.png` are
dated 19:31 on the 24th, so it ran at least once that evening.

CLAUDE.md was last written at 18:50 on the 24th, one minute before `1282f7d`. It
documents the committed pinch, not the rewrite, so from 2026-08-24 until today
the notes and the working tree disagreed about how pinching works.

## 2026-08-25 to 2026-11-06: dormant

Ten weeks, no commits and no file changes. On 2026-11-05 the Claude Code
transcript cleanup ran and deleted the chats for sessions 1 to 4.

## 2026-11-06: history recovered, pinch magnifier finished

Opened with a question: is there any history of this project left anywhere.
Searched git, the reflog, the object store, the Claude Code state directory,
`.claude.json`, the VS Code workspace storage and local history, and the Claude
desktop app data.

Findings, in short: the Claude Code transcripts are gone and are not
recoverable, there is no git remote so nothing is mirrored off this machine, and
the per-project prompt history in `.claude.json` is empty. What survives is the
20 commits, the two dangling ones, CLAUDE.md, `.scratch/`, and the July Copilot
chat. That dig is the source for every entry above, and this file is the answer
to it: the project now keeps its own history rather than relying on a tool's
30-day retention.

Then picked the pinch magnifier back up, which is the entry that follows.

### Finishing the pinch magnifier

Started from the tree as session 4 left it: typecheck clean, 136 tests green, so
nothing was broken, it was simply unfinished. The approach was kept as found,
because it is the better one. `1282f7d` is still a zoom however long it defers
the redraw, and a CSS transform is a magnifier that costs nothing.

What the rewrite had missed, all of it the same mistake in six places. The
transform means a screen pixel now owes two scales, the viewport's and the
magnifier's, and `localPoint` had been taught to divide the second one out but
only the code that goes through `localPoint` was fixed. Each of these measures
the screen by hand and was out by the magnification:

1. The paste point. `dropAt` in Viewer converted the pointer straight through
   `toPdf`, so the more the page was magnified the further down it a paste
   landed.
2. The zoom anchor. The `[scale]` scroll restore read `magRef.current`, but an
   explicit zoom clears the magnifier in the same commit and the ref is not put
   back to 1 until a later effect. It now reads the render's `mag`, or zooming
   out of a magnified page jumped somewhere else entirely.
3. Fit to width did not clear the magnifier, so it fitted and then did not fit.
4. A drawing's grab point mixed the two spaces outright: `rectToBox` gives page
   pixels and it was being added to the shell's screen rect.
5. A box's `boxW`/`boxH` for a cross-page drag came off
   `getBoundingClientRect`, so an annotation dropped on another page while
   magnified arrived that many times too big. This is the bug CLAUDE.md already
   warns about in its `.ann-html > *` form, arriving by a different road.
6. `markRects`. A highlight made while magnified was laid down several times too
   big, hanging off the page.

One behaviour was changed rather than fixed: a mouse notch now clears the
magnifier, the way the buttons, Ctrl+= and fit do. It keeps "an explicit zoom
lets go of the magnifier" true for every explicit zoom, and it stops `magBox`,
which is measured once as the magnifier leaves 1, from describing a layout that
has since been zoomed underneath it.

Verification. `.scratch/batch38.mjs`, the spec session 4 wrote and never
recorded a result for, passes all 19 of its assertions with no page errors: the
page grows 595 to 3572 with the zoom still reading 100% and the canvas backing
still 595, the stroke and the picture hold their place to four decimals, a hard
pinch stops at exactly x6.00, pinching out returns 3572 to 595, a note lands
under the pointer and a drag moves 119.1pt where 119.1pt was wanted.

batch38 does not reach the two cases that fixes 5 and 6 are about, so
`.scratch/d8.mjs` is new and covers them: a highlight made at x1.35 comes out
188.9pt against 184.9pt wanted and sits inside the page, and a 180x19pt text box
dragged to the next page at x2.23 arrives 180x19pt. Both would be out by their
magnification without the fixes. `batch37` (the document zoom) and `batch32` and
`batch34` (flags, marks, renaming, every tool) were re-run and stay green, so
the notch change cost nothing.

geometry.ts is one of the five tested-core files, so the magnification change
ships with regression tests: six new cases in `geometry.test.ts` covering the
accessors, `localPoint` at rest and magnified, and the invariant that matters,
that a pointer reaches the store as the same PDF point at x1.25, x2 and x6.
Client tests 92 to 98, 136 to 142 in all, server unchanged at 44. Typecheck
clean.

CLAUDE.md was rewritten where it described the old pinch. Invariant 1 now says
that a screen pixel owes both scales, the pinch section describes the two nested
divs and why neither exists at rest, and there is a list of every hand
measurement that owes the magnification, since six of them were wrong at once
and the seventh will be too. The session log now says it is standing state and
points here for dated work.

Left alone, still open: the 404 on every page load, page 4's sidebar thumbnail
reading portrait while the page renders landscape, and TESTING.md steps 6 to 14,
which have never been exercised end to end.
