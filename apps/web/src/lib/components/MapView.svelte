<script lang="ts">
	import { onMount } from 'svelte';
	import { currentTrip, currentWaypoints, updateWaypoint } from '$stores/trip';
	import { haversine } from '$lib/utils';
	import { isRiding, mapState, mapReady, markWaypointVisited, setMapReady, setAddingWaypoint, setRideInstruction, setRouteData, stopRide, updateRidePosition } from '$stores/map';
	import { currentView, toastInfo, uiState, openModal, closeModal } from '$stores/ui';
	import type { Waypoint } from '$types';

	let L: any;

	const OSRM_URL = 'https://maps.incitat.io/route/v1';
	const TILE_URL_PRIMARY = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
	const TILE_ATTR_PRIMARY = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; CARTO';
	const TILE_URL_FALLBACK = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
	const TILE_ATTR_FALLBACK = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

	const WP_ICONS: Record<string, { color: string; icon: string }> = {
		stop:    { color: '#e94560', icon: '📍' },
		scenic:  { color: '#4ade80', icon: '🏞️' },
		fuel:    { color: '#fbbf24', icon: '⛽' },
		food:    { color: '#f97316', icon: '🍽️' },
		lodging: { color: '#8b5cf6', icon: '🏨' },
		custom:  { color: '#06b6d4', icon: '⭐' },
	};

	let mapEl: HTMLDivElement | null = null;
	const MAP_ELEMENT_ID = 'ride-map-canvas';
	let map: any;
	let markers: Map<string, any> = new Map();
	let routeLine: any = null;
	let tempMarker: any = null;
	let tileLayer: any = null;
	let mapError = $state('');
	let routeRequestToken = 0;
	let tileLoadSucceeded = false;
	let tileFailureCount = 0;
	let usingFallbackTiles = false;
	let mapInitialized = $state(false);
	let rideWatchId: number | null = null;
	let fittedTripKey = '';
	const tripWaypoints = $derived.by(() =>
		$currentWaypoints
			.map((waypoint) => ({
				...waypoint,
				lat: Number(waypoint.lat ?? waypoint.latitude ?? NaN),
				lng: Number(waypoint.lng ?? waypoint.longitude ?? NaN)
			}))
			.filter((waypoint) => Number.isFinite(waypoint.lat) && Number.isFinite(waypoint.lng))
	);

	function attachMapBehaviors() {
		if (!map) return;

		map.on('click', handleMapClick);
		map.on('zoomend', () => {
			const z = map.getZoom();
			for (const [id, marker] of markers) {
				const wp = $currentTrip?.waypoints?.find((waypoint: Waypoint) => waypoint.id === id);
				if (wp) marker.setIcon(createIcon(wp.type, z));
			}
		});

		L.control.zoom({ position: 'bottomleft' }).addTo(map);
		setMapReady(true);
	}

	function bindTileEvents(layer: any) {
		layer.on('tileerror', () => {
			tileFailureCount += 1;

			if (!tileLoadSucceeded && !usingFallbackTiles && tileFailureCount >= 6) {
				usingFallbackTiles = true;
				toastInfo('Primary map tiles failed. Switching to fallback tiles...');
				if (tileLayer && map?.hasLayer(tileLayer)) {
					map.removeLayer(tileLayer);
				}
				tileLayer = L.tileLayer(TILE_URL_FALLBACK, {
					attribution: TILE_ATTR_FALLBACK,
					maxZoom: 19,
					keepBuffer: 3,
					subdomains: 'abcd',
				}).addTo(map);
				bindTileEvents(tileLayer);
			}

			if (!tileLoadSucceeded && tileFailureCount >= 12) {
				toastInfo('Map tiles are loading slowly or being blocked.');
			}
		});

		layer.on('load', () => {
			tileLoadSucceeded = true;
			tileFailureCount = 0;
			mapError = '';
		});
	}

	const mapDebugLabel = $derived.by(() => {
		if (mapError) return `error: ${mapError}`;
		if (!mapInitialized) return 'initializing map...';
		if (!tileLoadSucceeded && tileFailureCount > 0) return `waiting for tiles (${tileFailureCount} errors)`;
		if (usingFallbackTiles) return 'map ready (fallback tiles)';
		if (tileLoadSucceeded) return 'map ready';
		return 'map initialized';
	});

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
			if (!Number.isFinite(wp.lat) || !Number.isFinite(wp.lng)) continue;
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
			const fitKey = `${$currentTrip?.id ?? 'none'}:${waypoints.map((wp) => `${wp.id}:${wp.lat.toFixed(5)}:${wp.lng.toFixed(5)}`).join('|')}`;
			const bounds = L.latLngBounds(
				waypoints.filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lng)).map(w => [w.lat, w.lng])
			);
			if (bounds.isValid() && fitKey !== fittedTripKey) {
				fittedTripKey = fitKey;
				map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
			}
		}
	}

	function updateRideProgress(waypoints: Waypoint[], position: GeolocationCoordinates) {
		const remaining = waypoints
			.filter((waypoint) => Number.isFinite(waypoint.lat) && Number.isFinite(waypoint.lng))
			.filter((waypoint) => !$mapState.ride.visitedWaypoints.has(waypoint.id))
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

		if (!remaining.length) {
			setRideInstruction({ text: 'Ride complete', distance: 0 }, 0);
			return;
		}

		const nextWaypoint = remaining[0];
		const distanceKm = haversine(position.latitude, position.longitude, nextWaypoint.lat, nextWaypoint.lng);
		const distanceMeters = Math.round(distanceKm * 1000);

		if (distanceMeters <= 40) {
			markWaypointVisited(nextWaypoint.id);
		}

		setRideInstruction({
			text: `Head to ${nextWaypoint.name || 'next stop'}`,
			distance: distanceMeters,
			type: nextWaypoint.type
		}, distanceMeters);
	}

	async function fetchRoute(waypoints: Waypoint[]) {
		const activeMap = map;
		const requestToken = ++routeRequestToken;
		if (!activeMap || !L) return;

		const coords = waypoints
			.filter(w => w.lat && w.lng)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		if (coords.length < 2) {
			if (routeLine && activeMap?.hasLayer(routeLine)) {
				activeMap.removeLayer(routeLine);
				routeLine = null;
			}
			setRouteData(null);
			return;
		}
		const coordStr = coords.map(w => `${w.lng},${w.lat}`).join(';');
		try {
			const res = await fetch(`${OSRM_URL}/driving/${coordStr}?overview=full&geometries=geojson&steps=true`);
			const data = await res.json();
			if (requestToken !== routeRequestToken || !map || map !== activeMap) return;
			if (data.code !== 'Ok' || !data.routes?.length) return;
			const route = data.routes[0];
			const geojson = route.geometry;

			if (routeLine && activeMap.hasLayer(routeLine)) activeMap.removeLayer(routeLine);
			routeLine = L.geoJSON(geojson, {
				style: { color: '#6366f1', weight: 4, opacity: 0.85 },
			}).addTo(activeMap);

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
			if (requestToken === routeRequestToken) {
				console.warn('Route fetch failed', e);
			}
		}
	}

	function handleMapClick(e: any) {
		if (!$mapState.isAddingWaypoint && $uiState.modal !== 'addWaypoint') return;
		const { lat, lng } = e.latlng;

		if (tempMarker) map.removeLayer(tempMarker);
		tempMarker = L.marker([lat, lng], {
			icon: createIcon('stop'),
			opacity: 0.7,
		}).addTo(map);

		openModal('addWaypoint', { lat, lng });
		setAddingWaypoint(true);
	}

	function beginAddWaypoint() {
		setAddingWaypoint(true);
		openModal('addWaypoint');
	}

	function cancelAddWaypoint() {
		setAddingWaypoint(false);
		closeModal();
		if (tempMarker && map) {
			map.removeLayer(tempMarker);
			tempMarker = null;
		}
	}

	function locateUser() {
		map?.locate({ setView: true, maxZoom: 14, enableHighAccuracy: true });
	}

	onMount(() => {
		let cancelled = false;
		let onResize: (() => void) | null = null;
		let resizeObserver: ResizeObserver | null = null;
		let mapElWaitFrames = 0;
		const fallbackWindow = window as Window & { __rideFallbackMap?: any; __rideMapBootstrapped?: boolean };
		L = (window as Window & { L?: any }).L;
		if (!L) {
			mapError = 'Leaflet failed to load.';
			return;
		}

		const initMap = () => {
			if (cancelled) return;
			mapEl = document.getElementById(MAP_ELEMENT_ID) as HTMLDivElement | null;
			if (!mapEl) {
				mapElWaitFrames += 1;
				if (mapElWaitFrames > 180) {
					mapError = 'Map container failed to initialize. Please refresh the page.';
					return;
				}
				requestAnimationFrame(initMap);
				return;
			}

			try {
				const fallbackMap = fallbackWindow.__rideFallbackMap;
				if (fallbackMap && fallbackMap.getContainer?.() === mapEl) {
					map = fallbackMap;
					tileLayer = Object.values((map as any)._layers ?? {}).find((layer: any) => layer?._url);
				} else {
					map = L.map(mapEl, {
						zoomControl: false,
						attributionControl: true,
					}).setView([-34.5386, 146.5933], 6);

					tileLayer = L.tileLayer(TILE_URL_PRIMARY, {
						attribution: TILE_ATTR_PRIMARY,
						maxZoom: 19,
						keepBuffer: 3,
						subdomains: 'abcd',
						detectRetina: true,
					}).addTo(map);
					bindTileEvents(tileLayer);
				}
				mapInitialized = true;
				attachMapBehaviors();

				onResize = () => map?.invalidateSize();
				window.addEventListener('resize', onResize);
				resizeObserver = new ResizeObserver(() => map?.invalidateSize({ pan: false }));
				resizeObserver.observe(mapEl);
				requestAnimationFrame(() => map?.invalidateSize({ pan: false }));
				setTimeout(() => map?.invalidateSize({ pan: false }), 120);

				if (tripWaypoints.length) {
					syncMarkers(tripWaypoints as Waypoint[]);
					fetchRoute(tripWaypoints as Waypoint[]);
				}
			} catch (error) {
				console.error('[Ride] Map initialization failed:', error);
				mapError = 'Map failed to initialize on this device. Please refresh and try again.';
				mapInitialized = false;
			}
		};

		initMap();

		return () => {
			cancelled = true;
			if (rideWatchId !== null && navigator.geolocation) {
				navigator.geolocation.clearWatch(rideWatchId);
				rideWatchId = null;
			}
			routeRequestToken += 1;
			if (onResize) window.removeEventListener('resize', onResize);
			if (resizeObserver) resizeObserver.disconnect();
			if (map) {
				map.remove();
				map = null;
			}
			fallbackWindow.__rideFallbackMap = null;
			mapInitialized = false;
			fittedTripKey = '';
			setMapReady(false);
			tileLayer = null;
			markers.clear();
		};
	});

	// Reactive sync: re-runs when trip data or map readiness changes
	$effect(() => {
		const ready = $mapReady;
		if (ready && map) {
			syncMarkers(tripWaypoints as Waypoint[]);
			fetchRoute(tripWaypoints as Waypoint[]);
		}
	});

	$effect(() => {
		const currentTripId = $currentTrip?.id ?? '';
		if (!currentTripId) {
			fittedTripKey = '';
		}
	});

	$effect(() => {
		if (!map || $currentView !== 'map') return;
		requestAnimationFrame(() => map?.invalidateSize({ pan: false }));
		setTimeout(() => map?.invalidateSize({ pan: false }), 120);
	});

	$effect(() => {
		const riding = $isRiding;
		if (!riding) {
			if (rideWatchId !== null && navigator.geolocation) {
				navigator.geolocation.clearWatch(rideWatchId);
				rideWatchId = null;
			}
			return;
		}

		if (!navigator.geolocation) {
			toastInfo('Geolocation is not available on this device.');
			stopRide();
			return;
		}

		if (rideWatchId !== null) return;

		rideWatchId = navigator.geolocation.watchPosition(
			(position) => {
				updateRidePosition(position.coords);
				if (map) {
					map.panTo([position.coords.latitude, position.coords.longitude], { animate: true });
				}
				if ($currentTrip?.waypoints?.length) {
					updateRideProgress($currentTrip.waypoints, position.coords);
				}
			},
			(error) => {
				console.warn('[Ride] Geolocation watch failed:', error);
				toastInfo('Unable to start ride tracking without location access.');
				stopRide();
			},
			{ enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
		);

		return () => {
			if (rideWatchId !== null && navigator.geolocation) {
				navigator.geolocation.clearWatch(rideWatchId);
				rideWatchId = null;
			}
		};
	});

	$effect(() => {
		if (!map || $uiState.modal === 'addWaypoint' || $mapState.isAddingWaypoint) return;
		if (tempMarker) {
			map.removeLayer(tempMarker);
			tempMarker = null;
		}
	});
</script>

<div class="map-container">
	{#if mapError}
		<div class="map-error">{mapError}</div>
	{:else}
		<div id={MAP_ELEMENT_ID} class="map"></div>
	{/if}

	<div class="map-controls">
		<button
			class="map-fab"
			class:active={$mapState.isAddingWaypoint}
			onclick={() => ($mapState.isAddingWaypoint || $uiState.modal === 'addWaypoint') ? cancelAddWaypoint() : beginAddWaypoint()}
			aria-label={$mapState.isAddingWaypoint ? 'Cancel adding waypoint' : 'Add waypoint'}
		>
			{#if $mapState.isAddingWaypoint}
				<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
			{:else}
				<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
			{/if}
		</button>

		<button class="map-fab small" onclick={locateUser} aria-label="My location">
			<svg viewBox="0 0 24 24"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>
		</button>
	</div>

	{#if $mapState.isAddingWaypoint}
		<div class="map-hint">Tap the map to place a waypoint</div>
	{/if}

	<div class="map-debug" aria-live="polite">{mapDebugLabel}</div>
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
		min-height: 320px;
	}

	:global(.leaflet-container) {
		background: #d7dbe2;
	}

	.map-error {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: 24px;
		text-align: center;
		color: var(--text-secondary);
		background: var(--bg-surface);
	}

	.map-controls {
		position: absolute;
		right: 14px;
		bottom: calc(var(--nav-height) + var(--safe-bottom) + 12px);
		display: flex;
		flex-direction: column;
		gap: 10px;
		z-index: 1206;
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
		top: calc(var(--header-height) + var(--safe-top) + 10px);
		left: 50%;
		transform: translateX(-50%);
		padding: 8px 18px;
		background: rgba(99, 102, 241, 0.92);
		color: #fff;
		border-radius: var(--radius-lg);
		font-size: 0.85rem;
		font-weight: 500;
		z-index: 1206;
		pointer-events: none;
		animation: fadeSlideDown 0.2s ease;
	}

	.map-debug {
		position: absolute;
		left: 12px;
		bottom: calc(var(--nav-height) + var(--safe-bottom) + 14px);
		padding: 6px 10px;
		border-radius: 999px;
		font-size: 0.75rem;
		line-height: 1;
		background: rgba(15, 23, 42, 0.78);
		color: rgba(255, 255, 255, 0.86);
		backdrop-filter: blur(6px);
		z-index: 1206;
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
