import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('viewer/fixture_a/');
  await expect(page.locator('#reader-loading')).toBeHidden();
  await expect(page.locator('#continuous-reader')).toBeVisible();
});

test('page entry, Roman labels and rapid arrows', async ({ page }) => {
  const input = page.locator('#page-order');
  await input.fill('3');
  await page.getByRole('button', { name: 'Go to entered page' }).click();
  await expect(page).toHaveURL(/pn=5/);
  await input.fill('II');
  await input.press('Enter');
  await expect(page).toHaveURL(/pn=2/);
  await input.blur();
  for (let i = 0; i < 3; i++) {
    await page.locator('#next-page').click();
    await page.locator('#previous-page').click();
  }
  await expect(page).toHaveURL(/pn=2/);
  expect(await page.locator('.reader-toolbar').evaluate(el => getComputedStyle(el).touchAction)).toBe('manipulation');
});

test('corpus tree reaches another volume with consistent navigation', async ({ page }) => {
  await page.locator('#contents-toggle').click();
  await expect(page.locator('#contents-drawer')).toHaveAttribute('aria-hidden', 'false');
  await page.locator('#contents-up').click();
  await expect(page.locator('#corpus-contents')).toBeVisible();
  await page.locator('#contents-up').click();
  await page.locator('#corpus-contents').getByRole('button', { name: /CMG I\b/ }).click();
  await page.locator('#corpus-contents a[href*="fixture_b"]').click();
  await expect(page).toHaveURL(/viewer\/fixture_b/);
  await expect(page.locator('#contents-drawer')).toHaveAttribute('aria-hidden', 'false');
  await page.locator('#contents-close').click();
  await expect(page.locator('#contents-toggle')).toBeFocused();
});

test('tools, thumbnails and Escape restore focus', async ({ page }) => {
  await page.locator('#tools-toggle').click();
  await expect(page.locator('#reader-secondary-tools')).toBeVisible();
  const initiallyOpen = await page.locator('#thumbnail-strip').isVisible();
  await page.locator('#thumbnails-toggle').click();
  if (initiallyOpen) await expect(page.locator('#thumbnail-strip')).toBeHidden();
  else await expect(page.locator('#thumbnail-strip')).toBeVisible();
  await expect(page.locator('#reader-secondary-tools')).toBeHidden();
  await page.locator('#tools-toggle').click();
  await page.locator('#thumbnails-toggle').click();
  if (initiallyOpen) await expect(page.locator('#thumbnail-strip')).toBeVisible();
  else await expect(page.locator('#thumbnail-strip')).toBeHidden();
  await page.locator('#tools-toggle').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#reader-secondary-tools')).toBeHidden();
  await expect(page.locator('#tools-toggle')).toBeFocused();
});

test('sharing reports success and provides a copy fallback', async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }));
  // The share module captures the clipboard at initialization.
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }));
  await page.reload();
  await expect(page.locator('#reader-loading')).toBeHidden();
  await page.locator('#share-view').click();
  await page.locator('#copy-view-link').click();
  await expect(page.locator('#share-status')).toHaveText('Link copied.');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
  await page.locator('#copy-view-link').click();
  await expect(page.locator('#share-status')).toContainText('Select and copy');
  await expect(page.locator('#share-link')).toBeFocused();
});

test('Info and Export open the actual viewer panels', async ({ page }) => {
  await page.locator('#tools-toggle').click();
  await page.locator('#info-toggle').click();
  await expect(page.locator('#tify')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__cmgTify?.options.view)).toBe('info');
  // Info may leave the disclosure open; normalize through its public toggle.
  if (await page.locator('#reader-secondary-tools').isHidden()) await page.locator('#tools-toggle').click();
  await page.locator('#export-toggle').click();
  await expect.poll(() => page.evaluate(() => window.__cmgTify?.options.view)).toBe('export');
});

test('spread jumps render one pair of pages', async ({ page }) => {
  await page.locator('#tools-toggle').click();
  await page.locator('#two-pages').click();
  await expect(page.locator('#tify')).toBeVisible();
  if (await page.locator('#reader-secondary-tools').isVisible()) await page.locator('#tools-toggle').click();
  await page.locator('#page-order').fill('3');
  await page.locator('#page-order').press('Enter');
  await expect.poll(() => page.evaluate(() => window.__cmgTify?.viewer?.world?.getItemCount())).toBe(2);
  await page.locator('#page-order').fill('5');
  await page.getByRole('button', { name: 'Go to entered page' }).click();
  await expect(page).toHaveURL(/pn=7/);
  await expect.poll(() => page.evaluate(() => window.__cmgTify?.options.pages)).toEqual([6, 7]);
  await expect.poll(() => page.evaluate(() => window.__cmgTify?.viewer?.world?.getItemCount())).toBe(2);
});

test('reader and open menus fit narrow and wide screens', async ({ page }) => {
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#tools-toggle').click();
    const box = await page.locator('#reader-secondary-tools').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    await page.locator('#tools-toggle').click();
  }
});

test('focus view remains usable when native fullscreen is unavailable', async ({ page }) => {
  await page.evaluate(() => {
    for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen', 'mozRequestFullScreen', 'msRequestFullscreen']) {
      Object.defineProperty(document.querySelector('.reader-app'), name, { value: undefined });
    }
  });
  await page.locator('#tools-toggle').click();
  await page.locator('#fullscreen').click();
  await expect(page.locator('.reader-app')).toHaveAttribute('data-fullscreen-mode', 'focus');
  if (await page.locator('#reader-secondary-tools').isHidden()) await page.locator('#tools-toggle').click();
  await page.locator('#fullscreen').click();
  await expect(page.locator('.reader-app')).not.toHaveAttribute('data-fullscreen-mode');
});

test('simulated visual viewport keeps focused page entry above an obstruction', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#page-order').focus();
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 400 });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => page.locator('#page-order').evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(401);
  await page.locator('#page-order').fill('4');
  await page.getByRole('button', { name: 'Go to entered page' }).click();
  await expect(page).toHaveURL(/pn=6/);
  await page.evaluate(() => {
    delete visualViewport.height;
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => page.locator('.reader-toolbar').evaluate(el => parseFloat(el.style.getPropertyValue('--keyboard-lift')))).toBe(0);
});
