import test from 'node:test';
import assert from 'node:assert/strict';
import { setupToolsMenu } from '../../src/assets/viewer-tools.js';

function fixture() {
  const handlers = {};
  const frames = [];
  const doc = { activeElement: null, addEventListener(name, action) { (handlers[name] ||= []).push(action); } };
  const control = () => ({ attributes: {}, handlers: {}, contains(target) { return target === this; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, action) { this.handlers[name] = action; },
    focus() { doc.activeElement = this; },
  });
  const toggle = control();
  const firstTool = control();
  const panel = { contains(target) { return target === firstTool; }, querySelector() { return firstTool; } };
  let state;
  const menu = setupToolsMenu({ toggle, panel, document: doc, schedule: callback => frames.push(callback), onChange: value => { state = value; } });
  const emit = (name, event) => (handlers[name] || []).forEach(action => action(event));
  return { toggle, firstTool, panel, doc, menu, emit, frames, state: () => state };
}

test('Tools opens and closes without a viewport restriction and keeps hidden/inert/ARIA synchronized', () => {
  const f = fixture();
  assert.equal(f.panel.hidden, true);
  assert.equal(f.panel.inert, true);
  f.toggle.handlers.click();
  assert.equal(f.state(), true);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.panel.inert, false);
  assert.equal(f.toggle.attributes['aria-expanded'], 'true');
  f.frames.shift()();
  assert.equal(f.doc.activeElement, f.firstTool);
  f.toggle.handlers.click();
  assert.equal(f.panel.hidden, true);
  assert.equal(f.panel.inert, true);
  assert.equal(f.doc.activeElement, f.toggle);
});

test('rapid open/close/reopen ignores stale focus callbacks', () => {
  const f = fixture();
  f.menu.setOpen(true);
  f.menu.setOpen(false);
  f.menu.setOpen(true);
  f.frames.shift()();
  assert.equal(f.doc.activeElement, null);
  f.frames.shift()();
  assert.equal(f.doc.activeElement, f.firstTool);
});

test('touches inside remain usable; outside taps close the menu', () => {
  const f = fixture();
  f.menu.setOpen(true);
  f.emit('pointerdown', { target: f.firstTool });
  assert.equal(f.state(), true);
  f.emit('pointerdown', { target: f.toggle });
  assert.equal(f.state(), true);
  f.emit('pointerdown', { target: {} });
  assert.equal(f.state(), false);
});

test('Escape closes, restores focus and consumes the key; tabbing outside closes', () => {
  const f = fixture();
  f.menu.setOpen(true);
  let prevented = false;
  f.emit('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.doc.activeElement, f.toggle);
  assert.equal(f.panel.hidden, true);
  f.menu.setOpen(true);
  f.emit('focusin', { target: {} });
  assert.equal(f.state(), false);
});
