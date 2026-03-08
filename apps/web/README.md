# @ride/web

Scaffold workspace for the web app.

Current production/runtime behavior is unchanged: Cloudflare Pages still serves static assets from root `public/`.

This workspace exists so web code can be migrated incrementally without breaking existing deploys.

## Migration Plan

1. Keep editing root `public/` for now.
2. Move files into `apps/web/` in small batches.
3. Flip `wrangler.toml [assets].directory` only after parity checks.
