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

import { setupCorpusContents } from '../../src/assets/viewer-corpus.js';

// Small DOM fixture for interaction logic; this does not verify browser layout.
function drawerFixture(t, request) {
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.hidden = false; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    click() { this.handlers.click?.(); }
    focus() { document.activeElement = this; }
  }
  const nodes = Object.fromEntries(['contents-up', 'book-contents', 'corpus-contents', 'contents-heading', 'contents-eyebrow'].map(id => [id, new Element()]));
  t.mock.method(globalThis, 'fetch', request);
  const previous = globalThis.document;
  globalThis.document = { querySelector: selector => nodes[selector.slice(1)], createElement: tag => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const controller = setupCorpusContents({ baseUrl: new URL('https://example.org/cmg-viewer/'), volumeId: 'current' });
  controller.setVolumeLabel('CMG V 1');
  return { nodes, controller, rows: () => nodes['corpus-contents'].children[0].children.map(li => li.children[0]) };
}
const navigationCatalogue = { items: [item('current', 'CMG', 'V 1'), item('other', 'CMG', 'V 2'), item('first', 'CMG', 'I 1')] };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('up traverses book, parent series, corpus; selecting current book preserves its contents', async t => {
  let requests = 0;
  const fixture = drawerFixture(t, async () => { requests++; return { ok: true, json: async () => navigationCatalogue }; });
  const { nodes, controller, rows } = fixture;
  const originalContents = { page: 42 };
  nodes['book-contents'].append(originalContents);
  assert.equal(requests, 0);
  nodes['contents-up'].click();
  await tick();
  assert.equal(nodes['contents-heading'].textContent, 'CMG V');
  assert.equal(nodes['book-contents'].hidden, true);
  assert.equal(rows()[0].getAttribute('aria-current'), 'location');
  assert.equal(rows()[1].href, 'https://example.org/cmg-viewer/viewer/other/?contents=1');
  nodes['contents-up'].click();
  assert.equal(nodes['contents-heading'].textContent, 'All CMG volumes');
  assert.equal(nodes['contents-up'].hidden, true);
  rows()[1].click();
  assert.equal(nodes['contents-heading'].textContent, 'CMG V');
  rows()[0].click();
  assert.equal(nodes['contents-heading'].textContent, 'CMG V 1');
  assert.equal(nodes['book-contents'].hidden, false);
  assert.equal(nodes['book-contents'].children[0], originalContents);
  controller.showBook();
  assert.equal(requests, 1);
});

test('rapid up clicks cannot restore a stale level', async t => {
  let resolve;
  const { nodes, controller, rows } = drawerFixture(t, () => new Promise(done => { resolve = done; }));
  nodes['contents-up'].click();
  nodes['contents-up'].click();
  resolve({ ok: true, json: async () => navigationCatalogue });
  await tick();
  assert.equal(nodes['contents-heading'].textContent, 'All CMG volumes');
  assert.equal(rows().length, 2);
  controller.showBook();
  assert.equal(nodes['corpus-contents'].hidden, true);
});

test('failed catalogue requests expose a working retry without losing the book', async t => {
  let attempts = 0;
  const { nodes, rows, controller } = drawerFixture(t, async () => {
    if (++attempts === 1) throw new Error('Offline');
    return { ok: true, json: async () => navigationCatalogue };
  });
  nodes['contents-up'].click();
  await tick();
  rows()[1].click();
  await tick();
  assert.equal(attempts, 2);
  assert.equal(nodes['contents-heading'].textContent, 'CMG V');
  controller.showBook();
  assert.equal(nodes['book-contents'].hidden, false);
});


test('returning to the book during a pending request keeps the book visible', async t => {
  let resolve;
  const { nodes, controller } = drawerFixture(t, () => new Promise(done => { resolve = done; }));
  nodes['contents-up'].click();
  controller.showBook();
  resolve({ ok: true, json: async () => navigationCatalogue });
  await tick();
  assert.equal(nodes['book-contents'].hidden, false);
  assert.equal(nodes['corpus-contents'].hidden, true);
  assert.equal(nodes['contents-heading'].textContent, 'CMG V 1');
});
