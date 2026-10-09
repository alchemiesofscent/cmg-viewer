// Desktop "hand tool": a primary-button mouse drag scrolls a native scroll
// container. Touch and pen keep their own gestures; scrollbars, controls and
// modified clicks keep their normal browser behaviour.
const DRAG_THRESHOLD = 3;
const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [contenteditable]';

export function setupDragPan(scroller, { enabled = () => true, onStart = () => {}, window: win = window } = {}) {
  let drag = null;
  let suppressClick = false;

  function overflows() {
    return scroller.scrollWidth > scroller.clientWidth || scroller.scrollHeight > scroller.clientHeight;
  }

  function onScrollbar(event) {
    const rect = scroller.getBoundingClientRect();
    return event.clientX - rect.left >= scroller.clientLeft + scroller.clientWidth
      || event.clientY - rect.top >= scroller.clientTop + scroller.clientHeight;
  }

  function end() {
    if (!drag) return;
    if (drag.moved) {
      // The click that follows this pointerup belongs to the drag, not to the page.
      suppressClick = true;
      win.setTimeout(() => { suppressClick = false; }, 0);
      try {
        if (scroller.hasPointerCapture(drag.id)) scroller.releasePointerCapture(drag.id);
      } catch {
        // Capture is already gone after pointercancel in some browsers.
      }
    }
    delete scroller.dataset.panning;
    drag = null;
  }

  function pointerdown(event) {
    if (
      event.pointerType !== 'mouse' || event.button !== 0
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || !enabled() || !overflows() || onScrollbar(event)
      || event.target.closest?.(INTERACTIVE)
    ) return;
    // No text selection or native image drag; keyboard scrolling stays with the reader.
    event.preventDefault();
    scroller.focus?.({ preventScroll: true });
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      moved: false,
    };
  }

  function pointermove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (!(event.buttons & 1)) {
      end();
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      scroller.dataset.panning = 'true';
      try {
        scroller.setPointerCapture(drag.id);
      } catch {
        // Without capture the drag still follows the pointer inside the reader.
      }
      onStart();
    }
    event.preventDefault();
    scroller.scrollLeft = drag.left - dx;
    scroller.scrollTop = drag.top - dy;
  }

  function pointerup(event) {
    if (drag && event.pointerId === drag.id) end();
  }

  function click(event) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  scroller.addEventListener('pointerdown', pointerdown);
  scroller.addEventListener('pointermove', pointermove);
  scroller.addEventListener('pointerup', pointerup);
  scroller.addEventListener('pointercancel', pointerup);
  scroller.addEventListener('lostpointercapture', pointerup);
  scroller.addEventListener('click', click, true);
  return {
    get active() { return Boolean(drag?.moved); },
    cancel: end,
    dispose() {
      end();
      scroller.removeEventListener('pointerdown', pointerdown);
      scroller.removeEventListener('pointermove', pointermove);
      scroller.removeEventListener('pointerup', pointerup);
      scroller.removeEventListener('pointercancel', pointerup);
      scroller.removeEventListener('lostpointercapture', pointerup);
      scroller.removeEventListener('click', click, true);
    },
  };
}
