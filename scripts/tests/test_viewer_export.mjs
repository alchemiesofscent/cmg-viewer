import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { exportRange, originalPdfUrl, createScanPdf } from '../../src/assets/viewer-export.js';
const images = JSON.parse(readFileSync(new URL('../../tests/export-images.json', import.meta.url)));
const pages = ['I', 'II', '1', '2'].map((label, index) => ({ label, image: `https://example.org/${index}` }));
const options = { pages, title: 'Test', source: 'https://example.org', loadPdf: async () => ({ PDFDocument }),
  fetchImage: async url => new Response(Buffer.from(images[Number(url.split('/').at(-1)) % 2], 'base64')) };

test('range uses printed labels and explicit scans, rejects duplicates and backwards ranges', () => {
  assert.deepEqual(exportRange(pages, 'II', '2').pages, pages.slice(1));
  assert.equal(exportRange(pages, 'scan 2', 'scan 4').start, 1);
  assert.throws(() => exportRange(pages, '2', 'I'), /last page/);
  assert.throws(() => exportRange([...pages, pages[0]], 'I', '2'), /more than once/);
  assert.throws(() => exportRange(pages, '5', '6'), /not found/);
  assert.throws(() => exportRange(Array(51).fill(pages[0]), 'scan 1', 'scan 51'), /at most 50/);
});
test('original PDF mapping preserves source filename and rejects unrelated URLs', () => {
  assert.equal(originalPdfUrl({ derivative: 'https://cmg.bbaw.de/epubl/online/jpg/cmg_01_01/CMG_01_01_0002-max.jpg' }), 'https://cmg.bbaw.de/epubl/online/PDF/cmg_01_01/CMG_01_01_0002.pdf');
  assert.equal(originalPdfUrl({ derivative: 'https://example.org/a-max.jpg' }), '');
});
test('export yields a valid PDF with ordered full-frame pages and source metadata', async () => {
  const urls = [];
  const data = await createScanPdf({ ...options, fetchImage: async url => { urls.push(url); return options.fetchImage(url); } });
  const pdf = await PDFDocument.load(data);
  assert.equal(pdf.getPageCount(), 4);
  assert.deepEqual(urls, pages.map(p => p.image));
  assert.equal(pdf.getTitle(), 'Test');
  assert.match(pdf.getSubject(), /https:\/\/example.org/);
  for (const page of pdf.getPages()) assert.ok(Math.abs(page.getHeight() / page.getWidth() - 1.5) < .001);
});
test('failure never returns a partial PDF; cancellation stops further fetches', async () => {
  await assert.rejects(createScanPdf({ ...options, fetchImage: async () => new Response('', { status: 503 }) }), /Could not export page I/);
  const controller = new AbortController(); let requests = 0;
  await assert.rejects(createScanPdf({ ...options, signal: controller.signal, fetchImage: async url => {
    requests++; controller.abort(); return options.fetchImage(url);
  } }), { name: 'AbortError' });
  assert.equal(requests, 1);
});
