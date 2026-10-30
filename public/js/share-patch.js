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
    return m >= 10000 ? (Math.round(m / 100) / 10).toFixed(1).replace(/\.0$/,'') + ' km'
      : m >= 1000 ? (m / 1000).toFixed(1).replace(/\.0$/,'') + ' km'
      : Math.round(m) + ' m';
  }
  function _fmtDur(s) {
    if (!s) return '0 min';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m} min`;
  }
  function _authHeaders() {
    if (typeof authHeaders === 'function') return authHeaders();
    const t = localStorage.getItem('ride_auth');
    return t ? { 'Authorization': `Bearer ${t}` } : {};
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
  const INSTALL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
    btn.innerHTML = '⬇ Install Ride';
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
    if (document.getElementById('rideShareInstallBtn')) return;
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

    window.addEventListener('beforeinstallprompt', () => {
      if (isInstallDismissed()) return;
      attachInstallButton();
    });
  }

  // Run install prompt init alongside mobile UI init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInstallPrompt);
  } else {
    initInstallPrompt();
  }


})();
