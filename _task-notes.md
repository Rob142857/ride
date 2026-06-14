# Alternative Routes Fix - Task Notes

## Issues Found

### 1. CSS Bug - Route Panel Hidden on Desktop
**File:** `public/css/app.css` line ~749
```css
.route-panel-container { display: none; }
```
This unconditionally hides the route panel. It should only hide on non-desktop viewports.

### 2. saveRouteData Doesn't Persist alternative_routes
**File:** `public/js/journal-controller.js` line ~76
```javascript
await API.trips.update(id, { route: routeJSON });
```
Only saves `route`, not `alternative_routes`. When user selects an alternative, the list of alternatives is lost.

### 3. initializeTripPlan Doesn't Restore alternative_routes
**File:** `public/js/map.js` line ~1627
Restores `route`, `route_summary`, `route_stats` from cache but NOT `alternative_routes`.

### 4. loadTripPlan Doesn't Send alternatives in ride:routeSelected
**File:** `public/js/map.js` line ~1551
Event only sends `waypoints`. Needs to send `alternatives` so route-alternatives.js can render them after page reload.

### 5. PATCH /trips/:id Doesn't Handle alternative_routes
**File:** `api/trips.js` line ~182
Handler updates `route`, `route_summary`, `route_stats` but not `alternative_routes`.

## Fixes to Apply

1. **app.css** - Change `.route-panel-container { display: none; }` to only apply on non-desktop
2. **journal-controller.js saveRouteData** - Include `alternative_routes` in the update payload
3. **map.js initializeTripPlan** - Restore `alternative_routes` from cache
4. **map.js loadTripPlan** - Send `alternatives` in `ride:routeSelected` event
5. **trips.js updateTrip** - Handle `alternative_routes` in PUT handler
6. **Mobile UX** - Improve alternative route selection on mobile