import test from 'node:test';
import assert from 'node:assert/strict';
import { setupKeyboardToolbar } from '../../src/assets/viewer-keyboard.js';
function fixture() {
  const target = () => ({ handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, removeEventListener(name) { delete this.handlers[name]; }, emit(name) { this.handlers[name]?.(); } });
  const viewport = Object.assign(target(), { height: 800, offsetTop: 0 });
  const frames = [];
  const win = Object.assign(target(), { visualViewport: viewport, requestAnimationFrame(fn) { frames.push(fn); return frames.length; }, cancelAnimationFrame() {} });
  const input = target();
  const doc = { activeElement: null };
  const media = Object.assign(target(), { matches: true });
  let applied = 0;
  const toolbar = { getBoundingClientRect: () => ({ bottom: 800 - applied }), style: { setProperty(name, value) { applied = parseFloat(value); }, removeProperty() { applied = 0; } } };
  const dispose = setupKeyboardToolbar({ input, toolbar, media, window: win, document: doc });
  return { viewport, input, doc, media, dispose, lift: () => applied, tick() { while (frames.length) frames.shift()(); }, focus() { doc.activeElement = input; input.emit('focus'); } };
}
test('keyboard resize and Safari pan keep controls at the visible bottom without accumulating offsets', () => {
  const f = fixture(); f.focus(); f.tick();
  f.viewport.height = 430; f.viewport.offsetTop = 70; f.viewport.emit('resize'); f.tick();
  assert.equal(f.lift(), 300);
  f.viewport.emit('scroll'); f.tick(); assert.equal(f.lift(), 300);
  f.viewport.offsetTop = 100; f.viewport.emit('scroll'); f.tick(); assert.equal(f.lift(), 270);
});
test('Go remains in place after blur until the keyboard closes', () => {
  const f = fixture(); f.focus(); f.viewport.height = 450; f.tick();
  f.doc.activeElement = null; f.input.emit('blur'); f.tick(); assert.equal(f.lift(), 350);
  f.viewport.height = 800; f.viewport.emit('resize'); f.tick(); assert.equal(f.lift(), 0);
  f.viewport.height = 400; f.viewport.emit('resize'); f.tick(); assert.equal(f.lift(), 0);
});
test('unfocused viewport changes do not move controls; switching to desktop and cleanup reset them', () => {
  const f = fixture(); f.viewport.height = 450; f.viewport.emit('resize'); f.tick(); assert.equal(f.lift(), 0);
  f.focus(); f.tick(); assert.equal(f.lift(), 350);
  f.media.matches = false; f.media.emit('change'); f.tick(); assert.equal(f.lift(), 0);
  f.dispose(); assert.equal(f.viewport.handlers.resize, undefined);
});
test('missing visual viewport leaves browser layout alone', () => {
  const dispose = setupKeyboardToolbar({ window: {}, document: {}, input: {}, toolbar: {}, media: {} });
  assert.doesNotThrow(dispose);
});
