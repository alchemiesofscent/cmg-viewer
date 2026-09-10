// One owner for page/layout state and the target of a programmatic scroll.
export function createReaderPosition(initialMode = 'single') {
  let index = 0;
  let mode = initialMode === 'spread' ? 'spread' : 'single';
  let target = null;
  let revision = 0;
  return {
    get index() { return index; },
    set index(value) { if (Number.isInteger(value) && value >= 0) index = value; },
    get mode() { return mode; },
    set mode(value) { if (value === 'single' || value === 'spread') mode = value; },
    get target() { return target; },
    set target(value) { target = value; },
    request(value) { target = value; revision += 1; return revision; },
    isCurrent(token) { return token === revision; },
    observe(value) {
      if (target != null && value !== target) return false;
      target = null;
      return true;
    },
    interrupt() { target = null; revision += 1; },
  };
}
