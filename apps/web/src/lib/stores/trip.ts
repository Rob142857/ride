/* ── Trip Store ─────────────────────────────────────────────────────── */
import { writable, derived, get } from 'svelte/store';
import type { Trip, Waypoint, JournalEntry } from '$lib/types';
import { trips as tripsApi, waypoints as waypointsApi, journal as journalApi } from '$lib/api';
import { toastSuccess, toastError } from './ui';

interface TripState {
	current: Trip | null;
	list: Trip[];
	loading: boolean;
	listLoading: boolean;
}

const initial: TripState = { current: null, list: [], loading: false, listLoading: false };

export const tripStore = writable<TripState>(initial);
export const tripState = tripStore;

export const currentTrip = derived(tripStore, ($t) => $t.current);
export const tripList = derived(tripStore, ($t) => $t.list);
export const tripLoading = derived(tripStore, ($t) => $t.loading);
export const currentWaypoints = derived(tripStore, ($t) => ($t.current?.waypoints ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));

/* ── Local ordering ──────────────────────────────────────────────── */
const ORDER_KEY = 'ride_trip_order';

function getSavedOrder(): string[] {
	try {
		if (typeof window === 'undefined') return [];
		return JSON.parse(window.localStorage.getItem(ORDER_KEY) || '[]');
	} catch {
		return [];
	}
}

