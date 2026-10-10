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

External OSM and satellite requests use normal browser HTTP caching without
application-managed offline storage or prefetching. Routing remains network
only. Keep the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
requirements when changing fallback behavior; do not bulk-download public OSM
or CARTO raster endpoints. Attribution follows the active basemap.

## Verification record

The initial hosting checks are recorded below. Complete the application rows
after verifying the live release.

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
| Final VM resource and isolation check | 1 CPU/2 GiB cap; current memory `219.8 MiB`, peak `468.9 MiB` (`491,724,800` bytes); `OOMKilled=false`, restart count `0`; durable disk `86 GiB` free. Loopback port `8082` and read-only `/data` confirmed; tunnel active and public OSRM `Ok` |
| Private planner and existing public trip; route/waypoints, attribution, source transition, outage fallback, offline viewed tiles | Awaiting final verification |
| Application build, Git revision, Cloudflare Worker version and live screenshots | Awaiting final verification |

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
