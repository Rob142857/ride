import { test, expect, openTrip, showView, TRIP_ID, TRIP } from './fixtures.mjs';

// The "Install Ride" prompt used to sit on top of the Update-itinerary dialog
// (same z-index, later in the DOM) and take the Save tap. Dialogs now stack
// above it and it is hidden while any dialog is open. Invented data only.

const planningFile = () => Buffer.from(JSON.stringify({
  rideTripId: TRIP_ID,
  itinerary: {
    version: 1, startDate: '2026-11-02',
    stops: TRIP.waypoints.map((wp, index) => ({
      id: `stop-${wp.id}`, waypointId: wp.id, name: `Invented stop ${index + 1}`,
      minNights: 0, plannedNights: index === TRIP.waypoints.length - 1 ? 0 : 1, maxNights: 3,
    })),
  },
}));

async function showInstallPrompt(page) {
  // What Chrome does when Ride is installable; the page shows its banner after 2 s.
  await page.evaluate(() => {
    try { localStorage.removeItem('ride_install_dismissed'); } catch { /* storage blocked */ }
    const event = new window.Event('beforeinstallprompt', { cancelable: true });
    event.prompt = () => {};
    event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(event);
  });
}

test('install prompt never covers the Update-itinerary dialog', async ({ page, apiCalls }) => {
  await openTrip(page);
  await showView(page, 'itinerary');
  await showInstallPrompt(page);
  const banner = page.locator('#installBanner');
  await expect(banner).toBeVisible({ timeout: 5000 });

  await page.locator('#itineraryUpdateFile').setInputFiles({ name: 'planning.json', mimeType: 'application/json', buffer: planningFile() });
  const dialog = page.locator('#itineraryPreviewModal');
  await expect(dialog).toBeVisible();
  await expect(banner).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/modal-open/);

  // Even if something forced the banner back on, dialogs stack above it.
  const [bannerZ, dialogZ] = await page.evaluate(() => ['#installBanner', '#itineraryPreviewModal']
    .map(selector => Number(getComputedStyle(document.querySelector(selector)).zIndex)));
  expect(bannerZ).toBeLessThan(dialogZ);

  // Save is the element under the finger, and the tap reaches it.
  const save = page.locator('#itineraryPreviewApply');
  await expect(save).toBeEnabled();
  const onTop = await save.evaluate(el => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el === hit || el.contains(hit);
  });
  expect(onTop).toBe(true);
  await save.click();
  await expect(dialog).toBeHidden();
  expect(apiCalls.some(call => call.method === 'PUT' && call.path === `/trips/${TRIP_ID}`)).toBe(true);

  // Back once no dialog is open.
  await expect(page.locator('body')).not.toHaveClass(/modal-open/);
  await expect(banner).toBeVisible();
});

test('install prompt also hides for a dialog opened without UI.openModal', async ({ page }) => {
  await openTrip(page);
  await showInstallPrompt(page);
  const banner = page.locator('#installBanner');
  await expect(banner).toBeVisible({ timeout: 5000 });
  await page.evaluate(() => document.getElementById('itineraryPreviewModal').classList.remove('hidden'));
  await expect(banner).toBeHidden();
  await page.evaluate(() => document.getElementById('itineraryPreviewModal').classList.add('hidden'));
  await expect(banner).toBeVisible();
});
