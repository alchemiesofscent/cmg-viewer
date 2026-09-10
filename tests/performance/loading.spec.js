import { test, expect } from '@playwright/test';

// Observational live benchmark: deliberately separate from release correctness gates.
for (const volume of ['cmg_01_01', 'cmg_05_02_01']) {
  test(`${volume}: cold and warm reading`, async ({ page, context }, testInfo) => {
    const session = await context.newCDPSession(page);
    await session.send('Network.enable');
    if (testInfo.project.name === 'mobile-shaped') {
      await session.send('Network.emulateNetworkConditions', {
        offline: false, latency: 100, downloadThroughput: 1_600_000 / 8,
        uploadThroughput: 750_000 / 8,
      });
    }
    const samples = [];
    try {
      for (let repeat = 0; repeat < 3; repeat++) {
        for (const cache of ['cold', 'warm']) {
          if (cache === 'cold') await session.send('Network.clearBrowserCache');
          await page.goto(`viewer/${volume}/?pn=2&view=single`, { waitUntil: 'domcontentloaded' });
          await expect.poll(async () => page.evaluate(() =>
            window.cmgLoadingTimings?.().some(entry => entry.name === 'first-sharp-page')
          ), { timeout: 75000 }).toBeTruthy();
          samples.push(await page.evaluate(({ cache, repeat }) => ({
            cache, repeat, timings: window.cmgLoadingTimings(),
            resources: performance.getEntriesByType('resource').filter(r => r.initiatorType === 'img').map(r => ({
              durationMs: Math.round(r.duration), transferBytes: r.transferSize,
              // Cross-origin bytes can be zero when Timing-Allow-Origin is absent.
            })),
            retainedDecodedPixelBytes: [...document.querySelectorAll('#continuous-reader img')]
              .reduce((sum, img) => sum + img.naturalWidth * img.naturalHeight * 4, 0),
          }), { cache, repeat }));
        }
      }
    } finally {
      await testInfo.attach('loading-samples', {
        body: JSON.stringify({ volume, profile: testInfo.project.name, samples }, null, 2),
        contentType: 'application/json',
      });
    }
  });
}
