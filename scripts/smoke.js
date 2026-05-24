#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://ride.incitat.io';
const DEFAULT_OSRM_URL = 'https://maps.incitat.io/route/v1/driving/151.2093,-33.8688;151.2153,-33.8568?overview=false';

const baseUrl = (process.env.RIDE_SMOKE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
const shortCode = process.env.RIDE_SMOKE_SHORT_CODE || '';
const osrmUrl = process.env.RIDE_SMOKE_OSRM_URL || DEFAULT_OSRM_URL;
const slowMs = Number(process.env.RIDE_SMOKE_SLOW_MS || 1500);
const hardLimitMs = Number(process.env.RIDE_SMOKE_HARD_LIMIT_MS || 10000);

async function timedFetch(label, url, options = {}) {
  const started = performance.now();
  const response = await fetch(url, {
    ...options,
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache',
      ...(options.headers || {}),
    },
  });
  const elapsedMs = Math.round(performance.now() - started);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = text;
  }

  return { label, url, status: response.status, ok: response.ok, elapsedMs, body };
}

function assertOk(result) {
  if (!result.ok) {
    throw new Error(`${result.label} failed with HTTP ${result.status}`);
  }
  if (result.elapsedMs > hardLimitMs) {
    throw new Error(`${result.label} exceeded hard latency limit: ${result.elapsedMs}ms`);
  }
}

function printResult(result) {
  const speed = result.elapsedMs > slowMs ? 'slow' : 'ok';
  console.log(`${result.label.padEnd(18)} ${String(result.status).padEnd(4)} ${String(result.elapsedMs).padStart(5)}ms ${speed}`);
}

async function run() {
  const checks = [
    ['home', `${baseUrl}/`],
    ['trip-shell', `${baseUrl}/trip`],
    ['build-endpoint', `${baseUrl}/api/_build`],
    ['deploy-endpoint', `${baseUrl}/api/_deploy`],
  ];

  if (shortCode) {
    checks.push(['share-api', `${baseUrl}/api/s/${shortCode}`]);
    checks.push(['share-page', `${baseUrl}/${shortCode}`]);
  }

  console.log(`Smoke target: ${baseUrl}`);
  console.log(`Slow threshold: ${slowMs}ms; hard limit: ${hardLimitMs}ms`);
  console.log('');

  const results = [];
  for (const [label, url] of checks) {
    const result = await timedFetch(label, url);
    assertOk(result);
    printResult(result);
    results.push(result);
  }

  const build = results.find(result => result.label === 'build-endpoint')?.body;
  if (!build?.build) {
    throw new Error('build-endpoint did not return a build id');
  }

  const osrm = await timedFetch('osrm-route', osrmUrl);
  assertOk(osrm);
  const route = osrm.body?.routes?.[0];
  if (osrm.body?.code !== 'Ok' || !route || route.distance <= 0 || route.duration <= 0) {
    throw new Error('osrm-route did not return a usable route with distance and duration');
  }
  printResult(osrm);
  console.log(`osrm-route detail  ${Math.round(route.distance)}m ${Math.round(route.duration)}s`);

  console.log('');
  console.log(`Smoke passed. Build ${build.build}`);
}

run().catch(error => {
  console.error('');
  console.error(`Smoke failed: ${error.message}`);
  process.exit(1);
});
