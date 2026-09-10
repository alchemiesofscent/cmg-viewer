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

test('remembered positions resume per volume while explicit page links win', async ({ page }) => {
  await page.locator('#page-order').fill('scan 7');
  await page.locator('#page-order').press('Enter');
  await expect(page).toHaveURL(/pn=7/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cmg-reader-progress-v1') || '{}').fixture_a?.order)).toBe(7);
  await page.goto('viewer/fixture_b/');
  await expect(page.locator('#reader-loading')).toBeHidden();
  await expect(page).toHaveURL(/pn=1/);
  await page.goto('viewer/fixture_a/');
  await expect(page.locator('#reader-loading')).toBeHidden();
  await expect(page).toHaveURL(/pn=7/);
  await page.goto('viewer/fixture_a/?pn=2');
  await expect(page.locator('#reader-loading')).toBeHidden();
  await expect(page).toHaveURL(/pn=2/);
});

test('catalogue provides a separate resume link without changing work links', async ({ page }) => {
  await page.locator('#page-order').fill('scan 6');
  await page.locator('#page-order').press('Enter');
  await expect(page).toHaveURL(/pn=6/);
  await page.goto('./');
  // Filter to the relevant work.
  await page.locator('#catalogue-search').fill('Synthetic browser test volume I 1');
  const resume = page.locator('.result-resume[href*="fixture_a"]');
  await expect(resume).toBeVisible();
  await expect(page.locator('.open-result[href*="fixture_a"]')).toHaveAttribute('href', /pn=1/);
  await resume.click();
  await expect(page.locator('#reader-loading')).toBeHidden();
  await expect(page).toHaveURL(/pn=6/);
});

test('scan entry and citation expose distinct page coordinates', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async text => { window.copiedCitation = text; },
  } }));
  await page.reload();
  await expect(page.locator('#reader-loading')).toBeHidden();
  await page.locator('#page-order').fill('scan 5');
  await page.locator('#page-order').press('Enter');
  await expect(page).toHaveURL(/pn=5/);
  // A delayed viewer history update must not change the page being shared.
  await page.evaluate(() => history.replaceState(null, '', '?pn=1&view=single'));
  await page.locator('#share-view').click();
  await expect(page.locator('#share-link')).toHaveValue(/pn=5/);
  await expect(page.locator('#share-reference')).toHaveText('Page label 3 · Scan 5 of 8');
  await expect(page.locator('#share-citation')).toHaveValue(/p\. 3\..*pn=5/);
  await page.locator('#copy-citation').click();
  await expect(page.locator('#share-status')).toHaveText('Citation copied.');
  await expect.poll(() => page.evaluate(() => window.copiedCitation)).toMatch(/p\. 3\./);
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
  await page.locator('#copy-citation').click();
  await expect(page.locator('#share-citation')).toBeFocused();
  await expect(page.locator('#share-status')).toContainText('Select and copy the citation');
});

test('blocked position storage does not prevent reading; timings remain local', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } }));
  await page.reload();
  await expect(page.locator('#reader-loading')).toBeHidden();
  await page.locator('#next-page').click();
  await expect(page).toHaveURL(/pn=2/);
  await expect.poll(() => page.evaluate(() => window.cmgLoadingTimings().filter(row => row.name === 'reading-image' && row.status === 'ok').length)).toBeGreaterThan(0);
  const names = await page.evaluate(() => window.cmgLoadingTimings().map(row => row.name));
  expect(names).toContain('volume-json');
  expect(names).toContain('manifest-json');
});

test('either metadata source can fail while the other keeps the volume readable', async ({ page }) => {
  for (const path of ['**/data/volumes/*.json', '**/iiif/*/manifest.json']) {
    await page.route(path, route => route.fulfill({ status: 503, body: 'Unavailable' }));
    await page.goto('viewer/fixture_a/?pn=1');
    await expect(page.locator('#reader-loading')).toBeHidden();
    await expect(page.locator('#reader-error')).toBeHidden();
    await expect(page.locator('#continuous-pages [data-page-index="0"] img').first()).toBeVisible();
    await page.locator('#next-page').click();
    await expect(page).toHaveURL(/pn=2/);
    await page.unroute(path);
  }
});

