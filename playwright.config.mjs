import { defineConfig, devices } from '@playwright/test';

// Mobile emulation suite. Run with `npm run test:mobile`; refresh baselines
// with `npm run test:mobile:update`. Agent guide (local to Rob's PC):
// C:\Users\RobertEvans\Agents\shared\mobile-testing.md
//
// Serves public/ from a zero-dependency static server on 127.0.0.1. Every
// /api call is answered by stubs in e2e/mobile/fixtures.mjs with an invented
// user and trip; Leaflet comes from node_modules; map tiles are blank. Nothing
// reaches ride.incitat.io or any other host.

const PORT = 4319;

// An invented point in inland NSW. Not anyone's address.
const TEST_GEO = { latitude: -33.42, longitude: 149.58, accuracy: 20 };

const shared = {
  timezoneId: 'Australia/Sydney',
  locale: 'en-AU',
  geolocation: TEST_GEO,
  permissions: ['geolocation'],
  reducedMotion: 'reduce',
  serviceWorkers: 'block',
};

export default defineConfig({
  testDir: 'e2e/mobile',
  outputDir: 'test-results/mobile',
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{projectName}/{arg}{ext}',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 45_000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/mobile', open: 'never' }]],
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.25, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...shared,
  },
  projects: [
    { name: 'pixel-7', use: { ...devices['Pixel 7'], ...shared } },
    { name: 'galaxy-s24', use: { ...devices['Galaxy S24'], ...shared } },
    { name: 'iphone-14', use: { ...devices['iPhone 14'], ...shared } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], ...shared } },
  ],
  webServer: {
    command: `node e2e/mobile/serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
