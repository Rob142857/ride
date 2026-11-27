// Moved out of index.html (27 Nov 2026) so the page CSP needs no inline script.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(reg => console.log('SW registered'))
    .catch(err => console.log('SW registration failed:', err));

  // Listen for build updates pushed by the SW
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'ride:update') {
      console.log('[App] New build detected:', event.data.build);
      if (typeof UI !== 'undefined' && UI.showToast) {
        UI.showToast('Updating…', 'info');
      }
      setTimeout(() => location.reload(), 600);
    }
  });
}

// ── PWA Install Prompt ──────────────────────────────────────────
let deferredInstallPrompt = null;
const installBanner = document.getElementById('installBanner');
const installAccept = document.getElementById('installAccept');
const installDismiss = document.getElementById('installDismiss');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // Don't re-show if user dismissed recently (24h cooldown)
  const dismissed = localStorage.getItem('ride_install_dismissed');
  if (dismissed && Date.now() - Number(dismissed) < 24 * 60 * 60 * 1000) return;
  // Show after a short delay so the app feels loaded first
  setTimeout(() => installBanner?.classList.remove('hidden'), 2000);
});

installAccept?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  installBanner?.classList.add('hidden');
  deferredInstallPrompt.prompt();
  const result = await deferredInstallPrompt.userChoice;
  console.log('[PWA] Install:', result.outcome);
  deferredInstallPrompt = null;
});

installDismiss?.addEventListener('click', () => {
  installBanner?.classList.add('hidden');
  deferredInstallPrompt = null;
  localStorage.setItem('ride_install_dismissed', Date.now().toString());
});

// Hide banner if app is already installed (standalone mode)
if (window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone) {
  installBanner?.classList.add('hidden');
}
