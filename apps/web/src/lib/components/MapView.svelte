<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { currentTrip } from '$stores/trip';
	import { addWaypoint, updateWaypoint } from '$stores/trip';
	import { mapState, setMapReady, setAddingWaypoint, setRouteData } from '$stores/map';
	import { uiState, openModal, switchView } from '$stores/ui';
	import { toastError, toastInfo } from '$stores/ui';
	import type { Waypoint, RouteData } from '$types';

	declare const L: any;

	const OSRM_URL = 'https://maps.incitat.io/route/v1';
	const TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
	const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

	const WP_ICONS: Record<string, { color: string; icon: string }> = {
		stop:    { color: '#e94560', icon: '📍' },
		scenic:  { color: '#4ade80', icon: '🏞️' },
		fuel:    { color: '#fbbf24', icon: '⛽' },
		food:    { color: '#f97316', icon: '🍽️' },
		lodging: { color: '#8b5cf6', icon: '🏨' },
		custom:  { color: '#06b6d4', icon: '⭐' },
	};

	let mapEl: HTMLDivElement;
	let map: any;
	let markers: Map<string, any> = new Map();
	let routeLine: any = null;
	let tempMarker: any = null;

	const trip = $derived($currentTrip);
	const mstate = $derived($mapState);

	function createIcon(type: string, zoom = 13) {
		const wp = WP_ICONS[type] || WP_ICONS.stop;
		const s = Math.max(24, Math.min(40, 14 + zoom * 1.8));
		return L.divIcon({
			className: 'wp-marker',
			html: `<span style="font-size:${s}px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))">${wp.icon}</span>`,
			iconSize: [s, s],
			iconAnchor: [s / 2, s],
		});
	}

	function syncMarkers(waypoints: Waypoint[]) {
		if (!map) return;
		const ids = new Set(waypoints.map(w => w.id));

		// Remove stale markers
		for (const [id, m] of markers) {
			if (!ids.has(id)) { map.removeLayer(m); markers.delete(id); }
		}

		// Update or create markers
		for (const wp of waypoints) {
			if (!wp.lat || !wp.lng) continue;
			const existing = markers.get(wp.id);
			if (existing) {
				existing.setLatLng([wp.lat, wp.lng]);
				existing.setIcon(createIcon(wp.type));
			} else {
				const m = L.marker([wp.lat, wp.lng], {
					icon: createIcon(wp.type),
					draggable: true,
				}).addTo(map);
				m.on('dragend', () => {
					const ll = m.getLatLng();
					updateWaypoint(wp.id, { lat: ll.lat, lng: ll.lng });
				});
				m.on('click', () => openModal('waypointDetail', wp));
				m.bindTooltip(wp.name, { direction: 'top', offset: [0, -20] });
				markers.set(wp.id, m);
			}
		}

		// Fit bounds if we have markers
		if (waypoints.length > 0) {
			const bounds = L.latLngBounds(
				waypoints.filter(w => w.lat && w.lng).map(w => [w.lat, w.lng])
			);
			if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
		}
	}

	async function fetchRoute(waypoints: Waypoint[]) {
		const coords = waypoints
			.filter(w => w.lat && w.lng)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		if (coords.length < 2) {
			if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
			setRouteData(null);
			return;
		}
		const coordStr = coords.map(w => `${w.lng},${w.lat}`).join(';');
		try {
			const res = await fetch(`${OSRM_URL}/driving/${coordStr}?overview=full&geometries=geojson&steps=true`);
			const data = await res.json();
			if (data.code !== 'Ok' || !data.routes?.length) return;
			const route = data.routes[0];
			const geojson = route.geometry;

			if (routeLine) map.removeLayer(routeLine);
			routeLine = L.geoJSON(geojson, {
				style: { color: '#6366f1', weight: 4, opacity: 0.85 },
			}).addTo(map);

			setRouteData({
				distance: route.distance,
				duration: route.duration,
				geometry: geojson,
				instructions: route.legs?.flatMap((leg: any) =>
					leg.steps?.map((s: any) => ({
						text: s.maneuver?.instruction || s.name || '',
						distance: s.distance,
						duration: s.duration,
					})) ?? []
				) ?? [],
			});
		} catch (e) {
			console.warn('Route fetch failed', e);
		}
	}

	function handleMapClick(e: any) {
		if (!mstate.isAddingWaypoint) return;
		const { lat, lng } = e.latlng;

		if (tempMarker) map.removeLayer(tempMarker);
		tempMarker = L.marker([lat, lng], {
			icon: createIcon('stop'),
			opacity: 0.7,
		}).addTo(map);

		openModal('addWaypoint', { lat, lng });
		setAddingWaypoint(false);
	}

	function locateUser() {
		map?.locate({ setView: true, maxZoom: 14, enableHighAccuracy: true });
	}

	onMount(() => {
		map = L.map(mapEl, {
			zoomControl: false,
			attributionControl: true,
		}).setView([-34.5386, 146.5933], 6);

		L.tileLayer(TILE_URL, {
			attribution: TILE_ATTR,
			subdomains: 'abcd',
			maxZoom: 19,
		}).addTo(map);

		L.control.zoom({ position: 'bottomleft' }).addTo(map);

		map.on('click', handleMapClick);
		map.on('zoomend', () => {
			const z = map.getZoom();
			for (const [id, m] of markers) {
				const wp = trip?.waypoints?.find((w: Waypoint) => w.id === id);
				if (wp) m.setIcon(createIcon(wp.type, z));
			}
		});

		window.addEventListener('resize', () => map?.invalidateSize());
		setMapReady(true);

		// Initial sync
		if (trip?.waypoints?.length) {
			syncMarkers(trip.waypoints);
			fetchRoute(trip.waypoints);
		}
	});

	onDestroy(() => {
		if (map) { map.remove(); map = null; }
		markers.clear();
	});

	// Reactive updates:
	$effect(() => {
		if (map && trip?.waypoints) {
			syncMarkers(trip.waypoints);
			fetchRoute(trip.waypoints);
		}
	});
