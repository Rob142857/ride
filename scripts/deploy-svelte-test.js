#!/usr/bin/env node
/**
 * deploy-svelte-test.js — build the Svelte frontend and deploy it as an isolated worker.
 *
 * Usage: node scripts/deploy-svelte-test.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKER_PATH = path.join(ROOT, 'api', 'worker.js');
const WEB_PATH = path.join(ROOT, 'apps', 'web');
const WRANGLER_CONFIG = path.join(ROOT, 'wrangler.svelte-test.toml');

let src = fs.readFileSync(WORKER_PATH, 'utf8');
const match = src.match(/const BUILD_ID\s*=\s*'([^']+)'/);
const oldId = match ? match[1] : '';

const today = new Date().toISOString().slice(0, 10);
let counter = 1;

if (oldId.startsWith(today + 'T')) {
  const prev = parseInt(oldId.split('T')[1], 10);
  if (!Number.isNaN(prev)) counter = prev + 1;
}

const newId = `${today}T${String(counter).padStart(2, '0')}`;
src = src.replace(/const BUILD_ID\s*=\s*'[^']*'/, `const BUILD_ID = '${newId}'`);
fs.writeFileSync(WORKER_PATH, src, 'utf8');

console.log(`\n  BUILD_ID: ${oldId || '(none)'} -> ${newId}\n`);
console.log('  Building Svelte frontend from ./apps/web...\n');
execSync('npm run build', { stdio: 'inherit', cwd: WEB_PATH });

console.log('\n  Deploying isolated Svelte preview worker...\n');
execSync(`npx wrangler deploy --config "${WRANGLER_CONFIG}"`, { stdio: 'inherit', cwd: ROOT });