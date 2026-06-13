/**
 * Journey aggregate helpers.
 *
 * The database still stores the core record in `trips`; these helpers compose
 * that trip with its route, waypoints, journal entries, and attachments into
 * the canonical journey payload used by the app and public share page.
 */

import { BASE_URL } from './utils.js';
import { safeJsonParse } from './handler-utils.js';

const DEFAULT_SHARE_SETTINGS = Object.freeze({
  includeWaypoints: true,
  includeRoute: true,
  includePublicNotes: true,
  includeGallery: true,
});

export function getJourneySettings(settings) {
  return safeJsonParse(settings || '{}', {});
}

export function getShareSettings(settings) {
  const parsed = getJourneySettings(settings);
  const share = parsed.share && typeof parsed.share === 'object' ? parsed.share : {};

  return {
    includeWaypoints: share.includeWaypoints !== false,
    includeRoute: share.includeRoute !== false,
    includePublicNotes: share.includePublicNotes !== false,
    includeGallery: share.includeGallery !== false,
  };
}

export function parseRouteData(routeData) {
  if (!routeData) return null;
  return {
    coordinates: safeJsonParse(routeData.coordinates || '[]', []),
    distance: routeData.distance,
    duration: routeData.duration,
  };
}

export function withAttachmentUrl(attachment) {
  return {
    ...attachment,
    url: `${BASE_URL}/api/attachments/${attachment.id}`,
  };
}

export function serializeOwnedJourney({ trip, waypoints, journal, attachments, routeData, alternativeRoutes }) {
  return {
    ...trip,
    settings: getJourneySettings(trip.settings),
    share: getShareSettings(trip.settings),
    short_url: trip.short_code ? `${BASE_URL}/${trip.short_code}` : null,
    waypoints,
    journal: (journal || []).map(entry => ({
      ...entry,
      tags: safeJsonParse(entry.tags || '[]', []),
      location: safeJsonParse(entry.location || 'null', null),
    })),
    attachments: (attachments || []).map(withAttachmentUrl),
    route: parseRouteData(routeData),
    alternative_routes: alternativeRoutes || [],
  };
}

export function serializePublicJourney({ trip, waypoints, journal, attachments, routeData, alternativeRoutes }) {
  const share = getShareSettings(trip.settings);
  const publicAttachments = (attachments || []).map(withAttachmentUrl);
  const explicitCover = publicAttachments.find(attachment => attachment.is_cover);
  const fallbackCover = publicAttachments.find(attachment => attachment.mime_type?.startsWith('image/'));
  const coverUrl = trip.cover_image_url || explicitCover?.url || fallbackCover?.url || null;
  const excludeCoverId = explicitCover?.id || null;
  const visibleAttachments = share.includeGallery
    ? publicAttachments.filter(attachment => {
        if (excludeCoverId && attachment.id === excludeCoverId) return false;
        if (!share.includePublicNotes && attachment.journal_entry_id) return false;
        return true;
      })
    : [];

  return {
    short_code: trip.short_code,
    title: trip.public_title || trip.name,
    description: trip.public_description || trip.description || '',
    contact: trip.public_contact || null,
    cover_image: coverUrl,
    cover_focus_x: trip.cover_focus_x ?? 50,
    cover_focus_y: trip.cover_focus_y ?? 50,
    created_at: trip.created_at,
    share,
    waypoints: share.includeWaypoints ? (waypoints || []).map(w => ({
      id: w.id,
      name: w.name,
      lat: w.lat,
      lng: w.lng,
      type: w.type,
      sort_order: w.sort_order,
    })) : [],
    journal: share.includePublicNotes ? (journal || []).map(entry => ({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      tags: safeJsonParse(entry.tags || '[]', []),
      created_at: entry.created_at,
    })) : [],
    attachments: visibleAttachments.map(attachment => ({
      id: attachment.id,
      name: attachment.original_name,
      type: attachment.mime_type,
      caption: attachment.caption,
      url: attachment.url,
      journal_entry_id: attachment.journal_entry_id || null,
      waypoint_id: attachment.waypoint_id || null,
    })),
    route: share.includeRoute ? parseRouteData(routeData) : null,
    alternative_routes: share.includeRoute ? (alternativeRoutes || []).map(ar => ({
      alt_idx: ar.route_index ?? ar.alt_idx ?? 0,
      name: ar.name || '',
      summary: ar.summary || '',
      color: ar.color || null,
      distance: ar.distance_meters ?? ar.distance ?? 0,
      duration: ar.duration_seconds ?? ar.duration ?? 0,
      saved: ar.is_selected ? true : (ar.saved ?? false),
      visible: ar.is_visible !== undefined ? !!ar.is_visible : true,
      coordinates: safeJsonParse(ar.coordinates || '[]', []),
    })) : [],
  };
}
