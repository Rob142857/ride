# Cloudflare Deployment Guide

Repository: `https://github.com/Rob142857/ride`

Primary production domain: `https://ride.incitat.io`

## Prerequisites

1. Install Wrangler CLI:

```bash
npm install -g wrangler
```

2. Authenticate with Cloudflare:

```bash
wrangler login
```

## Runtime Surfaces

- Pages static assets come from `public/`
- Worker entrypoint is `_worker.js`, which re-exports `api/worker.js`
- Worker + Pages routes are configured in `wrangler.toml`
- Workspace scaffold exists under `apps/web`, `apps/worker`, and `packages/sdk` for incremental migration without runtime changes.

## Required Bindings

These binding names must match the code in `api/`:

- `RIDE_TRIP_PLANNER_DB` (D1)
- `RIDE_TRIP_PLANNER_SESSIONS` (KV)
- `RIDE_TRIP_PLANNER_ATTACHMENTS` (R2)

`wrangler.toml` is the source of truth for production names and IDs.

For open-source forks, start from `wrangler.template.toml` and replace placeholders with your own Cloudflare IDs.
You can keep local overrides in `wrangler.local.toml` or `wrangler.private.toml` (both are gitignored).

## Initial Provisioning

### 1. Create D1 database

```bash
npm run db:create
```

Then set `database_id` in `wrangler.toml` under `[[d1_databases]]`.

### 2. Create KV namespace

```bash
npm run kv:create
```

Then set `id` in `wrangler.toml` under `[[kv_namespaces]]`.

### 3. Create R2 bucket

```bash
wrangler r2 bucket create ride-attachments
```

### 4. Apply schema/migrations

```bash
npm run db:migrate
```

## OAuth Setup

Configure provider redirect URIs exactly as follows:

- Google: `https://ride.incitat.io/api/auth/callback/google`
- Microsoft: `https://ride.incitat.io/api/auth/callback/microsoft`

Set secrets in Cloudflare:

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put MICROSOFT_CLIENT_ID
wrangler secret put MICROSOFT_CLIENT_SECRET
```

Optional places search key:

```bash
wrangler secret put GOOGLE_PLACES_API_KEY
```

## Deploy

```bash
npm run deploy
```

This will:

1. bump `BUILD_ID` in `api/worker.js`
2. run `wrangler deploy`

Service worker clients detect the new build through `/api/_build`.

## Share URL Behavior

- Canonical public URL: `https://ride.incitat.io/<shortCode>`
- Legacy paths `/t/<shortCode>` and `/trip/<shortCode>` redirect to canonical form

## Local Cloud Test

```bash
npm run dev:remote
```

## Troubleshooting

### OAuth callback errors

Double-check exact callback URLs in Google/Azure app registrations.

### Database mismatch

Verify tables exist:

```bash
wrangler d1 execute ride-db --command "SELECT name FROM sqlite_master WHERE type='table'"
```

### KV/session issues

Verify KV namespace binding IDs in `wrangler.toml` and inspect Worker logs.

### R2 attachment issues

```bash
wrangler r2 bucket list
wrangler r2 object list ride-attachments
```
