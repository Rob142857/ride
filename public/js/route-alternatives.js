/**
 * Route Alternatives UI module for the Ride SPA.
 * Provides a panel for selecting alternative routes with badges,
 * distance/duration meta, and radio-style active indicators.
 */
(function() {
  'use strict';

  /* ── Helpers ──────────────────────────────────────────────────────── */

  function formatDistance(m) {
    if (window.RideUtils && typeof window.RideUtils.formatDistance === 'function') {
      return window.RideUtils.formatDistance(m);
    }
    if (!m && m !== 0) return '—';
    if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
    return Math.round(m) + ' m';
  }

  function formatDuration(s) {
    if (!s && s !== 0) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    return m + ' min';
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function svgCheck() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '3');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    p.setAttribute('points', '20 6 9 17 4 12');
    s.appendChild(p);
    return s;
  }

  function svgRoute() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('class', 'route-alt-icon');
    s.innerHTML = '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M12 19l4-9 2-4"/>';
    return s;
  }

  /* ── Panel builder ──────────────────────────────────────────────── */

  function buildPanel(trip) {
    const alts = trip && trip.alternativeRoutes;
    if (!Array.isArray(alts) || alts.length < 2) return null;

    const container = el('div', 'route-alternatives');
    const activeIdx = trip.activeRouteIndex || 0;

    // Header
    const header = el('div', 'route-alternatives-header');
    header.appendChild(svgRoute());
    const title = el('span', 'route-alt-title', 'Route Options');
    header.appendChild(title);
    const count = el('span', 'route-alt-count', alts.length + ' options');
    header.appendChild(count);
    container.appendChild(header);

    // Options
    const options = el('div', 'route-alt-options');
    alts.forEach((route, idx) => {
      const card = el('div', 'route-alt-card' + (idx === activeIdx ? ' active' : ''));
      card.setAttribute('data-index', String(idx));
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-pressed', String(idx === activeIdx));

      // Type badge
      const typeCls = ['route-alt-type'];
      if (route.is_fastest) typeCls.push('fastest');
      else if (route.is_fewer_turns) typeCls.push('fewer-turns');
      const badge = el('span', typeCls.join(' '));
      if (route.is_fastest) badge.textContent = 'Fastest';
      else if (route.is_fewer_turns) badge.textContent = 'Fewer turns';
      else badge.textContent = String(idx + 1);
      card.appendChild(badge);

      // Info
      const info = el('div', 'route-alt-info');
      const label = el('span', 'route-alt-label', route.name || ('Route ' + (idx + 1)));
      info.appendChild(label);
      const meta = el('span', 'route-alt-meta',
        formatDistance(route.distance || 0) + ' · ' + formatDuration(route.duration || 0));
      if (route.summary) meta.textContent += ' · ' + route.summary;
      info.appendChild(meta);
      card.appendChild(info);

      // Check indicator
      const check = el('div', 'route-alt-check');
      check.appendChild(svgCheck());
      card.appendChild(check);

      // Click / keyboard activation
      function activate() {
        if (idx === activeIdx) return;
        dispatchEvent(trip, idx, route);
      }
      card.addEventListener('click', activate);
      card.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          activate();
        }
      });

      options.appendChild(card);
    });

    container.appendChild(options);
    return container;
  }

  function dispatchEvent(trip, idx, route) {
    window.dispatchEvent(new CustomEvent('ride:routeSelected', {
      detail: { routeIndex: idx, route: route }
    }));
  }

  /* ── Module ─────────────────────────────────────────────────────── */

  let currentPanel = null;

  window.RouteAlternatives = {
    renderPanel(trip) {
      this.clear();
      const panel = buildPanel(trip);
      if (!panel) return null;
      currentPanel = panel;
      return panel;
    },

    activateRoute(trip, index) {
      const alts = trip && trip.alternativeRoutes;
      if (!Array.isArray(alts) || index < 0 || index >= alts.length) return false;
      const changed = index !== (trip.activeRouteIndex || 0);
      if (changed) {
        trip.activeRouteIndex = index;
        trip.distance = alts[index].distance;
        trip.duration = alts[index].duration;
      }
      // Re-render selection state if panel exists
      if (currentPanel) {
        const cards = currentPanel.querySelectorAll('.route-alt-card');
        cards.forEach((c, i) => {
          const isActive = i === index;
          c.classList.toggle('active', isActive);
          c.setAttribute('aria-pressed', String(isActive));
        });
      }
      return changed;
    },

    clear() {
      if (currentPanel && currentPanel.parentNode) {
        currentPanel.parentNode.removeChild(currentPanel);
      }
      currentPanel = null;
    },

    onRouteSelected(callback) {
      window.addEventListener('ride:routeSelected', function(ev) {
        callback(ev.detail);
      });
    }
  };
})();