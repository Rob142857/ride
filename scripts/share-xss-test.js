/**
 * Regression checks for the share-page XSS and upload fixes (23 Nov 2026).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const { cleanCaption, bytesMatchType, ATTACHMENT_TYPES } = await import('../api/attachments.js');
  assert.equal(cleanCaption('a"b\nc\u0000d'), 'a"b c d');
  assert.equal(cleanCaption('x'.repeat(500)).length, 300);
  assert.equal(cleanCaption(null), '');
  assert.ok(!('image/svg+xml' in ATTACHMENT_TYPES), 'SVG must not be allowed');
  assert.ok(!('text/html' in ATTACHMENT_TYPES), 'HTML must not be allowed');
  const t = require('node:fs').readFileSync('api/waypoints.js', 'utf8'); assert.ok(/'lodging', 'custom'/.test(t));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(bytesMatchType(png, 'image/png'), true);
  assert.equal(bytesMatchType(png, 'image/jpeg'), false);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>');
  assert.equal(bytesMatchType(svg, 'image/png'), false);

  const trip = fs.readFileSync('public/trip.html', 'utf8');
  assert.ok(!/onclick="openLightbox/.test(trip), 'no inline lightbox onclick');
  assert.match(trip, /replace\(\/"\/g, '&quot;'\)/, 'escapeHtml escapes double quotes');
  assert.match(trip, /escapeHtml\(wp\.type \|\| 'Stop'\)/, 'waypoint type escaped');

  const worker = fs.readFileSync('api/worker.js', 'utf8');
  assert.match(worker, /const image = escapeAttr\(/, 'og:image escaped');
  assert.ok(!/\$1\$\{(title|desc|image|pageUrl)\}\$2/.test(worker), 'replace uses functions, not $ patterns');
  const trips = fs.readFileSync('api/trips.js', 'utf8');
  assert.match(trips, /isOwnImageUrl\(body\.cover_image_url\)/, 'cover url validated');
  const utils = fs.readFileSync('api/utils.js', 'utf8');
  assert.match(utils, /Cross-origin write refused/, 'requireAuth has CSRF guard');
  console.log('share-xss-test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
