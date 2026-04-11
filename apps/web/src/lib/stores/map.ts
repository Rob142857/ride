/* ── Map Store ─────────────────────────────────────────────────────── */
import { writable, derived } from 'svelte/store';
import type { Waypoint, RouteData, RouteInstruction } from '$lib/types';

interface RideState {
	active: boolean;
	position: GeolocationCoordinates | null;
	heading: number | null;
	speed: number | null;
	nextInstruction: RouteInstruction | null;
	distanceToNext: number;
	visitedWaypoints: Set<string>;
	offRouteCount: number;
	rerouting: boolean;
}

interface MapState {
	ready: boolean;
	isAddingWaypoint: boolean;
	routeData: RouteData | null;
	ride: RideState;
}

const initial: MapState = {
	ready: false,
	isAddingWaypoint: false,
	routeData: null,
	ride: {
		active: false,
		position: null,
		heading: null,
		speed: null,
		nextInstruction: null,
		distanceToNext: 0,
		visitedWaypoints: new Set(),
		offRouteCount: 0,
		rerouting: false
	}
};

export const mapStore = writable<MapState>(initial);
export const mapState = mapStore;

export const mapReady = derived(mapStore, ($m) => $m.ready);
export const isAddingWaypoint = derived(mapStore, ($m) => $m.isAddingWaypoint);
export const routeData = derived(mapStore, ($m) => $m.routeData);
export const isRiding = derived(mapStore, ($m) => $m.ride.active);
export const rideState = derived(mapStore, ($m) => $m.ride);

export function setMapReady(ready: boolean): void {
	mapStore.update((s) => ({ ...s, ready }));
}

export function setAddingWaypoint(adding: boolean): void {
	mapStore.update((s) => ({ ...s, isAddingWaypoint: adding }));
}

export function setRouteData(data: RouteData | null): void {
	mapStore.update((s) => ({ ...s, routeData: data }));
}

/* ── Ride mode ───────────────────────────────────────────────────── */
export function startRide(): void {
	mapStore.update((s) => ({
		...s,
		ride: { ...s.ride, active: true, visitedWaypoints: new Set(), offRouteCount: 0 }
	}));
}

export function stopRide(): void {
	mapStore.update((s) => ({
		...s,
		ride: { ...initial.ride }
	}));
}

export function updateRidePosition(coords: GeolocationCoordinates): void {
	mapStore.update((s) => ({
		...s,
		ride: {
			...s.ride,
			position: coords,
			heading: coords.heading,
			speed: coords.speed
		}
	}));
}

export function markWaypointVisited(id: string): void {
	mapStore.update((s) => {
		const visited = new Set(s.ride.visitedWaypoints);
		visited.add(id);
		return { ...s, ride: { ...s.ride, visitedWaypoints: visited } };
	});
}

export function setRideInstruction(instruction: RouteInstruction | null, distance: number): void {
	mapStore.update((s) => ({
		...s,
		ride: { ...s.ride, nextInstruction: instruction, distanceToNext: distance }
	}));
}
