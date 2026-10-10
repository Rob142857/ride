# Ride Australia basemap operations

Ride serves Australian street maps from a downloadable Geofabrik Shortbread
MBTiles extract, rasterized by TileServer GL. The private planner and public
shared-trip viewer use the same Leaflet basemap module. The Ride software
maintenance workflow owns the application, renderer, existing VM, tunnel rule,
release verification and rollback together.

## Deployment

The existing Ubuntu host stores the service on durable disk at
`/srv/ride-tiles`. Temporary VM storage must not hold the archive. The service is
the `ride-tiles` Compose service, container `ride-australia-tiles`, with:

- Read-only `/srv/ride-tiles:/data` mount.
- Host binding `127.0.0.1:8082`, container port `8080`.
- Initial limits of 1 CPU and 2 GiB RAM; restart policy `unless-stopped`.
- JSON logs limited to three 10 MB files.
- Local data, glyphs and sprites; no runtime provider key or asset hotlinks.
- Disabled front page, static map endpoints and remote marker icons.
- Native vector zooms 0–14, server-rendered raster zooms through 19.
- 32-pixel rendering margin, cropped back to 256-pixel tiles; `maxSize: 320`.

The public raster URL is:

```text
https://maps.incitat.io/styles/ride-australia/{z}/{x}/{y}.png?v=2026-10-10-1
```

The tile rule in the existing locally managed Cloudflare Tunnel uses host
`maps.incitat.io`, path `^/(styles|data|fonts)/`, and service
`http://127.0.0.1:8082`. It must precede the existing same-host rule that sends routing
requests to the existing OSRM service on port `5000`. Preserve all other ingress
rules, credentials and the final catchall. No public VM port or new Azure
resource is required.

`prepare.py` prepares assets and receipts; it does not start containers or change
the tunnel. It expects `data/australia.mbtiles` beneath the supplied root:

```bash
python3 /srv/ride-tiles/prepare.py /srv/ride-tiles
docker compose -f /srv/ride-tiles/docker-compose.yml up -d ride-tiles
```

Only run preparation against a validated archive. The original download may
have the longer name `australia-shortbread-1.0.mbtiles`; reconcile the filename
without downloading the same archive again.

## Sources, versions and licenses

