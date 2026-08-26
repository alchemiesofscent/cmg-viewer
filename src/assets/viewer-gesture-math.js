export function clampZoom(value, { min = 0.75, max = 2.5 } = {}) {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : 1;
  return Math.round(Math.max(min, Math.min(max, safe)) * 1000) / 1000;
}

export function pointDistance(first, second) {
  if (!first || !second) return Number.POSITIVE_INFINITY;
  const deltaX = Number(second.x) - Number(first.x);
  const deltaY = Number(second.y) - Number(first.y);
  return Number.isFinite(deltaX) && Number.isFinite(deltaY)
    ? Math.hypot(deltaX, deltaY)
    : Number.POSITIVE_INFINITY;
}

export function pinchZoom(startZoom, startDistance, currentDistance, limits = {}) {
  const initialDistance = Number(startDistance);
  const nextDistance = Number(currentDistance);
  if (!Number.isFinite(initialDistance) || initialDistance <= 0 || !Number.isFinite(nextDistance)) {
    return clampZoom(startZoom, limits);
  }
  return clampZoom(Number(startZoom) * (nextDistance / initialDistance), limits);
}

export function dragZoom(startZoom, deltaY, { sensitivity = 180, ...limits } = {}) {
  const distance = Number(deltaY);
  const divisor = Number(sensitivity);
  if (!Number.isFinite(distance) || !Number.isFinite(divisor) || divisor <= 0) {
    return clampZoom(startZoom, limits);
  }
  return clampZoom(Number(startZoom) * (2 ** (-distance / divisor)), limits);
}

export function isSecondTap(lastTap, nextTap, { maxDelay = 300, maxDistance = 48 } = {}) {
  if (!lastTap || !nextTap || lastTap.target !== nextTap.target) return false;
  const elapsed = Number(nextTap.time) - Number(lastTap.time);
  return elapsed >= 0
    && elapsed <= maxDelay
    && pointDistance(lastTap, nextTap) <= maxDistance;
}
