# Ride App - Research & Improvement Plan

## Architecture
- SPA at `/` (index.html) with client-side routing
- Standalone trip.html for shared/public trip viewing
- Backend: Workers + Cloudflare D1 (SQLite)
- Map: Leaflet with OSRM for routing
- Styling: global.css tokens + app.css overrides

## Key Bugs Found

### 1. CRITICAL: Wrong HTTP method in trip.html route save
- **File:** `public/trip.html` 
- **Line:** Script source is `js/trip.js` (reverted, NOT inline)
- **Backend:** `api/trips.js` expects `PUT /trips/:id/route/:altIdx`
- **trip.js from interface.md** used `method: 'POST'` - BUG
- **app.js (SPA)** calls `Api.updateTripRoute(tripId, altIdx)` which uses `PUT` - CORRECT
- **Fix:** Ensure trip.js uses `PUT` not `POST`

### 2. CRITICAL: Route alternatives hidden on desktop
- **File:** `public/css/app.css`
- **CSS:** `.route-alternatives { display: none !important; }` at `@media (min-width: 481px)`
- **This means alternatives are VISIBLE only on <480px, hidden everywhere else!**
- **Fix:** Remove `display: none !important` from the desktop breakpoints

### 3. trip.html uses wrong script name
- `trip.html` loads `trip.js` but the file from interface.md was `app-trip.js`
- **trip.html currently says:** `<script src="js/trip.js"></script>`
- Need to check if `js/trip.js` exists or if it should be `app-trip.js`

### 4. Owner class bug
- **trip.html line 1262:** `document.body.classList.add('owner', isOwner);`
- This adds TWO classes: 'owner' AND the string value of `isOwner` (e.g. 'true'/'false')
- Should be: one `if` check

### 5. Multiple route stylesheet inclusions
- **trip.html lines 41-42:** includes both `global.css` AND `trip.css`
- trip.css may have conflicting styles

## Backend API - Alternative Routes
- `PUT /trips/:id/route/:altIdx` - Sets activeRouteIndex, saves route geometry/polyline
- Response returns `{ success: true, trip: {...} }` with full trip object
- Backend correctly validates altIdx against alternatives array
- Backend stores route geometry in `trips.route_geometry` and `trips.route_polyline`

## Current Flow
1. User clicks "Plan Route" → calls `App.planRoute()` in app.js
2. OSRM returns multiple alternatives → stored in `trip.alternativeRoutes`
3. UI renders `route-alternatives.js` panel
4. User clicks an alternative → dispatches `ride:routeSelected` event
5. SPA handler: updates `trip.activeRouteIndex`, redraws route on map, calls `App.saveRouteData()`
6. **BUT** `saveRouteData()` sends `POST` request to backend... wait, actually the SPA uses `Api.updateTripRoute()` which uses `PUT`

## Missing: trip.html share page save
- Share page currently READ-ONLY for routes
- Need to add ability for owner to change routes on share page too

## Mobile UX Issues
1. `.route-alternatives` only visible on <480px (desktop HIDDEN - this is backwards!)
2. Panel z-index may be too low (no z-index specified)
3. No swipe gesture for switching alternatives
4. No haptic feedback
5. Bottom sheet pattern not used for route selection
6. Touch targets may be too small

## Share Page (trip.html) Issues
1. No route alternative selection for owner
2. routePolyline is baked into page for share display
3. No ability to recalculate routes
4. Static map - not interactive beyond pan/zoom
5. Card layout needs mobile optimization

## Files to Modify
1. `public/js/trip.js` - fix `POST` → `PUT`, fix owner class
2. `public/css/app.css` - fix route-alternatives visibility on desktop
3. `public/trip.html` - comprehensive mobile/share improvements
4. `public/css/trip.css` - add mobile-specific share page styles
5. `public/js/route-alternatives.js` - add mobile gestures, bottom sheet mode