| Component | Version or source | License |
| --- | --- | --- |
| Australia data | [Geofabrik Australia Shortbread 1.0 archive](https://download.geofabrik.de/australia-oceania/australia-shortbread-1.0.mbtiles) | OpenStreetMap ODbL 1.0; [attribution and license](https://www.openstreetmap.org/copyright) |
| Style and sprites | VersaTiles style [v6.1.1](https://github.com/versatiles-org/versatiles-style/releases/tag/v6.1.1); `colorful/en.json`, sprite namespace `base` | [MIT](https://github.com/versatiles-org/versatiles-style/blob/v6.1.1/LICENSE.md) |
| Glyphs | VersaTiles fonts [v3.0.0](https://github.com/versatiles-org/versatiles-fonts/releases/tag/v3.0.0), `noto_sans.tar.gz`; `noto_sans_regular` and `noto_sans_bold` | Noto Sans SIL Open Font License 1.1 |
| Renderer | Official `maptiler/tileserver-gl:v5.6.0` full image | [TileServer GL BSD 2-Clause](https://github.com/maptiler/tileserver-gl/blob/v5.6.0/LICENSE.md) |

The Compose image is pinned to the multiarchitecture index digest:

```text
sha256:3a9ccdb24820b6814c8119bcc8a4376c39867cb0ffe69d62919ef898b90c2427
```

The verified amd64 manifest digest is:

```text
sha256:f5f954587478ca6be606f834fba1880b5ddd9c958132ded79a573bc1790a8bf0
```

The original 10 October 2026 source HEAD reported `2,833,620,992` bytes. The
Geofabrik download URL is mutable: each later update needs its own source
headers, byte count, validation and SHA256 receipt. A locally calculated SHA256
identifies the installed file; it is not an independently published upstream
checksum.

Preparation writes `source-receipt.json` with archive metadata and SHA256 hashes
of the downloaded style, sprite and font archives. Keep it with the deployment,
along with `STYLE-LICENSE.txt`, `FONT-LICENSE.txt`, the download validation
receipt, source headers and archive checksum. The generated style attributes
OpenStreetMap, Geofabrik and VersaTiles. It omits the upstream ESA WorldCover
attribution because this extract does not include that overlay.

## Application behavior

Online, owned tiles are selected when the map is at zoom 4 or higher, its
center lies within the conservative mainland Australia/Tasmania box
`[112, -44, 155, -9]`, and its entire viewport fits the verified archive bounds,
`[68.13342, -57.07106, 169.0016, -8.809565]` (longitude/latitude order). Owned
tile bounds also use that archive extent, so Australian route overviews and
their ocean margins remain on the owned map. Wider views and centers outside
the application box use interactive OpenStreetMap raster tiles. The
initial archive metadata reports native vector zooms 0–14. The rendered raster
TileJSON and Leaflet layer support zooms through 19: TileServer GL redraws the
zoom 14 vectors at the requested display zoom, preserving readable label sizes
instead of enlarging a zoom 14 PNG. Source metadata retains native zoom 14.
Recheck metadata and high-zoom rendering when replacing the archive.

A current owned-tile error switches to OpenStreetMap for a 60-second retry
window. Source selection runs after map movement and connection changes. When
the browser reports offline, an Australian view retains the owned source so
previously viewed tiles can be revisited. Successful owned PNG responses alone
enter the service worker's `ride-owned-tiles-v1` cache, capped at 800 tiles.
Redirects, error pages and non-PNG responses are excluded. This is a bounded
cache of viewed tiles, not a download of all Australian raster tiles.

The owned URL carries the stable tile revision `v=2026-10-10-1`. Bump the
revision in `public/js/basemaps.js` whenever data, style, glyphs or rendering
settings change, and use that revision during public verification. Both CDN
requests and service-worker cache keys retain the query, so draft or previous
rendering output is not reused for the new release.

The next prepared revision, `2026-10-10-2`, registers a second raster style,
`ride-australia-labels`, for labels above the route. It contains the exact same
48 symbol layers in the same order, with identical sources, glyphs, sprites,
filters, collision settings and text halos. All non-symbol layers and root
sky/fog are removed for transparent PNG output. The base style retains its
symbols, so its labels remain if the overlay is unavailable. Use PNG, because
JPEG cannot preserve the transparent backdrop. The labels endpoint uses the
same tile coordinates and revision query as the base endpoint:

```text
https://maps.incitat.io/styles/ride-australia-labels/{z}/{x}/{y}.png?v=2026-10-10-2
```

This revision also makes the existing motorway/trunk/primary face and casing
layers visible at their first available style zoom (5/6/8), instead of fading
from zero for another full zoom. For 256-pixel TileServer GL rasters these are
display zooms 6/7/9. Road data and symbol minimum zooms are unchanged; this does
not create country-overview roads or names absent from the archive.

External OSM and satellite requests use normal browser HTTP caching without
application-managed offline storage or prefetching. Routing remains network
only. Keep the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
requirements when changing fallback behavior; do not bulk-download public OSM
or CARTO raster endpoints. Attribution follows the active basemap.

The shared viewer exposes its content before Leaflet measures the map and caps
initial zoom at 19. Source selection waits for valid geometry, then recovers on
map movement. Same-origin page navigation uses fresh network HTML with an exact
cached-page fallback offline, followed by the application shell. The release
uses shell cache `ride-v10` while retaining the viewed owned-tile cache.

## Verification record

The hosting and application checks below were completed for the live release.
These records describe revision `2026-10-10-1` / build T05. The labels revision
requires fresh transparent-PNG, route-label, offline and resource verification
before its activation can be recorded as complete.

| Evidence | Result |
| --- | --- |
| Installed archive SHA256, data timestamp and source-header receipt | SHA256 `45a603c17e2f960fad790803e40a36ede3d4b6a1c8764eeb61d5e8d551eaabd4`; source Last-Modified `Sat, 10 Oct 2026 02:47:43 GMT`; source headers retained with deployment |
| Final archive byte count and SQLite integrity | `2,833,620,992` bytes; SQLite `quick_check` returned `ok` |
| Archive format, bounds and native zoom | Shortbread 1.0 `pbf`, zooms 0–14, bounds `[68.13342, -57.07106, 169.0016, -8.809565]` |
| Actual Shortbread source layers and style compatibility | All style source-layer IDs exist in the extract; six-city local PNG rendering passed at zooms 12 and 14 |
| Local raster labels, roads and water at Sydney, Parkes, Hervey Bay, Berry, Perth and Darwin; low/native/overzoom | Local PNGs passed at zooms 12/14. Independent public visual checks passed: six-city 3×3 zoom-13 mosaics, native zoom-14 center tiles, rendered zoom-19 center tiles, and Australia land/water mosaics at zooms 4/5. Margin 32 resolves the observed internal seam label clipping; no provider watermark or enlarged raster blur |
| Self-contained glyphs and sprites; public HTTPS PNG and CORS | Public PNG, glyph, sprite and data endpoints returned HTTP `200` with `Access-Control-Allow-Origin: *`; runtime asset URLs all use `maps.incitat.io`. Independent query-busted visual QA fetched 91 PNGs, all 256×256, CORS `*`, and CDN `MISS` |
| Tunnel candidate validation, rule matching and permission-preserving backup location | Candidate ingress valid; tile rule 3 precedes unchanged OSRM rule 4; backup `/etc/cloudflared/config.yml.ride-tiles-20261010T104704Z.bak` |
| OSRM nearest/route checks before and after tunnel activation | Local routing, post-activation public route and public nearest checks returned `Ok` |
| Final VM resource and isolation check | 1 CPU/2 GiB cap; post-release memory `165.5 MiB`, peak `468.9 MiB` (`491,724,800` bytes); `OOMKilled=false`, restart count `0`; durable disk `86 GiB` free. Loopback port `8082` and read-only `/data` confirmed; tunnel active and post-release public OSRM `Ok` |
| Private planner and existing public trip; route/waypoints, attribution, source transition, outage fallback, offline viewed tiles | Both use owned revision `2026-10-10-1` and correct attribution. Private route retains 101 marker/editor handles and 2 paths; public retains 51 waypoints, 52 paths, 6,724.8 km and 88h 14m. Live blocked-tile test switched to OSM and recovered to owned; offline Sydney revisit loaded every previously viewed tile. Global/wide-context selection and high-zoom rendering passed. External providers are absent from the application tile cache |
| Application build, Git revision, Cloudflare Worker version and live screenshots | Live build `2026-10-10T05`, application commit `4b1e283`; Worker version `83a59bbd-f7ae-4d5a-9552-62fcef83e4e0` at 100%. Existing D1/KV/R2 variables and seven secret names preserved, no migration. Live screenshots saved outside the repository in `output/ride-tiles-live/`: `private-planner-sydney.jpg`, `private-offline-sydney.jpg`, `public-shared-overview.jpg` |

The preceding application version was `a65b5901-e92f-48e8-a840-67d88d87b772`
(build T03). The intermediate T04 release was superseded after the live shared
viewer check caught the hidden-container initialization issue; use T05 for this
tile release. Screenshots and QA receipts stay outside source control.

TileServer GL 5.6.0 allocates both tile and static renderer pools even with
static map endpoints disabled. The configured pool minimum of 1 and maximum of
2 therefore applies to each pool. Check real memory use after rendering; do not
infer consumption solely from the configured pool size. `tileMargin: 32` renders
labels and roads beyond tile edges before cropping each output to 256 pixels;
`maxSize: 320` accommodates that margin. Margin rendering uses the static pool.
The verified margin resolves the observed label clipping at internal tile
seams; scale remains limited to 1. Recheck seams, high-zoom label sizes and
resource use when changing renderer settings. The prior zero-margin config is
retained at `/srv/ride-tiles/config.json.before-margin-20261010T105054Z.bak`.
Pools are allocated per style: enabling the labels style adds another tile and
static pool and a second render request for each viewed tile. Keep the existing
CPU/memory cap and measure warm memory, peak memory, restarts and render latency
after exercising both styles. The prior single-style memory receipt does not
verify this two-style configuration.

Useful host checks:

```bash
docker compose -f /srv/ride-tiles/docker-compose.yml ps
docker stats --no-stream ride-australia-tiles
docker inspect --format '{{.State.Status}} OOMKilled={{.State.OOMKilled}}' ride-australia-tiles
docker logs --tail 50 ride-australia-tiles
```

## Manual updates and staged rollback

There is no scheduled or automatic tile refresh. Archive or renderer updates
are deliberate maintenance releases.

For the labels/style change alone, keep the installed MBTiles, fonts, sprites
and license files. Copy the reviewed `adapt_style.py` beside `prepare.py`, then
generate a separate candidate using the existing deployment as read-only input:

```bash
python3 /srv/ride-tiles/adapt_style.py /srv/ride-tiles --output /srv/ride-tiles-labels-candidate
```

The candidate contains only two style JSON files, `config.json` and the updated
`source-receipt.json`. It preserves the existing data mapping, service options,
render margin, attribution and rendered zoom range. Test these files with the
existing read-only assets in a temporary renderer before activation. Verify
that a label-rich PNG contains both zero-alpha pixels and visible labels, that
base/overlay symbols align, and that names remain legible on a route at zooms
13/14/19. Check revision queries, low-zoom highways and the added renderer load.
Keep timestamped copies of the replaced style/config/receipt files, install
only the reviewed candidate files in a brief maintenance window, and recreate
only `ride-tiles`. Roll back those files and recreate it if any required check
fails. No archive/font download or tunnel change is needed. Run fresh
`prepare.py` with `adapt_style.py` beside it for future full data releases.

1. Keep the active deployment intact. Check disk and memory capacity, then
   prepare a separate timestamped directory on durable storage, such as
   `/srv/ride-tiles-releases/2026-10-10`. Copy the reviewed preparation and
   production Compose files into it. Download a new archive to a `.part` file
   there, record the source headers, and finalize `data/australia.mbtiles` only
   after size, SQLite integrity, vector format and representative tile checks
   pass. Record metadata and a SHA256 receipt.
2. Run `prepare.py` against that staged directory. Check all data, glyph and
   sprite references, source layers, license notices and receipts. Test it in a
   separate temporary container using the pinned image, read-only staged
   volume and the same CPU/memory/log limits. Use an unused localhost port for
   candidate testing after checking available capacity. Leave the production
   port and tunnel unchanged.
3. Verify the same geographic/rendering matrix and resource checks as the
   initial deployment. Stop and remove only the temporary candidate container
   after testing. Keep the old release directory, Compose file, image pin,
   receipts and any tunnel backup available for rollback.
4. In a brief maintenance window, stop only the production `ride-tiles`
   service. Move the existing deployment to a timestamped rollback directory,
   put the verified staged deployment at `/srv/ride-tiles`, and recreate only
   `ride-tiles` with `docker compose -f /srv/ride-tiles/docker-compose.yml up -d
   --force-recreate --no-deps ride-tiles`. Force recreation is necessary so the
   container binds the replacement directory even when its path is unchanged.
   The production volume and
   port must still be `/srv/ride-tiles:/data:ro` and `127.0.0.1:8082:8080`.
5. Recheck public tiles/CORS, both application views, resource use and OSRM.
   If any required check fails, stop only the new tile service, restore the
   retained directory and original Compose/image, recreate the tile service
   and repeat the public checks. Leave unrelated containers running.

A data-only refresh needs no tunnel change. For an ingress change, make a
timestamped permission-preserving backup of `/etc/cloudflared/config.yml`,
edit a separate candidate, and validate it with
`cloudflared tunnel --config <candidate> ingress validate`. Check a tile URL and
an OSRM route URL with `ingress rule` before activation. Reload the existing
service if supported, otherwise restart it, then verify both public services.
Restore the validated backup and reload/restart if public checks fail. Do not
print or commit tunnel credentials or full live configuration.

For an application change, verify the tile endpoint first, run
`node scripts/deploy.js --stamp-only`, review/commit the resulting build and
asset versions, merge into main, and deploy the reviewed revision with the
production Wrangler configuration and `--keep-vars`. Preserve the existing
D1, KV, R2 and secret bindings; tile releases require no data migration. Record
the preceding Worker version before deployment so application rollback can
restore it if necessary. Check the service worker cache behavior after a tile
data refresh, including offline revisit and online revalidation.

Further references: [Geofabrik Australia downloads](https://download.geofabrik.de/australia-oceania/australia.html),
[Shortbread publishing](https://shortbread-tiles.org/publishing/),
[TileServer GL configuration](https://maptiler-tileserver.readthedocs.io/en/latest/config.html),
and [Cloudflare locally managed tunnel configuration](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/).
