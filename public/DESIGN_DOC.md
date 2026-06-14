# EfficientRoute.ai Share Page & Route Selector Design

## 1. Sharing Algorithm Refinements (Fixes)

### Best Way to Obtain & Save Alternative Routes
Currently the app saves all alternatives every time a single route is chosen. This wastes DB bandwidth. The fixes have been applied:

1. **Save-route endpoint now stores the chosen index** in `trip.chosen_route_index`
2. **Frontend saves alternative routes once** after a recalculation, not on every choice change
3. **PUT /routes replaces all routes**, and a separate choose-route endpoint updates only the chosen index

### Applied Fixes
- Changed `saveRoute(tripId, routeIndex)` from POST to PUT (matches backend expectation)
- Added `chooseRoute(tripId, routeIndex)` POST for lightweight switching
- Fixed `saveAlternativeRoutes` signature mismatch (removed extra `trip` arg)
- Added linear trail ghost markers to main map while keyboard dismissed
- Map padding includes `collapsed-notes` height for proper fit

## 2. UX - Desktop: Route Selector as Top Bar

Replace the nested accordion with a clean **pill selector bar**:

- `route-selector` becomes a **horizontal flex** of compact pill `route-option` cards
- Each pill shows: badges + primary stat (e.g. `~42m`) + checkmark for active
- No scrolling — all options visible at a glance
- `padding: 8px 16px` + `gap: 8px`
- Active pill: `ring-2 ring-blue-500 bg-blue-50`
- Badge text: `0x00000rem`, `font-medium`

### Why pills?
- Horizontal layout → no vertical accordion expansion/collapse
- Click one pill → immediate preview on map + notes panel instantly refreshes
- Keyboard shortcut: `Ctrl+1/2/3` cycles options
- Bars above map so map area isn't pushed down when options appear

## 3. UX - Mobile: Bottom Sheet Drawer

On viewports < 640px, the selector turns into a **drag handle bottom sheet**:

- Tapping "Route options" mini-bar pulls up the sheet
- Inside the sheet: large touch-friendly `route-option-row` with **radio circles**
- Swipe down on handle or tap backdrop dismisses
- Sheet has `max-height: 70vh`, `border-radius: 20px 20px 0 0`, `box-shadow: 0 -8px 30px`
- Keyboard users: swipe/scroll inside sheet works

## 4. Share Page Polish (User's First Experience)

### Above-the-fold on mobile:
- Route thumbnail / map combo hero
- **Bold "Route Option" pill bar** right under title
- Clean stat pills: duration / distance / fuel — horizontally scrollable on mobile
- "Get Directions" sticky footer CTA (iOS Safari chrome-aware)
- All waypoints colored markers if multi-stop

### Loading experience:
- Skeleton cards matching the glassy aesthetic (not generic pulsing blocks)
- Route line pre-draws in low-opacity, then brightens when data arrives

### CTA Strip
- iOS: `apple-maps://` deep link
- Android: `geo:` intent or `https://maps.google.com/maps`
- Web: Native share sheet with Web Share API (`navigator.share`) as primary + copy-to-clipboard fallback

### Photo gallery
- Lightbox on press/hold with egress button, not full-bleed takeover
- Desktop: arrow key navigation

## 5. Component Spec: er-route-selector (Custom Element)

```js
// attrs: options (JSON), chosen, fastest, shortest, show-mobile-sheet
// events: route-chosen

updateUI() {
  // Desktop: horizontal pills
  // Mobile: cooked sheet
}
```

## 6. Performance Budget
- First paint: `< 1.2s` on 4G
- Route polyline must not re-decode on every selection switch
- Lazy-load non-active route geometries (keep encoded strings, decode on demand)

## 7. Status

- [x] Backend fixes applied (save-route, choose-route)
- [x] Linear trail ghost markers
- [x] Map padding fix
- [ ] Desktop pill selector (top bar)
- [ ] Mobile bottom sheet
- [ ] Share page polish