</script>

<div class="map-container">
	<div bind:this={mapEl} class="map"></div>

	<div class="map-controls">
		<button
			class="map-fab"
			class:active={mstate.isAddingWaypoint}
			onclick={() => setAddingWaypoint(!mstate.isAddingWaypoint)}
			aria-label={mstate.isAddingWaypoint ? 'Cancel adding waypoint' : 'Add waypoint'}
		>
			{#if mstate.isAddingWaypoint}
				<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
			{:else}
				<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
			{/if}
		</button>

		<button class="map-fab small" onclick={locateUser} aria-label="My location">
			<svg viewBox="0 0 24 24"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>
		</button>
	</div>

	{#if mstate.isAddingWaypoint}
		<div class="map-hint">Tap the map to place a waypoint</div>
	{/if}
</div>

<style>
	.map-container {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.map {
		width: 100%;
		height: 100%;
	}

	.map-controls {
		position: absolute;
		right: 14px;
		bottom: 24px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		z-index: 50;
	}

	.map-fab {
		width: 50px;
		height: 50px;
		border-radius: 50%;
		background: var(--accent);
		color: #fff;
		border: none;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4);
		transition: transform 0.15s, background 0.15s;
	}

	.map-fab:active { transform: scale(0.92); }
	.map-fab.active { background: var(--red); }
	.map-fab.small { width: 42px; height: 42px; background: var(--bg-elevated); color: var(--text-secondary); box-shadow: var(--shadow-lg); }
	.map-fab.small:hover { color: var(--accent-light); }

	.map-fab svg { width: 24px; height: 24px; fill: currentColor; }

	.map-hint {
		position: absolute;
		top: 16px;
		left: 50%;
		transform: translateX(-50%);
		padding: 8px 18px;
		background: rgba(99, 102, 241, 0.92);
		color: #fff;
		border-radius: var(--radius-lg);
		font-size: 0.85rem;
		font-weight: 500;
		z-index: 50;
		pointer-events: none;
		animation: fadeSlideDown 0.2s ease;
	}

	@keyframes fadeSlideDown {
		from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}

	/* Global marker override */
	:global(.wp-marker) {
		background: none !important;
		border: none !important;
		display: flex;
		align-items: end;
		justify-content: center;
	}
</style>
