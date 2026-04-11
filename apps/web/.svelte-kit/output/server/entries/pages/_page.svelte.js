import "../../chunks/index-server.js";
import { B as attr, V as escape_html, c as unsubscribe_stores, i as ensure_array_like, n as attr_class, o as store_get, r as derived } from "../../chunks/dev.js";
import { c as currentTrip, f as currentView, h as uiState, i as rideState, l as currentWaypoints, m as toastInfo, n as isRiding, r as mapState, t as formatDistance, u as tripState } from "../../chunks/utils2.js";
//#region src/lib/components/MapView.svelte
function MapView($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		let L;
		const TILE_URL_FALLBACK = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
		const TILE_ATTR_FALLBACK = "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors";
		const MAP_ELEMENT_ID = "ride-map-canvas";
		let map;
		let tileLayer = null;
		let mapError = "";
		let tileLoadSucceeded = false;
		let tileFailureCount = 0;
		let usingFallbackTiles = false;
		derived(() => store_get($$store_subs ??= {}, "$currentWaypoints", currentWaypoints).map((waypoint) => ({
			...waypoint,
			lat: Number(waypoint.lat ?? waypoint.latitude ?? NaN),
			lng: Number(waypoint.lng ?? waypoint.longitude ?? NaN)
		})).filter((waypoint) => Number.isFinite(waypoint.lat) && Number.isFinite(waypoint.lng)));
		function bindTileEvents(layer) {
			layer.on("tileerror", () => {
				tileFailureCount += 1;
				if (!tileLoadSucceeded && !usingFallbackTiles && tileFailureCount >= 6) {
					usingFallbackTiles = true;
					toastInfo("Primary map tiles failed. Switching to fallback tiles...");
					if (tileLayer && map?.hasLayer(tileLayer)) map.removeLayer(tileLayer);
					tileLayer = L.tileLayer(TILE_URL_FALLBACK, {
						attribution: TILE_ATTR_FALLBACK,
						maxZoom: 19,
						keepBuffer: 3,
						subdomains: "abcd"
					}).addTo(map);
					bindTileEvents(tileLayer);
				}
				if (!tileLoadSucceeded && tileFailureCount >= 12) toastInfo("Map tiles are loading slowly or being blocked.");
			});
			layer.on("load", () => {
				tileLoadSucceeded = true;
				tileFailureCount = 0;
				mapError = "";
			});
		}
		const mapDebugLabel = derived(() => {
			if (mapError) return `error: ${mapError}`;
			return "initializing map...";
		});
		$$renderer.push(`<div class="map-container svelte-njbu1f">`);
		if (mapError) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="map-error svelte-njbu1f">${escape_html(mapError)}</div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div${attr("id", MAP_ELEMENT_ID)} class="map svelte-njbu1f"></div>`);
		}
		$$renderer.push(`<!--]--> <div class="map-controls svelte-njbu1f"><button${attr_class("map-fab svelte-njbu1f", void 0, { "active": store_get($$store_subs ??= {}, "$mapState", mapState).isAddingWaypoint })}${attr("aria-label", store_get($$store_subs ??= {}, "$mapState", mapState).isAddingWaypoint ? "Cancel adding waypoint" : "Add waypoint")}>`);
		if (store_get($$store_subs ??= {}, "$mapState", mapState).isAddingWaypoint) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<svg viewBox="0 0 24 24" class="svelte-njbu1f"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<svg viewBox="0 0 24 24" class="svelte-njbu1f"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"></path></svg>`);
		}
		$$renderer.push(`<!--]--></button> <button class="map-fab small svelte-njbu1f" aria-label="My location"><svg viewBox="0 0 24 24" class="svelte-njbu1f"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"></path></svg></button></div> `);
		if (store_get($$store_subs ??= {}, "$mapState", mapState).isAddingWaypoint) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="map-hint svelte-njbu1f">Tap the map to place a waypoint</div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <div class="map-debug svelte-njbu1f" aria-live="polite">${escape_html(mapDebugLabel())}</div></div>`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
//#region src/lib/components/WaypointsView.svelte
function WaypointsView($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		const WP_ICONS = {
			stop: "📍",
			scenic: "🏞️",
			fuel: "⛽",
			food: "🍽️",
			lodging: "🏨",
			custom: "⭐"
		};
		const waypoints = derived(() => store_get($$store_subs ??= {}, "$currentWaypoints", currentWaypoints));
		let dragId = null;
		let overIdx = null;
		$$renderer.push(`<div class="waypoints-view svelte-40g25l"><div class="view-header svelte-40g25l"><h2 class="svelte-40g25l">Waypoints</h2> <span class="count-badge svelte-40g25l">${escape_html(waypoints().length)}</span> <button class="btn-primary small">+ Stop</button></div> `);
		if (waypoints().length === 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="empty-state svelte-40g25l"><svg viewBox="0 0 24 24" class="svelte-40g25l"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"></path></svg> <h3 class="svelte-40g25l">No waypoints yet</h3> <p class="svelte-40g25l">Switch to the map and tap + to add your first stop</p> <button class="btn-primary">Add Stop</button></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="waypoint-list svelte-40g25l" role="list"><!--[-->`);
			const each_array = ensure_array_like(waypoints());
			for (let i = 0, $$length = each_array.length; i < $$length; i++) {
				let wp = each_array[i];
				$$renderer.push(`<div${attr_class("waypoint-item svelte-40g25l", void 0, {
					"dragging": dragId === wp.id,
					"dragover": overIdx === i && dragId !== wp.id
				})} draggable="true" role="listitem"><div class="wp-handle svelte-40g25l" aria-hidden="true"><svg viewBox="0 0 24 24" class="svelte-40g25l"><path d="M10 4h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2zm4-12h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z"></path></svg></div> <span class="wp-icon svelte-40g25l">${escape_html(WP_ICONS[wp.type] ?? "📍")}</span> <div class="wp-info svelte-40g25l" role="button" tabindex="0"><span class="wp-name svelte-40g25l">${escape_html(i + 1)}. ${escape_html(wp.name)}</span> `);
				if (wp.address) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="wp-address svelte-40g25l">${escape_html(wp.address)}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div> <div class="wp-actions svelte-40g25l"><button class="icon-btn compact" aria-label="Move waypoint up"${attr("disabled", i === 0, true)}><svg viewBox="0 0 24 24"><path d="M7.41 14.59 12 10l4.59 4.59L18 13.17l-6-6-6 6z"></path></svg></button> <button class="icon-btn compact" aria-label="Move waypoint down"${attr("disabled", i === waypoints().length - 1, true)}><svg viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"></path></svg></button> <button class="icon-btn" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg></button></div></div>`);
			}
			$$renderer.push(`<!--]--></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
//#region src/lib/components/JournalView.svelte
function JournalView($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		const entries = derived(() => (store_get($$store_subs ??= {}, "$currentTrip", currentTrip)?.journalEntries ?? store_get($$store_subs ??= {}, "$currentTrip", currentTrip)?.journal ?? []).slice().sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()));
		function formatDate(d) {
			if (!d) return "";
			return new Date(d).toLocaleDateString(void 0, {
				month: "short",
				day: "numeric",
				year: "numeric"
			});
		}
		$$renderer.push(`<div class="journal-view svelte-19s3c3y"><div class="view-header svelte-19s3c3y"><h2 class="svelte-19s3c3y">Journal</h2> <span class="count-badge svelte-19s3c3y">${escape_html(entries().length)}</span> <button class="btn-primary small svelte-19s3c3y">+ Note</button></div> `);
		if (entries().length === 0) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="empty-state svelte-19s3c3y"><svg viewBox="0 0 24 24" class="svelte-19s3c3y"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"></path></svg> <h3 class="svelte-19s3c3y">No journal entries</h3> <p class="svelte-19s3c3y">Capture thoughts, photos, and memories from your trip</p></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="journal-list svelte-19s3c3y"><!--[-->`);
			const each_array = ensure_array_like(entries());
			for (let $$index_1 = 0, $$length = each_array.length; $$index_1 < $$length; $$index_1++) {
				let entry = each_array[$$index_1];
				$$renderer.push(`<article class="journal-card svelte-19s3c3y">`);
				if (entry.attachments?.length) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<div class="card-thumb svelte-19s3c3y"><img${attr("src", entry.attachments[0].url)} alt="" loading="lazy" class="svelte-19s3c3y"/></div>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> <div class="card-body svelte-19s3c3y"><h3 class="card-title svelte-19s3c3y">${escape_html(entry.title || "Untitled")}</h3> `);
				if (entry.content) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<p class="card-excerpt svelte-19s3c3y">${escape_html(entry.content.slice(0, 120))}${escape_html(entry.content.length > 120 ? "…" : "")}</p>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> <div class="card-meta svelte-19s3c3y"><span class="card-date svelte-19s3c3y">${escape_html(formatDate(entry.createdAt))}</span> `);
				if (entry.tags?.length) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<div class="card-tags svelte-19s3c3y"><!--[-->`);
					const each_array_1 = ensure_array_like(entry.tags);
					for (let $$index = 0, $$length = each_array_1.length; $$index < $$length; $$index++) {
						let tag = each_array_1[$$index];
						$$renderer.push(`<span class="tag svelte-19s3c3y">${escape_html(tag)}</span>`);
					}
					$$renderer.push(`<!--]--></div>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (entry.isPrivate) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="private-badge svelte-19s3c3y">Private</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div></div> <button class="icon-btn card-delete svelte-19s3c3y" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg></button></article>`);
			}
			$$renderer.push(`<!--]--></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
