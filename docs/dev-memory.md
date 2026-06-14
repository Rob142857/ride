# Ride Trip Planner — Developer Memory / Design Document
> Last updated: 2026-06-13
> Scope: Alternative Routes + Share Page Mobile UX

---

## 1. Alternative Routes Architecture

### 1.1 Flow
```
[User selects alt route in TripPlanner]
  ↓
UI calls: this.saveAlternativeRoutes(altRoutes)
  ↓
trips.js → saveAlternativeRoutes(tripId, altRoutes)
  ↓
PATCH /api/trip/:id/alternative-routes
  ↓
api/trips.js → saveAlternativeRoutes({ user, params, data: { alternative_routes } })
  ↓
DB: DELETE + INSERT INTO alternative_routes
  ↓
Share page: GET /api/share/:code → serializePublicJourney → includes alternative_routes
```

### 1.2 Data Model (DB Schema)
Table: `alternative_routes`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | auto-increment |
| `trip_id` | INTEGER FK → trips | indexed, ON DELETE CASCADE |
| `route_index` | INTEGER | 0-based position |
| `name` | TEXT | e.g. "Fastest Route", "Scenic" |
| `summary` | TEXT | brief description |
| `coordinates` | JSON TEXT | array of {lat, lng} pairs |
| `distance_meters` | INTEGER | |
| `duration_seconds`| INTEGER | |
| `color` | TEXT | hex color code |
| `is_selected` | INTEGER (0/1) | user chose this as active |
| `is_visible` | INTEGER (0/1) | show on map |

### 1.3 API Endpoints
- `PATCH /api/trip/:id/alternative-routes` — save alt routes array
- `GET /api/share/:shortCode` — public share page data (includes alt_routes)

### 1.4 Frontend Classes
**MapComponent** (`public/js/map-component.js`)
- `altRoutes: Map<number, Object>` — key is route index
- `addAlternativeRoute(altRoute)` — adds to map
- `getAllRoutes()` — should return `[primary, ...altRoutes.values()]`
- `updateRouteStyles(selectedIdx)` — updates all route polylines
- `clearAlternativeRoutes()` — removes alt routes from map

**TripPlanner** (`public/js/trip-planner.js`)
- `saveAlternativeRoutes(altRoutes)` — saves to DB
- `handleAlternativeRouteSelected(altIdx)` — switches active route
- `renderAlternativeRoutesList(routes, selectedIdx)` — renders UI cards

### 1.5 BUG FIX: Map Component (CRITICAL)
**File**: `public/js/map-component.js`
**Method**: `getAllRoutes()`
**Issue**: Was using `Object.values(this.routes)` (empty) instead of `Object.values(this.altRoutes)`
**Fix**:
```javascript
getAllRoutes() {
    return [this.primaryRoute, ...Object.values(this.altRoutes)];
}
```
**Impact**: Without this fix, alternative routes never render on the map.

---

## 2. Share Page Mobile UX Architecture

### 2.1 Design Philosophy
The share page (`/ABCDE`) is the **primary viral entry point** — many users' first experience of the app. It must feel like a polished native mobile app, not a stretched desktop page.

### 2.2 File: `public/js/share-patch.js`
Injected into both `index.html` and `trip.html` to enhance the share page:

#### Mobile Detection
```javascript
const isMobile = window.innerWidth < 768 || 'ontouchstart' in window;
```
Uses UA check as fallback: `/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)`

#### 2.2.1 Hero Section
- **Before**: Hero image `max-height: 380px`, header overlay at top with buttons
- **After**: Hero image `height: 55vh` (mobile), `max-height: 480px` (desktop). Gradient overlay from bottom creates card-like feel. Buttons moved below title.

#### 2.2.2 Route Card
- **Before**: White line with colored dot, large "Distance" labels
- **After**: Pill-shaped card with `backdrop-filter: blur(12px)`, vivid colored dot, bigger metric numbers (distance/duration), touch-friendly tap target. Desktop: info bar inline, Mobile: full card.

#### 2.2.3 Waypoint List
- **Before**: Bulleted list, plain text, `0.5rem 0` padding
- **After**: Card per waypoint with `1px solid rgba(0,0,0,0.06)`, avatar circle (first letter), distance pill, subtle left border accent. Map fly-to on tap.

#### 2.2.4 Alternative Routes Accordion
- **Before**: Inline list, always visible
- **After**: Collapsible header "Alternative Routes (N)" — saves vertical space. Slides down with max-height animation. Desktop: inline list, Mobile: vertical cards.

#### 2.2.5 Map
- **Before**: Static `height: 300px`
- **After**: `height: 50vh` (mobile), smooth scroll-into-view, full-width. Touch gestures enabled (drag to pan, pinch to zoom).

#### 2.2.6 Gallery
- **Before**: Horizontal scroll with small images
- **After**: 2-column grid on mobile (`grid-template-columns: repeat(2, 1fr)`), gap `8px`. Full-width lightbox on tap with close button top-right.

