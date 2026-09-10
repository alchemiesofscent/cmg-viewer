import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePages, buildToc } from '../../src/assets/viewer-data.js';

const canvas = (id, order, label) => ({
  id, type: 'Canvas', label: { none: [label] }, width: 600, height: 900,
  metadata: [{ label: { en: ['Physical order'] }, value: { none: [String(order)] } }],
  items: [{ items: [{ body: { id: `${id}/image.jpg`, service: [{ id: `${id}/iiif`, type: 'ImageService2' }] } }] }],
});
const manifest = { items: [canvas('a', 10, 'II'), canvas('b', 12, '1'), canvas('c', 15, '2')] };

test('manifest-only fallback retains source orders, labels and image services', () => {
  const pages = normalizePages({}, manifest);
  assert.deepEqual(pages.map(p => [p.order, p.label]), [[10, 'II'], [12, '1'], [15, '2']]);
  assert.equal(pages[0].image, 'a/image.jpg');
  assert.equal(pages[0].service, 'a/iiif');
  assert.equal(pages[0].thumbnail, 'a/iiif/full/200,/0/default.jpg');
});
test('volume-only fallback preserves pages when the manifest is unavailable', () => {
  const pages = normalizePages({ pages: [{ order: 42, label: 'X', imageUrl: 'scan.jpg', width: 800, height: 1200 }] }, null);
  assert.equal(pages.length, 1); assert.equal(pages[0].order, 42); assert.equal(pages[0].image, 'scan.jpg');
});
test('an explicitly indexed record overrides only its own canvas', () => {
  const pages = normalizePages({ pages: [{ index: 2, order: 99, label: 'Plate', imageUrl: 'plate.jpg' }] }, manifest);
  assert.deepEqual(pages.map(p => p.order), [10, 12, 99]);
  assert.equal(pages[0].image, 'a/image.jpg');
  assert.equal(pages[2].image, 'plate.jpg');
});
test('volume contents retain source provenance and resolve nonconsecutive orders', () => {
  const pages = normalizePages({}, manifest);
  const toc = buildToc({ structures: { label: 'Text', orders: [12], provenance: ['mets', 'html'], items: [] } }, manifest, pages);
  assert.equal(toc[0].index, 1); assert.equal(toc[0].order, 12);
  assert.deepEqual(toc[0].provenance, ['METS', 'CMG']);
});
test('range references resolve complete definitions regardless of declaration order', () => {
  const pages = normalizePages({}, manifest);
  const child = { id: 'child', type: 'Range', label: { en: ['Child'] }, items: [{ id: 'b', type: 'Canvas' }] };
  const parent = { id: 'parent', type: 'Range', label: { en: ['Parent'] }, items: [{ id: 'child', type: 'Range' }] };
  for (const structures of [[child, parent], [parent, child]]) {
    const toc = buildToc({}, { ...manifest, structures }, pages);
    const entry = toc.find(node => node.label === 'Parent');
    assert.equal(entry.index, 1); assert.equal(entry.children[0].label, 'Child');
  }
});
test('circular range references terminate and preserve reachable canvas targets', () => {
  const pages = normalizePages({}, manifest);
  const a = { id: 'one', type: 'Range', label: { en: ['One'] }, items: ['two'] };
  const b = { id: 'two', type: 'Range', label: { en: ['Two'] }, items: ['one', { id: 'c', type: 'Canvas' }] };
  const toc = buildToc({}, { ...manifest, structures: [a, b] }, pages);
  assert.equal(toc[0].index, 2); assert.equal(toc[0].children[0].index, 2);
  assert.equal(toc[0].children[0].children.length, 0);
});
