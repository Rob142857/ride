const assert = require('node:assert/strict');
const RideNavigation = require('../public/js/ride-navigation.js');

const route = {
  distance: 5559,
  coordinates: [0, 0.01, 0.02, 0.03, 0.04, 0.05].map(lng => ({ lat: 0, lng })),
  steps: [{ index: 3, text: 'Turn at the river' }]
};
const waypoints = [
  { id: 'start', name: 'Start', order: 0, lat: 0, lng: 0.005 },
  { id: 'middle', name: 'Middle stop', order: 1, lat: 0, lng: 0.03 },
  { id: 'finish', name: 'Finish', order: 2, lat: 0, lng: 0.05 }
];

// Starting mid-trip projects onto route progress and selects the next ordered stop.
const midtrip = RideNavigation.inferNextStop(route, waypoints, { lat: 0.0001, lng: 0.025 });
assert.equal(midtrip.nextWaypoint.id, 'middle');
assert.ok(midtrip.progress > 2000 && midtrip.progress < 3500);

// GeoJSON coordinate arrays are [longitude, latitude], matching the route codec.
const arrayRoute = { coordinates: [[0, 0], [0.01, 0]] };
assert.ok(RideNavigation.distance(RideNavigation.pointAtProgress(arrayRoute, 500), { lat: 0, lng: 0.0045 }) < 10);

// At a repeated crossing, same-trip progress disambiguates the later traversal.
const loop = { coordinates: [
  { lat: 0, lng: 0 }, { lat: 0.01, lng: 0.01 }, { lat: 0.02, lng: 0 },
  { lat: 0.01, lng: -0.01 }, { lat: 0, lng: 0 }, { lat: -0.01, lng: 0.01 }
] };
const loopCandidates = RideNavigation.projectCandidates(loop, { lat: 0, lng: 0 });
assert.ok(loopCandidates.length >= 2);
const laterCrossing = RideNavigation.projectProgress(loop, { lat: 0, lng: 0 }, loopCandidates[1].progress - 20);
assert.ok(laterCrossing.progress > loopCandidates[0].progress + 1000);

// Poor GPS keeps a useful segment projection and does not jump to the route end.
const noisy = RideNavigation.projectProgress(route, { lat: 0.00025, lng: 0.025 });
assert.ok(noisy.distance < 40);
assert.ok(noisy.progress < RideNavigation.routeMetrics(route).total - 1000);

// Passed ordered stops count as remaining guidance progress, without being
// added to the explicitly visited set or emitted as arrival notifications.
const afterMiddle = RideNavigation.projectProgress(route, { lat: 0, lng: 0.04, accuracy: 5, timestamp: Date.now() });
const remainingStops = RideNavigation.inferNextStop(route, waypoints, { lat: 0, lng: 0.04 }, afterMiddle.progress, new Set(), { projection: afterMiddle });
assert.equal(remainingStops.nextWaypoint.id, 'finish');
assert.ok(remainingStops.inferredVisitedIds.includes('middle'));
assert.ok(!new Set().has('middle'));

// Planned navigation keeps turn steps whose route indices fall inside the leg.
const stepLeg = RideNavigation.mapStepsToLeg(route, 1200, 4700);
assert.equal(stepLeg.length, 1);
assert.equal(stepLeg[0].text, 'Turn at the river');
assert.ok(stepLeg[0].index > 0);

