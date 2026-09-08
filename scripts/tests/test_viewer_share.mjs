import test from 'node:test';
import assert from 'node:assert/strict';
import { copyViewLink } from '../../src/assets/viewer-share.js';
const fixture = () => {
  const field = { value: 'https://example.org/viewer/volume/?pn=42&view=spread', focus() { this.focused = true; }, select() { this.selected = true; } };
  return { field, status: { textContent: '' } };
};
test('copy preserves the page/view URL and gives visible confirmation', async () => {
  const f = fixture();
  let copied;
  const result = await copyViewLink({ ...f, clipboard: { async writeText(text) { copied = text; } } });
  assert.equal(result, true);
  assert.equal(copied, f.field.value);
  assert.equal(f.status.textContent, 'Link copied.');
});
test('clipboard denial gives a selectable manual link instead of silent failure', async () => {
  const f = fixture();
  assert.equal(await copyViewLink({ ...f, clipboard: { async writeText() { throw new Error('Denied'); } } }), false);
  assert.equal(f.field.focused, true);
  assert.equal(f.field.selected, true);
  assert.match(f.status.textContent, /Select and copy/);
});
test('browsers without a clipboard API retain the manual copy path', async () => {
  const f = fixture();
  assert.equal(await copyViewLink(f), false);
  assert.equal(f.field.selected, true);
});
