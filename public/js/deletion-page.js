// Moved out of deletion.html (27 Nov 2026) so the page CSP needs no inline script.
(function() {
  const btn = document.getElementById('deleteDataBtn');
  const status = document.getElementById('deleteStatus');
  const confirmInput = document.getElementById('deleteConfirm');
  let authedUser = null;
  const pendingReauthKey = 'ride_pending_purge_reauth';

  function setStatus(message, tone) {
    status.textContent = message;
    status.className = `status ${tone || ''}`.trim();
  }

  function typedDeleteOk() {
    return confirmInput && confirmInput.value.trim().toUpperCase() === 'DELETE';
  }

  function syncButtonState() {
    const ready = !!authedUser && typedDeleteOk();
    btn.disabled = !ready;
  }

  function setLoginLinks() {
    const returnTo = window.location.href;
    const providers = ['google', 'microsoft'];
    providers.forEach((p) => {
      const el = document.getElementById(`loginBtn${p.charAt(0).toUpperCase() + p.slice(1)}`);
      if (el) el.href = API.auth.loginUrl(p, returnTo);
    });
  }

  function openLoginModal() {
    setLoginLinks();
    const modal = document.getElementById('loginModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeLoginModal() {
    const modal = document.getElementById('loginModal');
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  async function refreshAuthState() {
    try {
      authedUser = await API.auth.getUser();
    } catch (err) {
      authedUser = null;
    }
    syncButtonState();
  }

  function clearPendingReauth() {
    try { localStorage.removeItem(pendingReauthKey); } catch (_) {}
  }

  if (btn) {
    btn.addEventListener('click', async () => {
      if (!typedDeleteOk()) {
        setStatus('Type DELETE to confirm.', 'error');
        return;
      }

      // Always require a fresh login before deletion
      setStatus('Please re-authenticate to continue.', 'error');
      btn.textContent = 'Awaiting login...';
      btn.disabled = true;

      try {
        await API.auth.logout();
      } catch (_) {
        // best-effort logout; continue to require re-login
      }

      try { localStorage.setItem(pendingReauthKey, '1'); } catch (_) {}
      openLoginModal();
    });
  }

  if (confirmInput) {
    confirmInput.addEventListener('input', () => {
      syncButtonState();
    });
  }

  document.querySelectorAll('[data-close-login]').forEach((btnEl) => {
    btnEl.addEventListener('click', closeLoginModal);
  });
  const loginModalEl = document.getElementById('loginModal');
  if (loginModalEl) {
    loginModalEl.addEventListener('click', (e) => {
      if (e.target.id === 'loginModal') {
        closeLoginModal();
      }
    });
  }

  // Initial auth check; if returning from reauth, prompt to click again
  (async () => {
    await refreshAuthState();
    let pending = false;
    try { pending = localStorage.getItem(pendingReauthKey) === '1'; } catch (_) {}
    if (pending) {
      clearPendingReauth();
      if (authedUser) {
        setStatus('Authenticated. Click delete again to finish.', 'success');
        btn.textContent = 'Delete my Ride data';
        btn.disabled = !typedDeleteOk();
      } else {
        setStatus('Please sign in to continue deletion.', 'error');
      }
    }
  })();
})();
