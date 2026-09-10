export const MAX_EXPORT_PAGES = 50;
const MAX_BYTES = 64 * 1024 * 1024;

export function exportRange(pages, from, to) {
  const resolve = value => {
    const text = String(value).trim();
    const scan = /^scan\s+(\d+)$/i.exec(text);
    if (scan) {
      const index = Number(scan[1]) - 1;
      if (index >= 0 && index < pages.length) return index;
      throw new Error('That scan position is outside this volume.');
    }
    const matches = pages.flatMap((p, i) => String(p.label).toLowerCase() === text.toLowerCase() ? [i] : []);
    if (matches.length > 1) throw new Error(`Page ${text} occurs more than once. Enter a scan position, such as “scan ${matches[0] + 1}”.`);
    if (!matches.length) throw new Error(`Page ${text || '(empty)'} was not found. Enter a printed label or “scan N”.`);
    return matches[0];
  };
  const start = resolve(from), end = resolve(to);
  if (end < start) throw new Error('The last page must follow the first page.');
  if (end - start + 1 > MAX_EXPORT_PAGES) throw new Error(`Choose at most ${MAX_EXPORT_PAGES} pages per export.`);
  return { start, end, pages: pages.slice(start, end + 1) };
}

export function originalPdfUrl(page) {
  // Preserve the original derivative basename; never infer it from a printed label.
  try {
    const url = new URL(page.derivative);
    if (url.origin !== 'https://cmg.bbaw.de' || !/^\/epubl\/online\/jpg\/[^/]+\/[^/]+-max\.jpg$/.test(url.pathname)) return '';
    url.pathname = url.pathname.replace('/online/jpg/', '/online/PDF/').replace(/-max\.jpg$/, '.pdf');
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return ''; }
}

export function exportImageUrl(page) {
  if (page.service) return `${page.service.replace(/\/$/, '')}/full/${Math.min(page.width || 2400, 2400)},/0/default.jpg`;
  if (page.image) return page.image;
  throw new Error('No image is available for this page.');
}

export async function createScanPdf({ pages, title, source, signal, onProgress = () => {},
  fetchImage = fetch, loadPdf = () => import('./vendor/pdf-lib/pdf-lib.esm.min.js') }) {
  if (!pages.length || pages.length > MAX_EXPORT_PAGES) throw new Error(`Choose 1–${MAX_EXPORT_PAGES} pages.`);
  const check = () => signal?.throwIfAborted();
  check();
  const { PDFDocument } = await loadPdf();
  check();
  const pdf = await PDFDocument.create();
  pdf.setTitle(title); pdf.setCreator('CMG Viewer');
  pdf.setSubject(`Created from BBAW page images. Source: ${source}`);
  let totalBytes = 0;
  for (let i = 0; i < pages.length; i++) {
    check();
    onProgress(`Preparing page ${i + 1} of ${pages.length}…`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 45000);
    try {
      const response = await fetchImage(exportImageUrl(pages[i]), { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error(`Image server returned ${response.status}.`);
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_BYTES - totalBytes) throw new Error('Export is too large. Choose a smaller range.');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (totalBytes + size > MAX_BYTES) { await reader.cancel(); throw new Error('Export is too large. Choose a smaller range.'); }
        chunks.push(value);
      }
      check(); totalBytes += size;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const image = bytes[0] === 0x89 ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      // Use the actual encoded image proportions, with no crop or extra compression.
      const width = 595.28, height = width * image.height / image.width;
      pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
      await pdf.flush();
    } catch (error) {
      check();
      throw new Error(`Could not export page ${pages[i].label} (${i + 1} of ${pages.length}). ${error.name === 'AbortError' ? 'The request timed out.' : error.message} Retry or choose a smaller range.`);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  check(); onProgress('Finishing PDF…');
  const bytes = await pdf.save();
  check(); return bytes;
}

export function setupPdfExport({ toggle, dialog, getState, beforeOpen, restoreFocus }) {
  const find = id => dialog.querySelector(`#${id}`);
  const mode = find('export-mode'), from = find('export-from'), to = find('export-to');
  const fields = find('export-range'), summary = find('export-summary'), status = find('export-status');
  const prepare = find('export-prepare'), cancel = find('export-cancel'), download = find('export-download');
  const share = find('export-share'), original = find('export-original');
  let snapshot, controller, blobUrl, file;
  const clearFile = () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = null; file = null; download.hidden = true; download.removeAttribute('href'); share.hidden = true;
  };
  const selection = () => mode.value === 'current'
    ? { start: snapshot.index, end: snapshot.index, pages: [snapshot.pages[snapshot.index]] }
    : exportRange(snapshot.pages, from.value, to.value);
  const update = () => {
    clearFile(); status.textContent = ''; prepare.textContent = 'Create PDF';
    fields.hidden = mode.value !== 'range';
    try {
      const range = selection();
      summary.textContent = `${range.pages.length} page${range.pages.length === 1 ? '' : 's'} · scans ${range.start + 1}–${range.end + 1} · labels ${range.pages[0].label}–${range.pages.at(-1).label}`;
      prepare.disabled = false;
    } catch (error) { summary.textContent = error.message; prepare.disabled = true; }
  };
  toggle.addEventListener('click', () => {
    if (controller) return;
    snapshot = getState();
    if (!snapshot.pages.length) return;
    beforeOpen(); mode.value = 'current';
    from.value = to.value = `scan ${snapshot.index + 1}`;
    const href = originalPdfUrl(snapshot.pages[snapshot.index]);
    original.hidden = !href;
    if (href) original.href = href; else original.removeAttribute('href');
    update(); dialog.showModal();
  });
  for (const control of [mode, from, to]) control.addEventListener('input', update);
  const stop = () => controller?.abort();
  cancel.addEventListener('click', stop);
  find('export-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { stop(); clearFile(); restoreFocus(); });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  prepare.addEventListener('click', async () => {
    const range = selection();
    clearFile(); controller = new AbortController();
    const signal = controller.signal;
    for (const control of [mode, from, to, prepare]) control.disabled = true;
    cancel.hidden = false;
    try {
      const bytes = await createScanPdf({ pages: range.pages, title: snapshot.title, source: snapshot.url,
        signal, onProgress: message => { status.textContent = message; } });
      const name = `${snapshot.id}-scans-${range.start + 1}-${range.end + 1}.pdf`;
      file = new File([bytes], name, { type: 'application/pdf' });
      blobUrl = URL.createObjectURL(file);
      download.href = blobUrl; download.download = name; download.hidden = false;
      share.hidden = !navigator.canShare?.({ files: [file] });
      status.textContent = `PDF ready (${(file.size / 1024 / 1024).toFixed(1)} MB). Save it below.`;
    } catch (error) {
      status.textContent = signal.aborted ? 'Export cancelled.' : error.message;
      prepare.textContent = 'Retry export';
    } finally {
      controller = null; cancel.hidden = true;
      for (const control of [mode, from, to, prepare]) control.disabled = false;
    }
  });
  share.addEventListener('click', async () => {
    try { await navigator.share({ files: [file], title: snapshot.title }); }
    catch (error) { if (error.name !== 'AbortError') status.textContent = 'Sharing was unavailable. Use Save PDF instead.'; }
  });
}
