import { createReaderPosition } from '../../src/assets/viewer-position.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressStore, initialPageIndex, PROGRESS_KEY } from '../../src/assets/viewer-progress.js';
import { resolvePageEntry, pageReference, pageCitation } from '../../src/assets/viewer-reference.js';
import { createLoadingMetrics } from '../../src/assets/viewer-metrics.js';

const memory = () => { let value = null; return { getItem: () => value, setItem: (_key, next) => { value = next; } }; };
test('progress is per volume, bounded, and survives a new store', () => {
  const storage = memory(); const store = createProgressStore(() => storage);
  store.save('a', 23); store.save('b', 5);
  assert.equal(createProgressStore(() => storage).get('a'), 23);
  assert.equal(store.get('b'), 5);
  for (let i = 0; i < 70; i++) store.save(`v${i}`, i);
  assert.equal(Object.keys(JSON.parse(storage.getItem(PROGRESS_KEY))).length, 50);
  assert.equal(store.get('v69'), 69);
});
test('corrupt or blocked storage never breaks navigation', () => {
  const storage = memory(); storage.setItem(PROGRESS_KEY, 'invalid');
  const store = createProgressStore(() => storage); assert.equal(store.get('a'), null);
  store.save('a', 2); assert.equal(store.get('a'), 2);
  const blocked = createProgressStore(() => { throw new Error('denied'); });
  blocked.save('a', 2); assert.equal(blocked.get('a'), null);
});
test('explicit page links override remembered positions; stale saves use the default', () => {
  const options = { savedOrder: 42, defaultOrder: 2, orderIndex: new Map([[2, 0], [3, 1], [42, 2]]) };
  assert.equal(initialPageIndex({ ...options, query: new URLSearchParams('pn=3') }).index, 1);
  assert.equal(initialPageIndex({ ...options, query: new URLSearchParams() }).index, 2);
  assert.equal(initialPageIndex({ ...options, savedOrder: 999, query: new URLSearchParams() }).index, 0);
  const invalid = initialPageIndex({ ...options, query: new URLSearchParams('pn=garbage') });
  assert.equal(invalid.index, 0); assert.equal(invalid.invalidLink, true);
});
const pages = [{ label: 'I', order: 2 }, { label: '1', order: 3 }, { label: '2', order: 4 }, { label: '1', order: 5 }];
const label = page => page.label;
test('scan positions are separate from labels and source order', () => {
  assert.equal(resolvePageEntry('scan 2', pages, 0, label), 1);
  assert.equal(resolvePageEntry('2', pages, 0, label), 2);
  assert.equal(resolvePageEntry('5', pages, 0, label), 3);
  assert.equal(resolvePageEntry('i', pages, 0, label), 0);
  assert.equal(resolvePageEntry('1', pages, 3, label), 3);
  assert.equal(resolvePageEntry('scan 0', pages, 0, label), null);
  assert.equal(resolvePageEntry('scan 99', pages, 0, label), null);
  assert.equal(resolvePageEntry('2junk', pages, 0, label), null);
});
test('citations never present a missing printed label as a printed page', () => {
  assert.equal(pageReference({ label: 'II', order: 4, index: 2, count: 8 }), 'Page label II · Scan 3 of 8');
  const citation = pageCitation({ title: 'Edition title', label: '', order: 42, index: 39, url: 'https://example.org/?pn=42' });
  assert.match(citation, /scan 40 \(source page 42\)/);
  assert.doesNotMatch(citation, /p\. 42/);
});
test('timings isolate resets, failures and returned snapshots', async () => {
  let time = 0; const metrics = createLoadingMetrics(() => time);
  const late = metrics.start('old'); metrics.reset(); time = 2; late();
  assert.deepEqual(metrics.snapshot(), []);
  const finish = metrics.start('reading-image'); time = 12; finish(); finish();
  assert.equal(metrics.snapshot()[0].durationMs, 10);
  metrics.snapshot()[0].name = 'mutated'; assert.equal(metrics.snapshot()[0].name, 'reading-image');
  await assert.rejects(metrics.measure('failed', async () => { throw new Error('network'); }));
  assert.equal(metrics.snapshot()[1].status, 'error');
  for (let i = 0; i < 150; i++) metrics.start('bounded')();
  assert.equal(metrics.snapshot().length, 100);
});

 test('reading history can be listed and cleared without touching unrelated storage', () => {
   let value = null; const storage = { getItem: () => value, setItem: (_, v) => { value = v; }, removeItem: key => { assert.equal(key, PROGRESS_KEY); value = null; } };
   const store = createProgressStore(() => storage); store.save('a', 4); store.save('b', 7);
   assert.equal(store.recent().length, 2); assert.equal(store.clear(), true); assert.deepEqual(store.recent(), []);
 });

test('stale scroll completions cannot cancel a later jump to the same page', () => {
 const position = createReaderPosition();
 const old = position.request(6); position.request(2); const latest = position.request(6);
 assert.equal(position.isCurrent(old), false); assert.equal(position.isCurrent(latest), true);
 assert.equal(position.observe(0), false); assert.equal(position.target, 6);
 assert.equal(position.observe(6), true); assert.equal(position.target, null);
 position.request(4); position.interrupt(); assert.equal(position.observe(1), true);
});