function applyOrder(trips: Trip[]): Trip[] {
	const order = getSavedOrder();
	if (!order.length) return trips;
	const map = new Map(trips.map((t) => [t.id, t]));
	const ordered: Trip[] = [];
	for (const id of order) {
		const t = map.get(id);
		if (t) {
			ordered.push(t);
			map.delete(id);
		}
	}
	const rest = [...map.values()].sort(
		(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
	);
	return [...ordered, ...rest];
}

export function saveTripOrder(ids: string[]): void {
	if (typeof window !== 'undefined') window.localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
}

function mergeTripIntoList(list: Trip[], trip: Trip): Trip[] {
	const exists = list.some((item) => item.id === trip.id);
	if (!exists) return [trip, ...list];
	return list.map((item) => (item.id === trip.id ? { ...item, ...trip } : item));
}

function setCurrentTripData(trip: Trip): void {
	tripStore.update((state) => ({
		...state,
		current: trip,
		list: mergeTripIntoList(state.list, trip)
	}));
}

async function refreshCurrentTrip(tripId: string): Promise<Trip | null> {
	const res = await tripsApi.get(tripId);
	if (res.ok && res.data) {
		setCurrentTripData(res.data);
		return res.data;
	}
	toastError(res.error ?? 'Failed to refresh trip');
	return null;
}

/* ── Load trips list ─────────────────────────────────────────────── */
export async function loadTrips(): Promise<void> {
	tripStore.update((s) => ({ ...s, listLoading: true }));
	const res = await tripsApi.list();
	if (res.ok && res.data) {
		const ordered = applyOrder(res.data!);
		tripStore.update((s) => ({ ...s, list: ordered, listLoading: false }));

		const state = get(tripStore);
		const currentStillExists = !!state.current && ordered.some((trip) => trip.id === state.current?.id);
		if (currentStillExists) return;

		if (ordered.length > 0) {
			await loadTrip(ordered[0].id);
			return;
		}

		await createTrip('New Trip');
	} else {
		tripStore.update((s) => ({ ...s, listLoading: false }));
		toastError(res.error ?? 'Failed to load trips');
	}
}

/* ── Load single trip ────────────────────────────────────────────── */
export async function loadTrip(id: string): Promise<Trip | null> {
	tripStore.update((s) => ({ ...s, loading: true }));
	const res = await tripsApi.get(id);
	if (res.ok && res.data) {
		const trip = res.data;
		tripStore.update((s) => ({ ...s, loading: false }));
		setCurrentTripData(trip);
		return trip;
	}
	tripStore.update((s) => ({ ...s, loading: false }));
	toastError(res.error ?? 'Failed to load trip');
	return null;
}

/* ── Create trip ─────────────────────────────────────────────────── */
export async function createTrip(name = 'New Trip'): Promise<Trip | null> {
	const res = await tripsApi.create({ name } as Partial<Trip>);
	if (res.ok && res.data) {
		setCurrentTripData(res.data);
		toastSuccess('Trip created');
		return await refreshCurrentTrip(res.data.id);
	}
	toastError(res.error ?? 'Failed to create trip');
	return null;
}

/* ── Update trip ─────────────────────────────────────────────────── */
export async function updateTrip(data: Partial<Trip>): Promise<boolean> {
	const state = get(tripStore);
	if (!state.current) return false;
	const res = await tripsApi.update(state.current.id, data);
	if (res.ok && res.data) {
		setCurrentTripData(res.data);
		return true;
	}
	toastError(res.error ?? 'Failed to save');
	return false;
}

/* ── Delete trip ─────────────────────────────────────────────────── */
export async function deleteTrip(id: string): Promise<boolean> {
	const res = await tripsApi.delete(id);
	if (res.ok) {
		tripStore.update((s) => ({
			...s,
			current: s.current?.id === id ? null : s.current,
			list: s.list.filter((t) => t.id !== id)
		}));
		toastSuccess('Trip deleted');
		return true;
	}
	toastError(res.error ?? 'Failed to delete');
	return false;
}

/* ── Waypoints ───────────────────────────────────────────────────── */
export async function addWaypoint(data: Partial<Waypoint>): Promise<Waypoint | null> {
	const state = get(tripStore);
	if (!state.current) return null;
	const res = await waypointsApi.add(state.current.id, data, state.current.version);
	if (res.ok && res.data) {
		await refreshCurrentTrip(state.current.id);
		return res.data;
	}
	toastError(res.error ?? 'Failed to add waypoint');
	return null;
}

export async function updateWaypoint(id: string, data: Partial<Waypoint>): Promise<boolean> {
	const state = get(tripStore);
	if (!state.current) return false;
	const res = await waypointsApi.update(state.current.id, id, data, state.current.version);
	if (res.ok && res.data) {
		await refreshCurrentTrip(state.current.id);
		return true;
	}
	toastError(res.error ?? 'Failed to update waypoint');
	return false;
}

export async function deleteWaypoint(id: string): Promise<boolean> {
	const state = get(tripStore);
	if (!state.current) return false;
	const res = await waypointsApi.delete(state.current.id, id, state.current.version);
	if (res.ok) {
		await refreshCurrentTrip(state.current.id);
		return true;
	}
	toastError(res.error ?? 'Failed to delete waypoint');
	return false;
}

export async function reorderWaypoints(ids: string[]): Promise<void> {
	const state = get(tripStore);
	if (!state.current) return;
	// Optimistic
	tripStore.update((s) => {
		if (!s.current) return s;
		const map = new Map(s.current.waypoints.map((w) => [w.id, w]));
		const ordered = ids.map((id, i) => ({ ...map.get(id)!, order: i }));
		const nextCurrent = { ...s.current, waypoints: ordered };
		return { ...s, current: nextCurrent };
	});
	const res = await waypointsApi.reorder(state.current.id, ids, state.current.version);
	if (res.ok) {
		await refreshCurrentTrip(state.current.id);
		return;
	}
	await refreshCurrentTrip(state.current.id);
}

/* ── Journal ─────────────────────────────────────────────────────── */
export async function addJournalEntry(data: Partial<JournalEntry>): Promise<JournalEntry | null> {
	const state = get(tripStore);
	if (!state.current) return null;
	const res = await journalApi.add(state.current.id, data);
	if (res.ok && res.data) {
		tripStore.update((s) => {
			if (!s.current) return s;
			return { ...s, current: { ...s.current, journalEntries: [res.data!, ...s.current.journalEntries] } };
		});
		return res.data;
	}
	toastError(res.error ?? 'Failed to add entry');
	return null;
}

export async function updateJournalEntry(id: string, data: Partial<JournalEntry>): Promise<boolean> {
	const state = get(tripStore);
	if (!state.current) return false;
	const res = await journalApi.update(state.current.id, id, data);
	if (res.ok && res.data) {
		tripStore.update((s) => {
			if (!s.current) return s;
			return {
				...s,
				current: {
					...s.current,
					journalEntries: s.current.journalEntries.map((j) => (j.id === id ? res.data! : j))
				}
			};
		});
		return true;
	}
	toastError(res.error ?? 'Failed to update entry');
	return false;
}

export async function deleteJournalEntry(id: string): Promise<boolean> {
	const state = get(tripStore);
	if (!state.current) return false;
	const res = await journalApi.delete(state.current.id, id);
	if (res.ok) {
		tripStore.update((s) => {
			if (!s.current) return s;
			return {
				...s,
				current: { ...s.current, journalEntries: s.current.journalEntries.filter((j) => j.id !== id) }
			};
		});
		return true;
	}
	toastError(res.error ?? 'Failed to delete entry');
	return false;
}
