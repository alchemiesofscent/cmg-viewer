import { setupToolsMenu } from './viewer-tools.js';

export async function copyViewLink({ clipboard, field, status, kind = 'Link' }) {
  const link = field.value;
  try {
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
    await clipboard.writeText(link);
    status.textContent = `${kind} copied.`;
    return true;
  } catch {
    field.focus();
    field.select();
    status.textContent = `Select and copy the ${kind.toLowerCase()} above. Automatic copying is unavailable in this browser.`;
    return false;
  }
}

export function setupSharePanel({ toggle, panel, field, copy, close, status, getUrl, clipboard, reference, citation, copyCitation, getReference, getCitation }) {
  const menu = setupToolsMenu({ toggle, panel, onChange(open) {
    if (!open) return;
    field.value = getUrl();
    if (reference) reference.textContent = getReference();
    if (citation) citation.value = getCitation();
    status.textContent = '';
  } });
  field.addEventListener('click', () => field.select());
  copy.addEventListener('click', async () => {
    copy.disabled = true;
    await copyViewLink({ clipboard, field, status });
    copy.disabled = false;
  });
  if (copyCitation && citation) {
    citation.addEventListener('click', () => citation.select());
    copyCitation.addEventListener('click', async () => {
      copyCitation.disabled = true;
      await copyViewLink({ clipboard, field: citation, status, kind: 'Citation' });
      copyCitation.disabled = false;
    });
  }
  close.addEventListener('click', () => menu.setOpen(false, { restoreFocus: true }));
  return menu;
}
