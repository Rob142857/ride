# Alternative Routes & Mobile UI Improvement Plan

## Date: 2026-06-13

## Current Issues Found

### 1. Save Route Logic Bug (trip.html)
**File:** `public/trip.html`
- `saveRouteSelection()` fetches `/api/trips/${tripId}?action=save_route` with `method: 'POST'`
- **Backend router** only allows `PUT` for this endpoint (`case 'PUT': tripStore.saveRoute(id)`)
- `POST` → `404` → `showToast('Failed to save route selection', 'error')`
- **Fix:** Change `method: 'POST'` to `method: 'PUT'`

### 2. Mobile Layout: Route Selector
- Light badges on light background (WCAG contrast fail)
- Routes not selectable on mobile (no touch affordance feedback)
- Route selector crammed into side panel on mobile
- Proposal: Make selector a bottom sheet on mobile

### 3. Trip.html Missing Owner State for Save UI
- `save-ui` id exists but `is-owner` class is never set on the element for owner trip
- CSS `#save-ui:not(.is-owner) { display: none !important; }` hides it for non-owners
- But JS `showSaveStatus()` sets `ui.style.display = 'block'` which only works if `is-owner` is present
- Need to set `is-owner` class when `trip.is_owner === true`

### 4. Main App (index.html / app.js) Alternative Route Flow
- No visible alternative route UI in the plan panel
- `fetchAlternatives` flag exists but alternatives are never presented to user
- `saveCurrentRoute()` tries to save `currentRoute.alt_idx` but should save `plan.route.alt_idx`
- Need inline route selector in plan panel with "Keep This Route" action

### 5. Mobile UX Issues (both pages)
- Map takes too much height on short mobile screens
- Bottom sheet panels lack safe-area padding
- Touch targets in Share flow too small (< 44px)
- Footer cards on share page too wide for mobile
- Toast messages appear off-screen on some mobile devices
- Map stats panel overlaps controls on small screens

## Implementation Plan

### A. Fix trip.html
1. **Fix save method:** `POST` → `PUT`
2. **Add owner class:** Set `is-owner` on save-ui when owner
3. **Mobile route selector:** Convert to bottom sheet on mobile, inline on desktop
4. **Add "Save This Route" button** inside route selector for owners (one-tap save)
5. **Improve mobile header:** Smaller title font, tighter padding
6. **Better route badges:** Dark background variants for mobile
7. **Fix map height:** Use `dvh` units with safe-area awareness

### B. Improve Main App Alternative Routing
1. **Override OSRM geometry** with personal/team note waypoints when present
2. **Alternative route panel:** Inline expandable list in plan panel
3. **Fetch alternatives:** When planning, request alternatives via `POST /directions` with `optimize_for=alternatives`
4. **"Compare Routes" button** in plan footer
5. **Save alternative as primary:** When user taps "Keep This Route", send `PUT /trips/{id}?action=save_route`

### C. CSS Overhaul (app.css)
1. **Better mobile-first variables**
2. **Bottom-sheet component** usable across pages
3. **Safe-area padding** on all fixed bottom elements
4. **Minimum 44px touch targets** everywhere
5. **Improved route selector styles** with high contrast badges
6. **Mobile-optimized map layout**

### D. Share Page Specific
1. **Improve footer CTA** on mobile (full-width, thumb-friendly)
2. **Better location display** on small screens
3. **Add route visual preview** even before map loads
4. **Improve dark-mode contrast** in route cards