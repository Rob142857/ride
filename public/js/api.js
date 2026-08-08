/**
 * API Client - handles all backend communication
 *
 * Normalization layer: all server responses go through normalize helpers
 * that map snake_case DB fields → consistent camelCase for the client.
 * The client always works with camelCase; snake_case only exists in API
 * request bodies sent TO the server (which expects them).
 *
 * Guest mode (local shim): when the app is not using the cloud
 * (window.App.useCloud === false, or API.localMode set explicitly),
 * trips/waypoints/journal/rideLogs operate on localStorage via Storage
 * (key ride_local_trips) with the same signatures and return shapes as
 * the cloud API. Cloud-only actions (photo upload, share links, places
 * search) throw an Error with err.code = 'LOGIN_REQUIRED' so callers can
 * suggest signing in. Cloud behavior is untouched when useCloud is true.
 */

function _safeJsonParse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function _normalizeShareSettings(settings, explicitShare) {
  const share = explicitShare || settings?.share || {};
  return {
    includeWaypoints: share.includeWaypoints !== false,
    includeRoute: share.includeRoute !== false,
    includePublicNotes: share.includePublicNotes !== false,
    includeGallery: share.includeGallery !== false,
  };
}

/** Normalize a single journal entry from server snake_case → client camelCase */
function _normalizeEntry(e) {
  if (!e) return e;
  return {
    ...e,
    isPrivate: !!(e.is_private ?? e.isPrivate),
    waypointId: e.waypoint_id ?? e.waypointId ?? null,
    createdAt: e.created_at ?? e.createdAt,
    updatedAt: e.updated_at ?? e.updatedAt,
    tags: _safeJsonParse(e.tags, []),
    location: _safeJsonParse(e.location, null),
    attachments: e.attachments || [],
  };
}

/** Normalize a single attachment from server snake_case → client camelCase */
function _normalizeAttachment(a) {
  if (!a) return a;
  return {
    ...a,
    journalEntryId: a.journal_entry_id ?? a.journalEntryId ?? null,
    waypointId: a.waypoint_id ?? a.waypointId ?? null,
    originalName: a.original_name ?? a.originalName ?? a.filename,
    mimeType: a.mime_type ?? a.mimeType,
    sizeBytes: a.size_bytes ?? a.sizeBytes,
    isCover: !!(a.is_cover ?? a.isCover),
    isPrivate: !!(a.is_private ?? a.isPrivate),
    createdAt: a.created_at ?? a.createdAt,
  };
}

/** Normalize a single waypoint from server snake_case → client camelCase */
function _normalizeWaypoint(w) {
  if (!w) return w;
  return {
    ...w,
    order: w.sort_order ?? w.order ?? 0,
    createdAt: w.created_at ?? w.createdAt,
  };
}

