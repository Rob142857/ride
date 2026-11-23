/**
 * Sign-in trust rules: Microsoft is locked to one tenant, and only
 * provider-verified emails may sign in (they can link to an existing account).
 */
const assert = require('node:assert/strict');

(async () => {
  const { PROVIDERS } = await import('../api/auth.js');
  const ms = PROVIDERS.microsoft;
  assert.ok(!ms.authUrl.includes('/common/'), 'Microsoft authorize must not use /common');
  assert.ok(!ms.tokenUrl.includes('/common/'), 'Microsoft token must not use /common');
  assert.ok(!ms.authUrl.includes('/organizations/') && !ms.authUrl.includes('/consumers/'));
  assert.match(ms.authUrl, /microsoftonline\.com\/[0-9a-f-]{36}\//);
  assert.match(ms.tokenUrl, /microsoftonline\.com\/[0-9a-f-]{36}\//);
  assert.equal(PROVIDERS.google.parseUser({ email: 'a@b.c', verified_email: false, id: '1' }).email_verified, false);
  assert.equal(PROVIDERS.google.parseUser({ email: 'a@b.c', id: '1' }).email_verified, false);
  assert.equal(PROVIDERS.google.parseUser({ email: 'a@b.c', verified_email: true, id: '1' }).email_verified, true);
  console.log('auth-verified-test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
