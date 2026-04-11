import { E as get, O as writable, T as derived } from "./dev.js";
import "./index-server2.js";
//#region src/lib/api.ts
var BASE = "/api";
async function request(method, path, body, opts) {
	const url = `${BASE}${path}`;
	const headers = { ...opts?.headers };
	let reqBody;
	if (typeof opts?.version === "number") headers["If-Match"] = String(opts.version);
	if (body instanceof FormData) reqBody = body;
	else if (body) {
		headers["Content-Type"] = "application/json";
		reqBody = JSON.stringify(body);
	}
	try {
		const res = await fetch(url, {
			...opts,
			method,
			headers,
			body: reqBody,
			credentials: "include"
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: res.statusText }));
			return {
				ok: false,
				error: err.error || err.message || res.statusText
			};
		}
		return {
			ok: true,
			data: await res.json().catch(() => ({}))
		};
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : "Network error"
		};
	}
}
function normalizeTrip(t) {
	return {
		id: t.id,
		userId: t.user_id ?? t.userId,
		name: t.name ?? "Untitled",
		description: t.description ?? "",
		waypointCount: Number(t.waypoint_count ?? t.waypointCount ?? 0),
		journalCount: Number(t.journal_count ?? t.journalCount ?? 0),
		attachmentCount: Number(t.attachment_count ?? t.attachmentCount ?? 0),
		isPublic: Boolean(t.is_public ?? t.isPublic),
		shareCode: t.share_code ?? t.shareCode,
		shortCode: t.short_code ?? t.shortCode,
		shortUrl: t.short_url ?? t.shortUrl,
		coverImageUrl: t.cover_image_url ?? t.coverImageUrl,
		coverImageId: t.cover_image_id ?? t.coverImageId,
		coverFocusX: t.cover_focus_x ?? t.coverFocusX,
		coverFocusY: t.cover_focus_y ?? t.coverFocusY,
		contactInfo: t.contact_info ?? t.contactInfo,
		settings: t.settings ? typeof t.settings === "string" ? JSON.parse(t.settings) : t.settings : {},
		waypoints: Array.isArray(t.waypoints) ? t.waypoints.map(normalizeWaypoint) : [],
		journalEntries: Array.isArray(t.journal_entries ?? t.journalEntries ?? t.journal) ? (t.journal_entries ?? t.journalEntries ?? t.journal).map(normalizeJournalEntry) : [],
		journal: Array.isArray(t.journal_entries ?? t.journalEntries ?? t.journal) ? (t.journal_entries ?? t.journalEntries ?? t.journal).map(normalizeJournalEntry) : [],
		attachments: Array.isArray(t.attachments) ? t.attachments.map(normalizeAttachment) : [],
		routeData: t.route_data ?? t.routeData ?? t.route,
		version: t.version ?? 1,
		createdAt: t.created_at ?? t.createdAt ?? "",
		updatedAt: t.updated_at ?? t.updatedAt ?? ""
	};
}
function normalizeWaypoint(w) {
	return {
		id: w.id,
		tripId: w.trip_id ?? w.tripId,
		name: w.name ?? "",
		address: w.address ?? "",
		lat: Number(w.lat ?? w.latitude ?? 0),
		lng: Number(w.lng ?? w.longitude ?? 0),
		type: w.type ?? "stop",
		notes: w.notes ?? "",
		order: Number(w.sort_order ?? w.order ?? 0),
		attachments: Array.isArray(w.attachments) ? w.attachments.map(normalizeAttachment) : [],
		createdAt: w.created_at ?? w.createdAt ?? "",
		latitude: Number(w.lat ?? w.latitude ?? 0),
		longitude: Number(w.lng ?? w.longitude ?? 0)
	};
}
function normalizeJournalEntry(j) {
	return {
		id: j.id,
		tripId: j.trip_id ?? j.tripId,
		title: j.title ?? "",
		content: j.content ?? "",
		tags: Array.isArray(j.tags) ? j.tags : typeof j.tags === "string" ? JSON.parse(j.tags) : [],
		isPrivate: Boolean(j.is_private ?? j.isPrivate),
		attachments: Array.isArray(j.attachments) ? j.attachments.map(normalizeAttachment) : [],
		createdAt: j.created_at ?? j.createdAt ?? "",
		updatedAt: j.updated_at ?? j.updatedAt ?? ""
	};
}
function normalizeAttachment(a) {
	return {
		id: a.id,
		tripId: a.trip_id ?? a.tripId,
		originalName: a.original_name ?? a.originalName ?? "",
		contentType: a.content_type ?? a.contentType ?? "",
		size: Number(a.size ?? 0),
		url: a.url ?? `/api/attachments/${a.id}`,
		isCover: Boolean(a.is_cover ?? a.isCover),
		isPrivate: Boolean(a.is_private ?? a.isPrivate),
		caption: a.caption ?? "",
		journalEntryId: a.journal_entry_id ?? a.journalEntryId,
		waypointId: a.waypoint_id ?? a.waypointId,
		createdAt: a.created_at ?? a.createdAt ?? ""
	};
}
var trips = {
	list: async () => {
		const r = await request("GET", "/trips");
		return r.ok && r.data?.trips ? {
			ok: true,
			data: r.data.trips.map(normalizeTrip)
		} : {
			ok: false,
			error: r.error
		};
	},
	get: async (id) => {
		const r = await request("GET", `/trips/${id}`);
		return r.ok && r.data?.trip ? {
			ok: true,
			data: normalizeTrip(r.data.trip)
		} : {
			ok: false,
			error: r.error
		};
	},
	create: async (data) => {
		const r = await request("POST", "/trips", data);
		return r.ok && r.data?.trip ? {
			ok: true,
			data: normalizeTrip(r.data.trip)
		} : {
			ok: false,
			error: r.error
		};
	},
	update: async (id, data) => {
		const r = await request("PUT", `/trips/${id}`, data);
		return r.ok && r.data?.trip ? {
			ok: true,
			data: normalizeTrip(r.data.trip)
		} : {
			ok: false,
			error: r.error
		};
	},
	delete: (id) => request("DELETE", `/trips/${id}`),
	share: async (id) => {
		const r = await request("POST", `/trips/${id}/share`);
		return r.ok ? {
			ok: true,
			data: r.data?.share_code
		} : {
			ok: false,
			error: r.error
		};
	}
};
var waypoints = {
	add: async (tripId, data, version) => {
		const r = await request("POST", `/trips/${tripId}/waypoints`, data, { version });
		return r.ok && r.data?.waypoint ? {
			ok: true,
			data: normalizeWaypoint(r.data.waypoint),
			tripVersion: r.data.trip_version
		} : {
			ok: false,
			error: r.error
		};
	},
	update: async (tripId, id, data, version) => {
		const r = await request("PUT", `/trips/${tripId}/waypoints/${id}`, data, { version });
		return r.ok && r.data?.waypoint ? {
			ok: true,
			data: normalizeWaypoint(r.data.waypoint),
			tripVersion: r.data.trip_version
		} : {
			ok: false,
			error: r.error
		};
	},
	delete: async (tripId, id, version) => {
		const r = await request("DELETE", `/trips/${tripId}/waypoints/${id}`, void 0, { version });
		return r.ok ? {
			ok: true,
			tripVersion: r.data?.trip_version
		} : {
			ok: false,
			error: r.error
		};
	},
	reorder: async (tripId, ids, version) => {
		const r = await request("PUT", `/trips/${tripId}/waypoints/reorder`, { order: ids }, { version });
		return r.ok ? {
			ok: true,
			tripVersion: r.data?.trip_version
		} : {
			ok: false,
			error: r.error
		};
	}
};
//#endregion
//#region src/lib/stores/ui.ts
var initial$2 = {
	view: "map",
	modal: null,
	modalData: null,
	sideMenuOpen: false,
	toasts: [],
	landingSeen: getLandingSeen()
};
function getLandingSeen() {
	try {
		return typeof window !== "undefined" && window.localStorage.getItem("ride_landing_seen") === "1";
	} catch {
		return false;
	}
}
var uiStore = writable(initial$2);
var uiState = uiStore;
var currentView = derived(uiStore, ($u) => $u.view);
derived(uiStore, ($u) => $u.modal);
derived(uiStore, ($u) => $u.modalData);
derived(uiStore, ($u) => $u.sideMenuOpen);
derived(uiStore, ($u) => $u.toasts);
derived(uiStore, ($u) => $u.landingSeen);
var toastCounter = 0;
function openModal(modal, data) {
	uiStore.update((s) => ({
		...s,
		modal,
		modalData: data ?? null
	}));
}
function addToast(text, type, duration = 3e3) {
	const id = ++toastCounter;
	uiStore.update((s) => ({
		...s,
		toasts: [...s.toasts, {
			id,
			text,
			type,
			duration
		}]
	}));
	setTimeout(() => {
		uiStore.update((s) => ({
			...s,
			toasts: s.toasts.filter((t) => t.id !== id)
		}));
	}, duration);
}
function toastError(text) {
	addToast(text, "error", 5e3);
}
function toastInfo(text) {
	addToast(text, "info");
}
var tripStore = writable({
	current: null,
	list: [],
	loading: false,
	listLoading: false
});
var tripState = tripStore;
var currentTrip = derived(tripStore, ($t) => $t.current);
derived(tripStore, ($t) => $t.list);
derived(tripStore, ($t) => $t.loading);
var currentWaypoints = derived(tripStore, ($t) => ($t.current?.waypoints ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
function mergeTripIntoList(list, trip) {
	if (!list.some((item) => item.id === trip.id)) return [trip, ...list];
	return list.map((item) => item.id === trip.id ? {
		...item,
		...trip
	} : item);
}
function setCurrentTripData(trip) {
	tripStore.update((state) => ({
		...state,
		current: trip,
		list: mergeTripIntoList(state.list, trip)
	}));
}
async function refreshCurrentTrip(tripId) {
	const res = await trips.get(tripId);
	if (res.ok && res.data) {
		setCurrentTripData(res.data);
		return res.data;
	}
	toastError(res.error ?? "Failed to refresh trip");
	return null;
}
async function updateWaypoint(id, data) {
	const state = get(tripStore);
	if (!state.current) return false;
	const res = await waypoints.update(state.current.id, id, data, state.current.version);
	if (res.ok && res.data) {
		await refreshCurrentTrip(state.current.id);
		return true;
	}
	toastError(res.error ?? "Failed to update waypoint");
	return false;
}
var mapStore = writable({
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
		visitedWaypoints: /* @__PURE__ */ new Set(),
		offRouteCount: 0,
		rerouting: false
	}
});
var mapState = mapStore;
derived(mapStore, ($m) => $m.ready);
derived(mapStore, ($m) => $m.isAddingWaypoint);
derived(mapStore, ($m) => $m.routeData);
var isRiding = derived(mapStore, ($m) => $m.ride.active);
var rideState = derived(mapStore, ($m) => $m.ride);
function setMapReady(ready) {
	mapStore.update((s) => ({
		...s,
		ready
	}));
}
function setAddingWaypoint(adding) {
	mapStore.update((s) => ({
		...s,
		isAddingWaypoint: adding
	}));
}
function setRouteData(data) {
	mapStore.update((s) => ({
		...s,
		routeData: data
	}));
}
//#endregion
//#region src/lib/utils.ts
/** Format distance (km → "12.3 km" or "450 m") */
function formatDistance(km) {
	if (km < 1) return `${Math.round(km * 1e3)} m`;
	return `${km.toFixed(1)} km`;
}
//#endregion
export { setAddingWaypoint as a, currentTrip as c, updateWaypoint as d, currentView as f, uiState as h, rideState as i, currentWaypoints as l, toastInfo as m, isRiding as n, setMapReady as o, openModal as p, mapState as r, setRouteData as s, formatDistance as t, tripState as u };
