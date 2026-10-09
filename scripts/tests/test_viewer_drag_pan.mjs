import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDragPan } from '../../src/assets/viewer-drag-pan.js';

function fixture({ enabled = () => true, scrollHeight = 2000 } = {}) {
  const handlers = {};
  const timers = [];
  const scroller = {
    dataset: {},
    scrollLeft: 100,
    scrollTop: 500,
    scrollWidth: 1600,
    scrollHeight,
    clientWidth: 800,
    clientHeight: 600,
    clientLeft: 0,
    clientTop: 0,
    captured: new Set(),
    focused: false,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener(name, fn) { handlers[name] = fn; },
    removeEventListener(name) { delete handlers[name]; },
    setPointerCapture(id) { this.captured.add(id); },
    releasePointerCapture(id) { this.captured.delete(id); },
    hasPointerCapture(id) { return this.captured.has(id); },
    focus() { this.focused = true; },
  };
  let started = 0;
  const pan = setupDragPan(scroller, {
    enabled,
    onStart: () => { started += 1; },
    window: { setTimeout: (fn) => timers.push(fn) },
  });
  function emit(name, overrides = {}) {
    const event = {
      pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1, clientX: 400, clientY: 300,
      target: { closest: () => null }, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...overrides,
    };
    handlers[name](event);
    return event;
  }
  return { scroller, pan, emit, handlers, started: () => started, flush: () => { while (timers.length) timers.shift()(); } };
}

test('a primary mouse drag scrolls the reader against the pointer and swallows the trailing click', () => {
  const f = fixture();
  assert.equal(f.emit('pointerdown').defaultPrevented, true);
  assert.equal(f.scroller.focused, true);
  f.emit('pointermove', { clientX: 401, clientY: 301 });
  assert.equal(f.started(), 0, 'Small jitter is not a drag');
  assert.equal(f.scroller.scrollTop, 500);
  f.emit('pointermove', { clientX: 340, clientY: 180 });
  assert.equal(f.started(), 1);
  assert.equal(f.pan.active, true);
  assert.equal(f.scroller.dataset.panning, 'true');
  assert.equal(f.scroller.scrollLeft, 160);
  assert.equal(f.scroller.scrollTop, 620);
  f.emit('pointermove', { clientX: 450, clientY: 350 });
  assert.equal(f.scroller.scrollLeft, 50);
  assert.equal(f.scroller.scrollTop, 450);
  f.emit('pointerup', { buttons: 0 });
  assert.equal(f.scroller.dataset.panning, undefined);
  assert.equal(f.scroller.captured.size, 0);
  const click = f.emit('click');
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.propagationStopped, true);
  f.flush();
  assert.equal(f.emit('click').defaultPrevented, false);
});

test('a click without movement is left alone', () => {
  const f = fixture();
  f.emit('pointerdown');
  f.emit('pointerup', { buttons: 0 });
  f.flush();
  assert.equal(f.emit('click').defaultPrevented, false);
  assert.equal(f.started(), 0);
});

test('touch, other buttons, modifiers, scrollbars, controls and disabled readers do not pan', () => {
  const cases = [
    { pointerType: 'touch' },
    { pointerType: 'pen' },
    { button: 2 },
    { shiftKey: true },
    { ctrlKey: true },
    { clientX: 805 },
    { clientY: 605 },
    { target: { closest: () => ({}) } },
  ];
  for (const overrides of cases) {
    const f = fixture();
    assert.equal(f.emit('pointerdown', overrides).defaultPrevented, false, JSON.stringify(overrides));
    f.emit('pointermove', { ...overrides, clientX: 200, clientY: 100 });
    assert.equal(f.scroller.scrollTop, 500, JSON.stringify(overrides));
  }
  const disabled = fixture({ enabled: () => false });
  assert.equal(disabled.emit('pointerdown').defaultPrevented, false);
  const fits = fixture({ scrollHeight: 600 });
  fits.scroller.scrollWidth = 800;
  assert.equal(fits.emit('pointerdown').defaultPrevented, false);
});

test('a released button or cancelled pointer ends the drag', () => {
  const f = fixture();
  f.emit('pointerdown');
  f.emit('pointermove', { clientX: 300, clientY: 200 });
  f.emit('pointermove', { clientX: 200, clientY: 100, buttons: 0 });
  assert.equal(f.scroller.scrollTop, 600);
  assert.equal(f.pan.active, false);
  const g = fixture();
  g.emit('pointerdown');
  g.emit('pointermove', { clientX: 300, clientY: 200 });
  g.emit('pointercancel');
  assert.equal(g.scroller.dataset.panning, undefined);
  g.pan.dispose();
  assert.equal(g.handlers.pointerdown, undefined);
});
