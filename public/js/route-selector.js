/**
 * Route Selector — the route-alternatives pill bar.
 *
 * Renders each alternative as a pill showing the road it follows, its time and
 * distance, a twistiness meter, and a badge: "Windiest" (gold) or "Fastest".
 * That badge is the whole point — it makes the scenic choice visible instead of
 * hiding it behind two near-identical durations.
 *
 * Markup is built with DOM APIs (no innerHTML) and every element carries BOTH
 * the BEM class name and the legacy short name so the stylesheet matches
 * whichever convention it settles on. `pointer-events` is forced back on for
 * the interactive parts because `.route-selector` itself is click-through.
 */
(function (window) {
  'use strict';

  const DEFAULTS = {
    position: 'top',          // 'top' | 'bottom'
    maxRoutes: 4,
    formatDistance: (m) => (window.RideUtils?.formatDistance
      ? RideUtils.formatDistance(m)
      : `${Math.round((m || 0) / 100) / 10} km`),
    formatDuration: (s) => (window.RideUtils?.formatDuration
      ? RideUtils.formatDuration(s)
      : `${Math.round((s || 0) / 60)} min`),
  };

  const BADGE_TEXT = { windiest: 'Windiest', fastest: 'Fastest' };

  function resolveContainer(mapOrContainer) {
    if (!mapOrContainer) return document.body;
    if (mapOrContainer instanceof HTMLElement) return mapOrContainer;
    return mapOrContainer.getContainer?.() || document.body;
  }

  /** Tolerate both the normalized shape and a raw Leaflet Routing route. */
  function routeDistance(route) {
    return Number(route?.distance ?? route?.summary?.totalDistance ?? 0) || 0;
  }
  function routeDuration(route) {
    return Number(route?.duration ?? route?.summary?.totalTime ?? 0) || 0;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function create(mapOrContainer, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const container = resolveContainer(mapOrContainer);

    const root = el('div', 'route-selector hidden');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Route options');
    setRootPosition(root, config.position);

    const listId = `route-options-${Math.random().toString(36).slice(2, 8)}`;
    const list = el('div', 'route-selector__list route-selector-list');
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Alternative routes');
    // The root is pointer-events:none so map drags pass through; the pills
    // themselves must still be clickable.
    list.style.pointerEvents = 'auto';

    const toggle = el('button', 'route-selector__close route-selector-close');
    toggle.type = 'button';
    toggle.style.pointerEvents = 'auto';
    toggle.setAttribute('aria-controls', listId);

    // Fastest/Windy engine switch + avoid-motorways toggle. Pure UI: clicks
    // only update local state and notify onModeChange — persistence + reroute
    // is MapManager's job (keeps this file free of API/App coupling).
    const modeToggle = el('div', 'route-mode-toggle');
    modeToggle.setAttribute('role', 'group');
    modeToggle.setAttribute('aria-label', 'Route mode');
    modeToggle.style.pointerEvents = 'auto';

    const fastestBtn = el('button', 'route-mode-btn is-active', 'Fastest');
    fastestBtn.type = 'button';
    fastestBtn.dataset.mode = 'fastest';
    fastestBtn.setAttribute('aria-pressed', 'true');

    const windyBtn = el('button', 'route-mode-btn', 'Windy');
    windyBtn.type = 'button';
    windyBtn.dataset.mode = 'windy';
    windyBtn.setAttribute('aria-pressed', 'false');

    const avoidBtn = el('button', 'route-avoid-motorways', 'Avoid highways and arterials');
    avoidBtn.type = 'button';
    avoidBtn.setAttribute('role', 'switch');
    avoidBtn.setAttribute('aria-checked', 'false');
    avoidBtn.style.pointerEvents = 'auto';

    // All three controls share the one glass bar. The avoid switch used to be
    // appended to `root` instead, which is a transparent pointer-events:none
    // overlay — so it rendered as bare text directly on the map (unreadable
    // over light terrain) and claimed a whole flex row of its own, leaving the
    // close button stranded on a fourth row.
    modeToggle.appendChild(fastestBtn);
    modeToggle.appendChild(windyBtn);
    modeToggle.appendChild(avoidBtn);

    root.appendChild(modeToggle);
    root.appendChild(list);
    root.appendChild(toggle);
    container.appendChild(root);

    // The bar lives inside the Leaflet map container. Gestures that begin on
    // it must never reach the map: Leaflet's drag handler preventDefault()s
    // the touchmoves, which kills native horizontal scrolling of the list on
    // mobile — the map pans underneath instead of the pills scrolling.
    [list, toggle, modeToggle, avoidBtn].forEach((node) => {
      // Raw stops first: Leaflet's pointer shim filters some pointerdown
      // events by pointerType, so its helpers alone are not airtight.
      ['pointerdown', 'touchstart', 'mousedown', 'wheel'].forEach((type) =>
        node.addEventListener(type, (e) => e.stopPropagation()));
      if (window.L?.DomEvent) {
        L.DomEvent.disableClickPropagation(node);
        L.DomEvent.disableScrollPropagation(node);
      }
    });

    // Desktop nicety: a mouse wheel over the bar scrolls it sideways instead
    // of doing nothing (vertical wheel has no axis to act on here).
    list.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && list.scrollWidth > list.clientWidth) {
        list.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });

    let routes = [];
    let selectedIndex = 0;
    let onSelect = null;
    let onModeChange = null;
    let collapsed = false;
    let mode = 'fastest';
    let avoidMotorways = false;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setCollapsed(!collapsed);
    });

    /** @param {{silent?: boolean}} [opts] silent = reflect external state without firing onModeChange. */
    function setMode(nextMode, opts = {}) {
      if (nextMode !== 'fastest' && nextMode !== 'windy') return;
      const changed = nextMode !== mode;
      mode = nextMode;
      fastestBtn.classList.toggle('is-active', mode === 'fastest');
      windyBtn.classList.toggle('is-active', mode === 'windy');
      fastestBtn.setAttribute('aria-pressed', mode === 'fastest' ? 'true' : 'false');
      windyBtn.setAttribute('aria-pressed', mode === 'windy' ? 'true' : 'false');
      if (changed && !opts.silent && typeof onModeChange === 'function') {
        onModeChange({ mode, avoidMotorways });
      }
    }

    /** @param {{silent?: boolean}} [opts] silent = reflect external state without firing onModeChange. */
    function setAvoidMotorways(next, opts = {}) {
      const value = !!next;
      const changed = value !== avoidMotorways;
      avoidMotorways = value;
      avoidBtn.classList.toggle('is-active', avoidMotorways);
      avoidBtn.setAttribute('aria-checked', avoidMotorways ? 'true' : 'false');
      if (changed && !opts.silent && typeof onModeChange === 'function') {
        onModeChange({ mode, avoidMotorways });
      }
    }

    fastestBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMode('fastest');
    });
    windyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMode('windy');
    });
    avoidBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setAvoidMotorways(!avoidMotorways);
    });

    function setRootPosition(node, pos) {
      node.classList.remove('route-selector--top', 'route-selector--bottom');
      node.classList.add(`route-selector--${pos}`);
    }

    /**
     * Collapse instead of dismiss — the old close button removed the picker
     * with no way back until the next recompute.
     */
    function setCollapsed(next) {
      collapsed = !!next;
      list.classList.toggle('hidden', collapsed);
      toggle.textContent = collapsed ? '⋯' : '×';
      toggle.title = collapsed ? 'Show route options' : 'Hide route options';
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.setAttribute(
        'aria-label',
        collapsed ? `Show route options (${routes.length})` : 'Hide route options'
      );
    }

    function formatDiff(primaryRoute, route) {
      if (!primaryRoute || !route) return '';
      const distDelta = routeDistance(route) - routeDistance(primaryRoute);
      const timeDelta = routeDuration(route) - routeDuration(primaryRoute);
      const parts = [];
      if (Math.abs(timeDelta) >= 60) {
        parts.push(timeDelta > 0
          ? `+${config.formatDuration(timeDelta)}`
          : `${config.formatDuration(Math.abs(timeDelta))} faster`);
      }
      if (Math.abs(distDelta) >= 500) {
        parts.push(distDelta > 0
          ? `+${config.formatDistance(distDelta)}`
          : `${config.formatDistance(Math.abs(distDelta))} shorter`);
      }
      return parts.join(' · ');
    }

    /**
     * Prefer the road the route actually follows ("via Snowy Mountains Hwy") —
     * far more useful than "Alt 2" when choosing a scenic line.
     */
    function routeLabel(route, index, count) {
      const name = (route?.name || '').split(',')[0].trim();
      if (name) return `via ${name.length > 22 ? `${name.slice(0, 21)}…` : name}`;
      if (index === 0) return 'Best route';
      if (count === 2) return 'Alternative';
      return `Alt ${index}`;
    }

    /** Twistiness meter, 0–1, scaled so ~120°/km reads as full. */
    function curvinessFraction(route) {
      const c = Number(route?.curviness) || 0;
      return Math.max(0.08, Math.min(1, c / 120));
    }

    function buildBadge(kind) {
      const badge = el(
        'span',
        `route-selector__badge route-selector__badge--${kind === 'windiest' ? 'windy' : 'fast'} route-pill-badge`,
        BADGE_TEXT[kind] || kind
      );
      // Minimal inline treatment so the badge reads correctly even before the
      // stylesheet learns about it; both values come from tokens.css.
      badge.style.cssText = [
        'font-size:0.68rem', 'font-weight:700', 'letter-spacing:0.04em',
        'text-transform:uppercase', 'padding:2px 7px', 'border-radius:999px',
        'white-space:nowrap', 'line-height:1.4'
      ].join(';');
      if (kind === 'windiest') {
        badge.style.background = 'var(--route, #f59e0b)';
        badge.style.color = 'var(--text-on-gold, #211a04)';
      } else {
        badge.style.background = 'var(--accent-soft, rgba(99,102,241,0.16))';
        badge.style.color = 'var(--accent-hover, #818cf8)';
      }
      return badge;
    }

    function buildPill(route, idx, primary, count) {
      const isActive = idx === selectedIndex;
      const pill = el(
        'div',
        `route-selector__pill route-pill${isActive ? ' route-selector__pill--active is-active' : ''}`
      );
      pill.setAttribute('role', 'option');
      pill.setAttribute('aria-selected', isActive ? 'true' : 'false');
      pill.dataset.index = String(idx);
      // Roving tabindex — one tab stop for the whole picker.
      pill.tabIndex = isActive ? 0 : -1;

      const bar = el('span', 'route-selector__bar route-pill-dot');
      bar.setAttribute('aria-hidden', 'true');
      const barInner = el('span', 'route-selector__bar-inner');
      barInner.style.height = `${Math.round(curvinessFraction(route) * 100)}%`;
      bar.appendChild(barInner);
      pill.appendChild(bar);

      const body = el('span', 'route-selector__body route-pill-body');
      body.appendChild(el('span', 'route-selector__route-name route-pill-label',
        routeLabel(route, idx, count)));

      const stats = el('span', 'route-selector__stats route-pill-meta');
      stats.appendChild(el('span', 'route-pill-duration', config.formatDuration(routeDuration(route))));
      stats.appendChild(el('span', 'route-pill-distance', config.formatDistance(routeDistance(route))));
      const diff = idx === 0 ? '' : formatDiff(primary, route);
      if (diff) stats.appendChild(el('span', 'route-pill-diff', diff));
      body.appendChild(stats);
      pill.appendChild(body);

      (route?.badges || []).forEach((kind) => pill.appendChild(buildBadge(kind)));

      const activate = (e) => {
        e.stopPropagation();
        selectRoute(idx);
      };
      pill.addEventListener('click', activate);
      pill.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(e);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          focusPill((idx + 1) % routes.length);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          focusPill((idx - 1 + routes.length) % routes.length);
        }
      });

      const label = [
        routeLabel(route, idx, count),
        config.formatDuration(routeDuration(route)),
        config.formatDistance(routeDistance(route)),
        ...(route?.badges || []).map((k) => BADGE_TEXT[k] || k)
      ].filter(Boolean).join(', ');
      pill.setAttribute('aria-label', label);

      return pill;
    }

    function render(newRoutes = [], newSelectedIndex = 0) {
      routes = Array.isArray(newRoutes) ? newRoutes.slice(0, config.maxRoutes) : [];
      selectedIndex = Number.isFinite(newSelectedIndex) ? newSelectedIndex : 0;
      if (selectedIndex < 0 || selectedIndex >= routes.length) selectedIndex = 0;

      // No route at all — nothing to show, including the mode toggle.
      if (!routes.length) {
        clear();
        return;
      }

      // A single route is not a *choice* — hide the pill list (and its
      // collapse button) but keep the bar (and the mode toggle) up, since
      // switching Fastest/Windy is still meaningful with only one route drawn.
      const hasChoice = routes.length >= 2;
      list.textContent = '';
      if (hasChoice) {
        const primary = routes[0];
        routes.forEach((route, idx) => list.appendChild(buildPill(route, idx, primary, routes.length)));
      }
      list.classList.toggle('hidden', !hasChoice);
      toggle.classList.toggle('hidden', !hasChoice);

      root.classList.remove('hidden');
      if (hasChoice) {
        setCollapsed(false);
        scrollActiveIntoView();
      } else {
        collapsed = false;
      }
    }

    /** Keep the chosen pill visible — off-screen selection reads as "missing". */
    function scrollActiveIntoView() {
      if (list.scrollWidth <= list.clientWidth) return;
      const active = list.querySelector('.is-active');
      if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }

    function focusPill(idx) {
      const pill = list.querySelector(`[data-index="${idx}"]`);
      if (!pill) return;
      list.querySelectorAll('[data-index]').forEach((p) => { p.tabIndex = -1; });
      pill.tabIndex = 0;
      pill.focus();
    }

    /**
     * @param {number} index
     * @param {{silent?: boolean}} [opts] silent = update the UI only (the caller
     *        is MapManager reflecting a selection made elsewhere, e.g. a tap on
     *        the grey line on the map).
     */
    function selectRoute(index, opts = {}) {
      if (!routes.length || index < 0 || index >= routes.length) return;
      const changed = index !== selectedIndex;
      selectedIndex = index;

      list.querySelectorAll('[data-index]').forEach((pill) => {
        const idx = Number(pill.dataset.index);
        const active = idx === selectedIndex;
        pill.classList.toggle('route-selector__pill--active', active);
        pill.classList.toggle('is-active', active);
        pill.setAttribute('aria-selected', active ? 'true' : 'false');
        pill.tabIndex = active ? 0 : -1;
      });
      scrollActiveIntoView();

      if (!changed || opts.silent) return;
      if (typeof config.onSelect === 'function') config.onSelect(selectedIndex, routes[selectedIndex]);
      if (typeof onSelect === 'function') onSelect(selectedIndex, routes[selectedIndex]);
    }

    function clear() {
      routes = [];
      selectedIndex = 0;
      collapsed = false;
      list.textContent = '';
      root.classList.add('hidden');
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
      /**
       * Reflect trip.settings.routing onto the toggle without firing
       * onModeChange — used by MapManager to sync the UI when a trip loads
       * or the active trip changes, as opposed to a user click.
       * @param {{mode?: string, avoidMotorways?: boolean}} state
       */
      setRouteMode(state = {}) {
        if (state.mode !== undefined) setMode(state.mode, { silent: true });
        if (state.avoidMotorways !== undefined) setAvoidMotorways(state.avoidMotorways, { silent: true });
      },
      /** cb({mode, avoidMotorways}) fires on every user click on the toggle. */
      onModeChange(cb) {
        onModeChange = cb;
      },
      destroy,
    };
  }

  window.RouteSelector = { create, DEFAULTS };
})(window);
