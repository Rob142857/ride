/* ── Ride API Client ────────────────────────────────────────────────── */
import type { Trip, Waypoint, JournalEntry, Attachment, User, PlaceResult } from './types';

const BASE = '/api';

interface VersionedRequestOptions extends RequestInit {
	version?: number;
}

interface ApiResponse<T = unknown> {
	ok: boolean;
	data?: T;
	error?: string;
}

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
	opts?: VersionedRequestOptions
): Promise<ApiResponse<T>> {
	const url = `${BASE}${path}`;
	const headers: Record<string, string> = { ...(opts?.headers as Record<string, string> | undefined) };
	let reqBody: BodyInit | undefined;
	if (typeof opts?.version === 'number') {
		headers['If-Match'] = String(opts.version);
	}

	if (body instanceof FormData) {
		reqBody = body;
	} else if (body) {
		headers['Content-Type'] = 'application/json';
		reqBody = JSON.stringify(body);
	}

	try {
		const res = await fetch(url, {
			...opts,
			method,
			headers,
			body: reqBody,
			credentials: 'include'
		});

		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: res.statusText }));
			return { ok: false, error: err.error || err.message || res.statusText };
		}

		const data = await res.json().catch(() => ({}));
		return { ok: true, data: data as T };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
	}
}

/* ── Normalize API responses (snake_case → camelCase) ──────────── */
function normalizeTrip(t: Record<string, unknown>): Trip {
	return {
		id: t.id as string,
		userId: (t.user_id ?? t.userId) as string,
		name: (t.name ?? 'Untitled') as string,
		description: (t.description ?? '') as string,
		waypointCount: Number(t.waypoint_count ?? t.waypointCount ?? 0),
		journalCount: Number(t.journal_count ?? t.journalCount ?? 0),
		attachmentCount: Number(t.attachment_count ?? t.attachmentCount ?? 0),
		isPublic: Boolean(t.is_public ?? t.isPublic),
		shareCode: (t.share_code ?? t.shareCode) as string | undefined,
		shortCode: (t.short_code ?? t.shortCode) as string | undefined,
		shortUrl: (t.short_url ?? t.shortUrl) as string | undefined,
		coverImageUrl: (t.cover_image_url ?? t.coverImageUrl) as string | undefined,
		coverImageId: (t.cover_image_id ?? t.coverImageId) as string | undefined,
		coverFocusX: (t.cover_focus_x ?? t.coverFocusX) as number | undefined,
		coverFocusY: (t.cover_focus_y ?? t.coverFocusY) as number | undefined,
		contactInfo: (t.contact_info ?? t.contactInfo) as string | undefined,
		settings: t.settings ? (typeof t.settings === 'string' ? JSON.parse(t.settings as string) : t.settings) as Trip['settings'] : {},
		waypoints: Array.isArray(t.waypoints) ? t.waypoints.map(normalizeWaypoint) : [],
		journalEntries: Array.isArray(t.journal_entries ?? t.journalEntries ?? t.journal) ? ((t.journal_entries ?? t.journalEntries ?? t.journal) as Record<string, unknown>[]).map(normalizeJournalEntry) : [],
		journal: Array.isArray(t.journal_entries ?? t.journalEntries ?? t.journal) ? ((t.journal_entries ?? t.journalEntries ?? t.journal) as Record<string, unknown>[]).map(normalizeJournalEntry) : [],
		attachments: Array.isArray(t.attachments) ? t.attachments.map(normalizeAttachment) : [],
		routeData: (t.route_data ?? t.routeData ?? t.route) as Trip['routeData'],
		version: (t.version ?? 1) as number,
		createdAt: (t.created_at ?? t.createdAt ?? '') as string,
		updatedAt: (t.updated_at ?? t.updatedAt ?? '') as string
	};
}

function normalizeWaypoint(w: Record<string, unknown>): Waypoint {
	return {
		id: w.id as string,
		tripId: (w.trip_id ?? w.tripId) as string,
		name: (w.name ?? '') as string,
		address: (w.address ?? '') as string,
		lat: Number(w.lat ?? w.latitude ?? 0),
		lng: Number(w.lng ?? w.longitude ?? 0),
		type: (w.type ?? 'stop') as Waypoint['type'],
		notes: (w.notes ?? '') as string,
		order: Number(w.sort_order ?? w.order ?? 0),
		attachments: Array.isArray(w.attachments) ? w.attachments.map(normalizeAttachment) : [],
		createdAt: (w.created_at ?? w.createdAt ?? '') as string,
		latitude: Number(w.lat ?? w.latitude ?? 0),
		longitude: Number(w.lng ?? w.longitude ?? 0)
	};
}