/** Normalize a full trip (with embedded waypoints, journal, attachments, route) */
function _normalizeTrip(t) {
  if (!t) return t;
  const settings = _safeJsonParse(t.settings, {});
  const share = _normalizeShareSettings(settings, t.share);
  const trip = {
    ...t,
    createdAt: t.created_at ?? t.createdAt,
    updatedAt: t.updated_at ?? t.updatedAt,
    isPublic: !!(t.is_public ?? t.isPublic),
    coverImageUrl: t.cover_image_url ?? t.coverImageUrl ?? '',
    coverFocusX: Number.isFinite(t.cover_focus_x) ? t.cover_focus_x : (Number.isFinite(t.coverFocusX) ? t.coverFocusX : 50),
    coverFocusY: Number.isFinite(t.cover_focus_y) ? t.cover_focus_y : (Number.isFinite(t.coverFocusY) ? t.coverFocusY : 50),
    shortCode: t.short_code ?? t.shortCode ?? null,
    shortUrl: t.short_url ?? t.shortUrl ?? null,
    shareId: t.share_id ?? t.shareId ?? null,
    settings,
    share,
    version: Number(t.version ?? 0),
  };
  // Also keep snake_case aliases for server round-trips (update payloads)
  trip.is_public = trip.isPublic ? 1 : 0;
  trip.cover_image_url = trip.coverImageUrl;
  trip.cover_focus_x = trip.coverFocusX;
  trip.cover_focus_y = trip.coverFocusY;
  trip.short_code = trip.shortCode;
  trip.short_url = trip.shortUrl;
  trip.share_id = trip.shareId;

  if (Array.isArray(trip.waypoints)) trip.waypoints = trip.waypoints.map(_normalizeWaypoint);
  if (Array.isArray(trip.journal)) trip.journal = trip.journal.map(_normalizeEntry);
  if (Array.isArray(trip.attachments)) trip.attachments = trip.attachments.map(_normalizeAttachment);
  if (trip.route) {
    const duration = trip.route.duration ?? trip.route.time ?? null;
    trip.route = { ...trip.route, duration, time: duration, coordinates: trip.route.coordinates || [] };
  }
  // Normalize alternative routes
  trip.alternativeRoutes = Array.isArray(t.alternative_routes) ? t.alternative_routes : (Array.isArray(t.alternativeRoutes) ? t.alternativeRoutes : []);
  trip.activeRouteIndex = t.active_route_index ?? t.activeRouteIndex ?? 0;
  // Keep snake_case aliases for round-trips
  trip.alternative_routes = trip.alternativeRoutes;
  trip.active_route_index = trip.activeRouteIndex;
  return trip;
}

/** Normalize a trip-list item (no embedded children) */
function _normalizeTripSummary(t) {
  if (!t) return t;
  const settings = _safeJsonParse(t.settings, {});
  return {
    ...t,
    createdAt: t.created_at ?? t.createdAt,
    updatedAt: t.updated_at ?? t.updatedAt,
    isPublic: !!(t.is_public ?? t.isPublic),
    shortCode: t.short_code ?? t.shortCode ?? null,
    shortUrl: t.short_url ?? t.shortUrl ?? null,
    settings,
    share: _normalizeShareSettings(settings, t.share),
    // keep snake_case aliases for UI compat
    is_public: !!(t.is_public ?? t.isPublic),
    short_code: t.short_code ?? t.shortCode ?? null,
    short_url: t.short_url ?? t.shortUrl ?? null,
  };
}

/* ── Guest-mode local store ──────────────────────────────────────────────
 * Trips live in localStorage (Storage.KEYS.LOCAL_TRIPS) as full
 * cloud-shaped objects: snake_case rows with embedded waypoints, journal,
 * attachments (always empty locally), route, alternative_routes and
 * ride_logs. Everything returned to callers passes through the same
 * normalize helpers as cloud responses.
 */

function _localNow() {
  return new Date().toISOString();
}

