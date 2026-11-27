// Moved out of trip.html (27 Nov 2026) so the page CSP needs no inline script.
    let map = null;
    let mapBounds = null;
    let isMapFullscreen = false;
    let activeBasemap = 'streets';
    let basemapLayer = null;
    let basemapLayers = null;
    let currentTripData = null;
    let activeRouteIndex = 0;
    let routePolylines = [];
    const pendingImportKey = 'ride:pendingImportShortCode';
    const useTripButtons = () => Array.from(document.querySelectorAll('.use-trip-btn'));
    const defaultOgImage = 'https://ride.incitat.io/icons/og-ride.png';
    const heroPlaceholderSvg = `
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/>
      </svg>`;

    function setHeroPlaceholder() {
      const heroContainer = document.getElementById('hero-image-container');
      if (!heroContainer) return;
      heroContainer.className = 'hero-placeholder';
      heroContainer.innerHTML = heroPlaceholderSvg;
      updateMeta('og:image', defaultOgImage);
    }

    function setHeroImage(url, focusX = 50, focusY = 50, title = 'Trip cover') {
      const heroContainer = document.getElementById('hero-image-container');
      if (!heroContainer) return;
      heroContainer.className = 'hero-placeholder';
      heroContainer.textContent = '';
      const img = document.createElement('img');
      img.className = 'hero-image';
      img.src = url;
      img.alt = title;
      img.style.objectPosition = `${focusX}% ${focusY}%`;
      heroContainer.appendChild(img);
    }


    function setUseTripState(state, label) {
      useTripButtons().forEach(btn => {
        if (!btn) return;
        if (state === 'loading') {
          btn.disabled = true;
          btn.textContent = label || 'Importing...';
        } else if (state === 'success') {
          btn.disabled = true;
          btn.textContent = label || 'Added';
        } else if (state === 'error') {
          btn.disabled = false;
          btn.textContent = label || 'Try again';
        } else {
          btn.disabled = false;
          btn.textContent = label || 'Use this trip';
        }
      });
    }
    
    function showError() {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('error').style.display = 'flex';
    }
    
    function secondsToHMM(seconds) {
      if (!seconds) return '0 min';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m} min`;
    }

    function metersToString(meters) {
      if (!meters) return '0 m';
      const km = (meters / 1000).toFixed(1);
      return meters >= 10000
        ? (Math.round(meters / 100) / 10).toFixed(1).replace(/\.0$/, '') + ' km'
        : (meters >= 1000 ? km.replace(/\.0$/, '') + ' km' : Math.round(meters) + ' m');
    }

    function renderTrip(trip) {
      currentTripData = trip;
      activeRouteIndex = trip.activeRouteIndex ?? trip.active_route_index ?? 0;
      const allRoutes = [trip.route, ...(trip.alternativeRoutes || trip.alt_routes || [])];
      const activeRoute = allRoutes[activeRouteIndex] || trip.route;

      // Update page title and meta
      document.title = `${trip.title} | Ride`;
      
      // Update meta tags for social sharing
      updateMeta('og:title', trip.title);
      updateMeta('og:description', trip.description || 'Explore this trip on Ride');
      updateMeta('og:url', window.location.href);
      updateMeta('twitter:title', trip.title);
      updateMeta('twitter:description', trip.description || 'Explore this trip on Ride');

      const heroImage = trip.cover_image || trip.cover_image_url;
      const focusX = Number.isFinite(trip.cover_focus_x) ? trip.cover_focus_x : 50;
      const focusY = Number.isFinite(trip.cover_focus_y) ? trip.cover_focus_y : 50;
      if (heroImage) {
        updateMeta('og:image', heroImage);
        updateMeta('twitter:image', heroImage);
        setHeroImage(heroImage, focusX, focusY, trip.title);
      } else {
        setHeroPlaceholder();
      }
      
      // Title
      document.getElementById('trip-title').textContent = trip.title;
      
      // Meta info
      const metaHtml = [];
      if (trip.waypoints?.length) {
        metaHtml.push(`
          <span class="trip-meta-item">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
            </svg>
            ${trip.waypoints.length} waypoints
          </span>
        `);
      }
      if (activeRoute?.distance) {
        metaHtml.push(`
          <span class="trip-meta-item">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/>
            </svg>
            ${formatDistance(activeRoute.distance)}
          </span>
        `);
      }
      if (activeRoute?.duration) {
        metaHtml.push(`
          <span class="trip-meta-item">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            ${formatDuration(activeRoute.duration)}
          </span>
        `);
      }
      document.getElementById('trip-meta').innerHTML = metaHtml.join('');
      
      // Map stats
      const statsHtml = [];
      if (trip.waypoints?.length) {
        statsHtml.push(`<div class="stat-item"><div class="stat-value">${trip.waypoints.length}</div><div class="stat-label">Stops</div></div>`);
      }
      if (activeRoute?.distance) {
        statsHtml.push(`<div class="stat-item"><div class="stat-value">${formatDistance(activeRoute.distance)}</div><div class="stat-label">Distance</div></div>`);
      }
      if (activeRoute?.duration) {
        statsHtml.push(`<div class="stat-item"><div class="stat-value">${formatDuration(activeRoute.duration)}</div><div class="stat-label">Duration</div></div>`);
      }
      if (trip.journal?.length) {
        statsHtml.push(`<div class="stat-item"><div class="stat-value">${trip.journal.length}</div><div class="stat-label">Journal Entries</div></div>`);
      }
      document.getElementById('map-stats').innerHTML = statsHtml.join('');
      
      // Initialize map only when the shared journey exposes route/waypoint data.
      const hasMapData = !!(trip.waypoints?.length || trip.route?.coordinates?.length);
      const mapContainer = document.querySelector('.map-container');
      const mapControls = document.getElementById('mapExpandBtn')?.closest('.action-group');
      if (mapContainer) mapContainer.style.display = hasMapData ? '' : 'none';
      if (mapControls) mapControls.style.display = hasMapData ? '' : 'none';
      // Leaflet must measure a visible container before fitting the journey.
      document.getElementById('loading').style.display = 'none';
      document.getElementById('content').style.display = 'block';
      if (hasMapData) initMap(trip);
      
      // Description
      if (trip.description) {
        document.getElementById('trip-description').textContent = trip.description;
        document.getElementById('description-section').style.display = 'block';
      }
      
      // Waypoints
      if (trip.waypoints?.length) {
        const waypointsHtml = trip.waypoints.map((wp, i) => `
          <div class="waypoint-card" data-lat="${wp.lat}" data-lng="${wp.lng}">
            <div class="waypoint-number">${i + 1}</div>
            <div class="waypoint-info">
              <div class="waypoint-name">${escapeHtml(wp.name)}</div>
              <div class="waypoint-type">${escapeHtml(wp.type || 'Stop')}</div>
            </div>
          </div>
        `).join('');
        document.getElementById('waypoints-list').innerHTML = waypointsHtml;
        document.getElementById('waypoints-section').style.display = 'block';
        
        // Click to zoom on waypoint
        document.querySelectorAll('.waypoint-card').forEach(card => {
          card.addEventListener('click', () => {
            const lat = parseFloat(card.dataset.lat);
            const lng = parseFloat(card.dataset.lng);
            if (map) map.setView([lat, lng], 14);
          });
        });
      }
      
      // Gallery
      const images = trip.attachments?.filter(a => a.type?.startsWith('image/'));
      if (images?.length) {
        const galleryHtml = images.map(img => `
          <div class="gallery-item" data-lightbox-url="${escapeHtml(img.url)}" data-lightbox-caption="${escapeHtml(img.caption || img.name || '')}"><img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.caption || img.name)}" loading="lazy">
            <div class="gallery-item-overlay"></div>
            ${img.caption ? `<div class="gallery-caption">${escapeHtml(img.caption)}</div>` : ''}
          </div>
        `).join('');
        const galleryGrid = document.getElementById('gallery-grid');
        galleryGrid.innerHTML = galleryHtml;
        if (images.length <= 4) galleryGrid.classList.add('few-items');
        document.getElementById('gallery-section').style.display = 'block';
      }
      
      // Journal entries
      if (trip.journal?.length) {
        // Group image attachments by journal entry id
        const journalImages = {};
        if (trip.attachments?.length) {
          for (const a of trip.attachments) {
            if (a.journal_entry_id && a.type?.startsWith('image/')) {
              if (!journalImages[a.journal_entry_id]) journalImages[a.journal_entry_id] = [];
              journalImages[a.journal_entry_id].push(a);
            }
          }
        }

        const journalHtml = trip.journal.map(entry => {
          const entryImages = journalImages[entry.id] || [];
          const imagesHtml = entryImages.length ? `
            <div class="journal-images${entryImages.length === 1 ? ' single-image' : ''}">
              ${entryImages.map(img => `
                <div class="journal-image" data-lightbox-url="${escapeHtml(img.url)}" data-lightbox-caption="${escapeHtml(img.caption || img.name || '')}"><img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.caption || img.name || '')}" loading="lazy">
                  ${img.caption ? `<div class="journal-image-caption">${escapeHtml(img.caption)}</div>` : ''}
                </div>
              `).join('')}
            </div>
          ` : '';

          return `
            <article class="journal-card">
              <div class="journal-header">
                <h3 class="journal-title">${escapeHtml(entry.title)}</h3>
                <div class="journal-date">${formatDate(entry.created_at)}</div>
              </div>
              ${entry.content ? `<div class="journal-content">${escapeHtml(entry.content)}</div>` : ''}
              ${imagesHtml}
              ${entry.tags?.length ? `
                <div class="journal-tags">
                  ${entry.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
                </div>
              ` : ''}
            </article>
          `;
        }).join('');
        document.getElementById('journal-list').innerHTML = journalHtml;
        document.getElementById('journal-section').style.display = 'block';
      }
      
      // Contact
      if (trip.contact) {
        document.getElementById('contact-value').textContent = trip.contact;
        document.getElementById('contact-section').style.display = 'block';
      }
      
      // Render share-card hero banner if alternatives exist
      if (typeof TripShareHero !== 'undefined') {
        TripShareHero.renderHeroBanner(trip, 'banner-style');
      }

      // Ensure map paints correctly after being hidden
      setTimeout(() => {
        if (map) {
          map.invalidateSize();
          if (mapBounds) {
            map.fitBounds(mapBounds, { padding: [30, 30] });
          }
        }
      }, 50);
    }
    
    function initMap(trip) {
      // Mobile: disable scroll-wheel zoom to prevent scroll trap when browsing vertically.
      // Pinch-to-zoom, double-tap, and zoom buttons still work.
      map = L.map('trip-map', {
        zoomControl: true,
        scrollWheelZoom: false,
        dragging: true,
        // The basemap group adds its child after view initialization. Cap a
        // single-point fit before the child can contribute its zoom limits.
        maxZoom: 19
      });

      // Basemaps: default Streets + optional Satellite
      basemapLayers = {
        streets: RideBasemaps.streets(),
        satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles © Esri',
          maxZoom: 19
        })
      };

      setBasemap('streets');
      wireBasemapButtons();
      
      const markers = [];
      const bounds = [];
      
      // Add waypoint markers
      if (trip.waypoints?.length) {
        trip.waypoints.forEach((wp, i) => {
          const marker = L.circleMarker([wp.lat, wp.lng], {
            pane: 'markerPane',
            radius: 10,
            fillColor: '#3b82f6',
            color: '#fff',
            weight: 2,
            fillOpacity: 0.9
          }).addTo(map);
          
          marker.bindPopup(`<b>${i + 1}. ${escapeHtml(wp.name)}</b>`);
          markers.push(marker);
          bounds.push([wp.lat, wp.lng]);
        });
      }
      
      // Draw the saved/active route only
      routePolylines = [];
      drawRouteForIndex(trip, activeRouteIndex, bounds);
      map.on('zoomend', () => {
        routePolylines.forEach(line => line.setStyle(RideBasemaps.routeStyle(map.getZoom(), { color: '#3b82f6' })));
      });
      
      // Fit bounds
      if (bounds.length) {
        mapBounds = L.latLngBounds(bounds);
        map.fitBounds(mapBounds, { padding: [30, 30] });
      } else {
        // Default to Australia
        map.setView([-25.2744, 133.7751], 4);
        mapBounds = null;
      }
    }

    function drawRouteForIndex(trip, index, boundsAccumulator) {
      // Clear existing route lines only (not markers)
      routePolylines.forEach(p => { if (map.hasLayer(p)) map.removeLayer(p); });
      routePolylines = [];

      const allOptions = [trip.route, ...(trip.alternativeRoutes || trip.alt_routes || [])];
      if (!allOptions.length) return;

      // Draw only the saved/active route
      const opt = allOptions[index] || allOptions[0];
      if (!opt?.coordinates?.length) return;
      const coords = opt.coordinates.map(c => Array.isArray(c) ? [c[0], c[1]] : [c.lat, c.lng]);
      const routeLine = L.polyline(coords,
        RideBasemaps.routeStyle(map.getZoom(), { color: '#3b82f6' })).addTo(map);
      routePolylines.push(routeLine);
      if (boundsAccumulator) {
        coords.forEach(c => boundsAccumulator.push(c));
      }
    }

    function renderRouteSelector(trip) {
      const container = document.getElementById('route-selector');
      if (!container) return;

      const allOptions = [trip.route, ...(trip.alternativeRoutes || trip.alt_routes || [])];
      if (allOptions.length < 2) {
        container.style.display = 'none';
        return;
      }

      const fastest = allOptions.slice().sort((a, b) => (a.duration || Infinity) - (b.duration || Infinity))[0];
      const shortest = allOptions.slice().sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity))[0];
      const mainIndex = 0;
      const savedIndex = allOptions.findIndex(r => r.saved);
      const resolvedSavedIndex = savedIndex !== -1 ? savedIndex : (trip.activeRouteIndex ?? trip.active_route_index ?? 0);

      container.innerHTML = `<div class="route-selector-title">Route Options</div>` + allOptions.map((opt, idx) => {
        const isFast = opt === fastest;
        const isSaved = idx === resolvedSavedIndex;
        const label = isSaved ? 'Saved' : isFast ? 'Fastest' : 'Alternative';
        const badgeClass = isSaved ? 'route-saved' : isFast ? 'route-fastest' : 'route-alternative';
        const summary = `${metersToString(opt.distance)} · ${secondsToHMM(opt.duration)}`;

        return `
          <button class="route-option${idx === activeRouteIndex ? ' is-active' : ''}" data-idx="${idx}" type="button">
            <div class="route-info">
              <div class="route-badges">
                <span class="route-badge ${badgeClass}">${label}</span>
              </div>
              <div class="route-summary">${summary}</div>
            </div>
            <div class="route-check">
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
            </div>
          </button>
        `;
      }).join('');

      container.style.display = 'block';

      container.querySelectorAll('.route-option').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx, 10);
          if (idx === activeRouteIndex) return;

          activeRouteIndex = idx;
          window.activeRouteIndex = idx;
          drawRouteForIndex(trip, idx, null);

          // Update active class
          container.querySelectorAll('.route-option').forEach(b => b.classList.toggle('is-active', parseInt(b.dataset.idx, 10) === idx));

          // Update displayed stats to reflect selected route
          updateTripStatsForRoute(trip, idx);
        });
      });
    }

    function updateTripStatsForRoute(trip, idx) {
      const allOptions = [trip.route, ...(trip.alternativeRoutes || trip.alt_routes || [])];
      const selected = allOptions[idx];
      if (!selected) return;

      const statsHtml = [];
      if (trip.waypoints?.length) {
        statsHtml.push(`<div class="stat-item"><div class="stat-value">${trip.waypoints.length}</div><div class="stat-label">Stops</div></div>`);
      }
      statsHtml.push(`<div class="stat-item"><div class="stat-value">${formatDistance(selected.distance)}</div><div class="stat-label">Distance</div></div>`);
      statsHtml.push(`<div class="stat-item"><div class="stat-value">${formatDuration(selected.duration)}</div><div class="stat-label">Duration</div></div>`);
      if (trip.journal?.length) {
        statsHtml.push(`<div class="stat-item"><div class="stat-value">${trip.journal.length}</div><div class="stat-label">Journal Entries</div></div>`);
      }
      document.getElementById('map-stats').innerHTML = statsHtml.join('');
    }

    function setBasemap(type) {
      if (!map || !basemapLayers) return;
      
      const next = basemapLayers[type];
      if (!next) return;

      if (basemapLayer && map.hasLayer(basemapLayer)) {
        map.removeLayer(basemapLayer);
      }

      basemapLayer = next;
      activeBasemap = type;
      basemapLayer.addTo(map);
      updateBasemapButtons();
    }

    function updateBasemapButtons() {
      const streetsBtn = document.getElementById('basemapStreetsBtn');
      const satBtn = document.getElementById('basemapSatelliteBtn');
      if (!streetsBtn || !satBtn) return;

      streetsBtn.classList.toggle('is-active', activeBasemap === 'streets');
      satBtn.classList.toggle('is-active', activeBasemap === 'satellite');
    }

    function wireBasemapButtons() {
      const streetsBtn = document.getElementById('basemapStreetsBtn');
      const satBtn = document.getElementById('basemapSatelliteBtn');
      if (streetsBtn) streetsBtn.addEventListener('click', () => setBasemap('streets'));
      if (satBtn) satBtn.addEventListener('click', () => setBasemap('satellite'));
      updateBasemapButtons();
    }

    function toggleMapFullscreen() {
      const card = document.querySelector('.map-card');
      const btn = document.getElementById('mapExpandBtn');
      if (!card || !btn || !map) return;

      isMapFullscreen = !isMapFullscreen;
      card.classList.toggle('fullscreen', isMapFullscreen);
      document.body.classList.toggle('no-scroll', isMapFullscreen);
      btn.textContent = isMapFullscreen ? 'Close map' : 'Expand map';

      setTimeout(() => {
        map.invalidateSize();
        if (mapBounds) {
          map.fitBounds(mapBounds, { padding: [30, 30] });
        }
      }, 100);
    }
    
    function updateMeta(property, content) {
      let meta = document.querySelector(`meta[property="${property}"]`) || 
                 document.querySelector(`meta[name="${property}"]`);
      if (meta) meta.setAttribute('content', content);
    }
    
    function formatDistance(meters) {
      if (meters >= 1000) {
        return (meters / 1000).toFixed(1) + ' km';
      }
      return Math.round(meters) + ' m';
    }
    
    function formatDuration(seconds) {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      if (hours > 0) {
        return `${hours}h ${minutes}m`;
      }
      return `${minutes} min`;
    }
    
    function formatDate(dateStr) {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-AU', { 
        day: 'numeric', 
        month: 'short', 
        year: 'numeric' 
      });
    }
    
    function escapeHtml(text) {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // One click listener for gallery and journal images (replaces inline onclick).
    document.addEventListener('click', (event) => {
      const item = event.target.closest && event.target.closest('[data-lightbox-url]');
      if (item) openLightbox(item.dataset.lightboxUrl, item.dataset.lightboxCaption || '');
    });

    function slugify(text) {
      return (text || 'ride-trip')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'ride-trip';
    }

    function createDownload(filename, mime, data) {
      const blob = new Blob([data], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    function downloadJson(trip) {
      if (!trip) return;
      const name = slugify(trip.title || trip.name || 'ride-trip');
      createDownload(`${name}.json`, 'application/json', JSON.stringify(trip, null, 2));
    }

    function downloadGpx(trip) {
      if (!trip) return;
      const name = slugify(trip.title || trip.name || 'ride-trip');
      const points = (trip.route?.coordinates?.length ? trip.route.coordinates : trip.waypoints || [])
        .map((p, idx) => ({
          lat: parseFloat(p.lat),
          lon: parseFloat(p.lng || p.lon),
          name: p.name || `Stop ${idx + 1}`
        }))
        .filter(p => !Number.isNaN(p.lat) && !Number.isNaN(p.lon));

      if (!points.length) return;

      const esc = (s) => String(s || '').replace(/[<&>"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
      const trkpts = points.map(p => `    <trkpt lat="${p.lat}" lon="${p.lon}">${p.name ? `<name>${esc(p.name)}</name>` : ''}</trkpt>`).join('\n');
      const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n` +