//#region src/lib/components/TripsView.svelte
function TripsView($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		const trips = derived(() => store_get($$store_subs ??= {}, "$tripState", tripState).list);
		function formatDate(d) {
			if (!d) return "";
			return new Date(d).toLocaleDateString(void 0, {
				month: "short",
				day: "numeric",
				year: "numeric"
			});
		}
		function tripStopCount(trip) {
			return trip.waypointCount ?? trip.waypoints?.length ?? 0;
		}
		$$renderer.push(`<div class="trips-view svelte-1hhqa5t"><div class="view-header svelte-1hhqa5t"><h2 class="svelte-1hhqa5t">My Trips</h2> <span class="count-badge svelte-1hhqa5t">${escape_html(trips().length)}</span> <button class="btn-primary small svelte-1hhqa5t">+ New Trip</button></div> `);
		if (store_get($$store_subs ??= {}, "$tripState", tripState).listLoading) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="trips-loading svelte-1hhqa5t"><!--[-->`);
			const each_array = ensure_array_like(Array(3));
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				each_array[$$index];
				$$renderer.push(`<div class="skeleton-card svelte-1hhqa5t"><div class="skeleton skeleton-title svelte-1hhqa5t"></div> <div class="skeleton skeleton-text svelte-1hhqa5t"></div></div>`);
			}
			$$renderer.push(`<!--]--></div>`);
		} else if (trips().length === 0) {
			$$renderer.push("<!--[1-->");
			$$renderer.push(`<div class="empty-state svelte-1hhqa5t"><svg viewBox="0 0 24 24" class="svelte-1hhqa5t"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"></path></svg> <h3 class="svelte-1hhqa5t">No trips yet</h3> <p class="svelte-1hhqa5t">Create your first trip to start planning an adventure</p> <button class="btn-primary">Create Trip</button></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="trip-grid svelte-1hhqa5t"><!--[-->`);
			const each_array_1 = ensure_array_like(trips());
			for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
				let trip = each_array_1[$$index_1];
				$$renderer.push(`<div${attr_class("trip-card svelte-1hhqa5t", void 0, { "active": store_get($$store_subs ??= {}, "$tripState", tripState).current?.id === trip.id })} role="button" tabindex="0">`);
				if (trip.coverImageUrl) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<div class="card-cover svelte-1hhqa5t"><img${attr("src", trip.coverImageUrl)} alt="" loading="lazy" class="svelte-1hhqa5t"/></div>`);
				} else {
					$$renderer.push("<!--[-1-->");
					$$renderer.push(`<div class="card-cover placeholder svelte-1hhqa5t"><svg viewBox="0 0 24 24" class="svelte-1hhqa5t"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"></path></svg></div>`);
				}
				$$renderer.push(`<!--]--> <div class="card-body svelte-1hhqa5t"><h3 class="card-name svelte-1hhqa5t">${escape_html(trip.name)}</h3> <div class="card-meta svelte-1hhqa5t"><span>${escape_html(tripStopCount(trip))} stops</span> <span>${escape_html(formatDate(trip.updatedAt))}</span></div></div> <button class="icon-btn card-delete svelte-1hhqa5t" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg></button></div>`);
			}
			$$renderer.push(`<!--]--></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
//#region src/lib/components/RideOverlay.svelte
function RideOverlay($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		if (store_get($$store_subs ??= {}, "$rideState", rideState).active) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div class="ride-overlay svelte-ssdsf2"><div class="ride-hud svelte-ssdsf2"><div class="hud-speed svelte-ssdsf2"><span class="speed-value svelte-ssdsf2">${escape_html(store_get($$store_subs ??= {}, "$rideState", rideState).speed ? Math.round(store_get($$store_subs ??= {}, "$rideState", rideState).speed * 3.6) : 0)}</span> <span class="speed-unit svelte-ssdsf2">km/h</span></div> `);
			if (store_get($$store_subs ??= {}, "$rideState", rideState).nextInstruction) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="hud-instruction svelte-ssdsf2"><span class="instruction-text svelte-ssdsf2">${escape_html(store_get($$store_subs ??= {}, "$rideState", rideState).nextInstruction.text)}</span> `);
				if (store_get($$store_subs ??= {}, "$rideState", rideState).nextInstruction.distance) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span class="instruction-dist svelte-ssdsf2">${escape_html(formatDistance(store_get($$store_subs ??= {}, "$rideState", rideState).nextInstruction.distance / 1e3))}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--> <div class="hud-stats svelte-ssdsf2">`);
			if (store_get($$store_subs ??= {}, "$rideState", rideState).position) {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<div class="hud-stat svelte-ssdsf2"><span class="stat-label svelte-ssdsf2">Heading</span> <span class="stat-value svelte-ssdsf2">${escape_html(store_get($$store_subs ??= {}, "$rideState", rideState).heading ? `${Math.round(store_get($$store_subs ??= {}, "$rideState", rideState).heading)}°` : "—")}</span></div>`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--> <div class="hud-stat svelte-ssdsf2"><span class="stat-label svelte-ssdsf2">Visited</span> <span class="stat-value svelte-ssdsf2">${escape_html(store_get($$store_subs ??= {}, "$rideState", rideState).visitedWaypoints.size)}</span></div></div></div> <button class="ride-end-btn svelte-ssdsf2"><svg viewBox="0 0 24 24" class="svelte-ssdsf2"><path d="M6 6h12v12H6z"></path></svg> End Ride</button></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]-->`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
//#region src/lib/components/ModalHost.svelte
function ModalHost($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		let wpName = "";
		let wpType = "stop";
		let wpNotes = "";
		let wpAddress = "";
		let wpLat = null;
		let wpLng = null;
		let placeQuery = "";
		let placeResults = [];
		let placeSearchLoading = false;
		let jTitle = "";
		let jContent = "";
		let jPrivate = false;
		let jTags = "";
		let isPublic = false;
		const wpTypes = [
			{
				value: "stop",
				label: "📍 Stop"
			},
			{
				value: "scenic",
				label: "🏞️ Scenic"
			},
			{
				value: "fuel",
				label: "⛽ Fuel"
			},
			{
				value: "food",
				label: "🍽️ Food"
			},
			{
				value: "lodging",
				label: "🏨 Lodging"
			},
			{
				value: "custom",
				label: "⭐ Custom"
			}
		];
		if (store_get($$store_subs ??= {}, "$uiState", uiState).modal) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<div${attr_class("modal-overlay svelte-1eowve3", void 0, { "passthrough": store_get($$store_subs ??= {}, "$uiState", uiState).modal === "addWaypoint" })}><div${attr_class("modal-sheet svelte-1eowve3", void 0, { "waypoint-sheet": store_get($$store_subs ??= {}, "$uiState", uiState).modal === "addWaypoint" })} role="dialog"${attr("aria-modal", store_get($$store_subs ??= {}, "$uiState", uiState).modal === "addWaypoint" ? "false" : "true")}><div class="modal-handle svelte-1eowve3"></div> `);
			if (store_get($$store_subs ??= {}, "$uiState", uiState).modal === "addWaypoint") {
				$$renderer.push("<!--[0-->");
				$$renderer.push(`<h2 class="modal-title svelte-1eowve3">Add Waypoint</h2> <form class="modal-form svelte-1eowve3"><div class="waypoint-actions-row svelte-1eowve3"><button class="btn-ghost small" type="button">Pick on map</button> <button class="btn-ghost small" type="button">Use my location</button></div> <input class="field svelte-1eowve3" type="text" placeholder="Waypoint name"${attr("value", wpName)} required=""/> <input class="field svelte-1eowve3" type="text" placeholder="Address or place details (optional)"${attr("value", wpAddress)}/> `);
				$$renderer.select({
					class: "field",
					value: wpType
				}, ($$renderer) => {
					$$renderer.push(`<!--[-->`);
					const each_array = ensure_array_like(wpTypes);
					for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
						let t = each_array[$$index];
						$$renderer.option({ value: t.value }, ($$renderer) => {
							$$renderer.push(`${escape_html(t.label)}`);
						});
					}
					$$renderer.push(`<!--]-->`);
				}, "svelte-1eowve3");
				$$renderer.push(` <div class="place-search-block svelte-1eowve3"><div class="place-search-row svelte-1eowve3"><input class="field svelte-1eowve3" type="text" placeholder="Search cafe, fuel, landmark..."${attr("value", placeQuery)}/> <button class="btn-ghost small" type="button"${attr("disabled", placeSearchLoading, true)}>${escape_html("Search")}</button></div> `);
				$$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (placeResults.length) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<div class="place-results svelte-1eowve3"><!--[-->`);
					const each_array_1 = ensure_array_like(placeResults);
					for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
						let place = each_array_1[$$index_1];
						$$renderer.push(`<button class="place-result svelte-1eowve3" type="button"><span class="place-name svelte-1eowve3">${escape_html(place.name)}</span> <span class="place-address svelte-1eowve3">${escape_html(place.address)}</span></button>`);
					}
					$$renderer.push(`<!--]--></div>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div> `);
				if (wpLat != null && wpLng != null) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<p class="muted coords-row svelte-1eowve3">Tap the map to reposition. ${escape_html(wpLat.toFixed(5))}, ${escape_html(wpLng.toFixed(5))}</p>`);
				} else {
					$$renderer.push("<!--[-1-->");
					$$renderer.push(`<p class="muted coords-row svelte-1eowve3">Choose a place, use your location, or tap the map to set coordinates.</p>`);
				}
				$$renderer.push(`<!--]--> <textarea class="field svelte-1eowve3" placeholder="Notes (optional)" rows="2">`);
				const $$body = escape_html(wpNotes);
				if ($$body) $$renderer.push(`${$$body}`);
				$$renderer.push(`</textarea> <button class="btn-primary" type="submit"${attr("disabled", wpLat == null || wpLng == null || !wpName.trim(), true)}>Add Waypoint</button></form>`);
			} else if (store_get($$store_subs ??= {}, "$uiState", uiState).modal === "addJournal" || store_get($$store_subs ??= {}, "$uiState", uiState).modal === "editJournal") {
				$$renderer.push("<!--[1-->");
				$$renderer.push(`<h2 class="modal-title svelte-1eowve3">${escape_html(store_get($$store_subs ??= {}, "$uiState", uiState).modal === "editJournal" ? "Edit Note" : "New Note")}</h2> <form class="modal-form svelte-1eowve3"><input class="field svelte-1eowve3" type="text" placeholder="Title"${attr("value", jTitle)} required=""/> <textarea class="field svelte-1eowve3" placeholder="What happened?" rows="4">`);
				const $$body_1 = escape_html(jContent);
				if ($$body_1) $$renderer.push(`${$$body_1}`);
				$$renderer.push(`</textarea> <input class="field svelte-1eowve3" type="text" placeholder="Tags (comma-separated)"${attr("value", jTags)}/> <label class="toggle-row svelte-1eowve3"><input type="checkbox"${attr("checked", jPrivate, true)}/> <span>Private note</span></label> <button class="btn-primary" type="submit">${escape_html(store_get($$store_subs ??= {}, "$uiState", uiState).modal === "editJournal" ? "Save" : "Add Note")}</button></form>`);
			} else if (store_get($$store_subs ??= {}, "$uiState", uiState).modal === "share") {
				$$renderer.push("<!--[2-->");
				$$renderer.push(`<h2 class="modal-title svelte-1eowve3">Share Trip</h2> <div class="modal-form svelte-1eowve3"><label class="toggle-row svelte-1eowve3"><input type="checkbox"${attr("checked", isPublic, true)}/> <span>Public trip</span></label> `);
				$$renderer.push("<!--[-1-->");
				$$renderer.push(`<p class="muted svelte-1eowve3">Generating share link…</p>`);
				$$renderer.push(`<!--]--></div>`);
			} else if (store_get($$store_subs ??= {}, "$uiState", uiState).modal === "waypointDetail") {
				$$renderer.push("<!--[3-->");
				const wp = store_get($$store_subs ??= {}, "$uiState", uiState).modalData;
				$$renderer.push(`<h2 class="modal-title svelte-1eowve3">${escape_html(wp?.name || "Waypoint")}</h2> <div class="modal-form svelte-1eowve3">`);
				if (wp?.address) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<p class="muted svelte-1eowve3">${escape_html(wp.address)}</p>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (wp?.notes) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<p>${escape_html(wp.notes)}</p>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> <div class="detail-meta svelte-1eowve3"><span>Type: ${escape_html(wp?.type)}</span> `);
				if (wp?.lat) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span>Lat: ${escape_html(wp.lat.toFixed(5))}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> `);
				if (wp?.lng) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<span>Lng: ${escape_html(wp.lng.toFixed(5))}</span>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div></div>`);
			} else {
				$$renderer.push("<!--[-1-->");
				$$renderer.push(`<p class="muted svelte-1eowve3">Unknown modal: ${escape_html(store_get($$store_subs ??= {}, "$uiState", uiState).modal)}</p>`);
			}
			$$renderer.push(`<!--]--> <button class="modal-close svelte-1eowve3" aria-label="Close"><svg viewBox="0 0 24 24" class="svelte-1eowve3"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg></button></div></div>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]-->`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
//#region src/routes/+page.svelte
function _page($$renderer) {
	var $$store_subs;
	$$renderer.push(`<div class="views svelte-1uha8ag"><div${attr_class("view svelte-1uha8ag", void 0, { "active": store_get($$store_subs ??= {}, "$currentView", currentView) === "map" })}>`);
	MapView($$renderer, {});
	$$renderer.push(`<!----></div> <div${attr_class("view svelte-1uha8ag", void 0, { "active": store_get($$store_subs ??= {}, "$currentView", currentView) === "waypoints" })}>`);
	WaypointsView($$renderer, {});
	$$renderer.push(`<!----></div> <div${attr_class("view svelte-1uha8ag", void 0, { "active": store_get($$store_subs ??= {}, "$currentView", currentView) === "journal" })}>`);
	JournalView($$renderer, {});
	$$renderer.push(`<!----></div> <div${attr_class("view svelte-1uha8ag", void 0, { "active": store_get($$store_subs ??= {}, "$currentView", currentView) === "trips" })}>`);
	TripsView($$renderer, {});
	$$renderer.push(`<!----></div></div> `);
	if (store_get($$store_subs ??= {}, "$isRiding", isRiding)) {
		$$renderer.push("<!--[0-->");
		RideOverlay($$renderer, {});
	} else $$renderer.push("<!--[-1-->");
	$$renderer.push(`<!--]--> `);
	ModalHost($$renderer, {});
	$$renderer.push(`<!---->`);
	if ($$store_subs) unsubscribe_stores($$store_subs);
}
//#endregion
export { _page as default };
