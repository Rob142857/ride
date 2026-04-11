# Ride — Workspace Instructions

## Project Overview

Ride is an **open-source trip planning PWA** — waypoints, route guidance, trip journals, photo attachments, and public share links. Monorepo with a SvelteKit 2 frontend, Cloudflare Workers API, and D1/KV/R2 storage.

**Key resources**: [README](./README.md) · [Deploy Guide](./DEPLOY.md) · [API Schema](./api/schema_v2.sql) · [License](./LICENSE)

## Architecture

| Component          | Path              | Purpose                                           |
| ------------------ | ----------------- | ------------------------------------------------- |
| `apps/web/`        | SvelteKit 2 app   | Svelte 5 runes, adapter-static SPA, Leaflet maps  |
| `api/`             | Worker API        | Auth, trips, waypoints, journal, attachments, share |
| `packages/sdk/`    | SDK scaffold      | Future `@ride/sdk` client package                  |
| `public/`          | Legacy static app | Original vanilla JS PWA (being migrated)           |
| `scripts/`         | Tooling           | deploy.js (auto-bump BUILD_ID + wrangler deploy)  |
| `infra/`           | OSRM infra        | Docker + Cloudflare Tunnel for self-hosted routing |
| `docs/`            | Documentation     | Architecture, billing, migration guides            |

## Tech Stack

- **Frontend**: SvelteKit 2.x, Svelte 5 (runes: `$state`, `$derived`, `$props`, `$effect`), adapter-static SPA
- **Maps**: Leaflet 1.9.4 via CDN, CARTO Voyager tiles, OSRM routing
- **API**: Cloudflare Workers (Wrangler 4.x), ES2022 modules
- **Storage**: Cloudflare D1 (relational), KV (sessions), R2 (attachments)
- **Auth**: OAuth — Google and Microsoft providers
- **Build**: Vite 6, TypeScript 5.7
- **Deploy**: `npm run deploy` → auto-bump BUILD_ID → vite build → wrangler deploy
- **Domain**: ride.incitat.io

## Build & Deploy Commands

```bash
npm install --legacy-peer-deps   # Workspace peer dep resolution
npm run deploy                   # Full deploy (build + wrangler deploy)
cd apps/web && npx vite build    # Frontend build only
cd apps/web && npx vite dev      # Local dev with API proxy
npx wrangler deploy              # Worker deploy only
npm run db:migrate               # Apply D1 schema
```

## Code Conventions

- **TypeScript**: Strict mode in `apps/web/`, ES2022 target
- **Svelte 5**: Use runes (`$state`, `$derived`, `$props`, `$effect`), NOT legacy reactive syntax (`$:`, `export let`)
- **Stores**: Svelte 4 `writable`/`derived` stores in `$stores/` — components access via `$storeName` auto-subscription
- **API client**: Typed functions in `$lib/api.ts` with snake_case→camelCase normalization
- **Worker API**: Plain JS modules in `api/`, router pattern with middleware (requireAuth, optionalAuth)
- **Imports**: ESNext module syntax, no CommonJS in app code. Worker API uses CommonJS-style for Wrangler compat.
- **CSS**: Custom properties (design tokens) in `app.css`, component-scoped `<style>` blocks
- **Naming**: camelCase for JS/TS, kebab-case for CSS classes and file names

## Project Structure — SvelteKit App

```
apps/web/src/
├── app.html          # Shell HTML (Leaflet CDN, fonts, meta)
├── app.css           # Global design tokens and base styles
├── lib/
│   ├── api.ts        # Typed API client with normalization
│   ├── types.ts      # All TypeScript interfaces
│   ├── utils.ts      # Shared utilities (haversine, format, uuid)
│   ├── stores/       # Svelte stores (auth, trip, ui, map)
│   └── components/   # 12 Svelte components
├── routes/
│   ├── +layout.ts    # ssr=false, prerender=false
│   ├── +layout.svelte # App shell (auth check, gates, nav)
│   └── +page.svelte  # Tabbed views (map/waypoints/journal/trips)
```

## Worker Routing

The Worker (`api/worker.js`) handles:
1. `/api/*` → API router (auth, CRUD, share, admin)
2. `/<6-char alphanumeric>` → Short-code trip share pages (OG tag injection)
3. Everything else → `env.ASSETS.fetch()` (SvelteKit static build)

HTML responses get security headers (CSP, HSTS, X-Frame-Options).

## Security Principles

- All user input validated at API boundaries
- No secrets in code — use Wrangler secrets or KV
- CSP enforced on all HTML responses
- OAuth session cookies with httpOnly, secure, sameSite
- R2 attachments access-controlled via Worker (no direct public bucket URLs)
- AGPL-3.0 license — all modifications must be shared

## MCP Servers (Model Context Protocol)

This workspace has MCP servers configured in `.vscode/mcp.json`:

| Server                  | Type         | Purpose                                              |
| ----------------------- | ------------ | ---------------------------------------------------- |
| **Cloudflare API**      | Remote/OAuth | Full Cloudflare API (Workers, D1, KV, R2, DNS)      |
| **Cloudflare Docs**     | Remote       | Up-to-date Cloudflare documentation search           |
| **Cloudflare Bindings** | Remote/OAuth | Build Workers with storage, AI, compute primitives   |
| **Cloudflare Builds**   | Remote/OAuth | Workers build insights and management                |
| **Cloudflare Observability** | Remote/OAuth | Logs, analytics, debugging                      |
| **GitHub**              | Remote/OAuth | Repo management, issues, PRs, CI/CD                 |
| **Sequential Thinking** | Local/npx    | Structured reasoning for complex refactors           |

When performing tasks, **prefer MCP tools over manual lookups** — e.g. use Cloudflare MCP to check D1 state or Worker logs rather than guessing, use GitHub MCP to check CI status.

## Key Files Reference

| File | What it does |
| --- | --- |
| `wrangler.toml` | Cloudflare deploy config (D1, KV, R2 bindings, assets dir) |
| `api/worker.js` | Main Worker entrypoint with BUILD_ID and all routing |
| `api/router.js` | Lightweight request router |
| `api/utils.js` | CORS, auth middleware, JSON helpers |
| `apps/web/svelte.config.js` | SvelteKit config (adapter-static, path aliases) |
| `apps/web/src/app.html` | HTML shell with CDN deps |
| `scripts/deploy.js` | Auto-bump BUILD_ID + build + wrangler deploy |
| `apps/web/static/sw.js` | Service worker (build-aware caching, ride-v7) |
