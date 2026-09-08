// One non-modal disclosure for desktop and touch layouts.
export function setupToolsMenu({ toggle, panel, onChange = () => {}, document: doc = document, schedule = requestAnimationFrame }) {
  let open = false;
  let revision = 0;
  function setOpen(value, { restoreFocus = false } = {}) {
    open = Boolean(value);
    const currentRevision = ++revision;
    panel.hidden = !open;
    panel.inert = !open;
    toggle.setAttribute('aria-expanded', String(open));
    onChange(open);
    if (open) {
      schedule(() => {
        if (!open || revision !== currentRevision) return;
        panel.querySelector('button:not(:disabled), a[href], input:not(:disabled)')?.focus({ preventScroll: true });
      });
    } else if (restoreFocus || panel.contains(doc.activeElement)) {
      toggle.focus({ preventScroll: true });
    }
  }
  toggle.addEventListener('click', () => setOpen(!open));
  doc.addEventListener('pointerdown', (event) => {
    if (open && !panel.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });
  doc.addEventListener('focusin', (event) => {
    if (open && !panel.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });
  doc.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      setOpen(false, { restoreFocus: true });
    }
  });
  setOpen(false);
  return { setOpen };
}
