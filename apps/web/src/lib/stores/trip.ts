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

/* ── Local ordering ──────────────────────────────────────────────── */
const ORDER_KEY = 'ride_trip_order';

function getSavedOrder(): string[] {
	try {
		return JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
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
	localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
}

/* ── Load trips list ─────────────────────────────────────────────── */
export async function loadTrips(): Promise<void> {
	tripStore.update((s) => ({ ...s, listLoading: true }));
	const res = await tripsApi.list();
	if (res.ok && res.data) {
		tripStore.update((s) => ({ ...s, list: applyOrder(res.data!), listLoading: false }));
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
		tripStore.update((s) => ({ ...s, current: trip, loading: false }));
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
		tripStore.update((s) => ({ ...s, current: res.data!, list: [res.data!, ...s.list] }));
		toastSuccess('Trip created');
		return res.data;
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
		tripStore.update((s) => ({
			...s,
			current: res.data!,
			list: s.list.map((t) => (t.id === res.data!.id ? res.data! : t))
		}));
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
	const res = await waypointsApi.add(state.current.id, data);
	if (res.ok && res.data) {
		tripStore.update((s) => {
			if (!s.current) return s;
			return { ...s, current: { ...s.current, waypoints: [...s.current.waypoints, res.data!] } };
		});
		return res.data;
	}
	toastError(res.error ?? 'Failed to add waypoint');
	return null;
}

export async function updateWaypoint(id: string, data: Partial<Waypoint>): Promise<boolean> {
	const state = get(tripStore);
	if (!state.current) return false;
	const res = await waypointsApi.update(state.current.id, id, data);
	if (res.ok && res.data) {
		tripStore.update((s) => {
			if (!s.current) return s;
			return {
				...s,
				current: {
					...s.current,
					waypoints: s.current.waypoints.map((w) => (w.id === id ? res.data! : w))
				}
			};
		});
		return true;
	}
	toastError(res.error ?? 'Failed to update waypoint');
	return false;
}

export async function deleteWaypoint(id: string): Promise<boolean> {
	const state = get(tripStore);
	if (!state.current) return false;
	const res = await waypointsApi.delete(state.current.id, id);
	if (res.ok) {
		tripStore.update((s) => {
			if (!s.current) return s;
			return { ...s, current: { ...s.current, waypoints: s.current.waypoints.filter((w) => w.id !== id) } };
		});
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
		return { ...s, current: { ...s.current, waypoints: ordered } };
	});
	await waypointsApi.reorder(state.current.id, ids);
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
