import { a9 as ssr_context, a as attr_class, aa as attr, d as derived, c as store_get, u as unsubscribe_stores, b as escape_html, e as ensure_array_like } from "../../chunks/renderer.js";
import "clsx";
import { m as mapState, c as currentTrip, t as tripState, u as uiState, a as currentView, i as isRiding } from "../../chunks/map.js";
function onDestroy(fn) {
  /** @type {SSRContext} */
  ssr_context.r.on_destroy(fn);
}
function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1e3)} m`;
  return `${km.toFixed(1)} km`;
}
function MapView($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let markers = /* @__PURE__ */ new Map();
    const mstate = derived(() => store_get($$store_subs ??= {}, "$mapState", mapState));
    onDestroy(() => {
      markers.clear();
    });
    $$renderer2.push(`<div class="map-container svelte-njbu1f"><div class="map svelte-njbu1f"></div> <div class="map-controls svelte-njbu1f"><button${attr_class("map-fab svelte-njbu1f", void 0, {
      "active": (
        // Reactive updates:
        mstate().isAddingWaypoint
      )
    })}${attr("aria-label", mstate().isAddingWaypoint ? "Cancel adding waypoint" : "Add waypoint")}>`);
    if (mstate().isAddingWaypoint) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<svg viewBox="0 0 24 24" class="svelte-njbu1f"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<svg viewBox="0 0 24 24" class="svelte-njbu1f"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"></path></svg>`);
    }
    $$renderer2.push(`<!--]--></button> <button class="map-fab small svelte-njbu1f" aria-label="My location"><svg viewBox="0 0 24 24" class="svelte-njbu1f"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"></path></svg></button></div> `);
    if (mstate().isAddingWaypoint) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="map-hint svelte-njbu1f">Tap the map to place a waypoint</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function WaypointsView($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const WP_ICONS = {
      stop: "📍",
      scenic: "🏞️",
      fuel: "⛽",
      food: "🍽️",
      lodging: "🏨",
      custom: "⭐"
    };
    const trip = derived(() => store_get($$store_subs ??= {}, "$currentTrip", currentTrip));
    const waypoints = derived(() => (trip()?.waypoints ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
    let dragId = null;
    let overIdx = null;
    $$renderer2.push(`<div class="waypoints-view svelte-40g25l"><div class="view-header svelte-40g25l"><h2 class="svelte-40g25l">Waypoints</h2> <span class="count-badge svelte-40g25l">${escape_html(waypoints().length)}</span></div> `);
    if (waypoints().length === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="empty-state svelte-40g25l"><svg viewBox="0 0 24 24" class="svelte-40g25l"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"></path></svg> <h3 class="svelte-40g25l">No waypoints yet</h3> <p class="svelte-40g25l">Switch to the map and tap + to add your first stop</p></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="waypoint-list svelte-40g25l" role="list"><!--[-->`);
      const each_array = ensure_array_like(waypoints());
      for (let i = 0, $$length = each_array.length; i < $$length; i++) {
        let wp = each_array[i];
        $$renderer2.push(`<div${attr_class("waypoint-item svelte-40g25l", void 0, {
          "dragging": dragId === wp.id,
          "dragover": overIdx === i && dragId !== wp.id
        })} draggable="true" role="listitem"><div class="wp-handle svelte-40g25l" aria-hidden="true"><svg viewBox="0 0 24 24" class="svelte-40g25l"><path d="M10 4h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2zm4-12h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z"></path></svg></div> <span class="wp-icon svelte-40g25l">${escape_html(WP_ICONS[wp.type] ?? "📍")}</span> <div class="wp-info svelte-40g25l" role="button" tabindex="0"><span class="wp-name svelte-40g25l">${escape_html(i + 1)}. ${escape_html(wp.name)}</span> `);
        if (wp.address) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="wp-address svelte-40g25l">${escape_html(wp.address)}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div> <div class="wp-actions svelte-40g25l"><button class="icon-btn" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg></button></div></div>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    }
    $$renderer2.push(`<!--]--></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function JournalView($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const trip = derived(() => store_get($$store_subs ??= {}, "$currentTrip", currentTrip));
    const entries = derived(() => (trip()?.journalEntries ?? trip()?.journal ?? []).slice().sort((a, b) => new Date(b.createdAt ?? b.created_at ?? 0).getTime() - new Date(a.createdAt ?? a.created_at ?? 0).getTime()));
    function formatDate(d) {
      if (!d) return "";
      return new Date(d).toLocaleDateString(void 0, { month: "short", day: "numeric", year: "numeric" });
    }
    $$renderer2.push(`<div class="journal-view svelte-19s3c3y"><div class="view-header svelte-19s3c3y"><h2 class="svelte-19s3c3y">Journal</h2> <span class="count-badge svelte-19s3c3y">${escape_html(entries().length)}</span> <button class="btn-primary small svelte-19s3c3y">+ Note</button></div> `);
    if (entries().length === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="empty-state svelte-19s3c3y"><svg viewBox="0 0 24 24" class="svelte-19s3c3y"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"></path></svg> <h3 class="svelte-19s3c3y">No journal entries</h3> <p class="svelte-19s3c3y">Capture thoughts, photos, and memories from your trip</p></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="journal-list svelte-19s3c3y"><!--[-->`);
      const each_array = ensure_array_like(entries());
      for (let $$index_1 = 0, $$length = each_array.length; $$index_1 < $$length; $$index_1++) {
        let entry = each_array[$$index_1];
        $$renderer2.push(`<article class="journal-card svelte-19s3c3y">`);
        if (entry.attachments?.length) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="card-thumb svelte-19s3c3y"><img${attr("src", entry.attachments[0].url)} alt="" loading="lazy" class="svelte-19s3c3y"/></div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <div class="card-body svelte-19s3c3y"><h3 class="card-title svelte-19s3c3y">${escape_html(entry.title || "Untitled")}</h3> `);
        if (entry.content) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<p class="card-excerpt svelte-19s3c3y">${escape_html(entry.content.slice(0, 120))}${escape_html(entry.content.length > 120 ? "…" : "")}</p>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <div class="card-meta svelte-19s3c3y"><span class="card-date svelte-19s3c3y">${escape_html(formatDate(entry.createdAt ?? entry.created_at))}</span> `);
        if (entry.tags?.length) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="card-tags svelte-19s3c3y"><!--[-->`);
          const each_array_1 = ensure_array_like(entry.tags);
          for (let $$index = 0, $$length2 = each_array_1.length; $$index < $$length2; $$index++) {
            let tag = each_array_1[$$index];
            $$renderer2.push(`<span class="tag svelte-19s3c3y">${escape_html(tag)}</span>`);
          }
          $$renderer2.push(`<!--]--></div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> `);
        if (entry.isPrivate) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="private-badge svelte-19s3c3y">Private</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div></div> <button class="icon-btn card-delete svelte-19s3c3y" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg></button></article>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    }
    $$renderer2.push(`<!--]--></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function TripsView($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const state = derived(() => store_get($$store_subs ??= {}, "$tripState", tripState));
    const trips = derived(() => state().list);
    function formatDate(d) {
      if (!d) return "";
      return new Date(d).toLocaleDateString(void 0, { month: "short", day: "numeric", year: "numeric" });
    }
    $$renderer2.push(`<div class="trips-view svelte-1hhqa5t"><div class="view-header svelte-1hhqa5t"><h2 class="svelte-1hhqa5t">My Trips</h2> <span class="count-badge svelte-1hhqa5t">${escape_html(trips().length)}</span> <button class="btn-primary small svelte-1hhqa5t">+ New Trip</button></div> `);
    if (state().listLoading) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="trips-loading svelte-1hhqa5t"><!--[-->`);
      const each_array = ensure_array_like(Array(3));
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        each_array[$$index];
        $$renderer2.push(`<div class="skeleton-card svelte-1hhqa5t"><div class="skeleton skeleton-title svelte-1hhqa5t"></div> <div class="skeleton skeleton-text svelte-1hhqa5t"></div></div>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    } else if (trips().length === 0) {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<div class="empty-state svelte-1hhqa5t"><svg viewBox="0 0 24 24" class="svelte-1hhqa5t"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"></path></svg> <h3 class="svelte-1hhqa5t">No trips yet</h3> <p class="svelte-1hhqa5t">Create your first trip to start planning an adventure</p> <button class="btn-primary">Create Trip</button></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="trip-grid svelte-1hhqa5t"><!--[-->`);
      const each_array_1 = ensure_array_like(trips());
      for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
        let trip = each_array_1[$$index_1];
        $$renderer2.push(`<div${attr_class("trip-card svelte-1hhqa5t", void 0, { "active": state().current?.id === trip.id })} role="button" tabindex="0">`);
        if (trip.coverImageUrl) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="card-cover svelte-1hhqa5t"><img${attr("src", trip.coverImageUrl)} alt="" loading="lazy" class="svelte-1hhqa5t"/></div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<div class="card-cover placeholder svelte-1hhqa5t"><svg viewBox="0 0 24 24" class="svelte-1hhqa5t"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"></path></svg></div>`);
        }
        $$renderer2.push(`<!--]--> <div class="card-body svelte-1hhqa5t"><h3 class="card-name svelte-1hhqa5t">${escape_html(trip.name)}</h3> <div class="card-meta svelte-1hhqa5t"><span>${escape_html(trip.waypoints?.length ?? 0)} stops</span> <span>${escape_html(formatDate(trip.updatedAt ?? trip.updated_at))}</span></div></div> <button class="icon-btn card-delete svelte-1hhqa5t" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg></button></div>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    }
    $$renderer2.push(`<!--]--></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function RideOverlay($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const ride = derived(() => store_get($$store_subs ??= {}, "$mapState", mapState).ride);
    if (ride().active) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="ride-overlay svelte-ssdsf2"><div class="ride-hud svelte-ssdsf2"><div class="hud-speed svelte-ssdsf2"><span class="speed-value svelte-ssdsf2">${escape_html(ride().speed ? Math.round(ride().speed * 3.6) : 0)}</span> <span class="speed-unit svelte-ssdsf2">km/h</span></div> `);
      if (ride().nextInstruction) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="hud-instruction svelte-ssdsf2"><span class="instruction-text svelte-ssdsf2">${escape_html(ride().nextInstruction.text)}</span> `);
        if (ride().nextInstruction.distance) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="instruction-dist svelte-ssdsf2">${escape_html(formatDistance(ride().nextInstruction.distance / 1e3))}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> <div class="hud-stats svelte-ssdsf2">`);
      if (ride().position) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="hud-stat svelte-ssdsf2"><span class="stat-label svelte-ssdsf2">Heading</span> <span class="stat-value svelte-ssdsf2">${escape_html(ride().heading ? `${Math.round(ride().heading)}°` : "—")}</span></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> <div class="hud-stat svelte-ssdsf2"><span class="stat-label svelte-ssdsf2">Visited</span> <span class="stat-value svelte-ssdsf2">${escape_html(ride().visitedWaypoints.size)}</span></div></div></div> <button class="ride-end-btn svelte-ssdsf2"><svg viewBox="0 0 24 24" class="svelte-ssdsf2"><path d="M6 6h12v12H6z"></path></svg> End Ride</button></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function ModalHost($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    const ui = derived(() => store_get($$store_subs ??= {}, "$uiState", uiState));
    let wpName = "";
    let wpType = "stop";
    let wpNotes = "";
    let jTitle = "";
    let jContent = "";
    let jPrivate = false;
    let jTags = "";
    let isPublic = false;
    const wpTypes = [
      { value: "stop", label: "📍 Stop" },
      { value: "scenic", label: "🏞️ Scenic" },
      { value: "fuel", label: "⛽ Fuel" },
      { value: "food", label: "🍽️ Food" },
      { value: "lodging", label: "🏨 Lodging" },
      { value: "custom", label: "⭐ Custom" }
    ];
    if (ui().modal) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="modal-overlay svelte-1eowve3"><div class="modal-sheet svelte-1eowve3" role="dialog" aria-modal="true"><div class="modal-handle svelte-1eowve3"></div> `);
      if (ui().modal === "addWaypoint") {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<h2 class="modal-title svelte-1eowve3">Add Waypoint</h2> <form class="modal-form svelte-1eowve3"><input class="field svelte-1eowve3" type="text" placeholder="Waypoint name"${attr("value", wpName)} required=""/> `);
        $$renderer2.select(
          { class: "field", value: wpType },
          ($$renderer3) => {
            $$renderer3.push(`<!--[-->`);
            const each_array = ensure_array_like(wpTypes);
            for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
              let t = each_array[$$index];
              $$renderer3.option({ value: t.value }, ($$renderer4) => {
                $$renderer4.push(`${escape_html(t.label)}`);
              });
            }
            $$renderer3.push(`<!--]-->`);
          },
          "svelte-1eowve3"
        );
        $$renderer2.push(` <textarea class="field svelte-1eowve3" placeholder="Notes (optional)" rows="2">`);
        const $$body = escape_html(wpNotes);
        if ($$body) {
          $$renderer2.push(`${$$body}`);
        }
        $$renderer2.push(`</textarea> <button class="btn-primary" type="submit">Add Waypoint</button></form>`);
      } else if (ui().modal === "addJournal" || ui().modal === "editJournal") {
        $$renderer2.push("<!--[1-->");
        $$renderer2.push(`<h2 class="modal-title svelte-1eowve3">${escape_html(ui().modal === "editJournal" ? "Edit Note" : "New Note")}</h2> <form class="modal-form svelte-1eowve3"><input class="field svelte-1eowve3" type="text" placeholder="Title"${attr("value", jTitle)} required=""/> <textarea class="field svelte-1eowve3" placeholder="What happened?" rows="4">`);
        const $$body_1 = escape_html(jContent);
        if ($$body_1) {
          $$renderer2.push(`${$$body_1}`);
        }
        $$renderer2.push(`</textarea> <input class="field svelte-1eowve3" type="text" placeholder="Tags (comma-separated)"${attr("value", jTags)}/> <label class="toggle-row svelte-1eowve3"><input type="checkbox"${attr("checked", jPrivate, true)}/> <span>Private note</span></label> <button class="btn-primary" type="submit">${escape_html(ui().modal === "editJournal" ? "Save" : "Add Note")}</button></form>`);
      } else if (ui().modal === "share") {
        $$renderer2.push("<!--[2-->");
        $$renderer2.push(`<h2 class="modal-title svelte-1eowve3">Share Trip</h2> <div class="modal-form svelte-1eowve3"><label class="toggle-row svelte-1eowve3"><input type="checkbox"${attr("checked", isPublic, true)}/> <span>Public trip</span></label> `);
        {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<p class="muted svelte-1eowve3">Generating share link…</p>`);
        }
        $$renderer2.push(`<!--]--></div>`);
      } else if (ui().modal === "waypointDetail") {
        $$renderer2.push("<!--[3-->");
        const wp = ui().modalData;
        $$renderer2.push(`<h2 class="modal-title svelte-1eowve3">${escape_html(wp?.name || "Waypoint")}</h2> <div class="modal-form svelte-1eowve3">`);
        if (wp?.address) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<p class="muted svelte-1eowve3">${escape_html(wp.address)}</p>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> `);
        if (wp?.notes) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<p>${escape_html(wp.notes)}</p>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <div class="detail-meta svelte-1eowve3"><span>Type: ${escape_html(wp?.type)}</span> `);
        if (wp?.lat) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span>Lat: ${escape_html(wp.lat.toFixed(5))}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> `);
        if (wp?.lng) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span>Lng: ${escape_html(wp.lng.toFixed(5))}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<p class="muted svelte-1eowve3">Unknown modal: ${escape_html(ui().modal)}</p>`);
      }
      $$renderer2.push(`<!--]--> <button class="modal-close svelte-1eowve3" aria-label="Close"><svg viewBox="0 0 24 24" class="svelte-1eowve3"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg></button></div></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function _page($$renderer) {
  var $$store_subs;
  $$renderer.push(`<div class="views svelte-1uha8ag"><div${attr_class("view svelte-1uha8ag", void 0, {
    "active": store_get($$store_subs ??= {}, "$currentView", currentView) === "map"
  })}>`);
  MapView($$renderer);
  $$renderer.push(`<!----></div> <div${attr_class("view svelte-1uha8ag", void 0, {
    "active": store_get($$store_subs ??= {}, "$currentView", currentView) === "waypoints"
  })}>`);
  WaypointsView($$renderer);
  $$renderer.push(`<!----></div> <div${attr_class("view svelte-1uha8ag", void 0, {
    "active": store_get($$store_subs ??= {}, "$currentView", currentView) === "journal"
  })}>`);
  JournalView($$renderer);
  $$renderer.push(`<!----></div> <div${attr_class("view svelte-1uha8ag", void 0, {
    "active": store_get($$store_subs ??= {}, "$currentView", currentView) === "trips"
  })}>`);
  TripsView($$renderer);
  $$renderer.push(`<!----></div></div> `);
  if (store_get($$store_subs ??= {}, "$isRiding", isRiding)) {
    $$renderer.push("<!--[0-->");
    RideOverlay($$renderer);
  } else {
    $$renderer.push("<!--[-1-->");
  }
  $$renderer.push(`<!--]--> `);
  ModalHost($$renderer);
  $$renderer.push(`<!---->`);
  if ($$store_subs) unsubscribe_stores($$store_subs);
}
export {
  _page as default
};
