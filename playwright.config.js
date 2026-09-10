import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:8000/cmg-viewer/', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop-webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'node scripts/python.mjs scripts/build_browser_fixture.py && node scripts/python.mjs scripts/serve.py --dist tmp/browser-site --port 8000',
    url: 'http://127.0.0.1:8000/cmg-viewer/', reuseExistingServer: false,
  },
});
