# Implementation Plan: Alternative Routes + Share Page Overhaul

## Current Architecture Understanding

### Data Flow
1. **map.js** (`App.getRoute()`): Calls OSRM routing, returns ONE route object
2. **journal-controller.js** (`saveRouteData()`): Stores single route in `this.currentTrip.route`
3. **trip-controller.js** (`saveCurrentTrip()`): PUT to `/api/trips/{id}` with `{route: {...}, ...}`
4. **Backend** (`api/trips/[id].js` PUT): Stores `route` in JSONB column `trips.route`
5. **Trip render** (`trip-controller.js` `renderCurrentTrip()`): Calls `UI.renderTripHeader()`, `UI.renderTripOverview()`, `UI.renderSegmentsTable()`
6. **Share page** (`public/trip.html`): Separate static HTML with inline styles, calls `/api/shares/{slug}`

### Current Route Storage Schema
```json
{
  "distance": 12345,
  "time": 3600,
  "duration": 3600,
  "coordinates": [[lon,lat], ...]
}
```

### Share Page Current State
- Self-contained static HTML file
- Inline styles (separate from main CSS)
- Calls `/api/shares/{slug}` for trip data
- Has its own `renderTrip()` function
- Uses `<img>` tags for map background

---

## Phase 1: Backend Changes

### 1.1 trips table migration
```sql
ALTER TABLE trips ADD COLUMN alt_routes JSONB DEFAULT '[]';
```

### 1.2 trips/[id].js PUT handler changes
- Accept `alt_routes` in request body
- Validate each alt route has distance, time, coordinates
- Limit to 5 alternatives
- Persist to `alt_routes` column
- If `alt_routes` omitted/undefined, keep existing value

### 1.3 shares/[slug].js GET handler changes
- Include `alt_routes` in response (or omit if null to keep response small)

---

## Phase 2: Frontend - Main App Alternative Routes

### 2.1 journal-controller.js - saveRouteData changes
- Accept `altRoutes` parameter
- Store in `this.currentTrip.alt_routes`
- Persist via `saveCurrentTrip()` → API

### 2.2 map.js - Routing changes
- OSRM already returns `routes[0]` with alternatives at `routes[1], routes[2]...`
- In `App.getRoute()` callback, extract alternatives:
  ```js
  const alternatives = data.routes.slice(1).map((r, idx) => ({
    index: idx + 1,
    distance: r.summary.totalDistance,
    time: r.summary.totalTime,
    duration: r.summary.totalTime,
    coordinates: (r.coordinates || []).map(c => [c.lng, c.lat])
  }));
  ```
- Dispatch `routeEvent.type === 'alternatives'` with `alternatives`

### 2.3 trip-controller.js - UI rendering changes
- In `renderCurrentTrip()`, detect `alt_routes.length`
- If alternatives exist, pass to UI for rendering selector

### 2.4 UI module - Alternative Routes selector
- Add `renderRouteAlternatives(altRoutes, selectedIndex)` function
- Create mobile-friendly card selector (horizontal scroll on mobile, tabs on desktop)
- Show distance + time for each option in human-readable format
- On select: switch to that route, update map, update stats
- Visual: selected state with accent color, summary info below

### 2.5 trips/[id].js GET handler
- Include `alt_routes` in response (already in row object, just needs to be in clean function)

---

## Phase 3: Frontend - API Module

### 3.1 api.js trip update
- Pass `alt_routes` through when making update call

---

## Phase 4: Share Page (trip.html) Overhaul

### 4.1 Structure improvements
- Add proper responsive viewport meta
- Add CSS Grid/Flexbox layout
- Better typography hierarchy
- Primary CTA for "Plan your own trip"

### 4.2 Mobile-first design
- Full-width on mobile, max-width on desktop
- Stacked layout: map/header → hero → stats → timeline
- Touch-friendly tap targets (min 48px)
- Horizontal scroll for alternative routes on mobile
- Use viewport-relative units

### 4.3 Visual polish
- Gradient hero with blurred map background
- Glassmorphism/sticky header
- Animated route line on hero map
- Show alternative routes in clean cards
- Journal entries with proper cards and typography
- Waypoint photos as a gallery grid

### 4.4 Brand integration
- Display app name/logo link
- Clear branding and CTA to main app

---

## Phase 5: CSS - Mobile-First Responsive Improvements

### 5.1 Main app responsive fixes
- Journey log: horizontal scroll on mobile
- Route panel: slide-up bottom sheet on mobile
- Timeline: collapsible sections
- Tab bar: swipeable on mobile
- Stats grid: 2-col on mobile, 4-col on desktop
- Media grid: full-bleed on mobile

### 5.2 CSS variables for theming
- Ensure all colors come from variables
- Add dark mode support where missing

---

## Implementation Order
1. Write this plan ✓
2. Backend: trips table migration + API changes
3. Frontend: map.js routing extension + journal-controller save changes
4. Frontend: trip-controller renderCurrentTrip changes + UI alternatives
5. Share page: Complete overhaul of trip.html
6. CSS: Mobile-first responsive improvements
7. Test and verify