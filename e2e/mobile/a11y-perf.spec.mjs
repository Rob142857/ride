import { test, expect } from './fixtures.mjs';

// Guards for the uplift pass: zoom allowed, landmarks, and sized/lazy images.

test('planner viewport allows pinch zoom', async ({ page }) => {
  await page.goto('/index.html');
  const content = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
  expect(content).not.toMatch(/maximum-scale\s*=\s*1(\.0)?\b/i);
});

test.describe('about page', () => {
  test('has one main landmark and a document order that starts with the nav', async ({ page }) => {
    await page.goto('/about.html');
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.locator('main h1')).toHaveCount(1);
  });

  test('screenshots are WebP, sized and lazy below the fold', async ({ page }) => {
    await page.goto('/about.html');
    const imgs = await page.locator('main img').evaluateAll((els) =>
      els.map((i) => ({ src: i.getAttribute('src'), w: i.getAttribute('width'), h: i.getAttribute('height'), lazy: i.loading, alt: i.getAttribute('alt') })));
    expect(imgs.length).toBeGreaterThan(0);
    for (const i of imgs) {
      expect(i.src, i.src).toMatch(/\.webp$/);
      expect(Number(i.w) > 0 && Number(i.h) > 0, `${i.src} needs width/height`).toBe(true);
      expect(i.alt, `${i.src} needs alt text`).toBeTruthy();
    }
    expect(imgs.filter((i) => i.lazy === 'lazy').length).toBe(imgs.length - 1);
  });

  test('muted text and footer links meet 4.5:1 contrast', async ({ page }) => {
    await page.goto('/about.html');
    const ratio = await page.evaluate(() => {
      const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
      const fg = rgb(getComputedStyle(document.querySelector('.footer-links a')).color);
      const bg = rgb(getComputedStyle(document.body).backgroundColor);
      const a = getComputedStyle(document.querySelector('.footer-links a')).color.match(/[\d.]+/g)[3];
      const alpha = a === undefined ? 1 : Number(a);
      const mixed = fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
      const [hi, lo] = [lum(mixed), lum(bg)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
