/**
 * trip-share-hero.js
 * Companion interactions for public/trip.html
 *
 * Auto-initialises on DOMContentLoaded as an IIFE.
 *
 * ── Globals expected from trip.html ──
 *   map   {L.Map|null}   Leaflet map instance
 *   data  {Object|null}  Trip payload
 *
 * ── DOM elements expected ──
 *   .hero                  – Hero overlay section
 *   #content               – Main page wrapper
 *   #map-section           – Map container
 *   #cover-section         – Cover image section
 *   .tab-btn               – Bottom tab buttons
 *   .tab-panel             – Tab content panels
 */

(function() {
  'use strict';

  /* ── Configuration ──────────────────────────────────────────────── */
  const HERO_KEY = 'ride_share_hero_seen';
  const SWIPE_THRESHOLD = 60;
  const SWIPE_TIME = 400;

  /* ── State ──────────────────────────────────────────────────────── */
  let heroEl, contentEl, mapSection;
  let touchStartY = 0, touchStartX = 0;
  let touchStartTime = 0;
  let isDismissed = false;

  /* ── Hero dismiss logic ─────────────────────────────────────────── */

  function shouldSkipHero() {
    try { return localStorage.getItem(HERO_KEY) === '1'; } catch(e) { return false; }
  }

  function markHeroSeen() {
    try { localStorage.setItem(HERO_KEY, '1'); } catch(e) {}
  }

  function dismissHero() {
    if (!heroEl || isDismissed) return;
    isDismissed = true;
    heroEl.style.transition = 'transform 0.45s var(--ease-smooth), opacity 0.4s ease';
    heroEl.style.transform = 'translateY(-100%)';
    heroEl.style.opacity = '0';
    setTimeout(() => {
      heroEl.style.display = 'none';
      if (contentEl) contentEl.style.display = '';
    }, 450);
    markHeroSeen();
  }

  function initHero() {
    heroEl = document.querySelector('.hero');
    contentEl = document.getElementById('content');
    if (!heroEl) return;

    const isContentHero = contentEl && contentEl.contains(heroEl);

    if (shouldSkipHero()) {
      heroEl.style.display = 'none';
      if (contentEl && !isContentHero) contentEl.style.display = '';
      return;
    }

    if (contentEl && !isContentHero) contentEl.style.display = 'none';

    heroEl.addEventListener('touchstart', function(e) {
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      touchStartTime = Date.now();
    }, { passive: true });

    heroEl.addEventListener('touchmove', function(e) {
      if (isDismissed) return;
      const dy = e.touches[0].clientY - touchStartY;
      if (dy > 0) {
        const pct = Math.min(dy / window.innerHeight, 0.5);
        heroEl.style.transform = 'translateY(' + (dy * 0.3) + 'px)';
        heroEl.style.opacity = String(1 - pct);
      }
    }, { passive: true });

    heroEl.addEventListener('touchend', function(e) {
      if (isDismissed) return;
      const dy = e.changedTouches[0].clientY - touchStartY;
      const dt = Date.now() - touchStartTime;
      if (dy > SWIPE_THRESHOLD || (dy > 20 && dt < 200)) {
        dismissHero();
      } else {
        heroEl.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
        heroEl.style.transform = '';
        heroEl.style.opacity = '';
        setTimeout(() => { heroEl.style.transition = ''; }, 300);
      }
    }, { passive: true });

    // Also dismiss on scroll down past hero
    let scrollTick = false;
    window.addEventListener('scroll', function() {
      if (isDismissed) return;
      if (!scrollTick) {
        requestAnimationFrame(() => {
          if (window.scrollY > heroEl.offsetHeight * 0.6) dismissHero();
          scrollTick = false;
        });
        scrollTick = true;
      }
    }, { passive: true });
  }

  /* ── Sticky stats bar ───────────────────────────────────────────── */

  function initStickyStats() {
    const statsBar = document.getElementById('sticky-stats');
    const mapSec = document.getElementById('map-section');
    if (!statsBar || !mapSec) return;

    const observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        statsBar.classList.toggle('visible', !entry.isIntersecting);
      });
    }, { threshold: 0.05 });

    observer.observe(mapSec);
  }

  /* ── Scroll progress bar ────────────────────────────────────────── */

  function initScrollProgress() {
    const bar = document.getElementById('scroll-progress');
    if (!bar) return;
    let tick = false;
    window.addEventListener('scroll', function() {
      if (tick) return;
      tick = true;
      requestAnimationFrame(function() {
        const h = document.documentElement.scrollHeight - window.innerHeight;
        const pct = h > 0 ? (window.scrollY / h) * 100 : 0;
        bar.style.width = pct + '%';
        tick = false;
      });
    }, { passive: true });
  }

  /* ── Section entrance animations ────────────────────────────────── */

  function initEntranceAnimations() {
    const sections = document.querySelectorAll('.tab-panel, .page-footer');
    if (!sections.length) return;
    if (!('IntersectionObserver' in window)) return;

    const obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });

    sections.forEach(function(s) { obs.observe(s); });
  }

  /* ── Pull-to-refresh (mobile) ───────────────────────────────────── */

  function initPullToRefresh() {
    if (!('ontouchstart' in window)) return;
    let startY = 0, refreshing = false;
    const ptr = document.getElementById('ptr-indicator');
    const ptrIcon = ptr ? ptr.querySelector('.ptr-spinner') : null;

    document.addEventListener('touchstart', function(e) {
      if (refreshing) return;
      if (window.scrollY > 5) return;
      startY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      if (refreshing) return;
      if (!ptr) return;
      if (window.scrollY > 5) { ptr.style.opacity = '0'; return; }
      const dy = e.touches[0].clientY - startY;
      if (dy > 0 && dy < 180) {
        const pct = dy / 120;
        ptr.style.opacity = String(Math.min(pct, 1));
        ptr.style.transform = 'translateY(' + (dy * 0.4) + 'px) scale(' + Math.min(1, 0.8 + pct * 0.2) + ')';
        if (ptrIcon) ptrIcon.style.transform = 'rotate(' + (pct * 360) + 'deg)';
      }
    }, { passive: true });

    document.addEventListener('touchend', function(e) {
      if (refreshing) return;
      if (!ptr) return;
      const dy = e.changedTouches[0].clientY - startY;
      if (dy > 100 && window.scrollY <= 5) {
        refreshing = true;
        ptr.classList.add('ptr-refreshing');
        setTimeout(() => {
          location.reload();
        }, 600);
      } else {
        ptr.style.transition = 'opacity 0.2s, transform 0.2s';
        ptr.style.opacity = '0';
        ptr.style.transform = '';
        setTimeout(() => { ptr.style.transition = ''; }, 200);
      }
    }, { passive: true });
  }

  /* ── Swipe nav between tabs ─────────────────────────────────────── */

  function initSwipeNav() {
    const tabs = document.querySelectorAll('.tab-btn');
    const panels = document.querySelectorAll('.tab-panel');
    if (tabs.length < 2) return;

    let startX = 0, startY = 0;
    const main = document.querySelector('main') || document.body;

    main.addEventListener('touchstart', function(e) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });

    main.addEventListener('touchend', function(e) {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx) * 1.5) return;

      const activeIdx = Array.from(tabs).findIndex(t => t.classList.contains('active'));
      if (activeIdx < 0) return;
      let next = activeIdx;
      if (dx < 0 && activeIdx < tabs.length - 1) next++;
      else if (dx > 0 && activeIdx > 0) next--;
      if (next !== activeIdx) tabs[next].click();
    }, { passive: true });
  }

  /* ── Reveal cover image ─────────────────────────────────────────── */

  function initCoverReveal() {
    const cover = document.getElementById('cover-img');
    if (!cover) return;
    cover.addEventListener('load', function() {
      cover.classList.add('loaded');
    });
    if (cover.complete) cover.classList.add('loaded');
  }

  /* ── Initialise ─────────────────────────────────────────────────── */

  function init() {
    initHero();
    initStickyStats();
    initScrollProgress();
    initEntranceAnimations();
    initPullToRefresh();
    initSwipeNav();
    initCoverReveal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();