#### 2.2.7 CTA Bar
- **Before**: None (inline button)
- **After**: Fixed bottom bar (mobile) with prominent "Plan a Trip" button. `padding-bottom: 100px` on content container to prevent overlap. Desktop: sticky banner at top.

### 2.3 CSS Variables Used
```css
--cover-height: 55vh;
--cover-max-height: 480px;
--content-padding: 1.25rem;
--section-gap: 2rem;
--card-radius: 16px;
--card-shadow: 0 2px 12px rgba(0,0,0,0.08);
```

### 2.4 Breakpoints
- Mobile: `< 768px`
- Tablet: `768px - 1024px`
- Desktop: `> 1024px`

### 2.5 Performance Optimizations
- Hero image uses `object-fit: cover` with `cover_focus_x/y` focal point
- Waypoint images lazy-loaded with `loading="lazy"`
- Map tiles cached; smooth fly-to animations via `map.flyTo()`
- Share patch only runs when `window.location.pathname !== '/'` (skip homepage)

---

## 3. Backend Architecture

### 3.1 Worker Entry Point (`api/worker.js`)
```javascript
export default {
  async fetch(request, env, ctx) {
    return Router.handle(request, env, ctx);
  }
};
```

### 3.2 Router (`api/router.js`)
- Pattern matching with regex for dynamic segments
- Auth middleware for protected routes
- CORS preflight handling

### 3.3 Auth Flow
- JWT stored in localStorage (legacy) + HttpOnly cookie
- `GET /api/user` validates token, returns user
- `middleware.auth()` extracts from both sources

### 3.4 Database
- Cloudflare D1 (SQLite-compatible)
- `api/schema_v2.sql` — current schema
- Migrations in `api/migrations/`

---

## 4. Known Issues & Fixes Applied

### 4.1 ✅ Fixed: saveAlternativeRoutes Signature
**File**: `public/js/trips.js` (frontend)
**Issue**: `saveAlternativeRoutes(alternativeRoutes)` but router passes `{ user, params, data }`
**Fix**: Changed method signature to `saveAlternativeRoutes({ params, data })` to match router.

### 4.2 ✅ Fixed: MapComponent.getAllRoutes()
**File**: `public/js/map-component.js`
**Issue**: Was iterating `this.routes` (always empty Map) instead of `this.altRoutes`
**Fix**: Changed to `Object.values(this.altRoutes)`

### 4.3 ✅ Fixed: Homepage share-patch exclusion
**File**: `public/js/share-patch.js`
**Added**: `if (window.location.pathname === '/') return;` to skip homepage

---

## 5. Testing Checklist

- [ ] Create trip with multiple waypoints
- [ ] Generate route → see primary route on map
- [ ] Request alternative routes (AI suggests 2-3)
- [ ] Select alternative route → map updates
- [ ] Save trip → alternative routes persisted
- [ ] Visit share page on mobile → hero looks good
- [ ] Scroll down → waypoint cards render with avatars
- [ ] Tap waypoint → map flies to location
- [ ] Alternative routes accordion expands/collapses
- [ ] Gallery images display in 2-col grid
- [ ] "Plan a Trip" CTA visible at bottom
- [ ] Same share page on desktop → not broken

---

## 6. Future Improvements

1. **Route comparison view**: Side-by-side comparison of alt routes with elevation profiles
2. **Route voting**: Allow share page visitors to "vote" on which route looks best
3. **Live traffic overlay**: OSRM supports traffic data — integrate for time estimates
4. **PWA install prompt**: Add `beforeinstallprompt` handler for share page visitors
5. **Deep linking**: Universal links so shared routes open in app if installed
6. **Analytics**: Track which share pages get the most visits, which routes get tapped

---

## 7. File Inventory

| File | Purpose | Modified? |
|------|---------|-----------|
| `public/js/trip-planner.js` | Main trip planning UI | Partial (alt routes UI) |
| `public/js/map-component.js` | Leaflet map wrapper | ✅ Bug fix getAllRoutes() |
| `public/js/trips.js` | API client for trips | ✅ Signature fix |
| `public/js/share-patch.js` | Share page UX enhancements | ✅ New file |
| `public/index.html` | Main app shell | ✅ Includes share-patch.js |
| `public/trip.html` | Share page template | ✅ Includes share-patch.js |
| `api/trips.js` | Trip backend handlers | Already had alt routes |
| `api/share.js` | Share page backend | Already had alt routes |
| `api/journey.js` | Journey serialization | Already includes alt_routes |
| `api/router.js` | Route definitions | Already had PATCH endpoint |
| `public/js/ai-route-service.js` | AI route suggestions | — |
| `public/js/collaboration.js` | Real-time collaboration | — |
| `public/js/pdf-export.js` | PDF export | — |