function normalizeEntry(entry) {
  if (!entry) return entry;
  return {
    ...entry,
    isPrivate: !!(entry.is_private ?? entry.isPrivate),
    waypointId: entry.waypoint_id ?? entry.waypointId ?? null,
    createdAt: entry.created_at ?? entry.createdAt,
    updatedAt: entry.updated_at ?? entry.updatedAt,
    tags: typeof entry.tags === 'string' ? JSON.parse(entry.tags) : (entry.tags || []),
    location: typeof entry.location === 'string' ? JSON.parse(entry.location) : (entry.location || null),
    attachments: entry.attachments || [],
  };
}

function normalizeAttachment(attachment) {
  if (!attachment) return attachment;
  return {
    ...attachment,
    journalEntryId: attachment.journal_entry_id ?? attachment.journalEntryId ?? null,
    waypointId: attachment.waypoint_id ?? attachment.waypointId ?? null,
    originalName: attachment.original_name ?? attachment.originalName ?? attachment.filename,
    mimeType: attachment.mime_type ?? attachment.mimeType,
    sizeBytes: attachment.size_bytes ?? attachment.sizeBytes,
    isCover: !!(attachment.is_cover ?? attachment.isCover),
    isPrivate: !!(attachment.is_private ?? attachment.isPrivate),
    createdAt: attachment.created_at ?? attachment.createdAt,
  };
}

function normalizeWaypoint(waypoint) {
  if (!waypoint) return waypoint;
  return {
    ...waypoint,
    order: waypoint.sort_order ?? waypoint.order ?? 0,
    createdAt: waypoint.created_at ?? waypoint.createdAt,
  };
}

function normalizeTrip(trip) {
  if (!trip) return trip;

  const normalized = {
    ...trip,
    createdAt: trip.created_at ?? trip.createdAt,
    updatedAt: trip.updated_at ?? trip.updatedAt,
    isPublic: !!(trip.is_public ?? trip.isPublic),
    coverImageUrl: trip.cover_image_url ?? trip.coverImageUrl ?? '',
    coverFocusX: Number.isFinite(trip.cover_focus_x)
      ? trip.cover_focus_x
      : (Number.isFinite(trip.coverFocusX) ? trip.coverFocusX : 50),
    coverFocusY: Number.isFinite(trip.cover_focus_y)
      ? trip.cover_focus_y
      : (Number.isFinite(trip.coverFocusY) ? trip.coverFocusY : 50),
    shortCode: trip.short_code ?? trip.shortCode ?? null,
    shortUrl: trip.short_url ?? trip.shortUrl ?? null,
    shareId: trip.share_id ?? trip.shareId ?? null,
    settings: typeof trip.settings === 'string' ? JSON.parse(trip.settings || '{}') : (trip.settings || {}),
    version: Number(trip.version ?? 0),
  };

  normalized.is_public = normalized.isPublic ? 1 : 0;
  normalized.cover_image_url = normalized.coverImageUrl;
  normalized.cover_focus_x = normalized.coverFocusX;
  normalized.cover_focus_y = normalized.coverFocusY;
  normalized.short_code = normalized.shortCode;
  normalized.short_url = normalized.shortUrl;
  normalized.share_id = normalized.shareId;

  if (Array.isArray(normalized.waypoints)) normalized.waypoints = normalized.waypoints.map(normalizeWaypoint);
  if (Array.isArray(normalized.journal)) normalized.journal = normalized.journal.map(normalizeEntry);
  if (Array.isArray(normalized.attachments)) normalized.attachments = normalized.attachments.map(normalizeAttachment);

  if (normalized.route) {
    const duration = normalized.route.duration ?? normalized.route.time ?? null;
    normalized.route = {
      ...normalized.route,
      duration,
      time: duration,
      coordinates: normalized.route.coordinates || [],
    };
  }

  return normalized;
}

function normalizeTripSummary(trip) {
  if (!trip) return trip;
  return {
    ...trip,
    createdAt: trip.created_at ?? trip.createdAt,
    updatedAt: trip.updated_at ?? trip.updatedAt,
    isPublic: !!(trip.is_public ?? trip.isPublic),
    shortCode: trip.short_code ?? trip.shortCode ?? null,
    shortUrl: trip.short_url ?? trip.shortUrl ?? null,
    is_public: !!(trip.is_public ?? trip.isPublic),
    short_code: trip.short_code ?? trip.shortCode ?? null,
    short_url: trip.short_url ?? trip.shortUrl ?? null,
  };
}

