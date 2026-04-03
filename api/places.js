/**
 * Google Places proxy for waypoint search
 */
import { jsonResponse, errorResponse } from './utils.js';

/** Max place searches per user per weekly window */
const WEEKLY_LIMIT = 50;
/** Free-tier monthly budget ($200 credit / $32 per 1k = ~6250) */
const MONTHLY_FREE_QUOTA = 6250;

/**
 * Returns the KV key and TTL for the current weekly window.
 * Window resets every Monday 00:00 UTC.
 */
function rateLimitKey(userId) {
  const now = new Date();
  // ISO week: find Monday of this week
  const day = now.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day; // days until Monday
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
  const weekId = monday.toISOString().slice(0, 10); // e.g. "2026-03-30"
  // TTL: seconds until next Monday
  const nextMonday = new Date(monday.getTime() + 7 * 86400_000);
  const ttl = Math.max(60, Math.ceil((nextMonday - now) / 1000));
  return { key: `places_rl:${userId}:${weekId}`, ttl };
}

/** Returns KV key and TTL for the global monthly counter. */
function monthlyCounterKey() {
  const now = new Date();
  const monthId = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  // TTL: seconds until end of next month (generous to avoid premature expiry)
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
  const ttl = Math.max(60, Math.ceil((nextMonth - now) / 1000));
  return { key: `places_monthly:${monthId}`, ttl };
}

export const PlacesHandler = {
  async search(context) {
    const { request, env } = context;
    const apiKey = env.GOOGLE_PLACES_API_KEY;

    if (!apiKey) {
      return errorResponse('Places search not configured', 503);
    }

    // --- Per-user weekly rate limit ---
    const userId = context.user?.id;
    if (userId) {
      const { key, ttl } = rateLimitKey(userId);
      const count = parseInt(await env.RIDE_TRIP_PLANNER_SESSIONS.get(key) || '0', 10);
      if (count >= WEEKLY_LIMIT) {
        return errorResponse(`Weekly place search limit reached (${WEEKLY_LIMIT}). Resets Monday.`, 429);
      }
      // Increment (fire-and-forget is fine; expirationTtl ensures cleanup)
      await env.RIDE_TRIP_PLANNER_SESSIONS.put(key, String(count + 1), { expirationTtl: ttl });
    }

    // Increment global monthly counter
    const mc = monthlyCounterKey();
    const monthCount = parseInt(await env.RIDE_TRIP_PLANNER_SESSIONS.get(mc.key) || '0', 10);
    await env.RIDE_TRIP_PLANNER_SESSIONS.put(mc.key, String(monthCount + 1), { expirationTtl: mc.ttl });

    const url = new URL(request.url);
    const query = (url.searchParams.get('q') || '').trim();
    const lat = url.searchParams.get('lat');
    const lng = url.searchParams.get('lng');
    const radius = url.searchParams.get('radius') || '50000';
    const region = url.searchParams.get('region') || '';

    if (!query) {
      return errorResponse('Missing query', 400);
    }

    const apiUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    apiUrl.searchParams.set('query', query);
    apiUrl.searchParams.set('key', apiKey);
    apiUrl.searchParams.set('language', 'en');
    if (lat && lng) {
      apiUrl.searchParams.set('location', `${lat},${lng}`);
      apiUrl.searchParams.set('radius', radius);
    }
    if (region) {
      apiUrl.searchParams.set('region', region);
    }

    let data;
    try {
      const resp = await fetch(apiUrl.toString());
      data = await resp.json();
    } catch (error) {
      console.error('Places API network error:', error);
      return errorResponse('Places search failed', 502);
    }

    if (data?.status && !['OK', 'ZERO_RESULTS'].includes(data.status)) {
      console.error('Places API error:', data.status, data?.error_message);
      return errorResponse(`Places search unavailable: ${data.status}${data.error_message ? ' – ' + data.error_message : ''}`, 502);
    }

    const results = (data?.results || []).slice(0, 12).map((place) => ({
      id: place.place_id,
      name: place.name,
      address: place.formatted_address || place.vicinity || '',
      location: place.geometry?.location
        ? { lat: place.geometry.location.lat, lng: place.geometry.location.lng }
        : null,
      rating: place.rating,
      types: place.types || []
    })).filter((p) => p.location);

    return jsonResponse({ results });
  },

  /** Admin: return monthly Places API usage vs free-tier quota. */
  async usageStats(context) {
    const { env } = context;
    const mc = monthlyCounterKey();
    const used = parseInt(await env.RIDE_TRIP_PLANNER_SESSIONS.get(mc.key) || '0', 10);
    const now = new Date();
    const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return jsonResponse({
      month: monthLabel,
      used,
      quota: MONTHLY_FREE_QUOTA,
      pct: Math.min(100, Math.round((used / MONTHLY_FREE_QUOTA) * 100)),
      costPerK: 32,
      estimatedCost: Math.max(0, ((used - MONTHLY_FREE_QUOTA) * 32 / 1000)).toFixed(2),
    });
  }
};