function _localClone(value) {
  if (value === null || value === undefined) return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function _loginRequiredError(action) {
  return Object.assign(new Error('Sign in required'), { code: 'LOGIN_REQUIRED', action: action || null });
}

function _localError(message, status) {
  return Object.assign(new Error(message), { status: status || 400 });
}

const LocalDB = {
  read() {
    return Storage.getLocalTrips();
  },

  write(trips) {
    if (!Storage.saveLocalTrips(trips)) {
      throw _localError('Local storage is full — could not save changes on this device', 507);
    }
  },

  requireTrip(trips, id) {
    const trip = trips.find(t => t.id === id);
    if (!trip) throw _localError('Trip not found', 404);
    if (!Array.isArray(trip.waypoints)) trip.waypoints = [];
    if (!Array.isArray(trip.journal)) trip.journal = [];
    if (!Array.isArray(trip.attachments)) trip.attachments = [];
    if (!Array.isArray(trip.alternative_routes)) trip.alternative_routes = [];
    if (!Array.isArray(trip.ride_logs)) trip.ride_logs = [];
    return trip;
  },

  /** Bump version + updated_at, mirroring the cloud's DB triggers. */
  touch(trip) {
    trip.version = Number(trip.version || 0) + 1;
    trip.updated_at = _localNow();
  },

  meta(trip) {
    return { trip_version: Number(trip.version || 0), trip_updated_at: trip.updated_at || null };
  },

  /* --- trips --- */

  /**
   * Strip embedded children so a row matches the cloud's `SELECT * FROM trips`.
   * Children are dropped from a shallow copy first, so the (potentially huge)
   * coordinate arrays are never cloned just to be thrown away.
   */
  bareTrip(trip) {
    const row = { ...trip };
    delete row.waypoints;
    delete row.journal;
    delete row.attachments;
    delete row.route;
    delete row.alternative_routes;
    delete row.ride_logs;
    return _localClone(row);
  },

  listTrips() {
    const rows = this.read().map(t => ({
      ...this.bareTrip(t),
      waypoint_count: (t.waypoints || []).length,
      journal_count: (t.journal || []).length,
      attachment_count: (t.attachments || []).length,
    }));
    rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    return rows.map(_normalizeTripSummary);
  },

  getTrip(id) {
    const trips = this.read();
    const trip = _localClone(this.requireTrip(trips, id));
    trip.journal.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    trip.waypoints.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    return _normalizeTrip(trip);
  },

  createTrip(body) {
    if (!body?.name) throw _localError('Trip name is required', 400);
    const now = _localNow();
    const trip = {
      id: Storage.generateId(),
      user_id: 'local',
      name: body.name,
      description: body.description || '',
      settings: (body.settings && typeof body.settings === 'object') ? _localClone(body.settings) : {},
      is_public: 0,
      public_title: null,
      public_description: null,
      public_contact: null,
      cover_image_url: '',
      cover_focus_x: 50,
      cover_focus_y: 50,
      short_code: null,
      short_url: null,
      version: 0,
      created_at: now,
      updated_at: now,
      waypoints: [],
      journal: [],
      attachments: [],
      route: null,
      alternative_routes: [],
      active_route_index: 0,
      ride_logs: [],
    };
    const trips = this.read();
    trips.push(trip);
    this.write(trips);
    // Cloud POST /trips returns the bare row (no children) — match it.
    return _normalizeTrip(this.bareTrip(trip));
  },

  updateTrip(id, body) {
    const trips = this.read();
    const trip = this.requireTrip(trips, id);
    const b = body || {};

    if (b.name !== undefined) trip.name = b.name;
    if (b.description !== undefined) trip.description = b.description;
    if (b.settings !== undefined) {
      const existing = _safeJsonParse(trip.settings, {}) || {};
      let merged = b.settings;
      if (b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings)) {
        merged = { ...existing, ..._localClone(b.settings) };
        if (Object.prototype.hasOwnProperty.call(b.settings, 'waypoint_order') && b.settings.waypoint_order === null) {
          delete merged.waypoint_order;
        }
      }
      trip.settings = merged;
    }
    if (b.is_public !== undefined) trip.is_public = b.is_public ? 1 : 0;
    if (b.public_title !== undefined) trip.public_title = b.public_title;
    if (b.public_description !== undefined) trip.public_description = b.public_description;
    if (b.public_contact !== undefined) trip.public_contact = b.public_contact;
    if (b.cover_image_url !== undefined) trip.cover_image_url = b.cover_image_url;
    if (b.cover_focus_x !== undefined) trip.cover_focus_x = b.cover_focus_x;
    if (b.cover_focus_y !== undefined) trip.cover_focus_y = b.cover_focus_y;
    if (b.active_route_index !== undefined) trip.active_route_index = Math.floor(Number(b.active_route_index)) || 0;
    if (b.route) {
      trip.route = {
        coordinates: _localClone(b.route.coordinates || []),
        steps: _localClone(b.route.steps || []),
        distance: b.route.distance ?? null,
        duration: b.route.duration ?? null,
      };
    }

    this.touch(trip);
    this.write(trips);
    // Cloud PUT /trips/:id returns the bare row (no children) — match it, so
    // callers that spread the result over currentTrip keep their children.
    return _normalizeTrip(this.bareTrip(trip));
  },

  deleteTrip(id) {
    const trips = this.read();
    const next = trips.filter(t => t.id !== id);
    if (next.length === trips.length) throw _localError('Trip not found', 404);
    this.write(next);
  },

  saveAlternativeRoutes(id, routes) {
    const trips = this.read();
    const trip = this.requireTrip(trips, id);
    const now = _localNow();
    const list = Array.isArray(routes) ? routes : [];
    // Field-for-field the shape api/journey.js parseAlternativeRoute emits,
    // including the distance/duration aliases the route UIs read.
    trip.alternative_routes = list.map((r, i) => {
      const distance = typeof r.distance_meters === 'number' ? r.distance_meters : (typeof r.distance === 'number' ? r.distance : 0);
      const duration = typeof r.duration_seconds === 'number' ? r.duration_seconds : (typeof r.duration === 'number' ? r.duration : 0);
      return {
        id: Storage.generateId(),
        route_index: i,
        name: r.name || r.label || `Route ${i + 1}`,
        summary: r.summary || '',
        color: r.color || null,
        distance,
        distance_meters: distance,
        duration,
        duration_seconds: duration,
        is_selected: !!r.is_selected,
        is_visible: r.is_visible !== false,
        coordinates: _localClone(r.coordinates || []),
        steps: _localClone(r.steps || []),
        created_at: now,
      };
    });
    this.touch(trip);
    this.write(trips);
    return { success: true, count: trip.alternative_routes.length };
  },

  /* --- waypoints --- */

  addWaypoint(tripId, body) {
    if (!body?.name || body.lat === undefined || body.lng === undefined) {
      throw _localError('Name, lat, and lng are required', 400);
    }
    const trips = this.read();
    const trip = this.requireTrip(trips, tripId);
    const maxOrder = trip.waypoints.reduce((max, w) => Math.max(max, Number(w.sort_order ?? -1)), -1);
    const waypoint = {
      id: Storage.generateId(),
      trip_id: tripId,
      name: body.name,
      address: body.address || '',
      lat: body.lat,
      lng: body.lng,
      type: body.type || 'stop',
      notes: body.notes || '',
      sort_order: maxOrder + 1,
      created_at: _localNow(),
    };
    trip.waypoints.push(waypoint);
    this.touch(trip);
    this.write(trips);
    return { waypoint: _localClone(waypoint), ...this.meta(trip) };
  },

  updateWaypoint(tripId, waypointId, body) {
    const trips = this.read();
    const trip = this.requireTrip(trips, tripId);
    const waypoint = trip.waypoints.find(w => w.id === waypointId) || null;
    if (waypoint) {
      ['name', 'address', 'lat', 'lng', 'type', 'notes', 'sort_order'].forEach(field => {
        if (body && body[field] !== undefined) waypoint[field] = body[field];
      });
    }
    this.touch(trip);
    this.write(trips);
    return { waypoint: _localClone(waypoint), ...this.meta(trip) };
  },

  deleteWaypoint(tripId, waypointId) {
    const trips = this.read();
    const trip = this.requireTrip(trips, tripId);
    trip.waypoints = trip.waypoints.filter(w => w.id !== waypointId);
    this.touch(trip);
    this.write(trips);
    return { success: true, ...this.meta(trip) };
  },

  reorderWaypoints(tripId, orderArray) {
    if (!Array.isArray(orderArray)) throw _localError('Order array is required', 400);
    const trips = this.read();
    const trip = this.requireTrip(trips, tripId);
    const desired = orderArray.map(id => String(id));
    const byId = new Map(trip.waypoints.map(w => [String(w.id), w]));
    desired.forEach((id, i) => {
      const wp = byId.get(id);
      if (wp) wp.sort_order = i;
    });
    trip.waypoints.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const settings = _safeJsonParse(trip.settings, {}) || {};
    settings.waypoint_order = desired;
    trip.settings = settings;
    this.touch(trip);
    this.write(trips);
    return { success: true, ...this.meta(trip) };
  },

  /* --- journal --- */

  addJournalEntry(tripId, body) {
    if (!body?.title) throw _localError('Title is required', 400);
    const trips = this.read();
    const trip = this.requireTrip(trips, tripId);
    const now = _localNow();
    const entry = {
      id: Storage.generateId(),
      trip_id: tripId,
      waypoint_id: body.waypoint_id || null,
      title: body.title,
      content: body.content || '',
      is_private: body.is_private ? 1 : 0,
      tags: _localClone(body.tags || []),
      location: body.location ? _localClone(body.location) : null,
      created_at: now,
      updated_at: now,
    };
    trip.journal.unshift(entry);
    this.touch(trip);
    this.write(trips);
    return _normalizeEntry(_localClone(entry));
  },

  updateJournalEntry(tripId, entryId, body) {
    const trips = this.read();
    const trip = this.requireTrip(trips, tripId);
    const entry = trip.journal.find(e => e.id === entryId);
    if (!entry) throw _localError('Journal entry not found', 404);
    const b = body || {};
    if (b.title !== undefined) entry.title = b.title;
    if (b.content !== undefined) entry.content = b.content;
    if (b.is_private !== undefined) entry.is_private = b.is_private ? 1 : 0;
    if (b.tags !== undefined) entry.tags = _localClone(b.tags);
    if (b.location !== undefined) entry.location = _localClone(b.location);
    entry.updated_at = _localNow();
    this.touch(trip);
    this.write(trips);
    return _normalizeEntry(_localClone(entry));
  },

  deleteJournalEntry(tripId, entryId) {
    const trips = this.read();
    const trip = this.requireTrip(trips, tripId);
    trip.journal = trip.journal.filter(e => e.id !== entryId);
    this.touch(trip);
    this.write(trips);
  },

  /* --- ride logs --- */

  saveRideLog(tripId, body) {
    const track = Array.isArray(body?.track) ? body.track : [];
    if (track.length < 2) throw _localError('Track must have at least 2 points', 400);
    const trips = this.read();
    const trip = this.requireTrip(trips, tripId);
    const log = {
      id: Storage.generateId(),
      trip_id: tripId,
      journal_entry_id: body.journal_entry_id || null,
      started_at: body.started_at || null,
      ended_at: body.ended_at || null,
      distance_meters: typeof body.distance_meters === 'number' && body.distance_meters >= 0 ? body.distance_meters : null,
      duration_seconds: typeof body.duration_seconds === 'number' && body.duration_seconds >= 0 ? body.duration_seconds : null,
      // Same 3000-point cap as the cloud handler
      track: _localClone(track.length > 3000 ? track.slice(-3000) : track),
    };
    trip.ride_logs.unshift(log);
    if (trip.ride_logs.length > 50) trip.ride_logs.length = 50;
    this.write(trips);
    return { id: log.id, success: true };
  },

  listRideLogs(tripId) {
    const trips = this.read();
    const trip = this.requireTrip(trips, tripId);
    const logs = _localClone(trip.ride_logs).slice(0, 50);
    logs.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
    return logs;
  },
};

