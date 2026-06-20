(function() {
  'use strict';

  // ── Mobile share page CSS ──
  const style = document.createElement('style');
  style.textContent = `
    .share-mobile-header { display:none; }
    .share-mobile-back { display:none; }
    @media (max-width: 768px) {
      .share-view { padding:12px; }
      .trip-cover-image { height:160px !important; border-radius:14px !important; }
      .trip-hero-text .trip-title { font-size:1.5rem !important; }
      .trip-hero-text .trip-dates { font-size:0.85rem !important; }
      .trip-hero-text { margin:16px 0 !important; }
      .share-mobile-header { display:flex !important; align-items:center; gap:10px; padding:8px 0 4px; margin-bottom:8px; }
      .share-mobile-header .logo-icon { width:28px; height:28px; border-radius:7px; }
      .share-mobile-header .logo-text { font-size:1rem; font-weight:700; color:var(--heading); }
      .share-mobile-back { display:inline-flex !important; align-items:center; gap:4px; font-size:0.85rem; color:var(--text-muted); text-decoration:none; margin-bottom:8px; }
      /* Bottom-sheet route selector */
      .route-selector.route-sheet {
        position:fixed; bottom:0; left:0; right:0; z-index:2000;
        margin:0; border-radius:20px 20px 0 0;
        max-height:55vh; overflow-y:auto;
        box-shadow:0 -4px 20px rgba(0,0,0,0.15);
        background:var(--surface);
      }
      .route-sheet-handle {
        width:36px; height:4px; background:var(--border);
        border-radius:2px; margin:8px auto 0;
      }
      .route-sheet .route-selector-title {
        padding:8px 16px 4px; font-size:0.8rem;
        position:sticky; top:0; background:var(--surface); z-index:1;
      }
      .route-sheet .route-option {
        padding:14px 16px; margin-bottom:8px; border-radius:14px;
      }
      .route-sheet .route-badge {
        font-size:0.65rem; padding:3px 8px;
      }
      .route-sheet .route-summary {
        font-size:0.8rem;
      }
      .route-sheet .route-check svg {
        width:18px; height:18px;
      }
    }
  `;
  document.head.appendChild(style);

  // ── Helpers ──
  function _fmtDist(m) {
    if (!m) return '0 m';
    return m >= 10000 ? (Math.round(m/100)/10).toFixed(1).replace(/\.0$/,'') + ' km'
      : m >= 1000 ? (m/1000).toFixed(1).replace(/\.0$/,'') + ' km'
      : Math.round(m) + ' m';
  }
  function _fmtDur(s) {
    if (!s) return '0 min';
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    return h > 0 ? `${h}h ${m}m` : `${m} min`;
  }
  function _authHeaders() {
    if (typeof authHeaders === 'function') return authHeaders();
    const t = localStorage.getItem('ride_auth');
    return t ? { 'Authorization': `Bearer ${t}` } : {};
  }

  // ── Ensure route-selector container exists inside share-view ──
  function ensureRouteContainer() {
    const shareView = document.getElementById('share-view');
    if (!shareView) return null;
    let rs = shareView.querySelector('#route-selector');
    if (!rs) {
      rs = document.createElement('div');
      rs.id = 'route-selector';
      rs.className = 'route-selector';
      rs.style.display = 'none';
      const cta = shareView.querySelector('.share-cta');
      if (cta && cta.nextSibling) {
        shareView.insertBefore(rs, cta.nextSibling);
      } else {
        shareView.appendChild(rs);
      }
    }
    return rs;
  }

  // ── Portable renderRouteSelector ──
  function renderRouteSelectorPortable(trip) {
    const container = ensureRouteContainer() || document.getElementById('route-selector');
    if (!container) return;

    const allOptions = [trip.route, ...(trip.alternativeRoutes || trip.alt_routes || [])];
    if (allOptions.length < 2) {
      container.style.display = 'none';
      return;
    }

    const fastest = allOptions.slice().sort((a,b)=>(a.duration||Infinity)-(b.duration||Infinity))[0];
    const savedIndex = allOptions.findIndex(r => r.saved);
    const resolvedSavedIndex = savedIndex !== -1 ? savedIndex : (trip.activeRouteIndex ?? trip.active_route_index ?? 0);
    const isMobile = window.innerWidth <= 768;

    if (isMobile) container.classList.add('route-sheet');
    else container.classList.remove('route-sheet');

    const handle = isMobile ? '<div class="route-sheet-handle"></div>' : '';
    container.innerHTML = handle + `<div class="route-selector-title">Route Options</div>` + allOptions.map((opt, idx) => {
      const isFast = opt === fastest;
      const isSaved = idx === resolvedSavedIndex;
      const label = isSaved ? 'Saved' : isFast ? 'Fastest' : 'Alternative';
      const badgeClass = isSaved ? 'route-saved' : isFast ? 'route-fastest' : 'route-alternative';
      const summary = `${_fmtDist(opt.distance)} · ${_fmtDur(opt.duration)}`;
      return `
        <button class="route-option${idx === (window.activeRouteIndex||0) ? ' is-active' : ''}" data-idx="${idx}" type="button">
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
        if (idx === (window.activeRouteIndex||0)) return;
        window.activeRouteIndex = idx;

        // Redraw route line if drawRouteForIndex exists
        if (typeof drawRouteForIndex === 'function') {
          drawRouteForIndex(trip, idx, null);
        }
        container.querySelectorAll('.route-option').forEach(b => b.classList.toggle('is-active', parseInt(b.dataset.idx,10) === idx));

        // Update map stats if updateTripStatsForRoute exists
        if (typeof updateTripStatsForRoute === 'function') {
          updateTripStatsForRoute(trip, idx);
        }
      });
    });
  }

  // ── Inject mobile header/back into share-view ──
  function injectMobileShareUI() {
    const shareView = document.getElementById('share-view');
    if (!shareView || shareView.querySelector('.share-mobile-header')) return;

    const header = document.createElement('div');
    header.className = 'share-mobile-header';
    header.innerHTML = '<img src="/icons/icon-192.png" alt="Ride" class="logo-icon" width="28" height="28"><span class="logo-text">Ride</span>';
    header.style.display = 'none';

    const backLink = document.createElement('a');
    backLink.href = '/';
    backLink.className = 'share-mobile-back';
    backLink.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg> Back to Ride';
    backLink.style.display = 'none';

    const cover = shareView.querySelector('.trip-cover-image');
    if (cover && cover.parentNode === shareView) {
      shareView.insertBefore(backLink, cover);
      shareView.insertBefore(header, backLink);
    } else {
      shareView.insertBefore(header, shareView.firstChild);
    }
  }

  function showMobileUI(visible) {
    const isMobile = window.innerWidth <= 768;
    const header = document.querySelector('.share-mobile-header');
    const back = document.querySelector('.share-mobile-back');
    const display = visible && isMobile ? 'flex' : 'none';
    const displayBack = visible && isMobile ? 'inline-flex' : 'none';
    if (header) header.style.display = display;
    if (back) back.style.display = displayBack;
  }

  // ── Patch showTrip (index.html) ──
  const origShowTrip = window.showTrip;
  if (typeof origShowTrip === 'function') {
    window.showTrip = function(trip) {
      origShowTrip(trip);
      injectMobileShareUI();
      showMobileUI(true);
    };
  }

  // ── Patch renderTrip (trip.html) ──
  const origRenderTrip = window.renderTrip;
  if (typeof origRenderTrip === 'function') {
    window.renderTrip = function(trip) {
      origRenderTrip(trip);
      injectMobileShareUI();
      showMobileUI(true);
    };
  }

  // ── Provide chooseRoute if missing ──
  if (typeof window.chooseRoute !== 'function') {
    window.chooseRoute = async function(tripId, option) {
      try {
        const base = typeof API_BASE !== 'undefined' ? API_BASE : '';
        const url = (base ? base.replace(/\/$/,'') + '/' : '/') + `trips/${tripId}/route`;
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ..._authHeaders() },
          body: JSON.stringify({
            distance: option.distance,
            duration: option.duration,
            geometry: option.geometry,
            polyline: option.polyline,
            alt_idx: option.alt_idx ?? 0,
          }),
        });
        if (!res.ok) throw new Error('Failed to save route choice: ' + res.status);
        const data = await res.json();
        return data.trip || null;
      } catch (err) {
        if (typeof showToast === 'function') showToast('Failed to save route choice', 'error');
        console.error(err);
        return null;
      }
    };
  }

  // ── Initial inject ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectMobileShareUI);
  } else {
    injectMobileShareUI();
  }

  // ── Re-show mobile UI on resize ──
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => showMobileUI(true), 150);
  });

  // ── PWA Install Prompt (share pages only) ───────────────────────────
  const INSTALL_STORAGE_KEY = 'ride_share_install_dismissed';
  const INSTALL_COOLDOWN_MS =7 * 24 * 60 * 60 * 1000; //7 days

  function isInstallDismissed() {
    try {
      const raw = localStorage.getItem(INSTALL_STORAGE_KEY);
      if (!raw) return false;
      return Date.now() - Number(raw) < INSTALL_COOLDOWN_MS;
    } catch (_) {
      return false;
    }
  }

  function markInstallDismissed() {
    try { localStorage.setItem(INSTALL_STORAGE_KEY, String(Date.now())); } catch (_) {}
  }

  function createInstallButton() {
    if (document.getElementById('rideShareInstallBtn')) return null;
    const btn = document.createElement('button');
    btn.id = 'rideShareInstallBtn';
    btn.className = 'footer-cta ride-install-btn';
    btn.type = 'button';
    btn.innerHTML = `
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 02424" style="vertical-align:middle;margin-right:4px;">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M416v1a330003 3h10a3 30003-3v-1m-4-4-44m00-4-4m44V4"/>
      </svg>
      Install Ride
    `;
    return btn;
  }

  async function triggerInstall() {
    const promptEvent = window.__rideDeferredInstallPrompt;
    if (!promptEvent) return;
    promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    window.__rideDeferredInstallPrompt = null;
    const btn = document.getElementById('rideShareInstallBtn');
    if (btn) btn.remove();
    if (outcome === 'dismissed') {
      markInstallDismissed();
    }
  }

  function attachInstallButton() {
    const container = document.querySelector('.footer-actions');
    if (!container) return;
    const existing = document.getElementById('rideShareInstallBtn');
    if (existing) return;
    const btn = createInstallButton();
    if (!btn) return;
    btn.addEventListener('click', triggerInstall);
    container.insertBefore(btn, container.firstChild);
  }

  function initInstallPrompt() {
    if (!('beforeinstallprompt' in window)) return;
    if (isInstallDismissed()) return;

    if (window.__rideDeferredInstallPrompt) {
      attachInstallButton();
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      if (isInstallDismissed()) return;
      attachInstallButton();
    });
  }

  const installRun = () => {
    injectMobileShareUI();
    initInstallPrompt();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installRun);
  } else {
    installRun();
  }

})();