`<gpx version="1.1" creator="Ride" xmlns="http://www.topografix.com/GPX/1/1">\n` +
`  <metadata><name>${esc(trip.title || trip.name || 'Ride Trip')}</name></metadata>\n` +
`  <trk>\n    <name>${esc(trip.title || trip.name || 'Ride Trip')}</name>\n    <trkseg>\n${trkpts}\n    </trkseg>\n  </trk>\n</gpx>`;

      createDownload(`${name}.gpx`, 'application/gpx+xml', gpx);
    }
    
    // Lightbox
    function openLightbox(src, caption) {
      document.getElementById('lightbox-image').src = src;
      document.getElementById('lightbox-caption').textContent = caption || '';
      document.getElementById('lightbox').classList.add('active');
      document.body.style.overflow = 'hidden';
    }
    
    function closeLightbox() {
      document.getElementById('lightbox').classList.remove('active');
      document.body.style.overflow = '';
    }
    
    document.getElementById('lightbox').addEventListener('click', (e) => {
      if (e.target.id === 'lightbox') closeLightbox();
    });
    
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });

    // Login modal events
    document.querySelectorAll('[data-close-login]').forEach((btn) => {
      btn.addEventListener('click', closeLoginModal);
    });

    const loginModalEl = document.getElementById('loginModal');
    if (loginModalEl) {
      loginModalEl.addEventListener('click', (e) => {
        if (e.target.id === 'loginModal') {
          closeLoginModal();
        }
      });
    }
    
    // Load trip on page load
    // Support both /trip.html?trip=abc123 and /abc123 (via worker redirect)
    function getShortCodeFromUrl() {
      const params = new URLSearchParams(window.location.search);
      if (params.has('trip')) return params.get('trip');
      // Also support /abc123 by checking pathname
      const match = window.location.pathname.match(/^\/?([a-zA-Z0-9]{6})$/);
      if (match) return match[1];
      return null;
    }

    const shortCode = getShortCodeFromUrl();

    // Clean up URL: if arrived via /trip.html?trip=abc123, rewrite to /abc123
    if (shortCode && window.location.pathname.includes('trip.html')) {
      try {
        history.replaceState(null, '', `/${shortCode}`);
      } catch (e) { /* ignore */ }
    }

    document.getElementById('mapExpandBtn')?.addEventListener('click', toggleMapFullscreen);
    document.getElementById('downloadJsonBtn')?.addEventListener('click', () => {
      if (window.trip) downloadJson(window.trip);
    });
    document.getElementById('downloadGpxBtn')?.addEventListener('click', () => {
      if (window.trip) downloadGpx(window.trip);
    });
    document.getElementById('downloadJsonBtnAlt')?.addEventListener('click', () => {
      if (window.trip) downloadJson(window.trip);
    });
    document.getElementById('downloadGpxBtnAlt')?.addEventListener('click', () => {
      if (window.trip) downloadGpx(window.trip);
    });

    useTripButtons().forEach((btn) => {
      btn.addEventListener('click', () => {
        setUseTripState('loading', 'Preparing...');
        importTripToAccount();
      });
    });
    setUseTripState('default');

    function showError(title = 'Trip Not Found', message = 'This trip may have been removed or the link is incorrect.') {
      document.getElementById('loading').style.display = 'none';
      const errorEl = document.getElementById('error');
      errorEl.querySelector('.error-title').textContent = title;
      errorEl.querySelector('.error-message').textContent = message;
      errorEl.style.display = 'flex';
    }

    function showPrivate() {
      showError('Trip Is Private', 'The creator has not shared this trip publicly yet.');
    }

    function normalizeWaypointInput(wp) {
      if (!wp) return null;
      const lat = parseFloat(wp.lat ?? wp.latitude);
      const lng = parseFloat(wp.lng ?? wp.lon ?? wp.longitude);
      if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
      return {
        name: wp.name || 'Waypoint',
        address: wp.address || '',
        lat,
        lng,
        type: wp.type || 'stop',
        notes: wp.notes || ''
      };
    }

    function normalizeJournalEntry(entry) {
      if (!entry) return null;
      return {
        title: entry.title || 'Note',
        content: entry.content || '',
        is_private: entry.is_private ?? entry.isPrivate ?? false,
        tags: Array.isArray(entry.tags) ? entry.tags : []
      };
    }

    function setLoginLinks() {
      const returnTo = window.location.href;
      const providers = ['google', 'microsoft'];
      providers.forEach((p) => {
        const el = document.getElementById(`loginBtn${p.charAt(0).toUpperCase() + p.slice(1)}`);
        if (el) el.href = API.auth.loginUrl(p, returnTo);
      });
    }

    function openLoginModal() {
      setLoginLinks();
      const modal = document.getElementById('loginModal');
      if (!modal) return;
      modal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    }

    function closeLoginModal() {
      const modal = document.getElementById('loginModal');
      if (!modal) return;
      modal.classList.add('hidden');
      document.body.style.overflow = '';
    }

    async function ensureUserOrPrompt() {
      try {
        const user = await API.auth.getUser();
        if (user) return user;
      } catch (err) {
        console.error('Auth check failed:', err);
      }

      if (shortCode) {
        localStorage.setItem(pendingImportKey, shortCode);
      }

      openLoginModal();
      return null;
    }

    async function importTripToAccount(autoResume = false) {
      if (!window.trip) return;

      const user = await ensureUserOrPrompt();
      if (!user) {
        if (!autoResume) setUseTripState('default');
        return;
      }

      setUseTripState('loading', 'Importing...');

      let createdTripId = null;
      try {
        const baseTrip = await API.trips.create({
          name: window.trip.title || window.trip.name || 'Imported Trip',
          description: window.trip.description || ''
        });
        createdTripId = baseTrip.id;

        let tripVersion = Number(baseTrip.version ?? 0);
        let wpAdded = 0;
        const wpTotal = Array.isArray(window.trip.waypoints) ? window.trip.waypoints.length : 0;

        if (wpTotal > 0) {
          for (const wp of window.trip.waypoints) {
            const normalized = normalizeWaypointInput(wp);
            if (!normalized) continue;
            const result = await API.waypoints.add(baseTrip.id, normalized, {
              headers: { 'If-Match': String(tripVersion) }
            });
            if (result?.trip_version !== undefined) {
              tripVersion = Number(result.trip_version);
            }
            wpAdded++;
          }
          if (wpAdded === 0) throw new Error('No waypoints were added');
        }

        if (window.trip.route) {
          await API.trips.update(baseTrip.id, { route: window.trip.route });
        }

        localStorage.removeItem(pendingImportKey);
        localStorage.setItem('ride_imported_trip_id', baseTrip.id);
        setUseTripState('success', 'Added to your trips');

        setTimeout(() => {
          window.location.href = '/';
        }, 800);
      } catch (err) {
        console.error('Failed to import trip:', err);
        // Clean up the empty shell trip so it doesn't confuse the user
        if (createdTripId) {
          try { await API.trips.delete(createdTripId); } catch (_) { /* best-effort */ }
        }
        localStorage.removeItem(pendingImportKey);
        localStorage.removeItem('ride_imported_trip_id');
        setUseTripState('error', 'Import failed. Try again');
      }
    }

    async function maybeResumeImport() {
      const pending = localStorage.getItem(pendingImportKey);
      if (!pending || pending !== shortCode) return;
      await importTripToAccount(true);
    }

    async function loadPublicTrip(code) {
      try {
        const res = await fetch(`/api/s/${code}`, {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          }
        });
        if (res.status === 403) {
          showPrivate();
          return;
        }
        if (!res.ok) {
          showError();
          return;
        }
        const data = await res.json();
        if (!data?.trip) {
          showError();
          return;
        }
        window.trip = data.trip;
        renderTrip(data.trip);
        await maybeResumeImport();
      } catch (err) {
        console.error('Failed to load trip:', err);
        showError();
      }
    }

    if (shortCode) {
      loadPublicTrip(shortCode);
    } else if (new URLSearchParams(window.location.search).get('test') === '1') {
      window.trip = {
        title: 'Sydney to Blue Mountains Test Trip',
        description: 'A scenic ride through the Blue Mountains with multiple route options.',
        short_code: 'abc123',
        cover_image: null,
        cover_focus_x: 50,
        cover_focus_y: 50,
        created_at: '2025-01-15T08:00:00Z',
        share: { includeWaypoints: true, includeRoute: true, includePublicNotes: true, includeGallery: true },
        waypoints: [
          { id: 1, name: 'Sydney CBD', lat: -33.8688, lng: 151.2093, type: 'start', sort_order: 0 },
          { id: 2, name: 'Katoomba', lat: -33.7120, lng: 150.3111, type: 'stop', sort_order: 1 },
          { id: 3, name: 'Blackheath', lat: -33.6350, lng: 150.2840, type: 'end', sort_order: 2 }
        ],
        journal: [],
        attachments: [],
        route: {
          distance: 12500,
          duration: 2700,
          coordinates: [
            [-33.8688, 151.2093], [-33.8600, 151.1800], [-33.8500, 151.1200],
            [-33.8200, 151.0000], [-33.7800, 150.8500], [-33.7500, 150.7000],
            [-33.7200, 150.5000], [-33.7120, 150.3111], [-33.6700, 150.3000], [-33.6350, 150.2840]
          ]
        },
        alternativeRoutes: [
          {
            routeIndex: 1,
            alt_idx: 1,
            name: 'M4 Motorway Route',
            summary: 'Via M4 motorway - faster but less scenic',
            distance: 10200,
            duration: 1620,
            saved: false,
            visible: true,
            coordinates: [
              [-33.8688, 151.2093], [-33.8650, 151.1500], [-33.8500, 151.0500],
              [-33.8000, 150.9000], [-33.7600, 150.7500], [-33.7300, 150.5500],
              [-33.7120, 150.3111], [-33.6700, 150.3000], [-33.6350, 150.2840]
            ]
          },
          {
            routeIndex: 2,
            alt_idx: 2,
            name: 'Scenic Bells Line Route',
            summary: 'Via Bell Line of Road - very scenic, saved by user',
            distance: 14800,
            duration: 3300,
            saved: true,
            visible: true,
            coordinates: [
              [-33.8688, 151.2093], [-33.8700, 151.2200], [-33.8600, 151.2500],
              [-33.8400, 151.3000], [-33.8000, 151.2500], [-33.7600, 151.1000],
              [-33.7300, 150.9000], [-33.7150, 150.6000], [-33.7120, 150.3111],
              [-33.6700, 150.3200], [-33.6500, 150.3100], [-33.6350, 150.2840]
            ]
          }
        ],
        activeRouteIndex: 2
      };
      renderTrip(window.trip);
    } else {
      showError();
    }

document.getElementById('lightboxCloseBtn')?.addEventListener('click', closeLightbox);
