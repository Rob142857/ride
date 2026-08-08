# Plan — Self-hosted map tiles for Ride (PMTiles on R2)

**Status:** approved in principle, not started
**Author:** drafted 2026-08-08 for handoff to an implementing agent
**Prerequisite:** the `/api/tiles/{style}/{z}/{x}/{y}` Worker proxy landed in the
tiles/offline batch of 2026-08-08. Read `api/tiles.js` and
`public/js/map-tiles.js` before doing anything else — this plan swaps what sits
*behind* that URL and does not change its shape.

---

## 0. Why, and the one big idea

Ride currently renders maps from the OpenStreetMap Foundation's free public tile
servers. That is fine at today's traffic and, with the Worker proxy now caching
at Cloudflare's edge, it is polite enough to keep using indefinitely. **This plan
is not urgent.** It exists because Rob's stated preference is to self-host rather
than pay a tile provider, and because self-hosting unlocks three things the free
raster tiles cannot give us:

1. **Brand control.** Ride has a design system (navy surfaces, indigo accent,
   gold route, emerald trail — `public/css/tokens.css`). The map is currently the
   one large surface that ignores it entirely. Vector tiles are styled at render
   time, so the basemap can finally match the product.
2. **Much smaller offline downloads.** Vector tiles are a fraction of raster
   size. The around-Australia use case is currently size-bound (see the offline
   feature's tile-count cap) — vector materially raises how much route a rider
   can carry.
3. **No third-party dependency in the critical path** for a feature riders may be
   relying on in areas with no coverage.

**The one big idea:** put a Protomaps PMTiles archive of Australia in R2 and read
tiles out of it with the Worker we already have. PMTiles is a single-file tiled
archive addressed by HTTP range requests, so there is **no tile server, no
PostGIS, no rendering daemon, and nothing new running on `mjw-vm`.** That last
point is deliberate — the VM is shared with unrelated projects and already had
one OOM incident on 2026-08-08 (see `FINDINGS.md`). Adding a render stack there
would be asking for a repeat. This design adds zero load to it.

---

## 1. Decision already made: vector, not raster

You may be tempted to pack pre-rendered PNGs into PMTiles because it needs no
client change. Don't. The comparison:

| | Raster PMTiles | **Vector PMTiles (chosen)** |
|---|---|---|
| Client change | none — Leaflet `tileLayer` as-is | must vendor a vector renderer |
| Size, AU, z0–14 | tens of GB (**exceeds R2 free tier**) | low single-digit GB (**verify**) |
| Who renders | we do, as a big offline compute job | the client, at draw time |
| Brand styling | baked in at render time, immutable | fully controllable at runtime |
| Offline size | large | much smaller |
| Retina / DPI | needs @2x variants, doubles storage | crisp at any DPI, free |

Vector wins on every axis that matters here except client complexity, and that
cost is one vendored library. **Build vector.**

### The one thing vector cannot do

Satellite imagery **cannot** be self-hosted — the imagery is licensed, not
open data. The `satellite` style must keep proxying Esri/ArcGIS exactly as it
does today. Do not attempt to move it, and do not remove it. Ride's satellite
view stays external; only the `street` and `dark` styles become self-hosted.

---

## 2. Ownership split — read this before starting

| Section | Owner | Why |
|---|---|---|
| §3 Produce the PMTiles file | **Rob** | needs a CLI, tens of GB of transfer, and R2 credentials |
| §4 Upload to R2 | **Rob** | needs credentials the agent does not have |
| §5 Worker read path | **agent** | code |
| §6 Client renderer + styling | **agent** | code |
| §7 Offline integration | **agent** | code |
| §8 Validation | shared | agent does static checks; Rob does the device checks |

**The implementing agent has no network access to R2, no wrangler credentials,
and cannot verify a real tile ever renders.** Write the code so it is correct by
construction and reviewable, and be explicit in the findings log about every
assumption you could not test. Do not fake a validation you did not run.

---

## 3. Produce the Australia PMTiles file — Rob

### 3a. Preferred path: extract from Protomaps' hosted planet build

Protomaps publishes daily builds of a whole-planet basemap as PMTiles. The
`pmtiles` CLI can extract a bounding box **by ranged reads against the remote
file**, so you download only Australia, not the planet. This needs almost no
compute and no local OSM processing.

```bash
# Install the CLI (Go binary; releases also available on GitHub)
go install github.com/protomaps/go-pmtiles@latest
```

Then confirm the current planet build URL from the Protomaps docs
(<https://docs.protomaps.com>) — **do not hardcode a URL from memory, the daily
build path has changed before** — and extract:

```bash
pmtiles extract <PLANET_BUILD_URL> australia.pmtiles \
  --bbox=112.0,-44.0,154.5,-9.0 \
  --maxzoom=14
```

The bbox covers the mainland plus Tasmania. Adjust if you want Norfolk/Christmas
Island or a slice of NZ.

**Zoom ceiling is the main size lever.** z14 gives street-level detail adequate
for navigation. z15 roughly quadruples the tile count for the deepest level —
only go there if the size genuinely fits and you have a reason.

Inspect what you got before uploading:

```bash
pmtiles show australia.pmtiles
ls -lh australia.pmtiles
```

Record the actual size, tile count, min/max zoom, and the tile compression and
format (expect Mapbox Vector Tile, gzip-compressed) in the findings log. **The
Worker code in §5 depends on the compression and format, so this is not
optional bookkeeping.**

### 3b. Fallback: build from the PBF already on the box

If §3a is unavailable, `~/ride/infra/osrm-data/data.osm.pbf` (878MB,
whole-of-Australia, dated 2026‑02‑14) can be turned into vector tiles with
[Planetiler](https://github.com/onthegomap/planetiler).

**Do not run this on `mjw-vm.`** Planetiler wants several GB of heap and heavy
disk I/O; the box is shared, has 8GB total, and is already hosting OSRM (3g cap)
and GraphHopper (3.5g cap). Run it on the Windows workstation or any machine with
RAM to spare, and copy the PBF over rather than processing it in place.

Note the PBF is from February 2026 — if you use it, the basemap will be six
months stale. §3a's planet build will be current. Prefer §3a.

---

## 4. Upload to R2 — Rob

Create a dedicated bucket (do **not** reuse `ride-attachments` — different
lifecycle, different access pattern, and mixing them makes the R2 dashboard
useless):

```bash
npx wrangler r2 bucket create ride-basemap
```

**`wrangler r2 object put` is not the right tool for a multi-GB file** — it has a
per-object size ceiling and no resumable multipart. Use R2's S3-compatible API
instead, via `rclone` or the AWS CLI pointed at the R2 endpoint. Configure an R2
API token with object read/write on this bucket only, and keep it out of the
repo — it is a credential, treat it like one.

Then add the binding to `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "RIDE_BASEMAP"
bucket_name = "ride-basemap"
```

**Free-tier figures to confirm against current Cloudflare docs before committing
to a file size** (these move, don't trust this document): R2 storage allowance,
Class A (write) and Class B (read) monthly operation allowances. The decisive
point is that **R2 egress is free**, which is exactly why this design is viable
at zero cost where a bandwidth-billed host would not be.

If the extract does not fit the free storage allowance, reduce `--maxzoom` before
reaching for a paid tier.

---

## 5. Worker read path — agent

### 5a. Keep the existing URL contract

`public/js/map-tiles.js` and `public/js/offline-maps.js` both already construct
`/api/tiles/{style}/{z}/{x}/{y}`. **That contract does not change.** All you are
doing is teaching `api/tiles.js` that some styles resolve to a PMTiles archive in
R2 instead of an upstream HTTP host. Every existing caller, including the offline
downloader, keeps working untouched. If you find yourself editing the client's
URL construction, stop and reconsider — you have probably taken a wrong turn.

### 5b. Reading a tile out of PMTiles

A PMTiles archive is a header, a directory (possibly with leaf directories for
large archives), then the tile data. Resolving one tile means reading the header,
walking the directory to find that tile's byte offset and length, then reading
those bytes. Implementing this from scratch is a real amount of fiddly work
(varint decoding, Hilbert tile IDs, gzip'd directories, leaf-directory recursion)
and getting it subtly wrong yields blank or wrong tiles that are miserable to
debug.

**Use the official `pmtiles` npm package and let wrangler bundle it.**

To be explicit, because the repo has a hard "no build step" rule: **that rule is
about the frontend** — `public/` is served as static files and must stay
framework-free and unbundled. Wrangler already bundles `api/worker.js` and its
imports on every deploy; adding a server-side dependency changes nothing about
how `public/` is served. This is consistent with the rule, not an exception to
it. Say so in a comment so the next reader doesn't "fix" it.

Requirements for the implementation:

- **Cache the archive header and directory.** Re-reading the directory on every
  single tile request would be catastrophic for both latency and R2 Class B
  operation count. Cache it in module scope (warm isolates reuse it) and treat a
  cold isolate as the only time you pay for it.
- **Serve from `caches.default` first**, exactly as the existing HTTP-upstream
  path does. Most requests must never touch R2 at all.
- **Use the R2 binding's range read**, not a full object GET. Fetching a
  multi-GB object to serve a 4KB tile is the failure mode this whole format
  exists to avoid. If you find yourself calling `.get()` without a range, that's
  the bug.
- **Set the right response headers.** Vector tiles are
  `application/vnd.mapbox-vector-tile`, and are stored gzip-compressed — decide
  deliberately whether you decompress in the Worker or pass through with
  `Content-Encoding: gzip`, and comment which and why. Getting this wrong
  produces tiles the renderer silently refuses to draw, with no console error.
- **A missing tile is normal, not an error.** Sparse archives legitimately have
  no tile at many coordinates (ocean, outside the bbox). Return 204 or an empty
  200 — whatever the client renderer treats as "nothing here" rather than
  "failure". Do not 404 or 500; a sea of console errors while panning over the
  Pacific is a bug.
- **Keep the existing z/x/y validation.** It is the security boundary that stops
  the endpoint being turned into a general-purpose fetcher. Do not weaken it.
- **Preserve graceful degradation.** If the R2 binding or archive is missing,
  fall back to the current HTTP upstream for that style rather than serving a
  broken map. A misconfigured deploy should look slightly worse, not blank.

---

## 6. Client renderer and brand styling — agent

### 6a. Vendor the renderer

Leaflet cannot draw vector tiles natively. Use **`protomaps-leaflet`**, which
renders MVT onto a Leaflet canvas layer and keeps the entire rest of the map
stack — markers, the routing machine, the route editor, drive mode — working
unchanged. Do **not** propose MapLibre GL: that means replacing Leaflet outright
and rewriting every map surface in the app. Wrong trade entirely.

Vendor the UMD build into `public/vendor/protomaps/` alongside the existing
vendored Leaflet, and register it in `public/sw.js` `STATIC_ASSETS` and the
`<script>` list in `public/index.html` and `public/trip.html`, following the
existing `?v=` cache-bust convention. No CDN — the project deliberately
self-hosts its vendored JS (that is an existing contract, not a preference).

### 6b. Style it to the brand

This is the payoff. `protomaps-leaflet` takes paint/label rules per feature
class, so map colours come from us:

- Land/water/landuse from the navy `--surface-*` family so the basemap sits
  underneath the UI instead of fighting it.
- **Roads must stay legible above all else.** This is a navigation app used at
  speed. Do not let brand aesthetics reduce road contrast — if a styling choice
  makes a minor road hard to pick out, the styling loses.
- **Never use `--route` gold or `--trail` emerald for basemap features.** Those
  two tokens mean "your planned route" and "where you actually rode". Reusing
  them in the basemap would destroy the app's most important visual distinction.
- Provide both a light (`street`) and dark (`dark`) style so the existing
  two-style switcher keeps working, and keep the share page defaulting to dark.

Read `public/css/tokens.css` for the real values. Do not hardcode hexes — read
the tokens at runtime the way `public/js/map.js`'s `_cssVar()` helper already
does, so a token change propagates to the map for free.

---

## 7. Offline integration — agent

The offline feature built on 2026-08-08 downloads tile URLs into a dedicated
Cache. Because §5a keeps the URL contract, **this keeps working with no changes**
— and each cached entry gets much smaller.

Two follow-ups, in order:

1. **Re-tune the size estimates and the tile cap.** `public/js/offline-maps.js`
   assumes ~15–20KB per raster tile. Vector tiles are typically far smaller but
   vary much more by area (dense city vs empty desert). Measure real average
   tile size from the actual archive and update both the per-tile estimate and
   the hard cap. Under-promising size is fine; a rider running out of phone
   storage mid-trip is not.
2. **Consider region-file download as a later phase — do not build it now.**
   Rather than caching thousands of individual tile responses, a rider could
   download one PMTiles *sub-extract* for their route corridor and have the SW
   serve tiles out of it locally. Dramatically more efficient, and it is what the
   format is designed for. It also needs client-side PMTiles decoding, OPFS or
   IndexedDB storage, and server-side extract generation. Log it as a follow-up
   with a note that it supersedes per-tile caching; do not start it in this pass.

---

## 8. Validation — deliberately light

Rob has explicitly asked for no copious validation passes. Do these and stop.

**Agent, statically:**
- `node --check` every `.js` file created or modified.
- Every new asset appears in `public/sw.js` `STATIC_ASSETS` **and** exists on
  disk — a missing entry fails SW install and bricks the app.
- The Worker's served path and the client's constructed path match exactly.
  Watch the axis order: OSM/vector use `{z}/{x}/{y}` but the ArcGIS satellite
  upstream genuinely uses `{z}/{y}/{x}`. Getting these crossed yields a map that
  looks plausible but is wrong.
- CSP `img-src`/`connect-src` in `api/worker.js` still covers everything used.
- No hardcoded hex colours introduced anywhere.

**Rob, on real devices — the parts that actually matter:**
- One tile request returns bytes: `curl -I https://ride.incitat.io/api/tiles/street/8/117/145`
- A map renders, pans and zooms, and roads are legible in both light and dark.
- **Drive mode on a real phone.** This is the gate. Vector tiles cost CPU to draw
  where raster tiles cost only bandwidth, and drive mode redraws constantly while
  moving. If a mid-range phone drops frames or the battery visibly suffers,
  that's a stop-and-reconsider, not a polish item. Test before trusting it on a
  ride.
- One offline download, then aeroplane mode, then open the trip.

---

## 9. Known gaps and things to note, up front

- **Terrain and hillshade are not in the Protomaps basemap.** Riders care about
  elevation. Not solved here; would need a separate terrain source.
- **The archive is a point-in-time snapshot.** New roads will not appear until
  someone re-runs the extract. There is no update automation in this plan —
  decide a refresh cadence (quarterly is probably ample) and note who owns it.
  A stale basemap is a real, if slow-moving, correctness issue for a navigation
  app.
- **Satellite stays external** (§1) and therefore stays subject to Esri's terms.
- **Attribution is a licensing obligation, not a nicety.** Self-hosting does not
  remove it: OpenStreetMap contributors must be credited, plus Protomaps for the
  basemap build. Carry it in the layer attribution as the current code does.
- **Vector rendering on low-end Android is the single biggest unknown** in this
  plan. See the drive-mode gate in §8.
- Routing is unaffected — OSRM and GraphHopper are separate services and this
  plan does not touch them.

---

## 10. Definition of done

1. `street` and `dark` render from R2-hosted PMTiles through
   `/api/tiles/{style}/{z}/{x}/{y}` with no client-side URL change.
2. `satellite` still works, still external.
3. Basemap colours derive from `tokens.css` at runtime; roads legible in both
   themes; `--route`/`--trail` not used for basemap features.
4. Cold tile → R2 range read; warm tile → edge cache, no R2 operation.
5. Missing tiles degrade silently; a missing R2 binding falls back to HTTP
   upstream rather than breaking the map.
6. Offline download still works end to end, with size estimates re-tuned to real
   measured vector tile sizes.
7. Drive mode verified on a real mid-range phone (Rob).
8. Findings log written — see below.

---

## 11. Findings log — required

Append to `FINDINGS.md` in the repo root, matching the existing format in that
file (`- [severity] file:line — what + why it matters`). Record, at minimum:

- Actual archive size, tile count, zoom range, tile format and compression.
- Measured average vector tile size, and the revised offline estimate/cap.
- Every assumption you could not verify without credentials or a device — state
  it as unverified rather than implying it was tested.
- Anything you found along the way that needs attention but was out of scope.
  This is not a formality; the last plan's findings log is the reason several
  cross-file bugs got caught at all.

**Do not `git commit`, `git push`, or deploy.** Rob does that.
