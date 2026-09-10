import assert from 'node:assert/strict';
import test from 'node:test';
import { pageLoadOrder, startImagePreview } from '../../src/assets/viewer-loading.js';

test('distant jumps request the selected page before either neighbour', () => {
  assert.deepEqual(pageLoadOrder(150, 300), [150, 151, 149]);
  assert.deepEqual(pageLoadOrder(0, 300), [0, 1]);
  assert.deepEqual(pageLoadOrder(299, 300), [299, 298]);
  assert.deepEqual(pageLoadOrder(0, 1), [0]);
  assert.deepEqual(pageLoadOrder(0, 0), []);
});

function previewFixture() {
  const handlers = {};
  const frame = {
    dataset: {}, children: [],
    prepend(image) { this.children.unshift(image); },
    removeAttribute(name) { if (name === 'data-preview') delete this.dataset.preview; },
  };
  const image = {
    addEventListener(name, handler) { handlers[name] = handler; },
    removeAttribute(name) { delete this[name]; },
    remove() { frame.children = frame.children.filter(child => child !== this); },
  };
  const cancel = startImagePreview(frame, 'thumbnail.jpg', {
    alt: 'Page 12 (preview)', width: 1654, height: 2480, createImage: () => image,
  });
  return { frame, image, handlers, cancel };
}

test('a loaded preview preserves page proportions and is marked as a preview', () => {
  const { frame, image, handlers } = previewFixture();
  assert.equal(frame.children.length, 0);
  handlers.load();
  assert.deepEqual(frame.children, [image]);
  assert.equal(frame.dataset.preview, 'true');
  assert.equal(image.width, 1654);
  assert.equal(image.height, 2480);
});

test('finishing the reading image removes the visible preview and its label', () => {
  const { frame, handlers, cancel, image } = previewFixture();
  handlers.load();
  cancel();
  assert.equal(frame.children.length, 0);
  assert.equal(frame.dataset.preview, undefined);
  assert.equal(image.src, undefined);
});

test('a late thumbnail cannot cover a reading image or reappear after release', () => {
  const { frame, handlers, cancel } = previewFixture();
  cancel();
  handlers.load();
  assert.equal(frame.children.length, 0);
  assert.equal(frame.dataset.preview, undefined);
});

test('thumbnail failure leaves the frame available for the reading image', () => {
  const { frame, handlers, cancel } = previewFixture();
  assert.doesNotThrow(() => handlers.error());
  assert.equal(frame.children.length, 0);
  assert.equal(frame.dataset.preview, undefined);
  cancel();
});

import { createContinuousImages } from '../../src/assets/viewer-images.js';
import { createLoadingMetrics } from '../../src/assets/viewer-metrics.js';

function readerImages() {
  const images = [];
  const frame = { dataset: {}, children: [], getBoundingClientRect: () => ({ width: 700 }),
    prepend(image) { this.children.unshift(image); }, removeAttribute() {} };
  const state = { zoom: 1, index: 0, pages: [{ service: 'https://example.org/iiif/page', width: 1600 }],
    continuousEntries: [{ frame }], continuousLoadedIndices: new Set() };
  const controller = createContinuousImages({ state, elements: { continuousScroll: { clientWidth: 700 } },
    loadingMetrics: createLoadingMetrics(), sourcePageLabel: () => '', pageDisplay: () => 'Page 1',
    devicePixelRatio: () => 1, createImage: () => {
      const image = { handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; },
        removeAttribute(name) { delete this[name]; }, remove() {}, decode: async () => {} };
      images.push(image); return image;
    } });
  return { state, frame, images, ...controller };
}

test('released image cannot return after a delayed decode', async () => {
  const fixture = readerImages();
  fixture.hydrateContinuousImage(0);
  const image = fixture.images[0];
  let finishDecode;
  image.decode = () => new Promise(resolve => { finishDecode = resolve; });
  const loading = image.handlers.load();
  fixture.releaseContinuousImage(0);
  finishDecode(); await loading;
  assert.equal(fixture.frame.children.length, 0);
  assert.equal(fixture.state.continuousLoadedIndices.size, 0);
});

test('zoom replacement retains the old image until the sharper image decodes', async () => {
  const fixture = readerImages();
  fixture.hydrateContinuousImage(0);
  await fixture.images[0].handlers.load();
  assert.match(fixture.images[0].src, /full\/800,/);
  fixture.state.zoom = 2;
  fixture.frame.getBoundingClientRect = () => ({ width: 1500 });
  fixture.hydrateContinuousImage(0);
  assert.equal(fixture.state.continuousEntries[0].image, fixture.images[0]);
  await fixture.images[1].handlers.load();
  assert.equal(fixture.state.continuousEntries[0].image, fixture.images[1]);
  assert.equal(fixture.images[0].src, undefined);
});
