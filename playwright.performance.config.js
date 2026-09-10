import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/performance', workers: 1, retries: 0, timeout: 180000,
  reporter: [['list'], ['json', { outputFile: 'performance-results/tests.json' }]],
  use: { baseURL: 'https://alchemiesofscent.github.io/cmg-viewer/' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-shaped', use: { ...devices['Pixel 7'] } },
  ],
});
