# Ride

Open-source trip planning PWA with waypoints, route guidance, trip journals, photo attachments, and public share links.

Public repository: `https://github.com/Rob142857/ride`

## Stack

- **Frontend:** Vanilla JS PWA in `public/`, rendered with [Leaflet](https://leafletjs.com) maps
- **Map tiles:** [CARTO Voyager](https://carto.com/) raster tiles backed by [OpenStreetMap](https://www.openstreetmap.org) data
- **Routing:** Self-hosted [OSRM](https://project-osrm.org) instance on an Azure Linux VM (Docker), exposed via Cloudflare Tunnel — see `docs/osrm-azure.md`
- **Place search:** Google Places API (proxied through the Worker)
- **Hosting:** Cloudflare Pages + Worker entrypoint in `_worker.js`
- **API:** Worker modules in `api/` with route handlers
- **Storage:** Cloudflare D1 (data), KV (sessions), R2 (attachments)
- **Auth:** OAuth providers — Google and Microsoft

## Project Structure

```text
apps/web/        Scaffold workspace for web migration (runtime still uses root public/)
apps/worker/     Scaffold workspace for worker migration (compat re-export in src/worker.js)
packages/sdk/    Developer API client package scaffold (@ride/sdk)
api/             Current Worker API modules and SQL schema/migrations (active runtime)
public/          Current Pages/static app (active runtime)
docs/            Operational and architecture docs
infra/           OSRM-related infra helpers
scripts/         Deployment and maintenance scripts
wrangler.toml    Primary Cloudflare deploy config
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
npm start
```

## Deploy

`npm run deploy` auto-bumps `BUILD_ID` in `api/worker.js` and then runs `wrangler deploy`.

Detailed setup is in `DEPLOY.md`.

For new environments or forks, start from `wrangler.template.toml`.

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
