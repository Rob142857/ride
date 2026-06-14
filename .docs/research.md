# Research Notes: Alternative Routes & Share Page Mobile UX

## Repo Architecture
- Cloudflare Worker backend with SQLite (D1)
- Static frontend served from `public/` — SPA index.html + share page trip.html
- OSRM routing (getOSRMRoute) supports up to 2 alternatives via `alternatives=true&alternatives_count=2`

## Key Files
| File | Purpose |
|---|---|
| `public/js/route-alternatives.js` | UI for selecting alternative routes in trip planner |
| `public/js/trip-share-hero.js` | Camera orbit hero on share page |
| `public/css/trip.css` | Share page styles — **needs mobile overhaul** |
| `public/trip.html` | Public share page |
| `api/trips.js` | Backend CRUD for alternative routes (table exists) |
| `api/journey.js` | `serializePublicJourney` includes `alternative_routes` array |
| `api/share.js` | Public share endpoint — already handles alternative routes |
| `api/router.js` | API router — `POST /api/trips/:id/alternative-routes` wired |

## Alternative Routes Storing
- Flow 1: Elsewhere in codebase (not found yet), alternative routes are generated via OSRM and sent via `POST /api/trips/:id/alternative-routes` which goes to `saveAlternativeRoutes()` — it DELETES all existing then bulk INSERTS new ones.
- `api/places.js` `getOSRMRoute()` sends `alternatives=true&alternatives_count=2` to OSRM.
- `serializePublicJourney` already maps `alternative_routes` properly with fields: `alt_idx`, `name`, `summary`, `color`, `distance`, `duration`, `saved`, `visible`, `coordinates`.
- Public share API (`api/share.js`) already queries and returns `alternative_routes` (see `getTripWithData()`).

## Share Page (`trip.html`) Issues Found
1. **Alternative routes NOT rendered** — the page only ever adds a single polyline (`primaryRouteLine`) with the `tripData.route` object. No code iterates `tripData.alternative_routes`.
2. **Map overflows viewport** — `.share-map` has `height: 45vh` which is too tall on mobile, causing the page to feel clunky and requiring excessive scrolling.
3. **Waypoints panel overlays map** — `.waypoints` is `position: absolute; top: 12px; left: 12px` which can cover >50% of map width on small screens.
4. **Hero card margins too high** — top margin `2rem` creates excessive blank space on mobile.
5. **Stats grid no mobile sizing** — 4-column grid on 320px screens means unreadably small content.
6. **Gallery grid no breakpoint** — 5-column min-content grid is unusable on mobile; should be 2-col on small, 3 on medium, 5 on desk.
7. **No `-webkit-tap-highlight-color`** — mobile browsers flash blue on any tap.
8. **No `overscroll-behavior-y: contain`** on panels — pull-to-refresh can trigger accidentally.
9. **Route card overlay missing** — no UI to display route cards for switching routes on the share page (the select exists for owned trips in the SPA).
10. **Mobile font sizes too large** — h1 at 2rem on 375px screen is cramped.

## Schema Confirmation Table
```sql
CREATE TABLE alternative_routes (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  route_index INTEGER NOT NULL,
  name TEXT,
  summary TEXT,
  color TEXT,
  distance_meters REAL,
  duration_seconds REAL,
  is_selected INTEGER DEFAULT 0,
  is_visible INTEGER DEFAULT 1,
  coordinates TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);
```

## Required UI/UX Changes
1. **trip.css**: Rewrite with mobile-first container queries, fix map height, adjust overlays, responsive gallery, remove awkward margins.
2. **trip.html JS**: Add alternative route polylines with jittered colors, add route selector UI for switching visible route, add "Hide show alternates" toggle, ensure map.fitBounds works for all routes.
3. **Alternative route persistence**: Investigate whether the SPA (`index.html` route) actually calls `saveAlternativeRoutes` after OSRM returns alternatives. If not, add the call.

## Design for Mobile Share Page
- **Hero**: h1 1.35rem, info bar max 280px, camera-orbit tilt 50deg on <480px, 65deg on >=480px.
- **Map**: 35vh on mobile, no overlay panel, waypoints shown as top-left floating compact panel with `max-width: min(220px, 55vw)` and close button.
- **Stats**: 2-column grid on <400px, 4-col on >=768px.
- **Alternatives**: Right-side vertical floating strip on desktop (top-right), bottom sheet on mobile.
- **Gallery**: 2-col on <480px, 3-col on <900px, 5-col desk.
- **Typography**: line-height 1.55 for readability.
- **Touch**: `-webkit-tap-highlight-color: transparent` globally.