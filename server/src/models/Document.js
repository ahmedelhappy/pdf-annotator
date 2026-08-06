import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    originalName: String,
    filename: { type: String, required: true },
    pageCount: { type: Number, default: 0 },
    thumbnailAssetId: String,
    // held while a page op rewrites the file, blocks annotation writes
    busy: { type: Boolean, default: false },
    busySince: Date,
    lastOpenedAt: Date,
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