function normalizePlaceResult(place: Record<string, unknown>): PlaceResult {
	const location = place.location as { lat?: number; lng?: number } | undefined;
	return {
		name: (place.name ?? '') as string,
		address: (place.address ?? '') as string,
		lat: Number(place.lat ?? location?.lat ?? 0),
		lng: Number(place.lng ?? location?.lng ?? 0),
		rating: place.rating != null ? Number(place.rating) : undefined,
		types: Array.isArray(place.types) ? (place.types as string[]) : []
	};
}

function normalizeJournalEntry(j: Record<string, unknown>): JournalEntry {
	return {
		id: j.id as string,
		tripId: (j.trip_id ?? j.tripId) as string,
		title: (j.title ?? '') as string,
		content: (j.content ?? '') as string,
		tags: Array.isArray(j.tags) ? j.tags as string[] : typeof j.tags === 'string' ? JSON.parse(j.tags as string) : [],
		isPrivate: Boolean(j.is_private ?? j.isPrivate),
		attachments: Array.isArray(j.attachments) ? j.attachments.map(normalizeAttachment) : [],
		createdAt: (j.created_at ?? j.createdAt ?? '') as string,
		updatedAt: (j.updated_at ?? j.updatedAt ?? '') as string
	};
}

function normalizeAttachment(a: Record<string, unknown>): Attachment {
	return {
		id: a.id as string,
		tripId: (a.trip_id ?? a.tripId) as string,
		originalName: (a.original_name ?? a.originalName ?? '') as string,
		contentType: (a.content_type ?? a.contentType ?? '') as string,
		size: Number(a.size ?? 0),
		url: (a.url ?? `/api/attachments/${a.id}`) as string,
		isCover: Boolean(a.is_cover ?? a.isCover),
		isPrivate: Boolean(a.is_private ?? a.isPrivate),
		caption: (a.caption ?? '') as string,
		journalEntryId: (a.journal_entry_id ?? a.journalEntryId) as string | undefined,
		waypointId: (a.waypoint_id ?? a.waypointId) as string | undefined,
		createdAt: (a.created_at ?? a.createdAt ?? '') as string
	};
}

/* ── Auth ────────────────────────────────────────────────────────── */
export const auth = {
	me: () => request<{ user: User }>('GET', '/auth/me'),
	login: (provider: string) => {
		window.location.href = `${BASE}/auth/login/${provider}`;
	},
	logout: () => request('POST', '/auth/logout')
};

/* ── Trips ───────────────────────────────────────────────────────── */
export const trips = {
	list: async () => {
		const r = await request<{ trips: Record<string, unknown>[] }>('GET', '/trips');
		return r.ok && r.data?.trips ? { ok: true, data: r.data.trips.map(normalizeTrip) } : { ok: false, error: r.error };
	},
	get: async (id: string) => {
		const r = await request<{ trip: Record<string, unknown> }>('GET', `/trips/${id}`);
		return r.ok && r.data?.trip ? { ok: true, data: normalizeTrip(r.data.trip) } : { ok: false, error: r.error };
	},
	create: async (data: Partial<Trip>) => {
		const r = await request<{ trip: Record<string, unknown> }>('POST', '/trips', data);
		return r.ok && r.data?.trip ? { ok: true, data: normalizeTrip(r.data.trip) } : { ok: false, error: r.error };
	},
	update: async (id: string, data: Partial<Trip>) => {
		const r = await request<{ trip: Record<string, unknown> }>('PUT', `/trips/${id}`, data);
		return r.ok && r.data?.trip ? { ok: true, data: normalizeTrip(r.data.trip) } : { ok: false, error: r.error };
	},
	delete: (id: string) => request('DELETE', `/trips/${id}`),
	share: async (id: string) => {
		const r = await request<{ share_code: string }>('POST', `/trips/${id}/share`);
		return r.ok ? { ok: true, data: r.data?.share_code } : { ok: false, error: r.error };
	}
};

