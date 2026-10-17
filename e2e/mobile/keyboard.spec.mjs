import { test, expect, openPlaceSearch, openVirtualKeyboard, isInViewport } from './fixtures.mjs';

// Place search is Ride's search box. The on-screen keyboard is approximated by
// shrinking the viewport to 55% of its height once the input has focus.

test.describe('place search with the on-screen keyboard open', () => {
  test.skip(({ isMobile }) => !isMobile, 'no on-screen keyboard on desktop');

  test.beforeEach(async ({ page }) => {
    await openPlaceSearch(page);
    await openVirtualKeyboard(page);
    await page.locator('#placeSearchInput').fill('bakery');
    await page.locator('#placeSearchInput').press('Enter');
    await expect(page.locator('#placeSearchResults .place-result').first()).toBeAttached();
  });

  test('the search input stays visible', async ({ page }) => {
    expect(await isInViewport(page, '#placeSearchInput')).toBe(true);
  });

  test('first result is visible or reachable by scrolling the modal', async ({ page }) => {
    const first = page.locator('#placeSearchResults .place-result').first();
    if (!(await isInViewport(page, '#placeSearchResults .place-result'))) await first.scrollIntoViewIfNeeded();
    expect(await isInViewport(page, '#placeSearchResults .place-result')).toBe(true);
    await expect(first.locator('[data-use-place]')).toBeVisible();
  });
});