const API = {
  baseUrl: '/api',

  /**
   * Explicit override for guest/local mode. When unset, local mode
   * follows window.App.useCloud === false.
   */
  localMode: undefined,

  /** True when trip data should live in localStorage instead of the cloud. */
  _isLocal() {
    // The share page loads api.js without storage.js. Note `Storage` is also a
    // native browser interface, so identity is checked by capability, not name.
    if (typeof Storage === 'undefined' || typeof Storage.getLocalTrips !== 'function') return false;
    if (this.localMode !== undefined) return this.localMode === true;
    return !!(typeof window !== 'undefined' && window.App && window.App.useCloud === false);
  },

  /** Request timeout — generous enough for slow rural connections. */
  requestTimeoutMs: 12000,

  /**
   * Make authenticated request.
   * Idempotent GETs are retried twice (backoff + jitter) before failing;
   * connection events are dispatched only after the final attempt.
   */
  async request(endpoint, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const maxAttempts = method === 'GET' ? 3 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this._attemptRequest(endpoint, options);
      } catch (error) {
        lastError = error;
        // A caller-initiated abort is a decision, not a failure — don't retry
        // it and don't report it as a connectivity problem.
        if (options.signal?.aborted) throw error;
        const retryable = method === 'GET' && (error.status === 0 || error.status >= 500);
        if (!retryable || attempt === maxAttempts) break;
        const backoff = 350 * attempt + Math.random() * 250;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    this._reportRequestFailure(endpoint, lastError, options);
    throw lastError;
  },

  /** Single network attempt with an AbortController timeout. */
  async _attemptRequest(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;

    const isForm = options.body instanceof FormData;
    const defaultHeaders = isForm
      ? {
          'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        }
      : {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        };

    const config = {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers,
      },
      credentials: 'include', // Include cookies for session
      cache: 'no-store',
    };

    if (options.body && typeof options.body === 'object' && !isForm) {
      config.body = JSON.stringify(options.body);
    }

    // Timeout via AbortController, chained to any caller-supplied signal so
    // callers can still cancel (e.g. superseded route/search requests).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const externalSignal = options.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    config.signal = controller.signal;

    try {
      const response = await fetch(url, config);
      let data;
      const clonedResponse = response.clone();
      try {
        data = await response.json();
      } catch (_) {
        // Fallback for non-JSON responses (HTML error pages, empty bodies)
        const text = await clonedResponse.text();
        data = text ? { error: text } : {};
      }

      if (!response.ok) {
        const err = new Error(data.error || data.message || `Request failed (${response.status})`);
        err.status = response.status;
        err.body = data;
        throw err;
      }

      return data;
    } catch (error) {
      // Normalize network failures / timeouts to status 0
      if (!error.status) {
        error.status = 0;
        if (error.name === 'AbortError') {
          error.aborted = true;
          if (!externalSignal?.aborted) {
            error.timedOut = true;
            error.message = 'Request timed out';
          }
        } else {
          error.message = error.message || 'Network error';
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  },

  /**
   * Centralized failure reporting, dispatched once per logical request:
   *   401                → 'ride:auth-expired' (and only 401 — never network)
   *   status 0 (network/timeout) → 'ride:connection-lost' {reason:'network'}
   *   5xx                → 'ride:connection-lost' {reason:'server'}
   *
   * options.silent suppresses the console line; options.quiet suppresses the
   * connection-lost event entirely. `quiet` is for background probes and
   * third-party proxies (/auth/me, /places/search) whose failure says nothing
   * about the user's own connection to their data — a 401 still reports.
   */
  _reportRequestFailure(endpoint, error, options = {}) {
    if (!error) return;
    if (!options.silent) console.error('API Error:', error);
    if (typeof window === 'undefined') return;
    try {
      if (error.status === 401) {
        window.dispatchEvent(new CustomEvent('ride:auth-expired', {
          detail: { endpoint, status: 401 }
        }));
      } else if (options.quiet) {
        // no connectivity signal from background/proxy requests
      } else if (error.status === 0) {
        window.dispatchEvent(new CustomEvent('ride:connection-lost', {
          detail: { endpoint, status: 0, kind: 'network', reason: 'network', timedOut: !!error.timedOut }
        }));
      } else if (error.status >= 500) {
        window.dispatchEvent(new CustomEvent('ride:connection-lost', {
          detail: { endpoint, status: error.status, kind: 'server', reason: 'server' }
        }));
      }
    } catch (_) {
      // ignore
    }
  },

  // Auth methods
  auth: {
    async getUser() {
      try {
        // quiet: a failed session probe (offline launch, screen wake) must not
        // masquerade as "connection lost" — guests open the app offline all the time.
        const data = await API.request('/auth/me', { silent: true, quiet: true });
        return data.user;
      } catch (err) {
        if (err.status === 401) return null;
        throw err;
      }
    },

    loginUrl(provider, returnTo) {
      const suffix = returnTo ? `?return=${encodeURIComponent(returnTo)}` : '';
      return `${API.baseUrl}/auth/login/${provider}${suffix}`;
    },

    async logout() {
      await API.request('/auth/logout', { method: 'POST' });
    },
  },

  // Guest-mode data management (consumed by the login migration flow)
  local: {
    /** Raw dump of every locally stored trip (full objects). */
    exportAllTrips() {
      return _localClone(Storage.getLocalTrips());
    },

    /** Wipe the guest trip store (after a successful cloud migration). */
    clearAllTrips() {
      Storage.clearLocalTrips();
    },
  },

  // Trip methods
  trips: {
    async list() {
      if (API._isLocal()) return LocalDB.listTrips();
      const data = await API.request('/trips');
      return (data.trips || []).map(_normalizeTripSummary);
    },

    async get(id) {
      if (API._isLocal()) return LocalDB.getTrip(id);
      const data = await API.request(`/trips/${id}`);
      return _normalizeTrip(data.trip);
    },

    async create(tripData) {
      if (API._isLocal()) return LocalDB.createTrip(tripData);
      const data = await API.request('/trips', {
        method: 'POST',
        body: tripData,
      });
      return _normalizeTrip(data.trip);
    },

    async update(id, tripData, options = {}) {
      if (API._isLocal()) return LocalDB.updateTrip(id, tripData);
      const data = await API.request(`/trips/${id}`, {
        method: 'PUT',
        body: tripData,
        ...(options || {}),
      });
      return _normalizeTrip(data.trip);
    },

    async delete(id) {
      if (API._isLocal()) { LocalDB.deleteTrip(id); return; }
      await API.request(`/trips/${id}`, { method: 'DELETE' });
    },

    async share(id) {
      if (API._isLocal()) throw _loginRequiredError('share link');
      const data = await API.request(`/trips/${id}/share`, { method: 'POST' });
      return data;
    },

    async saveAlternativeRoutes(id, routes) {
      if (API._isLocal()) return LocalDB.saveAlternativeRoutes(id, routes);
      const data = await API.request(`/trips/${id}/alternatives`, {
        method: 'PUT',
        body: { routes },
      });
      return data;
    },
  },

  // Waypoint methods
  waypoints: {
    async add(tripId, waypointData, options = {}) {
      if (API._isLocal()) return LocalDB.addWaypoint(tripId, waypointData);
      return await API.request(`/trips/${tripId}/waypoints`, {
        method: 'POST',
        body: waypointData,
        ...(options || {}),
      });
    },

    async update(tripId, waypointId, waypointData, options = {}) {
      if (API._isLocal()) return LocalDB.updateWaypoint(tripId, waypointId, waypointData);
      return await API.request(`/trips/${tripId}/waypoints/${waypointId}`, {
        method: 'PUT',
        body: waypointData,
        ...(options || {}),
      });
    },

    async delete(tripId, waypointId, options = {}) {
      if (API._isLocal()) return LocalDB.deleteWaypoint(tripId, waypointId);
      return await API.request(`/trips/${tripId}/waypoints/${waypointId}`, {
        method: 'DELETE',
        ...(options || {}),
      });
    },

    async reorder(tripId, orderArray, options = {}) {
      if (API._isLocal()) return LocalDB.reorderWaypoints(tripId, orderArray);
      return await API.request(`/trips/${tripId}/waypoints/reorder`, {
        method: 'PUT',
        body: { order: orderArray },
        ...(options || {}),
      });
    },
  },

  // Journal methods
  journal: {
    async add(tripId, entryData) {
      if (API._isLocal()) return LocalDB.addJournalEntry(tripId, entryData);
      const data = await API.request(`/trips/${tripId}/journal`, {
        method: 'POST',
        body: entryData,
      });
      return _normalizeEntry(data.entry);
    },

    async update(tripId, entryId, entryData) {
      if (API._isLocal()) return LocalDB.updateJournalEntry(tripId, entryId, entryData);
      const data = await API.request(`/trips/${tripId}/journal/${entryId}`, {
        method: 'PUT',
        body: entryData,
      });
      return _normalizeEntry(data.entry);
    },

    async delete(tripId, entryId) {
      if (API._isLocal()) { LocalDB.deleteJournalEntry(tripId, entryId); return; }
      await API.request(`/trips/${tripId}/journal/${entryId}`, {
        method: 'DELETE',
      });
    },
  },

  // Attachment methods (cloud-only: photos need object storage)
  attachments: {
    async upload(tripId, file, options = {}) {
      if (API._isLocal()) throw _loginRequiredError('photo upload');
      const formData = new FormData();
      formData.append('file', file);
      if (options.is_cover !== undefined) formData.append('is_cover', options.is_cover ? 'true' : 'false');
      if (options.is_private !== undefined) formData.append('is_private', options.is_private ? 'true' : 'false');
      if (options.caption !== undefined) formData.append('caption', String(options.caption || ''));
      if (options.journal_entry_id) formData.append('journal_entry_id', options.journal_entry_id);
      if (options.waypoint_id) formData.append('waypoint_id', options.waypoint_id);

      const data = await API.request(`/trips/${tripId}/attachments`, {
        method: 'POST',
        body: formData,
        headers: options.headers || {},
      });
      return _normalizeAttachment(data.attachment);
    },

    async delete(attachmentId, options = {}) {
      if (API._isLocal()) throw _loginRequiredError('photo management');
      return API.request(`/attachments/${attachmentId}`, {
        method: 'DELETE',
        headers: options.headers || {},
      });
    },

    async update(attachmentId, data) {
      if (API._isLocal()) throw _loginRequiredError('photo management');
      const result = await API.request(`/attachments/${attachmentId}`, {
        method: 'PUT',
        body: data,
      });
      return _normalizeAttachment(result.attachment);
    },
  },

  // Places search (Google Places via backend proxy — requires a signed-in
  // session server-side, so it can never work offline/local; fail fast
  // with the same LOGIN_REQUIRED contract as the other cloud-only actions
  // instead of round-tripping a 401 through the network layer)
  places: {
    async search(query, options = {}) {
      if (API._isLocal()) throw _loginRequiredError('place search');
      const params = new URLSearchParams({ q: query });
      if (options.lat != null && options.lng != null) {
        params.set('lat', options.lat);
        params.set('lng', options.lng);
      }
      if (options.radius) params.set('radius', options.radius);
      if (options.region) params.set('region', options.region);
      const data = await API.request(`/places/search?${params}`, { quiet: true });
      return data.results || [];
    },
  },

  // Ride logs — actual GPS tracks recorded during navigation
  rideLogs: {
    async save(tripId, logData) {
      if (API._isLocal()) return LocalDB.saveRideLog(tripId, logData);
      const data = await API.request(`/trips/${tripId}/ride-logs`, {
        method: 'POST',
        body: logData,
      });
      return data;
    },

    async list(tripId) {
      if (API._isLocal()) return LocalDB.listRideLogs(tripId);
      const data = await API.request(`/trips/${tripId}/ride-logs`);
      return data.logs || [];
    },
  },
};

// Classic-script `const` does not create a window property — publish it
// explicitly so the global is reachable the same way App/UI/MapManager are.
window.API = API;