function emitDomEvent(eventTarget, enabled, eventName, detail) {
  if (!enabled) return;
  if (!eventTarget || typeof eventTarget.dispatchEvent !== 'function') return;
  if (typeof CustomEvent === 'undefined') return;

  try {
    eventTarget.dispatchEvent(new CustomEvent(eventName, { detail }));
  } catch (_) {
    // Ignore dispatch failures in non-browser runtimes.
  }
}

function resolveFetch(fetchImpl) {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch !== 'undefined') return fetch.bind(globalThis);
  throw new Error('No fetch implementation available. Provide options.fetch when creating the client.');
}

function resolveFormData(formDataImpl) {
  if (formDataImpl) return formDataImpl;
  if (typeof FormData !== 'undefined') return FormData;
  throw new Error('No FormData implementation available. Provide options.FormData for attachment uploads.');
}

function isFormDataBody(body) {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

export function createClient(options = {}) {
  const baseUrl = options.baseUrl || '/api';
  const fetchImpl = resolveFetch(options.fetch);
  const eventTarget = options.eventTarget ?? (typeof window !== 'undefined' ? window : null);
  const emitDomEvents = options.emitDomEvents ?? true;
  const includeCredentials = options.includeCredentials ?? true;
  const defaultCacheControlHeaders = options.defaultCacheControlHeaders || {
    'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  };

  const client = {
    baseUrl,

    async request(endpoint, requestOptions = {}) {
      const url = `${baseUrl}${endpoint}`;
      const isForm = isFormDataBody(requestOptions.body);

      const defaultHeaders = isForm
        ? { ...defaultCacheControlHeaders }
        : {
            'Content-Type': 'application/json',
            ...defaultCacheControlHeaders,
          };

      const config = {
        ...requestOptions,
        headers: {
          ...defaultHeaders,
          ...(requestOptions.headers || {}),
        },
        cache: 'no-store',
      };

      if (includeCredentials && config.credentials === undefined) {
        config.credentials = 'include';
      }

      if (requestOptions.body && typeof requestOptions.body === 'object' && !isForm) {
        config.body = JSON.stringify(requestOptions.body);
      }

      try {
        const response = await fetchImpl(url, config);
        let data;

        try {
          data = await response.json();
        } catch (_) {
          const text = await response.text();
          data = text ? { error: text } : {};
        }

        if (!response.ok) {
          if (response.status === 401) {
            emitDomEvent(eventTarget, emitDomEvents, 'ride:auth-expired', {
              endpoint,
              status: response.status,
            });
          }

          if (response.status >= 500) {
            emitDomEvent(eventTarget, emitDomEvents, 'ride:connection-lost', {
              endpoint,
              status: response.status,
              kind: 'server',
            });
          }

          const error = new Error(data.error || data.message || `Request failed (${response.status})`);
          error.status = response.status;
          error.body = data;
          throw error;
        }

        return data;
      } catch (error) {
        if (!error.status) {
          error.status = 0;
          error.message = error.message || 'Network error';
        }

        if (error.status === 0) {
          emitDomEvent(eventTarget, emitDomEvents, 'ride:connection-lost', {
            endpoint,
            status: 0,
            kind: 'network',
          });
        }

        throw error;
      }
    },

    auth: {
      async getUser() {
        try {
          const data = await client.request('/auth/me');
          return data.user;
        } catch (error) {
          if (error.status === 401) return null;
          throw error;
        }
      },

      loginUrl(provider, returnTo) {
        const suffix = returnTo ? `?return=${encodeURIComponent(returnTo)}` : '';
        return `${baseUrl}/auth/login/${provider}${suffix}`;
      },

      async logout() {
        await client.request('/auth/logout', { method: 'POST' });
      },
    },

    trips: {
      async list() {
        const data = await client.request('/trips');
        return (data.trips || []).map(normalizeTripSummary);
      },

      async get(id) {
        const data = await client.request(`/trips/${id}`);
        return normalizeTrip(data.trip);
      },

      async create(tripData) {
        const data = await client.request('/trips', {
          method: 'POST',
          body: tripData,
        });
        return normalizeTrip(data.trip);
      },

      async update(id, tripData, requestOptions = {}) {
        const data = await client.request(`/trips/${id}`, {
          method: 'PUT',
          body: tripData,
          ...(requestOptions || {}),
        });
        return normalizeTrip(data.trip);
      },

      async delete(id) {
        await client.request(`/trips/${id}`, { method: 'DELETE' });
      },

      async share(id) {
        return client.request(`/trips/${id}/share`, { method: 'POST' });
      },
    },

    waypoints: {
      async add(tripId, waypointData, requestOptions = {}) {
        return client.request(`/trips/${tripId}/waypoints`, {
          method: 'POST',
          body: waypointData,
          ...(requestOptions || {}),
        });
      },

      async update(tripId, waypointId, waypointData, requestOptions = {}) {
        return client.request(`/trips/${tripId}/waypoints/${waypointId}`, {
          method: 'PUT',
          body: waypointData,
          ...(requestOptions || {}),
        });
      },

      async delete(tripId, waypointId, requestOptions = {}) {
        return client.request(`/trips/${tripId}/waypoints/${waypointId}`, {
          method: 'DELETE',
          ...(requestOptions || {}),
        });
      },

      async reorder(tripId, orderArray, requestOptions = {}) {
        return client.request(`/trips/${tripId}/waypoints/reorder`, {
          method: 'PUT',
          body: { order: orderArray },
          ...(requestOptions || {}),
        });
      },
    },

    journal: {
      async add(tripId, entryData) {
        const data = await client.request(`/trips/${tripId}/journal`, {
          method: 'POST',
          body: entryData,
        });
        return normalizeEntry(data.entry);
      },

      async update(tripId, entryId, entryData) {
        const data = await client.request(`/trips/${tripId}/journal/${entryId}`, {
          method: 'PUT',
          body: entryData,
        });
        return normalizeEntry(data.entry);
      },

      async delete(tripId, entryId) {
        await client.request(`/trips/${tripId}/journal/${entryId}`, {
          method: 'DELETE',
        });
      },
    },

    attachments: {
      async upload(tripId, file, attachmentOptions = {}) {
        const FormDataCtor = resolveFormData(options.FormData);
        const formData = new FormDataCtor();

        formData.append('file', file);
        if (attachmentOptions.is_cover !== undefined) formData.append('is_cover', attachmentOptions.is_cover ? 'true' : 'false');
        if (attachmentOptions.is_private !== undefined) formData.append('is_private', attachmentOptions.is_private ? 'true' : 'false');
        if (attachmentOptions.caption !== undefined) formData.append('caption', String(attachmentOptions.caption || ''));
        if (attachmentOptions.journal_entry_id) formData.append('journal_entry_id', attachmentOptions.journal_entry_id);
        if (attachmentOptions.waypoint_id) formData.append('waypoint_id', attachmentOptions.waypoint_id);

        const data = await client.request(`/trips/${tripId}/attachments`, {
          method: 'POST',
          body: formData,
          headers: attachmentOptions.headers || {},
        });

        return normalizeAttachment(data.attachment);
      },

      async delete(attachmentId, requestOptions = {}) {
        return client.request(`/attachments/${attachmentId}`, {
          method: 'DELETE',
          headers: requestOptions.headers || {},
        });
      },

      async update(attachmentId, data) {
        const result = await client.request(`/attachments/${attachmentId}`, {
          method: 'PUT',
          body: data,
        });
        return normalizeAttachment(result.attachment);
      },
    },

    places: {
      async search(query, searchOptions = {}) {
        const params = new URLSearchParams({ q: query });
        if (searchOptions.lat != null && searchOptions.lng != null) {
          params.set('lat', searchOptions.lat);
          params.set('lng', searchOptions.lng);
        }
        if (searchOptions.radius) params.set('radius', searchOptions.radius);
        if (searchOptions.region) params.set('region', searchOptions.region);

        const data = await client.request(`/places/search?${params}`);
        return data.results || [];
      },
    },

    normalize: {
      entry: normalizeEntry,
      attachment: normalizeAttachment,
      waypoint: normalizeWaypoint,
      trip: normalizeTrip,
      tripSummary: normalizeTripSummary,
    },
  };

  return client;
}

export const createRideClient = createClient;

export const RideSDK = {
  createClient,
  createRideClient,
};
