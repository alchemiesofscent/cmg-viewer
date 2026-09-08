// Preserve the reader's layout while lifting its toolbar into the visible area.
export function setupKeyboardToolbar({ input, toolbar, media, window: win = window, document: doc = document }) {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  let editing = false;
  let lift = 0;
  let frame = null;
  function update() {
    frame = null;
    const focused = doc.activeElement === input;
    if (!media.matches) editing = false;
    const bottom = toolbar.getBoundingClientRect().bottom + lift;
    lift = editing && media.matches
      ? Math.max(0, bottom - (viewport.offsetTop + viewport.height))
      : 0;
    toolbar.style.setProperty('--keyboard-lift', `${lift}px`);
    // Keep the Go button in place during blur and the keyboard's closing
    // animation. Clearing on blur can move it before iOS dispatches its click.
    if (!focused && lift === 0) editing = false;
  }
  function schedule() {
    if (frame === null) frame = win.requestAnimationFrame(update);
  }
  function focus() { editing = true; schedule(); }
  input.addEventListener('focus', focus);
  input.addEventListener('blur', schedule);
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  win.addEventListener('resize', schedule);
  win.addEventListener('scroll', schedule);
  media.addEventListener('change', schedule);
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    input.removeEventListener('focus', focus);
    input.removeEventListener('blur', schedule);
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    win.removeEventListener('scroll', schedule);
    media.removeEventListener('change', schedule);
    toolbar.style.removeProperty('--keyboard-lift');
  };
}
