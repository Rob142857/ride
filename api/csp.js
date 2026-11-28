/* global btoa */
/**
 * Content Security Policy for HTML responses.
 * App pages (27 Nov 2026): no inline scripts and no inline event handlers; every script is a file on this origin,
 * unpkg (Leaflet) or the Cloudflare beacon. The one inline script on an app page is Cloudflare's own bot-detection
 * snippet (JavaScript Detections), injected at the edge: it is allowed by a fresh nonce in the CSP header, which
 * Cloudflare reads from the header and adds to the snippet (docs: developers.cloudflare.com/cloudflare-challenges/
 * challenge-types/javascript-detections/). Nothing in our own HTML carries the nonce.
 * The admin page (behind Access) still has inline handlers, so it keeps 'unsafe-inline' and gets NO nonce: browsers
 * ignore 'unsafe-inline' when a nonce is present.
 */
const BASE = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https: https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org https://server.arcgisonline.com https://ride.incitat.io https://lh3.googleusercontent.com https://*.microsoft.com",
  "connect-src 'self' https://ride.incitat.io https://maps.incitat.io https://unpkg.com https://events.rmesolutions.com.au",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com https://login.microsoftonline.com"
];
const SCRIPT_HOSTS = 'https://unpkg.com https://static.cloudflareinsights.com';

/** 128 random bits, base64. New value on every call; never stored or logged. */
export function makeNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The policy string. App pages need a nonce; the admin page must not get one. */
export function buildCsp({ admin = false, nonce = '' } = {}) {
  if (admin) {
    return [BASE[0], `script-src 'self' 'unsafe-inline' ${SCRIPT_HOSTS}`, ...BASE.slice(1)].join('; ');
  }
  const nonceToken = nonce ? ` 'nonce-${nonce}'` : '';
  return [BASE[0], `script-src 'self'${nonceToken} ${SCRIPT_HOSTS}`, "script-src-attr 'none'", ...BASE.slice(1)].join('; ');
}
