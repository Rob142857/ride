/**
 * Sign-in return URL checks. Ride may send people back only to its own pages
 * or to Trip Companion (https://trip.incitat.io); everything else falls back
 * to '/'. Runs the pure helper and the real login route with an in-memory KV.
 */
const assert = require('node:assert/strict');

(async () => {
  const { sanitizeReturnUrl } = await import('../api/auth.js');
  const { default: worker } = await import('../api/worker.js');

  // Allowed: Trip Companion keeps its absolute URL.
  assert.equal(sanitizeReturnUrl('https://trip.incitat.io/'), 'https://trip.incitat.io/');
  assert.equal(sanitizeReturnUrl('https://trip.incitat.io/?tab=plan#today'), 'https://trip.incitat.io/?tab=plan#today');

  // Allowed: Ride's own URLs and paths become a path.
  assert.equal(sanitizeReturnUrl('https://ride.incitat.io/trip.html?id=1#map'), '/trip.html?id=1#map');
  assert.equal(sanitizeReturnUrl('/saved'), '/saved');
  assert.equal(sanitizeReturnUrl(null), '/');
  assert.equal(sanitizeReturnUrl(''), '/');

  // Rejected: anything else falls back to '/'.
  const rejected = [
    'https://evil.example',
    'https://evil.example/https://trip.incitat.io/',
    'https://trip.incitat.io.evil.example',
    'https://trip.incitat.io.evil.example/',
    '//evil.example',
    '//evil.example/path',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'https://trip.incitat.io@evil.example',
    'https://trip.incitat.io@evil.example/',
    'https://user:pass@trip.incitat.io/',
    'http://trip.incitat.io/',
    'https://trip.incitat.io:8443/',
    'https://sub.trip.incitat.io/',
    'https://ride.incitat.io.evil.example/',
    'data:text/html,hi',
    'https://[::1',
  ];
  for (const raw of rejected) {
    assert.equal(sanitizeReturnUrl(raw), '/', `should reject ${raw}`);
  }

  // Login route stores the sanitised return URL with the OAuth state.
  const kv = new Map();
  const env = {
    GOOGLE_CLIENT_ID: 'test-client-id',
    RIDE_TRIP_PLANNER_SESSIONS: {
      async get(key) { return kv.has(key) ? JSON.parse(kv.get(key)) : null; },
      async put(key, value) { kv.set(key, value); },
      async delete(key) { kv.delete(key); }
    }
  };
  const ctx = { waitUntil() {} };
  async function login(returnParam) {
    kv.clear();
    const qs = returnParam === undefined ? '' : `?return=${encodeURIComponent(returnParam)}`;
    const response = await worker.fetch(new Request(`https://ride.incitat.io/api/auth/login/google${qs}`), env, ctx);
    assert.equal(response.status, 302);
    assert.ok(response.headers.get('Location').startsWith('https://accounts.google.com/'));
    const stored = [...kv.entries()].filter(([k]) => k.startsWith('oauth_state_'));
    assert.equal(stored.length, 1);
    return JSON.parse(stored[0][1]).returnUrl;
  }
  assert.equal(await login('https://trip.incitat.io/'), 'https://trip.incitat.io/');
  assert.equal(await login('/trip.html'), '/trip.html');
  assert.equal(await login(undefined), '/');
  for (const raw of ['https://evil.example', 'https://trip.incitat.io.evil.example', '//evil.example',
    'javascript:alert(1)', 'https://trip.incitat.io@evil.example']) {
    assert.equal(await login(raw), '/', `login should reject ${raw}`);
  }

  console.log('auth-return-test: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
