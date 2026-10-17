import { test, expect, openTrip, openPlaceSearch, showView, TEST_GEO } from './fixtures.mjs';

test.describe('geolocation', () => {
  test('Center on my location moves the map to the device position', async ({ page }) => {
    await openTrip(page);
    await page.locator('#locateBtn').click();
    await expect.poll(() => page.evaluate(() => {
      // MapManager is a top-level const in a classic script, not a window property.
      // eslint-disable-next-line no-undef
      const c = MapManager.map?.getCenter();
      return c ? [Number(c.lat.toFixed(2)), Number(c.lng.toFixed(2))] : null;
    })).toEqual([TEST_GEO.latitude, TEST_GEO.longitude]);
  });

  test('Use current location biases place search to the device position', async ({ page, apiCalls }) => {
    await openPlaceSearch(page);
    await page.locator('#placeUseCurrentLocation').click();
    await expect(page.locator('#placeSearchStatus')).toContainText('Location set');
    await page.locator('#placeSearchInput').fill('fuel');
    await page.locator('#placeSearchSubmit').click();
    await expect(page.locator('#placeSearchResults .place-result').first()).toBeVisible();
    const search = apiCalls.findLast(call => call.path === '/places/search');
    const params = new URLSearchParams(search.search);
    expect(Number(params.get('lat'))).toBeCloseTo(TEST_GEO.latitude, 4);
    expect(Number(params.get('lng'))).toBeCloseTo(TEST_GEO.longitude, 4);
  });

  test.describe('when location is denied', () => {
    test.use({ permissions: [] });
    test('Center on my location says so', async ({ page, context }) => {
      await context.clearPermissions();
      await openTrip(page);
      await page.locator('#locateBtn').click();
      await expect(page.getByText(/Location permission denied|Unable to get your location/)).toBeVisible({ timeout: 15_000 });
    });
  });
});

test.describe('time zone', () => {
  // The invented journal entry was written 3 hours before the frozen clock:
  // 2026-10-17T20:00Z = 07:00 AEDT Sydney = 04:00 AWST Perth.
  test('journal times follow the device clock (Sydney)', async ({ page }) => {
    await openTrip(page);
    await showView(page, 'journal');
    await expect(page.locator('.journal-date').first()).toHaveText(/07:00\s*am/i);
  });

  test.describe('on a Perth phone', () => {
    test.use({ timezoneId: 'Australia/Perth' });
    test('journal times move three hours back', async ({ page }) => {
      await openTrip(page);
      await showView(page, 'journal');
      await expect(page.locator('.journal-date').first()).toHaveText(/04:00\s*am/i);
    });
  });
});
