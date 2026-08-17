/**
 * Storage module - handles local storage for trips and data
 *
 * Schema versioning: ride_schema_version stamps the shape of everything
 * this module writes. Bump SCHEMA_VERSION and add a migration step in
 * MIGRATIONS when a stored shape changes. v2 introduced ride_local_trips
 * (guest-mode trip store — full trip objects incl. waypoints/journal/
 * route/alternative_routes, consumed by the API local shim in api.js).
 */
const Storage = {
  SCHEMA_VERSION: 2,

  /**
   * The complete ride_* keyspace. Everything this app persists is declared
   * here so migrations and "clear my data" have one list to work from —
   * read/write through Storage rather than touching localStorage directly.
   */
  KEYS: {
    SCHEMA_VERSION: 'ride_schema_version',
    TRIPS: 'ride_trips',
    LOCAL_TRIPS: 'ride_local_trips',
    CURRENT_TRIP: 'ride_current_trip',
    SETTINGS: 'ride_settings',
    TRIP_ORDER: 'ride_trip_order',
    // UI/session/ride flags owned by other modules (ui.js, auth-controller.js,
    // trip-controller.js, ride-controller.js, index.html) — declared here so
    // the keyspace stays discoverable even though those modules read/write
    // the raw key directly rather than going through Storage.
    LAST_USER_ID: 'ride_last_user_id',
    INSTALL_DISMISSED: 'ride_install_dismissed',
    LANDING_SEEN: 'ride_landing_seen',
    WAYPOINTS_HELP_SEEN: 'ride_waypoints_help_seen',
    IMPORTED_TRIP_ID: 'ride_imported_trip_id',
    RIDE_TRACK_CHECKPOINT: 'ride_track_checkpoint',
    RIDE_PENDING_LOGS: 'ride_pending_logs',
    // Per-leg collapse state in the waypoints list (ui-renderers.js). Not a
    // single key: the real key is this prefix + `${tripId}_${legBreakWaypointId}`,
    // value '1' (collapsed) | '0' (expanded). Always go through
    // getLegCollapsed/setLegCollapsed below rather than composing the key ad
    // hoc, so this entry stays an accurate map of the keyspace.
    LEG_COLLAPSE_PREFIX: 'ride_leg_collapse_',
    // Per-trip scenic-road suppression list (scenic-suggest.js): the road ids
    // the rider dismissed or already accepted. Parameterised the same way as
    // the prefix above — the real key is this prefix + `${tripId}`, value a
    // JSON array of road ids. That module composes the key itself and goes
    // through Storage.save/Storage.load, so there's no accessor pair here yet;
    // the prefix is declared so the keyspace map stays complete.
    SCENIC_DISMISSED_PREFIX: 'ride_scenic_dismissed_',
    // Device-local fuel-tank state (fuel.js / window.FuelPlanner). Deliberately
    // NOT trip data — the tank belongs to the bike, not the trip, so it is
    // never synced to the cloud and survives switching between trips. Value
    // is { percent: 0-100, updatedAt: ISO string|null }. Always go through
    // getFuelState/saveFuelState below rather than touching this key directly.
    FUEL_STATE: 'ride_fuel_state'
  },

  /**
   * Per-version migration steps. Key N migrates (N-1) → N.
   * Each step must be idempotent — it may run on a client that never
   * had the older shape at all.
   */
  MIGRATIONS: {
    // v1 → v2: introduced the ride_local_trips guest store. Nothing to
    // transform — older clients simply didn't have local trips.
    2() {}
  },

  /**
   * Run pending migrations and stamp the current schema version.
   * Called once at script load (bottom of this file).
   */
  ensureSchema() {
    let version = Number(this.load(this.KEYS.SCHEMA_VERSION, 1)) || 1;
    if (version >= this.SCHEMA_VERSION) return;
    while (version < this.SCHEMA_VERSION) {
      version += 1;
      const step = this.MIGRATIONS[version];
      if (typeof step === 'function') {
        try {
          step.call(this);
        } catch (e) {
          console.error(`Storage migration to v${version} failed:`, e);
        }
      }
    }
    this.save(this.KEYS.SCHEMA_VERSION, this.SCHEMA_VERSION);
  },

  /**
   * Save data to localStorage
   */
  save(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('Storage save error:', e);
      return false;
    }
  },

  /**
   * Load data from localStorage
   */
  load(key, defaultValue = null) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defaultValue;
    } catch (e) {
      console.error('Storage load error:', e);
      return defaultValue;
    }
  },

  /**
   * Remove data from localStorage
   */
  remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.error('Storage remove error:', e);
      return false;
    }
  },

  /**
   * Get all trips
   */
  getTrips() {
    return this.load(this.KEYS.TRIPS, []);
  },

  /**
   * Save all trips
   */
  saveTrips(trips) {
    return this.save(this.KEYS.TRIPS, trips);
  },

  /**
   * Guest-mode trip store (full trip objects, cloud-shaped).
   * Read/written by the API local shim — see api.js.
   */
  getLocalTrips() {
    const trips = this.load(this.KEYS.LOCAL_TRIPS, []);
    return Array.isArray(trips) ? trips : [];
  },

  /**
   * Persist the guest-mode trip store. Returns false when the write
   * failed (e.g. quota exceeded) so callers can surface the problem.
   */
  saveLocalTrips(trips) {
    return this.save(this.KEYS.LOCAL_TRIPS, Array.isArray(trips) ? trips : []);
  },

  clearLocalTrips() {
    return this.remove(this.KEYS.LOCAL_TRIPS);
  },

  /**
   * Generate unique ID
   */
  generateId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for very old WebViews without crypto.randomUUID
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  },

  /**
   * Get trip order
   */
  getTripOrder() {
    return this.load(this.KEYS.TRIP_ORDER, []);
  },

  /**
   * Set trip order
   */
  setTripOrder(order) {
    return this.save(this.KEYS.TRIP_ORDER, order || []);
  },

  clearTrips() {
    this.saveTrips([]);
    this.remove(this.KEYS.CURRENT_TRIP);
    this.remove(this.KEYS.TRIP_ORDER);
  },

  /** Waypoints-list leg collapse state, persisted per trip + leg-break waypoint id. */
  getLegCollapsed(tripId, legId) {
    if (!tripId || !legId) return false;
    try {
      return localStorage.getItem(this.KEYS.LEG_COLLAPSE_PREFIX + tripId + '_' + legId) === '1';
    } catch (e) {
      return false;
    }
  },

  setLegCollapsed(tripId, legId, collapsed) {
    if (!tripId || !legId) return;
    try {
      localStorage.setItem(this.KEYS.LEG_COLLAPSE_PREFIX + tripId + '_' + legId, collapsed ? '1' : '0');
    } catch (e) {
      // Quota or private-browsing storage errors are non-fatal — the leg just
      // won't remember its collapsed state across a reload.
    }
  },

  /**
   * Device-local fuel-tank state (see FUEL_STATE key comment). Defaults to
   * a full tank when nothing has been stored yet, or when the stored value
   * is malformed — never returns a non-numeric percent.
   */
  getFuelState() {
    const state = this.load(this.KEYS.FUEL_STATE, null);
    if (!state || typeof state !== 'object' || !Number.isFinite(state.percent)) {
      return { percent: 100, updatedAt: null };
    }
    return {
      percent: Math.max(0, Math.min(100, state.percent)),
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null
    };
  },

  /** Persist fuel-tank state, clamping percent to 0-100. */
  saveFuelState(state) {
    const num = Number(state?.percent);
    const percent = Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : 0;
    return this.save(this.KEYS.FUEL_STATE, {
      percent,
      updatedAt: typeof state?.updatedAt === 'string' ? state.updatedAt : new Date().toISOString()
    });
  }
};

Storage.ensureSchema();

// Make available globally
window.Storage = Storage;