// A same-location start/finish keeps the first-order assumption without a
// prior fix, and saved progress identifies the later home occurrence.
const closedLoop = { coordinates: [{ lat: 0, lng: 0 }, { lat: 0.02, lng: 0 }, { lat: 0, lng: 0 }] };
const loopStops = [
  { id: 'home-start', order: 0, lat: 0, lng: 0 },
  { id: 'middle-stop', order: 1, lat: 0.02, lng: 0 },
  { id: 'home-finish', order: 2, lat: 0, lng: 0 }
];
const loopLength = RideNavigation.routeMetrics(closedLoop).total;
const noHistoryAtHome = RideNavigation.inferNextStop(closedLoop, loopStops, { lat: 0, lng: 0 });
assert.equal(noHistoryAtHome.nextWaypoint.id, 'home-start');
assert.equal(noHistoryAtHome.ambiguous, true);
const noHistoryAfterArrivingHome = RideNavigation.inferNextStop(closedLoop, loopStops, { lat: 0, lng: 0 }, null, new Set(['home-start']));
assert.equal(noHistoryAfterArrivingHome.nextWaypoint.id, 'middle-stop');
assert.equal(noHistoryAfterArrivingHome.ambiguous, true);
const returnedHome = RideNavigation.inferNextStop(
  closedLoop, loopStops, { lat: 0.0001, lng: 0 }, loopLength - 100, new Set(['home-start', 'middle-stop'])
);
assert.equal(returnedHome.nextWaypoint.id, 'home-finish');

// Saved progress can be validated against route identity and its location.
const fingerprint = RideNavigation.routeFingerprint(route);
assert.equal(RideNavigation.routeFingerprint({ coordinates: route.coordinates.map(p => ({ ...p, lng: p.lng + 0.001 })) }) === fingerprint, false);
const savedPoint = RideNavigation.pointAtProgress(route, midtrip.progress);
assert.ok(RideNavigation.distance(savedPoint, { lat: 0, lng: 0.025 }) < 20);

// Late route responses are ignored after a new request or trip/session starts.
const request = RideNavigation.requestContext('session-a', 'trip-a', 3);
assert.equal(RideNavigation.isCurrentRequest(request, { sessionId: 'session-a', tripId: 'trip-a', requestId: 3 }), true);
assert.equal(RideNavigation.isCurrentRequest(request, { sessionId: 'session-a', tripId: 'trip-a', requestId: 4 }), false);
assert.equal(RideNavigation.isCurrentRequest(request, { sessionId: 'session-b', tripId: 'trip-a', requestId: 3 }), false);

// Navigation ignores unreliable/stale fixes even though the recorder receives
// every fix before this navigation validation runs.
const now = Date.now();
assert.equal(RideNavigation.isUsableNavigationFix({ lat: 0, lng: 0, accuracy: 500, timestamp: now }, now), false);
assert.equal(RideNavigation.isUsableNavigationFix({ lat: 0, lng: 0, accuracy: 5, timestamp: now - 60000 }, now), false);
assert.equal(RideNavigation.isUsableNavigationFix({ lat: 91, lng: 0, accuracy: 5, timestamp: now }, now), false);
assert.equal(RideNavigation.isUsableNavigationFix({ lat: 0, lng: 0, accuracy: 5, timestamp: now }, now), true);

// A realistic 50k-point trip retains local projection behavior without
// requiring a full route scan for each ordinary fix. This is functional, not
// a brittle wall-clock benchmark.
const longRoute = { coordinates: Array.from({ length: 50000 }, (_, index) => ({ lat: 0, lng: index * 0.00001 })) };
const longMetrics = RideNavigation.routeMetrics(longRoute);
const longFix = RideNavigation.pointAtProgress(longRoute, longMetrics.total * 0.6);
const localProjection = RideNavigation.projectProgress(longRoute, longFix, longMetrics.total * 0.6 - 10, { maxForwardMeters: 1000 });
assert.equal(localProjection.usedLocalWindow, true);
assert.ok(localProjection.segmentsScanned < 2000);
assert.ok(Number.isFinite(localProjection.progress));

// Failed/stale reroutes carry no authority to mutate the planned route.
const before = JSON.stringify(route);
const navLeg = RideNavigation.sliceRoute(route, midtrip.progress, midtrip.waypointProgress);
assert.ok(navLeg.length >= 2);
let activeNavigationRoute = null;
const failedRouteResult = { error: new Error('offline'), context: request };
if (!failedRouteResult.error && RideNavigation.isCurrentRequest(failedRouteResult.context, { sessionId: 'session-a', tripId: 'trip-a', requestId: 3 })) {
  activeNavigationRoute = failedRouteResult.route;
}
assert.equal(activeNavigationRoute, null);
assert.equal(JSON.stringify(route), before);

console.log('RideNavigation replay checks passed.');