/* ── Waypoints ───────────────────────────────────────────────────── */
export const waypoints = {
	add: async (tripId: string, data: Partial<Waypoint>, version?: number) => {
		const r = await request<{ waypoint: Record<string, unknown>; trip_version?: number }>('POST', `/trips/${tripId}/waypoints`, data, {
			version
		});
		return r.ok && r.data?.waypoint
			? { ok: true as const, data: normalizeWaypoint(r.data.waypoint), tripVersion: r.data.trip_version }
			: { ok: false as const, error: r.error };
	},
	update: async (tripId: string, id: string, data: Partial<Waypoint>, version?: number) => {
		const r = await request<{ waypoint: Record<string, unknown>; trip_version?: number }>('PUT', `/trips/${tripId}/waypoints/${id}`, data, {
			version
		});
		return r.ok && r.data?.waypoint
			? { ok: true as const, data: normalizeWaypoint(r.data.waypoint), tripVersion: r.data.trip_version }
			: { ok: false as const, error: r.error };
	},
	delete: async (tripId: string, id: string, version?: number) => {
		const r = await request<{ success: boolean; trip_version?: number }>('DELETE', `/trips/${tripId}/waypoints/${id}`, undefined, {
			version
		});
		return r.ok ? { ok: true as const, tripVersion: r.data?.trip_version } : { ok: false as const, error: r.error };
	},
	reorder: async (tripId: string, ids: string[], version?: number) => {
		const r = await request<{ success: boolean; trip_version?: number }>('PUT', `/trips/${tripId}/waypoints/reorder`, { order: ids }, {
			version
		});
		return r.ok ? { ok: true as const, tripVersion: r.data?.trip_version } : { ok: false as const, error: r.error };
	}
};

/* ── Journal ─────────────────────────────────────────────────────── */
export const journal = {
	add: async (tripId: string, data: Partial<JournalEntry>) => {
		const r = await request<{ entry: Record<string, unknown> }>('POST', `/trips/${tripId}/journal`, data);
		return r.ok && r.data?.entry ? { ok: true, data: normalizeJournalEntry(r.data.entry) } : { ok: false, error: r.error };
	},
	update: async (tripId: string, id: string, data: Partial<JournalEntry>) => {
		const r = await request<{ entry: Record<string, unknown> }>('PUT', `/trips/${tripId}/journal/${id}`, data);
		return r.ok && r.data?.entry ? { ok: true, data: normalizeJournalEntry(r.data.entry) } : { ok: false, error: r.error };
	},
	delete: (tripId: string, id: string) => request('DELETE', `/trips/${tripId}/journal/${id}`)
};

/* ── Attachments ─────────────────────────────────────────────────── */
export const attachments = {
	upload: async (tripId: string, file: File, opts?: { isCover?: boolean; isPrivate?: boolean; journalEntryId?: string; waypointId?: string }) => {
		const fd = new FormData();
		fd.append('file', file);
		if (opts?.isCover) fd.append('is_cover', '1');
		if (opts?.isPrivate) fd.append('is_private', '1');
		if (opts?.journalEntryId) fd.append('journal_entry_id', opts.journalEntryId);
		if (opts?.waypointId) fd.append('waypoint_id', opts.waypointId);
		const r = await request<{ attachment: Record<string, unknown> }>('POST', `/trips/${tripId}/attachments`, fd);
		return r.ok && r.data?.attachment ? { ok: true, data: normalizeAttachment(r.data.attachment) } : { ok: false, error: r.error };
	},
	update: (id: string, data: Partial<Attachment>) => request('PUT', `/attachments/${id}`, data),
	delete: (id: string) => request('DELETE', `/attachments/${id}`)
};

/* ── Places ──────────────────────────────────────────────────────── */
export const places = {
	search: async (q: string, lat?: number, lng?: number) => {
		const params = new URLSearchParams({ q });
		if (lat != null) params.set('lat', String(lat));
		if (lng != null) params.set('lng', String(lng));
		const r = await request<{ results: Record<string, unknown>[] }>('GET', `/places/search?${params}`);
		return r.ok ? { ok: true, data: (r.data?.results ?? []).map(normalizePlaceResult) } : { ok: false, error: r.error, data: [] };
	}
};

/* ── System ──────────────────────────────────────────────────────── */
export const system = {
	build: () => request<{ build: string }>('GET', '/_build'),
	sharedTrip: async (code: string) => {
		const r = await request<{ trip: Record<string, unknown> }>('GET', `/s/${code}`);
		return r.ok && r.data?.trip ? { ok: true, data: normalizeTrip(r.data.trip) } : { ok: false, error: r.error };
	}
};

export const api = { auth, trips, waypoints, journal, attachments, places, system };
export default api;
