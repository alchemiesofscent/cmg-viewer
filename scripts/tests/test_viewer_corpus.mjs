import test from 'node:test';
import assert from 'node:assert/strict';
import { corpusGroups } from '../../src/assets/viewer-corpus.js';
const item = (volumeId, collection, seriesNumber, label = volumeId) => ({ volumeId, collection, seriesNumber, label });

test('orders CMG divisions numerically and collections bibliographically', () => {
  const groups = corpusGroups({ items: [
    item('other', 'Weitere Ausgaben', 'Dioscurides'),
    item('orient', 'CMG Supplementum Orientale', 'V'),
    item('ten', 'CMG', 'X'), item('two', 'CMG', 'II'),
    item('latin', 'CML', 'I'), item('supp', 'CMG Supplementum', 'I'), item('one', 'CMG', 'I'),
  ] });
  assert.deepEqual(groups.map(g => g.label), ['CMG I', 'CMG II', 'CMG X', 'CMG Supplementum', 'CMG Supplementum Orientale', 'CML', 'Weitere Ausgaben']);
});
test('sorts subdivisions and supplement Roman numerals naturally', () => {
  const groups = corpusGroups({ items: [
    item('ten', 'CMG', 'V 10'), item('two', 'CMG', 'V 2'),
    item('sx', 'CMG Supplementum', 'X'), item('sii', 'CMG Supplementum', 'II'),
  ] });
  assert.deepEqual(groups[0].volumes.map(v => v.id), ['two', 'ten']);
  assert.deepEqual(groups[1].volumes.map(v => v.id), ['sii', 'sx']);
});
test('combines separate works in the same scan without losing titles', () => {
  const first = item('shared', 'CMG', 'V 2,1', 'First work');
  const groups = corpusGroups({ items: [first, { ...first, label: 'Second work' }, first] });
  assert.equal(groups[0].volumes.length, 1);
  assert.deepEqual(groups[0].volumes[0].titles, ['First work', 'Second work']);
});
test('does not fabricate routes for entries without a volume and rejects malformed catalogues', () => {
  assert.deepEqual(corpusGroups({ items: [{ label: 'No scan' }] }), []);
  assert.throws(() => corpusGroups({}), /Missing catalogue/);
});
