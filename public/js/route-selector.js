/**
 * Route Selector — unified route-alternatives UI.
 *
 * Renders alternative routes as a compact, accessible pill / card bar on desktop
 * and a bottom sheet on mobile. Keeps all map concerns inside MapManager and
 * emits selection events only.
 */
(function (window) {
  'use strict';

  const DEFAULTS = {
    position: 'top',          // 'top' | 'bottom'
    maxRoutes: 5,
    formatDistance: (m) => (window.RideUtils?.formatDistance ? RideUtils.formatDistance(m) : `${Math.round((m ||0) / 100) / 10} km`),
    formatDuration: (s) => (window.RideUtils?.formatDuration ? RideUtils.formatDuration(s) : `${Math.round((s || 0) / 60)} min`),
  };

  function create(mapOrContainer, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const container = resolveContainer(mapOrContainer);
    const root = document.createElement('div');
    root.className = 'route-selector hidden';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Route options');
    setRootPosition(root, config.position);
    container.appendChild(root);

    let routes = [];
    let selectedIndex = 0;
    let onSelect =null;
    let expanded =false;

    function setRootPosition(el, pos) {
      el.classList.remove('route-selector--top', 'route-selector--bottom');
      el.classList.add(`route-selector--${pos}`);
    }

    function resolveContainer(mapOrContainer) {
      if (!mapOrContainer) return document.body;
      if (mapOrContainer instanceof HTMLElement) return mapOrContainer;
      const mapContainer = mapOrContainer.getContainer?.();
      return mapContainer || document.body;
    }

    function formatDiff(primaryRoute, route) {
      if (!primaryRoute || !route) return '';
      const distDelta = (route.summary?.totalDistance || 0) - (primaryRoute.summary?.totalDistance || 0);
      const timeDelta = (route.summary?.totalTime || 0) - (primaryRoute.summary?.totalTime || 0);
      if (distDelta === 0 && timeDelta === 0) return '';
      const parts = [];
      if (distDelta > 0) parts.push(`+${config.formatDistance(distDelta)}`);
      else if (distDelta < 0) parts.push(config.formatDistance(Math.abs(distDelta)) + ' less');
      if (timeDelta > 0) parts.push(`+${config.formatDuration(timeDelta)}`);
      else if (timeDelta < 0) parts.push(config.formatDuration(Math.abs(timeDelta)) + ' faster');
      return parts.filter(Boolean).join(' · ');
    }

    function routeLabel(index, routesCount) {
      if (index === 0) return 'Best route';
      if (routesCount ===2) return 'Alternative';
      return `Alt ${index}`;
    }

    function render(newRoutes = [], newSelectedIndex = 0) {
      routes = newRoutes;
      selectedIndex = newSelectedIndex;
      expanded = false;

      if (!routes.length) {
        clear();
        return;
      }

      const primary = routes[0];

      const listId = `route-options-${Math.random().toString(36).slice(2, 8)}`;
      root.setAttribute('aria-controls', listId);
      root.classList.remove('hidden');

      const itemsHtml = routes.map((route, idx) => {
        const isActive = idx === selectedIndex;
        const distance = config.formatDistance(route.summary?.totalDistance);
        const duration = config.formatDuration(route.summary?.totalTime);
        const diff = idx === 0 ? '' : formatDiff(primary, route);
        return `
          <li class="route-pill${isActive ? ' is-active' : ''}" role="option" aria-selected="${isActive ? 'true' : 'false'}" data-index="${idx}" tabindex="0">
            <span class="route-pill-dot" aria-hidden="true" data-index="${idx}"></span>
            <span class="route-pill-body">
              <span class="route-pill-label">${routeLabel(idx, routes.length)}</span>
              <span class="route-pill-meta">
                <span class="route-pill-duration">${duration}</span>
                <span class="route-pill-distance">${distance}</span>
              </span>
              ${diff ? `<span class="route-pill-diff">${diff}</span>` : ''}
            </span>
          </li>
        `;
      }).join('');

      root.innerHTML = `
        <button type="button" class="route-selector-close" aria-label="Hide route options" title="Hide route options">×</button>
        <ul id="${listId}" class="route-selector-list" role="listbox" aria-label="Alternative routes">
          ${itemsHtml}
        </ul>
      `;

      root.querySelector('.route-selector-close').addEventListener('click', (e) => {
        e.stopPropagation();
        clear();
      });

      root.querySelectorAll('.route-pill').forEach((pill) => {
        const select = (e) => {
          e.stopPropagation();
          const idx = Number(pill.dataset.index);
          if (Number.isNaN(idx)) return;
          selectRoute(idx);
        };
        pill.addEventListener('click', select);
        pill.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select(e);
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            focusPill((Number(pill.dataset.index) + 1) % routes.length);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            focusPill((Number(pill.dataset.index) - 1 + routes.length) % routes.length);
          }
        });
      });
    }

    function focusPill(idx) {
      const pill = root.querySelector(`.route-pill[data-index="${idx}"]`);
      pill?.focus();
    }

    function selectRoute(index) {
      if (index === selectedIndex) return;
      selectedIndex = index;
      root.querySelectorAll('.route-pill').forEach((pill) => {
        const idx = Number(pill.dataset.index);
        const active = idx === selectedIndex;
        pill.classList.toggle('is-active', active);
        pill.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (typeof config.onSelect === 'function') config.onSelect(selectedIndex, routes[selectedIndex]);
      if (typeof onSelect === 'function') onSelect(selectedIndex, routes[selectedIndex]);
    }

    function clear() {
      routes =[];
      selectedIndex =0;
      root.classList.add('hidden');
      root.innerHTML = '';
    }

    function isVisible() {
      return !root.classList.contains('hidden');
    }

    function destroy() {
      root.remove();
    }

    return {
      render,
      clear,
      isVisible,
      selectRoute,
      setPosition(pos) {
        config.position = pos;
        setRootPosition(root, pos);
      },
      onSelect(cb) {
        onSelect = cb;
      },
      destroy,
    };
  }

  window.RouteSelector = { create, DEFAULTS };
})(window);
