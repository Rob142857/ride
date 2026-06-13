# Alternative Routes & Share Page Mobile-First UX Implementation Plan

## Current State Analysis

### Routing
- OSRM self-hosted at `https://maps.incitat.io/route/v1`
- Leaflet Routing Machine (`L.Routing.control`) with `showAlternatives: false`
- Route stored as `{ coordinates: [...], distance, duration, steps }` on trip
- No alternative route storage capability

### Share Page (trip.html)
- Hero image section, map card, waypoint list, journal, gallery
- Mobile breakpoint at 640px only, minimal mobile optimizations
- Map height fixed at 400px (300px mobile)
- No route-specific stats display beyond basic distance/duration
- No alternative route display at all

### Main App Map
- `MapManager.updateRoute()` creates `L.Routing.control`
- Route styles: primary (#e94560) + glow layer, zoom-responsive weight
- `showAlternatives: false` hardcoded
- `fitSelectedRoutes: false`
- Route data extracted from `routes[0]` only

## Implementation Plan

### 1. Backend: Alternative Routes Storage
- Add `alternatives` JSON column to `trips` table (or use existing route_data flexibility)
- Update `api/journey.js` `serializePublicTrip()` to include `alternatives`
- Update trip update/create handlers to persist alternatives

### 2. Main App: Alternative Routes UI
- Set `showAlternatives: true` in `L.Routing.control`
- Listen to `routesfound` event to capture alternatives
- Build mobile-first route selector panel (bottom sheet on mobile, sidebar on desktop)
- On route selection: update stored route, save to backend
- Persist selected alternative index

### 3. Share Page (trip.html): Complete Overhaul
- **Hero**: Keep, but improve overlay gradient, adjust mobile sizing
- **Map**: 
  - Add route profile badge (Driving/Scenic/etc)
  - Add distance/duration/time display in a sticky bottom bar or overlay
  - Make map tappable/focusable on mobile
  - Fullscreen toggle improved
- **Route Cards** (NEW): Show alternative routes as swipeable cards below map on mobile, horizontal scroll on desktop
- **Waypoints**: Improve vertical timeline styling for mobile
- **Journal**: Collapsible sections, better image grid
- **Gallery**: Swipeable on mobile, lightbox improvements
- **Meta/SEO**: Add Open Graph route preview image generation support comments
- **Responsive**: Add 768px and 480px breakpoints, use container queries where possible

### 4. CSS Improvements
- Mobile-first media queries
- Touch targets min 44px
- Improved typography scale
- Glass-morphism map overlays
- Smooth animations

## Files to Modify
1. `api/journey.js` - Add alternatives to serialization
2. `public/js/map.js` - Enable alternatives, capture them, render selector
3. `public/js/trip-controller.js` - Save alternatives with trip
4. `public/js/trip.js` - Add alternatives to trip data structure
5. `public/index.html` - Add route selector UI markup
6. `public/trip.html` - Complete redesign for premium mobile UX
7. `public/css/global.css` - Mobile-first utilities