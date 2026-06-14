# Alternative Routes — Design Notes

## 1. How alternatives are fetched
- In `routing.js` `fetchAlternatives()` calls `API.journey.plan()` with `alternatives=true` flag.
- `API.journey.plan()` already passes `alternatives` through to the query string, so the backend supports the flag.
- Backend `journey.js` currently does NOT support alternatives (API returns `message: "Alternatives not supported yet"`).
- The `osrm.getAlternatives()` method in the backend DOES exist and queries the OSRM `/route/v1/driving/{coordinates}?alternatives=true&steps=true&geometries=polyline6` endpoint.

## 2. How alternatives are saved
- `Routing.saveAlternativeRoutes()` maps OSRM alternative routes into `{polyline, distance, duration, summary}` objects.
- Saves them to `trip.alt_routes` array via `processRouteUpdate(trip, 'save-alternative-routes', {routes})`.
- Backend trips.js `processRouteUpdate()` receives `data.type === 'save-alternative-routes'` and calls `saveAlternativeRoutes(data.routes, trip, account)`.
- `saveAlternativeRoutes()` inserts rows into `route_alternatives` table and then updates `trip.alt_routes` JSON field.
- On load, `getTripById()` does: `alternative_routes: JSON.parse(trip.alt_routes || '[]')`.

## 3. UI — trip.html share page
- `renderRouteSelector(trip)` builds a horizontal button row for each route option.
- `selectRoute(trip, index)` updates the map, summary stats, and highlights the active button.
- `updateTripStatsForRoute(trip, idx)` recalculates trip.distance/trip.duration etc.
- On page load, `showTrip(trip)` checks `trip.alt_routes?.length` and calls `renderRouteSelector(trip)`.

## 4. UI — index.html app
- `addAlternativeRoutesPanel(routes)` builds a right-panel list in the trip view.
- On planning, `handleRoute()` proxy does: if alternatives > 0, `addAlternativeRoutesPanel(routes)`.
- If no alternatives returned, `removeAlternativeRoutesPanel()` is called to clear previous data.
- `selectAlternative(index)` calls `updateWaypointsForRoute()` then refreshes map + summary stats.

## 5. What's missing / needs fixing
- **Backend journey.js**: Needs to pass `alternatives` flag through to OSRM.
- **Backend osrm.js**: Already supports alternatives flag; needs to be used.
- **index.html saveTrip()**: Does NOT save alt_routes to the cloud. After saving, `App.currentTrip.alt_routes` is not persisted via API (saveTrip doesn't send them).
- **share page**: Route selector exists but may not be well styled for mobile.