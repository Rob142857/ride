/**
 * share-patch.js — near-stub.
 *
 * This file used to inject a stylesheet, rebuild the share page's mobile
 * header, and monkey-patch showTrip/renderTrip/chooseRoute. All of that
 * targeted a generation of markup that no longer exists: trip.html now ships
 * its own header, route selector and styling, and index.html never had any of
 * those elements. Everything dead was deleted rather than kept "just in case".
 *
 * The one behaviour still worth having lives here: trip.html captures the PWA
 * install prompt into window.__rideDeferredInstallPrompt and leaves a
 * .footer-actions row for the install CTA. That contract is honoured below and
 * no-ops everywhere else (including the app shell, which has its own banner).
 */
(function () {
  'use strict';

  const DISMISS_KEY = 'ride_share_install_dismissed';
  const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  function isDismissed() {
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      return !!raw && Date.now() - Number(raw) < COOLDOWN_MS;
    } catch (_) {
      return false;
    }
  }

  function markDismissed() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (_) {}
  }

  function alreadyPresent() {
    return !!document.querySelector('#rideShareInstallBtn, [data-ride-install]');
  }

  async function triggerInstall() {
    const promptEvent = window.__rideDeferredInstallPrompt;
    if (!promptEvent) return;
    promptEvent.prompt();
    let outcome = 'dismissed';
    try { ({ outcome } = await promptEvent.userChoice); } catch (_) {}
    window.__rideDeferredInstallPrompt = null;
    document.getElementById('rideShareInstallBtn')?.remove();
    if (outcome === 'dismissed') markDismissed();
  }

  function attachInstallButton() {
    if (isDismissed() || alreadyPresent()) return;
    const container = document.querySelector('.footer-actions');
    if (!container) return; // not a share page — nothing to do
    const btn = document.createElement('button');
    btn.id = 'rideShareInstallBtn';
    btn.type = 'button';
    btn.className = 'footer-cta ride-install-btn';
    btn.dataset.rideInstall = '1';
    btn.textContent = 'Install Ride';
    btn.addEventListener('click', triggerInstall);
    container.insertBefore(btn, container.firstChild);
  }

  function init() {
    if (!('beforeinstallprompt' in window)) return;
    if (window.__rideDeferredInstallPrompt) attachInstallButton();
    window.addEventListener('beforeinstallprompt', () => attachInstallButton());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
