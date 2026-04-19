# Ride

Open-source trip planning PWA with waypoints, route guidance, trip journals, photo attachments, and public share links.

Public repository: `https://github.com/Rob142857/ride`

## Stack

- **Frontend:** Vanilla JS PWA in `public/` — no build step, no framework
- **Maps:** [Leaflet](https://leafletjs.com) with [CARTO Voyager](https://carto.com/) raster tiles ([OpenStreetMap](https://www.openstreetmap.org) data)
- **Routing:** Self-hosted [OSRM](https://project-osrm.org) on Azure Linux VM (Docker) via Cloudflare Tunnel — see `docs/osrm-azure.md`
- **Place search:** Google Places API (proxied through the Worker)
- **Hosting:** Cloudflare Workers with static assets from `public/`
- **API:** Worker modules in `api/` — vanilla JS with route handlers
- **Storage:** Cloudflare D1 (data), KV (sessions), R2 (attachments)
- **Auth:** OAuth — Google and Microsoft

## Project Structure

```
ride/
├── api/                    Cloudflare Worker API
│   ├── worker.js           Worker entrypoint (fetch handler, routing)
│   ├── router.js           Route matching
│   ├── auth.js             OAuth flows + session management
│   ├── trips.js            Trip CRUD + route data
│   ├── waypoints.js        Waypoint CRUD
│   ├── journal.js          Journal entry CRUD
│   ├── attachments.js      R2 file upload/download
│   ├── places.js           Google Places proxy
│   ├── share.js            Public share link generation
│   ├── account.js          Account/profile endpoints
│   ├── handler-utils.js    Shared request helpers
│   ├── utils.js            Misc utilities
│   ├── schema.sql          D1 schema (v1)
│   ├── schema_v2.sql       D1 schema (v2)
│   └── migrations/         Incremental SQL migrations
├── public/                 Static frontend (served by Cloudflare)
│   ├── index.html          Main app shell
│   ├── trip.html           Public shared trip viewer
│   ├── about.html          About page
│   ├── admin.html          Admin panel
│   ├── sw.js               Service worker (build-aware caching)
│   ├── manifest.json       PWA manifest
│   ├── css/
│   │   ├── app.css         Main styles
│   │   ├── global.css      Reset / base
│   │   └── ride-mode.css   Navigation mode overlay
│   ├── js/
│   │   ├── api.js          API client + response normalizers
│   │   ├── app-core.js     App singleton (init, auth, trip normalize)
│   │   ├── auth-controller.js  OAuth UI + token handling
│   │   ├── trip-controller.js  Trip list, load, create, delete, sync
│   │   ├── waypoint-controller.js  Waypoint add/edit/delete/reorder
│   │   ├── journal-controller.js   Journal + route save
│   │   ├── ride-controller.js  GPS navigation mode
│   │   ├── map.js          Leaflet map + OSRM routing
│   │   ├── map-ride.js     Navigation HUD overlay
│   │   ├── ui.js           Core DOM (modals, nav, forms, toast, stats)
│   │   ├── ui-renderers.js Waypoint/journal list rendering
│   │   ├── ui-place-search.js  Place search autocomplete
│   │   ├── trip-details.js Trip details/settings modal
│   │   ├── trip.js         Trip data model helpers
│   │   ├── export-import.js  GPX/JSON export + import
│   │   ├── share.js        Share page logic
│   │   ├── storage.js      localStorage wrapper
│   │   └── utils.js        Format helpers (distance, duration, etc.)
│   ├── icons/              PWA icons (SVG + PNG)
│   └── images/             Product screenshots
├── packages/sdk/           @ride/sdk — API client library (WIP)
├── docs/                   Architecture and ops documentation
├── infra/                  OSRM Docker setup + health checks
├── scripts/
│   ├── deploy.js           Bump BUILD_ID + wrangler deploy
│   ├── generate-icons.js   SVG → PNG icon generation
│   └── regen-share.js      Regenerate share short codes
├── wrangler.toml           Cloudflare deploy config (production)
├── wrangler.template.toml  Template for new environments/forks
└── package.json            Root package (devDependencies only)
```

## Local Development

Requirements: Node 18+, Wrangler CLI, Cloudflare account.

```bash
npm install
npm run db:migrate
npm run dev:remote
```

Static preview without Worker API:

```bash
npm start    # serves public/ on :3000
```

## Deploy

```bash
npm run deploy    # bumps BUILD_ID, runs wrangler deploy
```

Or manually: `npx wrangler deploy`

Detailed setup: `DEPLOY.md`. For new environments, copy `wrangler.template.toml`.

## Public Share URLs

- Canonical short URL: `https://ride.incitat.io/<shortCode>`
- Legacy redirects supported: `/t/<shortCode>` and `/trip/<shortCode>`

## Open Source Boundary Guidance

If you want public code with safer operational separation, keep this repository as product source and move sensitive operations material to a private companion repository, for example:

- Public repo (`ride`): app code, Worker code, schema, tests, docs, non-secret defaults
- Private repo (`ride-ops-private`): production runbooks, account IDs, cost dashboards, incident notes, environment-specific automation

This gives you open collaboration without exposing operational internals.

More detailed guidance: `docs/open-source-separation.md`
Workspace migration guidance: `docs/workspace-migration.md`

## License

GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).
