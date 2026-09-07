import assert from 'node:assert/strict';
import test from 'node:test';
import { syncTifyPageSelection } from '../../src/assets/viewer-navigation.js';

function viewerAt(pages) {
  return {
    options: { pages },
    loads: [],
    toggles: 0,
    setPage(next) {
      this.options.pages = next;
      this.loads.push(next);
    },
    toggleDoublePage() {
      this.toggles += 1;
      this.options.pages = [this.options.pages.at(-1)];
    },
  };
}

test('change then submit for the same spread starts only one image load', () => {
  const viewer = viewerAt([2, 3]);
  syncTifyPageSelection(viewer, [20, 21]);
  syncTifyPageSelection(viewer, [20, 21]);
  assert.deepEqual(viewer.loads, [[20, 21]]);
  assert.deepEqual(viewer.options.pages, [20, 21]);
});

test('initial synchronization does not reload the constructor selection', () => {
  const viewer = viewerAt([20, 21]);
  assert.equal(syncTifyPageSelection(viewer, [20, 21]), false);
  assert.equal(viewer.loads.length, 0);
});

test('different spreads still navigate, including back to a previous spread', () => {
  const viewer = viewerAt([2, 3]);
  for (const pages of [[20, 21], [22, 23], [20, 21]]) syncTifyPageSelection(viewer, pages);
  assert.deepEqual(viewer.loads, [[20, 21], [22, 23], [20, 21]]);
});

test('switching to a single page disables facing mode once', () => {
  const viewer = viewerAt([20, 21]);
  syncTifyPageSelection(viewer, [20]);
  syncTifyPageSelection(viewer, [20]);
  syncTifyPageSelection(viewer, [22]);
  assert.equal(viewer.toggles, 1);
  assert.deepEqual(viewer.loads, [[20], [22]]);
});

test('blank and non-paged partners are preserved without duplicate reloads', () => {
  const viewer = viewerAt([2, 3]);
  for (const pages of [[0, 1], [0, 1], [-1, 5], [-1, 5]]) syncTifyPageSelection(viewer, pages);
  assert.deepEqual(viewer.loads, [[0, 1], [-1, 5]]);
});
