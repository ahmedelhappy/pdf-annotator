import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    pageIndex: { type: Number, required: true },
    type: {
      type: String,
      enum: ['ink', 'highlight', 'text', 'note', 'image'],
      required: true,
    },
    // Every coordinate inside `data` is PDF user space: points, origin
    // bottom-left, unrotated. Screen pixels are never stored.
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Paint order within a page. Higher sits on top. Ties fall back to
    // insertion order, so untouched documents keep the order they had.
    z: { type: Number, default: 0 },
    // A locked annotation cannot be moved, resized, erased or deleted until
    // it is unlocked again. Nothing on the server enforces it; it is a guard
    // against knocking finished work out of place.
    locked: { type: Boolean, default: false },
    style: {
      color: { type: String, default: '#e11d48' },
      width: { type: Number, default: 2 },
      opacity: { type: Number, default: 1 },
      fontSize: { type: Number, default: 14 },
    },
  },
  { timestamps: true }
);

schema.index({ documentId: 1, pageIndex: 1 });

export default mongoose.model('Annotation', schema);
