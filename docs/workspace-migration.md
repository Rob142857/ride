# Workspace Migration Scaffold

This repository now includes a non-breaking scaffold for deeper compartmentalization:

- `apps/web`
- `apps/worker`
- `packages/sdk`

## Current Runtime (Unchanged)

- Active web assets: `public/`
- Active worker runtime source: `api/worker.js`
- Active deploy config: `wrangler.toml`

## New Scaffold Roles

- `apps/web`: target home for future web source migration
- `apps/worker`: compatibility workspace for future worker module migration
- `packages/sdk`: shared API client package (`@ride/sdk`) for integrators and eventual app reuse

## Recommended Migration Order

1. Adopt `@ride/sdk` in new integration code first.
2. Migrate non-critical web modules from `public/js` into `apps/web` in small batches.
3. Migrate worker route modules from `api/` into `apps/worker` with re-export shims.
4. Flip runtime paths (`wrangler.toml` assets/main) only after parity checks.

## Safety Rules

- Keep old paths as compatibility shims during migration.
- Do not change Cloudflare binding names.
- Validate smoke flows after each batch: auth, trip CRUD, share link, attachment upload.
