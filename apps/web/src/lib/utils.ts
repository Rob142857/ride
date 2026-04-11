/* ── Shared Utilities ───────────────────────────────────────────────── */

/** Haversine distance between two lat/lng points in km */
export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const R = 6371;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLng = ((lng2 - lng1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Format distance (km → "12.3 km" or "450 m") */
export function formatDistance(km: number): string {
	if (km < 1) return `${Math.round(km * 1000)} m`;
	return `${km.toFixed(1)} km`;
}

/** Format duration (seconds → "2h 15m") */
export function formatDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

/** Generate a UUID v4 */
export function uuid(): string {
	return crypto.randomUUID();
}

/** Debounce a function */
export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
	let timer: ReturnType<typeof setTimeout>;
	return ((...args: unknown[]) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	}) as T;
}

/** Clamp a number between min and max */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Quick check if we're on a touch device */
export function isTouchDevice(): boolean {
	return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/** Trigger haptic feedback if available */
export function haptic(pattern: number | number[] = 10): void {
	navigator?.vibrate?.(pattern);
}
