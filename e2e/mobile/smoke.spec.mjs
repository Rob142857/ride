import { test, expect, openTrip, showView, horizontalOverflow, smallTapTargets } from './fixtures.mjs';

const VIEWS = ['map', 'waypoints', 'journal', 'itinerary', 'trips'];
const STATIC_PAGES = ['/about.html', '/privacy.html', '/terms.html', '/deletion.html'];

test.describe('main pages load with no console errors', () => {
  test('planner with the invented trip, every bottom-nav view', async ({ page, consoleErrors }) => {
    await openTrip(page);
    for (const view of VIEWS) await showView(page, view);
    await page.waitForLoadState('networkidle');
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });

  for (const path of STATIC_PAGES) {
    test(`${path}`, async ({ page, consoleErrors }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
    });
  }

  test.describe('signed out', () => {
    test.use({ signedIn: false });
    test('shows the sign-in gate', async ({ page, consoleErrors }) => {
      await page.goto('/');
      await expect(page.locator('#authGate')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
    });
  });
});

test.describe('no sideways scroll on narrow phones', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone widths only');

  for (const width of [360, 375]) {
    test(`planner views at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: page.viewportSize().height });
      await openTrip(page);
      const offenders = [];
      for (const view of VIEWS) {
        await showView(page, view);
        await page.waitForTimeout(150);
        const over = await horizontalOverflow(page);
        if (over > 0) offenders.push(`${view} (+${over}px)`);
      }
      expect(offenders).toEqual([]);
    });

    test(`static pages at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: page.viewportSize().height });
      const offenders = [];
      for (const path of STATIC_PAGES) {
        await page.goto(path);
        const over = await horizontalOverflow(page);
        if (over > 0) offenders.push(`${path} (+${over}px)`);
      }
      expect(offenders).toEqual([]);
    });
  }
});

test.describe('tap targets', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch layouts only');

  test('top bar, bottom nav and map controls are at least 44px', async ({ page }) => {
    await openTrip(page);
    const small = await smallTapTargets(page, '#topBar button, #bottomNav button, #locateBtn, #addWaypointBtn');
    expect(small, small.join('\n')).toEqual([]);
  });
});

test.describe('saving', () => {
  // Regression: a persistent 409 used to loop handleTripConflict -> refreshData
  // -> OSRM reroute -> saveRouteData -> PUT (~1,600 requests in 3 s). Now the
  // client fetches the latest trip once, pauses autosave and asks the rider.
  test('a refused save (409 conflict) does not retry in a tight loop', async ({ page, apiState }) => {
    apiState.failSaves = 409;
    let requests = 0;
    page.on('request', () => { requests += 1; });
    await page.goto('/?openTrip=e2e-trip-0001');
    await page.waitForTimeout(1000);
    requests = 0;
    await page.waitForTimeout(3000);
    expect(requests).toBeLessThan(30);
    await expect(page.locator('#tripConflictModal')).toBeVisible();
    await expect(page.locator('#tripConflictReload')).toBeVisible();
    await expect(page.locator('#tripConflictKeep')).toBeVisible();
  });
});
