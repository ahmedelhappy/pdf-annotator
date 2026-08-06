// Pure page-index remapping. Kept free of Mongo and pdf-lib so the logic that
// decides where an annotation lands after a page op can be tested directly.
// Each function returns (oldIndex) => newIndex, or null to drop the annotation.

export const afterInsert = (at) => (i) => (i >= at ? i + 1 : i);

export const afterDelete = (at) => (i) => (i === at ? null : i > at ? i - 1 : i);

// Several pages removed at once. A survivor moves back by however many of the
// removed pages sat in front of it, which is the same answer as deleting them
// one at a time from the highest index down, without the intermediate states.
export function afterDeleteMany(indices) {
  const gone = new Set(indices);
  return (i) => {
    if (gone.has(i)) return null;
    let before = 0;
    for (const g of gone) if (g < i) before++;
    return i - before;
  };
}

export const afterDuplicate = (at) => (i) => (i > at ? i + 1 : i);

// Several pages copied at once, each copy landing straight after its original.
// A page moves along by however many copies were made in front of it, and a
// duplicated page itself does not move: its copy goes after it, not before.
export function afterDuplicateMany(indices) {
  const at = [...indices];
  return (i) => i + at.reduce((n, d) => n + (d < i ? 1 : 0), 0);
}

export const afterImport = (at, count) => (i) => (i >= at ? i + count : i);

// order[newPosition] = oldIndex, e.g. [2,0,1] means page 2 moves to the front
export function afterReorder(order) {
  const lookup = new Map(order.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  return (i) => (lookup.has(i) ? lookup.get(i) : null);
}

// Rotation changes nothing: it is stored in the PDF page itself, and pdf.js
// folds it into the viewport, so stored coordinates stay valid.
export const afterRotate = () => (i) => i;

// Applies a remap to a plain array of { _id, pageIndex }. Returns the ids to
// delete and the index changes to write, so callers do the minimum work.
export function planRemap(annotations, remap) {
  const remove = [];
  const move = [];
  for (const a of annotations) {
    const next = remap(a.pageIndex);
    if (next === null) remove.push(a._id);
    else if (next !== a.pageIndex) move.push({ _id: a._id, pageIndex: next });
  }
  return { remove, move };
}
