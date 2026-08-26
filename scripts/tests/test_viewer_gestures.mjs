import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampZoom,
  dragZoom,
  isSecondTap,
  pinchZoom,
  pointDistance,
} from '../../src/assets/viewer-gesture-math.js';

const limits = { min: 0.75, max: 2.5 };

test('pinch zoom follows distance ratios and clamps safely', () => {
  assert.equal(pinchZoom(1, 100, 175, limits), 1.75);
  assert.equal(pinchZoom(2, 100, 50, limits), 1);
  assert.equal(pinchZoom(1, 100, 400, limits), 2.5);
  assert.equal(pinchZoom(1, 100, 20, limits), 0.75);
  assert.equal(pinchZoom(1.5, 0, 100, limits), 1.5);
  assert.equal(pinchZoom(1.5, Number.NaN, 100, limits), 1.5);
});

test('double-tap drag maps upward movement to zoom in and downward to zoom out', () => {
  assert.equal(dragZoom(1, -180, { ...limits, sensitivity: 180 }), 2);
  assert.equal(dragZoom(2, 180, { ...limits, sensitivity: 180 }), 1);
  assert.equal(dragZoom(2.5, -500, { ...limits, sensitivity: 180 }), 2.5);
  assert.equal(dragZoom(0.75, 500, { ...limits, sensitivity: 180 }), 0.75);
});

test('incremental samples reverse immediately after either zoom bound', () => {
  const pinchedToMaximum = pinchZoom(1, 100, 400, limits);
  assert.equal(pinchedToMaximum, 2.5);
  assert.equal(pinchZoom(pinchedToMaximum, 400, 380, limits), 2.375);

  const draggedToMaximum = dragZoom(2.5, -200, { ...limits, sensitivity: 180 });
  assert.equal(draggedToMaximum, 2.5);
  assert.ok(dragZoom(draggedToMaximum, 20, { ...limits, sensitivity: 180 }) < 2.5);
});

test('second tap requires the same target, bounded delay, and nearby point', () => {
  const target = {};
  const first = { target, time: 100, x: 20, y: 30 };
  assert.equal(isSecondTap(first, { target, time: 399, x: 50, y: 30 }), true);
  assert.equal(isSecondTap(first, { target, time: 401, x: 50, y: 30 }), false);
  assert.equal(isSecondTap(first, { target, time: 200, x: 69, y: 30 }), false);
  assert.equal(isSecondTap(first, { target: {}, time: 200, x: 20, y: 30 }), false);
});

test('distance and clamping reject invalid values without escaping bounds', () => {
  assert.equal(pointDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(pointDistance(null, { x: 3, y: 4 }), Number.POSITIVE_INFINITY);
  assert.equal(clampZoom(Number.POSITIVE_INFINITY, limits), 1);
  assert.equal(clampZoom(-5, limits), 0.75);
  assert.equal(clampZoom(8, limits), 2.5);
});
