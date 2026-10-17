import { test, expect, openTrip, showView } from './fixtures.mjs';

// Per-device visual baselines: invented trip, blank map tiles, straight-line
// routes, frozen clock. Refresh after an intended UI change:
// `npm run test:mobile:update`.

const shot = (page, name) => expect(page).toHaveScreenshot(name, { mask: [page.locator('.toast, #toast, .toast-container')] });

for (const view of ['map', 'waypoints', 'journal', 'itinerary', 'trips']) {
  test(`${view} view matches baseline`, async ({ page }) => {
    await openTrip(page);
    await showView(page, view);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    await shot(page, `${view}.png`);
  });
}

test('about page matches baseline', async ({ page }) => {
  await page.goto('/about.html');
  await page.waitForLoadState('networkidle');
  await shot(page, 'about.png');
});

test.describe('signed out', () => {
  test.use({ signedIn: false });
  test('sign-in gate matches baseline', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#authGate')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await shot(page, 'signed-out.png');
  });
});
