import test from 'node:test';
import assert from 'node:assert/strict';
import {
  afterDelete, afterDeleteMany, afterDuplicate, afterDuplicateMany, afterImport,
  afterInsert, afterReorder, planRemap,
} from '../src/lib/remap.js';

// Annotations on pages 0..3, one per page, named by their page
const sample = () => [
  { _id: 'a0', pageIndex: 0 },
  { _id: 'a1', pageIndex: 1 },
  { _id: 'a2', pageIndex: 2 },
  { _id: 'a3', pageIndex: 3 },
];

test('insert shifts everything at or after the insertion point', () => {
  const { remove, move } = planRemap(sample(), afterInsert(2));
  assert.deepEqual(remove, []);
  assert.deepEqual(move, [
    { _id: 'a2', pageIndex: 3 },
    { _id: 'a3', pageIndex: 4 },
  ]);
});

test('insert at the front shifts everything', () => {
  const { move } = planRemap(sample(), afterInsert(0));
  assert.equal(move.length, 4);
  assert.deepEqual(move.map((m) => m.pageIndex), [1, 2, 3, 4]);
});

test('insert at the end moves nothing', () => {
  const { remove, move } = planRemap(sample(), afterInsert(4));
  assert.deepEqual(remove, []);
  assert.deepEqual(move, []);
});

test('delete drops the page and pulls later ones back by one', () => {
  const { remove, move } = planRemap(sample(), afterDelete(1));
  assert.deepEqual(remove, ['a1']);
  assert.deepEqual(move, [
    { _id: 'a2', pageIndex: 1 },
    { _id: 'a3', pageIndex: 2 },
  ]);
});

test('deleting the last page touches nothing else', () => {
  const { remove, move } = planRemap(sample(), afterDelete(3));
  assert.deepEqual(remove, ['a3']);
  assert.deepEqual(move, []);
});

test('duplicate keeps the source page and shifts only what follows', () => {
  const { remove, move } = planRemap(sample(), afterDuplicate(1));
  assert.deepEqual(remove, []);
  assert.deepEqual(move, [
    { _id: 'a2', pageIndex: 3 },
    { _id: 'a3', pageIndex: 4 },
  ]);
});

test('import inserts a block and shifts by the block size', () => {
  const { move } = planRemap(sample(), afterImport(1, 3));
  assert.deepEqual(move, [
    { _id: 'a1', pageIndex: 4 },
    { _id: 'a2', pageIndex: 5 },
    { _id: 'a3', pageIndex: 6 },
  ]);
});

test('reorder follows pages to their new positions', () => {
  // new order is old pages [2, 0, 3, 1]
  const { remove, move } = planRemap(sample(), afterReorder([2, 0, 3, 1]));
  assert.deepEqual(remove, []);
  const byId = Object.fromEntries(move.map((m) => [m._id, m.pageIndex]));
  assert.equal(byId.a2, 0);
  assert.equal(byId.a3, 2);
  assert.equal(byId.a1, 3);
  // a0 lands at 1
  assert.equal(byId.a0, 1);
});

test('reversing a reorder restores every original page index', () => {
  const order = [2, 0, 3, 1];
  const forward = afterReorder(order);

  // invert the permutation: inverse[oldIdx] = newIdx
  const inverse = [];
  order.forEach((oldIdx, newIdx) => { inverse[newIdx] = oldIdx; });
  const backOrder = [];
  inverse.forEach((oldIdx, newIdx) => { backOrder[oldIdx] = newIdx; });
  const backward = afterReorder(backOrder);

  for (let i = 0; i < order.length; i++) {
    assert.equal(backward(forward(i)), i);
  }
});

test('a page dropped from the reorder list takes its annotations with it', () => {
  // page 3 is not in the new order, so it and its annotations are gone
  const { remove } = planRemap(sample(), afterReorder([0, 1, 2]));
  assert.deepEqual(remove, ['a3']);
});

test('annotations never end up on a negative page', () => {
  const ops = [afterInsert(0), afterDelete(0), afterDuplicate(0), afterImport(0, 2)];
  for (const op of ops) {
    for (let i = 0; i < 6; i++) {
      const next = op(i);
      assert.ok(next === null || next >= 0, `page ${i} produced ${next}`);
    }
  }
});

test('deleting several pages pulls survivors back past all of them', () => {
  const remap = afterDeleteMany([1, 3]);
  assert.equal(remap(0), 0);
  assert.equal(remap(1), null);
  assert.equal(remap(2), 1);
  assert.equal(remap(3), null);
  assert.equal(remap(4), 2);
  assert.equal(remap(5), 3);
});

test('deleting several pages matches deleting them one at a time', () => {
  const indices = [1, 3, 4];
  const many = afterDeleteMany(indices);
  // highest first, so earlier deletions do not shift the ones still to come
  const oneByOne = (i) => {
    let at = i;
    for (const g of [...indices].sort((a, b) => b - a)) {
      const step = afterDelete(g)(at);
      if (step === null) return null;
      at = step;
    }
    return at;
  };
  for (let i = 0; i < 8; i++) assert.equal(many(i), oneByOne(i), `page ${i}`);
});

test('deleting a single page the many way agrees with the one way', () => {
  for (let at = 0; at < 4; at++) {
    for (let i = 0; i < 4; i++) {
      assert.equal(afterDeleteMany([at])(i), afterDelete(at)(i));
    }
  }
});

test('deleting no pages leaves everything where it is', () => {
  const remap = afterDeleteMany([]);
  for (let i = 0; i < 5; i++) assert.equal(remap(i), i);
});

test('a plan for a multi delete drops and moves the right annotations', () => {
  const anns = [
    { _id: 'a', pageIndex: 0 },
    { _id: 'b', pageIndex: 1 },
    { _id: 'c', pageIndex: 2 },
    { _id: 'd', pageIndex: 4 },
  ];
  const { remove, move } = planRemap(anns, afterDeleteMany([1, 3]));
  assert.deepEqual(remove, ['b']);
  assert.deepEqual(move, [{ _id: 'c', pageIndex: 1 }, { _id: 'd', pageIndex: 2 }]);
});

test('afterDuplicateMany matches afterDuplicate for a single page', () => {
  const many = afterDuplicateMany([1]);
  const one = afterDuplicate(1);
  for (let i = 0; i < 5; i++) assert.equal(many(i), one(i));
});

test('afterDuplicateMany shifts by the copies made in front of a page', () => {
  // 0 1 2 3, copying 1 and 2, becomes 0 1 1' 2 2' 3
  const f = afterDuplicateMany([1, 2]);
  assert.equal(f(0), 0);
  assert.equal(f(1), 1);
  assert.equal(f(2), 3);
  assert.equal(f(3), 5);
});

test('afterDuplicateMany keeps a duplicated page where it was', () => {
  const f = afterDuplicateMany([0, 3]);
  assert.equal(f(0), 0);
  assert.equal(f(3), 4);
});

test('afterDuplicateMany drops nothing', () => {
  const f = afterDuplicateMany([0, 1, 2]);
  for (let i = 0; i < 3; i++) assert.notEqual(f(i), null);
});

test('duplicating every page doubles the document', () => {
  const f = afterDuplicateMany([0, 1, 2]);
  assert.deepEqual([f(0), f(1), f(2)], [0, 2, 4]);
});
