/**
 * trip-share-hero.js
 * Companion behaviours for the public share page (public/trip.html).
 *
 * Public API — window.TripShareHero
 *   renderHeroBanner(trip)  Called by renderTrip() once the share payload lands.
 *                           Wires the sticky mini-header, the cover reveal, the
 *                           section entrance animations and the install prompt.
 *   refresh()               Re-runs the same wiring (safe to call repeatedly).
 *
 * Everything in here is progressive enhancement: if this file fails to load the
 * share page still renders, scrolls, and links correctly. Nothing hides content
 * that JavaScript would then have to bring back — the hero is a page header, not
 * a dismissible splash.
 */
(function () {
  'use strict';

  /* ── Configuration ──────────────────────────────────────────────── */
  var REVEAL_SELECTOR = [
    '#description-section',
    '#waypoints-section',
    '#gallery-section',
    '#journal-section',
    '#contact-section',
    '.page-footer'
  ].join(', ');

  var INSTALL_KEY = 'ride_share_install_dismissed';
  var INSTALL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  /* ── State (each initialiser is idempotent) ─────────────────────── */
  var scrollWired = false;
  var revealWired = false;
  var installWired = false;
  var pendingReveal = [];

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ── Scroll pass: sticky mini-header + section reveal ───────────
     One rAF-throttled listener drives both. The top bar is always
     present (brand + home link); once the hero has scrolled past it,
     it gains a glass background, the trip name and stats, and the
     "Open in Ride" CTA. */
  function initScrollEffects() {
    if (scrollWired) return;
    scrollWired = true;

    var ticking = false;
    var isScrolled = false;

    function threshold(topbar) {
      var hero = document.getElementById('hero');
      if (!hero) return 32;
      return Math.max(32, (hero.offsetHeight || 0) - (topbar.offsetHeight || 56) - 24);
    }

    function apply() {
      ticking = false;
      revealVisibleSections();

      var topbar = document.getElementById('share-topbar');
      if (!topbar) return;
      var next = window.scrollY > threshold(topbar);
      if (next === isScrolled) return;
      isScrolled = next;
      topbar.classList.toggle('scrolled', next);
      var trip = topbar.querySelector('.topbar-trip');
      if (trip) trip.setAttribute('aria-hidden', next ? 'false' : 'true');
    }

    function schedule() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(apply);
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    apply();
  }

  /* ── Cover image ────────────────────────────────────────────────
     trip.html fades the cover in on load; this is the belt-and-braces
     pass for a cached image plus a graceful fallback if it 404s. */
  function ensurePlaceholderWordmark() {
    var container = document.getElementById('hero-image-container');
    if (!container || !container.classList.contains('hero-placeholder')) return;
    if (container.querySelector('.placeholder-wordmark')) return;
    var mark = document.createElement('span');
    mark.className = 'placeholder-wordmark wordmark-shimmer';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = 'Ride';
    container.appendChild(mark);
  }

  function initCoverReveal() {
    var container = document.getElementById('hero-image-container');
    var img = container ? container.querySelector('.hero-image') : null;

    if (!img) {
      ensurePlaceholderWordmark();
      return;
    }

    if (img.complete && img.naturalWidth > 0) {
      img.classList.add('loaded');
      return;
    }

    img.addEventListener('load', function () {
      img.classList.add('loaded');
    }, { once: true });

    img.addEventListener('error', function () {
      // A broken cover should fall back to the branded hero, not an empty box.
      img.remove();
      if (container) container.classList.add('hero-placeholder');
      ensurePlaceholderWordmark();
    }, { once: true });
  }

  /* ── Section entrance animations ────────────────────────────────
     Sections are visible by default. The fade-up class is only applied
     once the page is actually on screen, and it is taken off by the same
     rAF-throttled scroll pass that drives the topbar — so there is no
     path where a section can end up permanently invisible. */
  function initSectionReveal() {
    if (revealWired || prefersReducedMotion()) return;

    // Measuring inside a display:none subtree gives every element a zero box,
    // which would reveal everything at once. Wait until #content is shown.
    var content = document.getElementById('content');
    if (!content || !content.offsetParent) return;

    var nodes = document.querySelectorAll(REVEAL_SELECTOR);
    if (!nodes.length) return;
    revealWired = true;

    Array.prototype.forEach.call(nodes, function (node) {
      node.classList.add('reveal');
      pendingReveal.push(node);
    });

    revealVisibleSections();
  }

  function revealVisibleSections() {
    if (!pendingReveal.length) return;
    var limit = window.innerHeight - 40;
    pendingReveal = pendingReveal.filter(function (node) {
      if (node.getBoundingClientRect().top > limit) return true;
      node.classList.add('in-view');
      return false;
    });
  }

  /* ── PWA install prompt ─────────────────────────────────────────
     A shared trip is exactly the moment a new visitor might install
     the app. Offered once, then snoozed for a week if dismissed. */
  function isInstallDismissed() {
    try {
      var raw = localStorage.getItem(INSTALL_KEY);
      if (!raw) return false;
      return Date.now() - Number(raw) < INSTALL_COOLDOWN_MS;
    } catch (e) {
      return false;
    }
  }

  function markInstallDismissed() {
    try { localStorage.setItem(INSTALL_KEY, String(Date.now())); } catch (e) { /* storage unavailable */ }
  }

  function isStandalone() {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    return window.navigator.standalone === true;
  }

  function triggerInstall() {
    var promptEvent = window.__rideDeferredInstallPrompt;
    if (!promptEvent) return;
    window.__rideDeferredInstallPrompt = null;
    promptEvent.prompt();
    Promise.resolve(promptEvent.userChoice).then(function (choice) {
      var btn = document.getElementById('rideShareInstallBtn');
      if (btn) btn.remove();
      if (choice && choice.outcome === 'dismissed') markInstallDismissed();
    }).catch(function () { /* prompt unavailable */ });
  }

  function attachInstallButton() {
    if (isInstallDismissed() || isStandalone()) return;
    if (document.getElementById('rideShareInstallBtn')) return;
    var container = document.querySelector('.footer-actions');
    if (!container) return;

    var btn = document.createElement('button');
    btn.id = 'rideShareInstallBtn';
    btn.type = 'button';
    btn.className = 'footer-about ride-install-btn';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16"/>' +
      '</svg>Install Ride';
    btn.addEventListener('click', triggerInstall);
    container.appendChild(btn);
  }

  function initInstallPrompt() {
    if (installWired) return;
    if (!('onbeforeinstallprompt' in window)) return;
    installWired = true;

    if (window.__rideDeferredInstallPrompt) attachInstallButton();

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      window.__rideDeferredInstallPrompt = e;
      attachInstallButton();
    });

    window.addEventListener('appinstalled', function () {
      var btn = document.getElementById('rideShareInstallBtn');
      if (btn) btn.remove();
    });
  }

  /* ── Entry points ───────────────────────────────────────────────── */
  function refresh() {
    initScrollEffects();
    initCoverReveal();
    initSectionReveal();
    initInstallPrompt();
  }

  /**
   * Called by trip.html's renderTrip() once the payload has been rendered.
   * The trip is accepted for future use (and kept for debugging) but the hero
   * markup itself is built by trip.html — this only wires behaviour.
   */
  function renderHeroBanner(trip) {
    window.TripShareHero.trip = trip || null;
    refresh();
  }

  window.TripShareHero = {
    trip: null,
    renderHeroBanner: renderHeroBanner,
    refresh: refresh
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
})();
