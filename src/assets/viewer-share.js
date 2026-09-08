import { setupToolsMenu } from './viewer-tools.js';

export async function copyViewLink({ clipboard, field, status }) {
  const link = field.value;
  try {
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
    await clipboard.writeText(link);
    status.textContent = 'Link copied.';
    return true;
  } catch {
    field.focus();
    field.select();
    status.textContent = 'Select and copy the link above. Automatic copying is unavailable in this browser.';
    return false;
  }
}

export function setupSharePanel({ toggle, panel, field, copy, close, status, getUrl, clipboard }) {
  const menu = setupToolsMenu({ toggle, panel, onChange(open) {
    if (!open) return;
    field.value = getUrl();
    status.textContent = '';
  } });
  field.addEventListener('click', () => field.select());
  copy.addEventListener('click', async () => {
    copy.disabled = true;
    await copyViewLink({ clipboard, field, status });
    copy.disabled = false;
  });
  close.addEventListener('click', () => menu.setOpen(false, { restoreFocus: true }));
  return menu;
}