test('failed page images do not block navigation to a healthy page', async ({ page }) => {
  await page.route('**/fixture-page.svg?page=1', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('viewer/fixture_a/?pn=1');
  await expect(page.locator('#continuous-pages [data-page-index="0"] .continuous-image-frame')).toHaveAttribute('data-image-failed', 'true');
  await page.locator('#next-page').click();
  await expect(page).toHaveURL(/pn=2/);
  await expect(page.locator('#continuous-pages [data-page-index="1"] img').first()).toBeVisible();
});

test('Retry recovers after both metadata sources fail', async ({ page }) => {
  let unavailable = true;
  const handler = route => unavailable ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fallback();
  await page.route('**/data/volumes/*.json', handler);
  await page.route('**/iiif/*/manifest.json', handler);
  await page.goto('viewer/fixture_a/?pn=1');
  await expect(page.locator('#reader-error')).toBeVisible();
  unavailable = false;
  await page.locator('#retry-reader').click();
  await expect(page.locator('#reader-error')).toBeHidden();
  await expect(page.locator('#continuous-reader')).toBeVisible();
  await expect(page.locator('#continuous-pages [data-page-index="0"] img').first()).toBeVisible();
});

test('corpus search keeps series hierarchy and recent history can be cleared', async ({ page }) => {
  await page.locator('#page-order').fill('scan 5');
  await page.locator('#page-order').press('Enter');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cmg-reader-progress-v1') || '{}').fixture_a?.order)).toBe(5);
  await page.locator('#contents-toggle').click();
  await page.locator('#corpus-search').fill('CMG V');
  await expect(page.locator('#corpus-contents')).toContainText('CMG V');
  await expect(page.locator('#corpus-contents a')).toHaveCount(1);
  const boxes = await page.evaluate(() => ['.drawer-header', '.contents-search', '.reading-history', '#corpus-contents'].map(selector => {
    const rect = document.querySelector(selector).getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height };
  }));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom - 1);
  expect(boxes[3].height).toBeGreaterThan(100);

  await page.locator('#corpus-search').fill('no-such-volume');
  await expect(page.locator('#corpus-contents')).toContainText('No matching volumes.');
  await page.locator('#corpus-search').fill('');
  await expect(page.locator('#book-contents')).toBeVisible();
  await page.locator('#reading-history summary').click();
  await expect(page.locator('#recent-volumes a')).toHaveAttribute('href', /pn=5/);
  await page.locator('#clear-reading-history').click();
  await expect(page.locator('#history-status')).toHaveText('Reading history cleared on this browser.');
  await page.locator('#contents-close').click();
  await page.goto('viewer/fixture_b/');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cmg-reader-progress-v1') || '{}').fixture_a ?? null)).toBe(null);
});

test('delayed programmatic scrolling ignores old scroll-end events', async ({ page }) => {
  await page.evaluate(() => {
    const scroller = document.querySelector('#continuous-scroll');
    const original = scroller.scrollTo.bind(scroller);
    scroller.scrollTo = options => setTimeout(() => original(options), 120);
  });
  await page.locator('#page-order').fill('scan 7');
  await page.locator('#page-order').press('Enter');
  await page.evaluate(() => {
    const scroller = document.querySelector('#continuous-scroll');
    scroller.dispatchEvent(new Event('scroll'));
    scroller.dispatchEvent(new Event('scrollend'));
  });
  await expect(page.locator('.continuous-page[data-current="true"]')).toHaveAttribute('data-page-index', '6');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cmg-reader-progress-v1') || '{}').fixture_a?.order)).toBe(7);
  await expect(page).toHaveURL(/pn=7/);
});

 test('catalogue sort direction reverses results and survives reload', async ({ page }) => {
   await page.goto('./');
   await expect(page.locator('#loading-results')).toBeHidden();
   const before = await page.locator('.result-card').evaluateAll(cards => cards.map(card => card.dataset.itemId));
   expect(before.length).toBeGreaterThan(1);
   await page.locator('#sort-direction').click();
   await expect(page).toHaveURL(/order=desc/);
   await expect.poll(() => page.locator('.result-card').evaluateAll(cards => cards.map(card => card.dataset.itemId))).toEqual([...before].reverse());
   await page.reload();
   await expect(page.locator('#sort-direction')).toHaveAttribute('aria-pressed', 'true');
   await expect(page.locator('#loading-results')).toBeHidden();
   await expect.poll(() => page.locator('.result-card').evaluateAll(cards => cards.map(card => card.dataset.itemId))).toEqual([...before].reverse());
 });
