import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    originalName: String,
    filename: { type: String, required: true },
    pageCount: { type: Number, default: 0 },
    thumbnailAssetId: String,
    // Which revision of the file the thumbnail was drawn from. A page op
    // rewrites the file and bumps fileRev, so the library can see that a card's
    // picture is of a document that no longer looks like that and redraw it.
    fileRev: { type: Number, default: 0 },
    // -1 means no picture has been drawn under this scheme yet, which is also
    // what every document that predates it reads as. That is deliberate: they
    // are stale by definition, since nothing was tracking their rewrites, so
    // they get redrawn once and are correct from then on. A default of 0 would
    // have made them indistinguishable from a document drawn a moment ago, and
    // a page deleted before this existed stayed on its card for ever.
    thumbnailRev: { type: Number, default: -1 },
    // A document with no PDF behind it to begin with: a blank page to draw on.
    // Kept only so the library can say what a card is.
    blank: { type: Boolean, default: false },
    // held while a page op rewrites the file, blocks annotation writes
    busy: { type: Boolean, default: false },
    busySince: Date,
    lastOpenedAt: Date,
    // Where the reader was when the document was last closed, so it opens
    // there instead of at page one. Renumbered with everything else by a page
    // op, and clamped on read in case the file shrank since.
    lastPage: { type: Number, default: 0 },
    // Deleting moves a document to the trash rather than unlinking the file, so
    // a mistaken delete is recoverable. Nothing purges this automatically.
    deletedAt: Date,
    // Pages kept in the file but skipped everywhere it is read: the viewer, and
    // the exported copy. Unhiding brings them straight back.
    hiddenPages: { type: [Number], default: [] },
    // Snapshots taken before each page op, newest last, so a delete can be
    // taken back. The file itself has to be kept, not just the row, because a
    // page op rewrites it and the page content is otherwise gone.
    pageUndo: {
      type: [
        {
          file: String,
          anns: String,
          pageCount: Number,
          hiddenPages: [Number],
          lastPage: Number,
          label: String,
          /** Which pages the op touched, so undo can point them out again. */
          pages: [Number],
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

export default mongoose.model('Document', schema);
