// Moved out of trip.html (27 Nov 2026) so the page CSP needs no inline script.
window.__rideDeferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  window.__rideDeferredInstallPrompt = e;
});
