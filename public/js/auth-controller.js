/**
 * Auth Controller — login/logout, session management, auth UI
 *
 * Guest-first: signing in is never required to use the app. The state machine
 * is UNKNOWN → CHECKING → AUTHENTICATED | UNAUTHENTICATED, where
 * UNAUTHENTICATED simply means guest mode (local trips through the API shim).
 *
 * Connectivity is deliberately NOT an auth signal. A network failure, timeout
 * or 5xx never changes auth state, never clears the trip and never covers the
 * map — it only raises a quiet degraded notice. Solely a confirmed 401 on a
 * live cloud session shows the sign-in prompt, and even then the map and the
 * loaded trip stay visible underneath it.
 *
 * Extends App object (loaded after app-core.js)
 */
Object.assign(App, {
  /** @type {'UNKNOWN'|'CHECKING'|'AUTHENTICATED'|'UNAUTHENTICATED'} */
  _authState: 'UNKNOWN',
  /** Timestamp of the last degraded-connectivity notice (throttles the toast) */
  _degradedNoticeAt: 0,

  /**
   * Central state transition — drives all auth-related UI.
   * @param {'CHECKING'|'AUTHENTICATED'|'UNAUTHENTICATED'} state
   * @param {{expired?: boolean}} [options] expired: a cloud session lapsed (401)
   */
  _setAuthState(state, options = {}) {
    const prev = this._authState;
    if (prev === state && state !== 'CHECKING') return; // no-op for same state (allow re-CHECKING)
    this._authState = state;

    switch (state) {
      case 'CHECKING':
        // No UI change while checking
        break;

      case 'AUTHENTICATED':
        this.updateUserUI();
        UI.hideAuthGate();
        UI.closeModal('loginModal');
        break;

      case 'UNAUTHENTICATED':
        this.currentUser = null;
        this.useCloud = false; // API.* now reads/writes localStorage
        try { localStorage.removeItem('ride_last_user_id'); } catch (_) {}
        this.updateUserUI();
        if (options.expired && !this.isSharedView) {
          // Trip + map stay on screen; the prompt just offers to resume syncing.
          UI.closeModal('loginModal');
          UI.showAuthGate('Session expired — sign in to keep syncing');
        } else {
          UI.hideAuthGate();
        }
        break;
    }
  },

  /**
   * Resolve the session silently. Returns true when a cloud session is live.
   * Skipped entirely mid-ride and while offline, and a transport failure never
   * downgrades the session — we keep whatever state we already had.
   */
  async checkAuth() {
    if (this.isRiding) return this._authState === 'AUTHENTICATED';
    if (!navigator.onLine) {
      // Nothing to ask. On a cold offline start settle into guest mode so
      // nothing waits on an answer that will never arrive; a session that was
      // already live stays live.
      if (this._authState === 'UNKNOWN') this._setAuthState('UNAUTHENTICATED');
      return this._authState === 'AUTHENTICATED';
    }

    const prev = this._authState;
    this._setAuthState('CHECKING');
    try {
      // getUser() resolves null on a confirmed 401 and throws on anything else.
      const user = await API.auth.getUser();
      if (user) {
        const lastUserId = localStorage.getItem('ride_last_user_id');
        if (lastUserId && lastUserId !== user.id) {
          // Different account on this device — drop the previous cloud ordering.
          Storage.clearTrips();
          Storage.setTripOrder([]);
        }
        localStorage.setItem('ride_last_user_id', user.id);
        this.currentUser = user;
        this.useCloud = true;
        this._setAuthState('AUTHENTICATED');
        return true;
      }
      this._setAuthState('UNAUTHENTICATED', { expired: prev === 'AUTHENTICATED' });
      return false;
    } catch (error) {
      this._authState = prev; // transient — not an auth answer
      this._noteDegraded(error);
      return prev === 'AUTHENTICATED';
    }
  },

  /**
   * Transient transport trouble (offline, timeout, 5xx). Non-blocking by
   * design: at most one toast a minute, no state change, no trip teardown,
   * and complete silence while a ride is in progress.
   */
  _noteDegraded(detail) {
    if (this.isRiding || this.isSharedView) return;
    const now = Date.now();
    if (now - (this._degradedNoticeAt || 0) < 60000) return;
    this._degradedNoticeAt = now;
    const isServer = detail?.kind === 'server' || Number(detail?.status) >= 500;
    let message;
    if (isServer) message = 'Server unreachable — recent changes may not be saved.';
    else if (this.useCloud && this.currentUser) message = 'Connection lost — recent changes may not be saved.';
    else message = 'Connection lost — your trips are safe on this device.';
    UI.showToast(message, 'info');
  },

  handleAuthExpired() {
    if (this._authState !== 'AUTHENTICATED') return;
    this._setAuthState('UNAUTHENTICATED', { expired: true });
  },

  handleConnectionLost(detail) {
    this._noteDegraded(detail);
  },

  handleAuthErrorFromUrl(code, description) {
    let message = 'Login failed. Please try again.';
    if (code === 'invalid_state') {
      message = 'Login expired. Please try again.';
    } else if (code === 'request_malformed' || code === 'invalid_request') {
      message = 'Login request was invalid. Please retry.';
    }
    if (description) message = `${message} (${description})`;
    UI.showToast(message, 'error');
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('error');
    cleanUrl.searchParams.delete('error_description');
    window.history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
  },

  configureLoginLinks() {
    const returnTo = window.location.href;
    document.querySelectorAll('[data-login-provider]').forEach((el) => {
      const provider = el.dataset.loginProvider;
      el.href = API.auth.loginUrl(provider, returnTo);
    });
  },

  bindUserButton() {
    const userBtn = document.getElementById('userBtn');
    if (!userBtn) return;
    userBtn.addEventListener('click', () => {
      if (this.currentUser) this.showUserDropdown();
      else this._suggestLogin('sync your trips across devices');
    });
  },

  updateUserUI() {
    const userBtn = document.getElementById('userBtn');
    const userAvatar = document.getElementById('userAvatar');
    const userInitial = document.getElementById('userInitial');
    if (this.currentUser) {
      userBtn.classList.add('logged-in');
      if (this.currentUser.avatar_url) {
        userAvatar.src = this.currentUser.avatar_url;
        userAvatar.classList.remove('hidden');
        if (userInitial) userInitial.classList.add('hidden');
      } else if (userInitial) {
        // No photo — show coloured initial
        userAvatar.classList.add('hidden');
        userAvatar.removeAttribute('src');
        const name = this.currentUser.name || this.currentUser.email || '?';
        userInitial.textContent = name.charAt(0).toUpperCase();
        userInitial.style.backgroundColor = this._initialColor(name);
        userInitial.classList.remove('hidden');
      }
    } else {
      userBtn.classList.remove('logged-in');
      userAvatar.classList.add('hidden');
      if (userInitial) userInitial.classList.add('hidden');
    }
  },

  /** Deterministic colour from a string */
  _initialColor(str) {
    const palette = [
      '#6366f1','#8b5cf6','#a855f7','#ec4899','#ef4444','#f97316',
      '#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6','#0ea5e9'
    ];
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return palette[Math.abs(hash) % palette.length];
  },

  showUserDropdown() {
    const existing = document.querySelector('.user-dropdown');
    if (existing) { existing.remove(); return; }
    const dropdown = document.createElement('div');
    dropdown.className = 'user-dropdown';
    dropdown.innerHTML = `
      <div class="user-dropdown-header">
        <div class="user-dropdown-name">${UI.escapeHtml(this.currentUser.name)}</div>
        <div class="user-dropdown-email">${UI.escapeHtml(this.currentUser.email)}</div>
      </div>
      <div class="user-dropdown-actions">
        <button id="logoutBtn" class="danger">Sign Out</button>
      </div>
    `;
    document.getElementById('userBtn').parentElement.appendChild(dropdown);
    dropdown.querySelector('#logoutBtn').addEventListener('click', () => this.logout());
    setTimeout(() => {
      document.addEventListener('click', function closeDropdown(e) {
        if (!dropdown.contains(e.target) && e.target.id !== 'userBtn') {
          dropdown.remove();
          document.removeEventListener('click', closeDropdown);
        }
      });
    }, 10);
  },

  async logout() {
    try { await API.auth.logout(); } catch (e) {}
    // Only the cloud ordering cache — guest trips (ride_local_trips) survive.
    Storage.clearTrips();
    const dropdown = document.querySelector('.user-dropdown');
    if (dropdown) dropdown.remove();
    this._setAuthState('UNAUTHENTICATED');
    this._failedMigrationIds = null;
    this._clearTripUI();
    await this.loadInitialTrip();
    this.refreshTripsList();
    UI.showToast('Signed out — you can keep planning as a guest', 'success');
  },

  /**
   * Re-check the session when the tab comes back or the network returns.
   * Never while riding (a mid-ride trip reload freezes the HUD) and never
   * while offline (an offline check would only produce a false negative).
   */
  bindSessionRefresh() {
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden || this.isRiding || !navigator.onLine) return;
      if (await this.checkAuth()) await this.refreshData('visibility');
    });
    window.addEventListener('online', async () => {
      if (this.isRiding) return;
      if (!await this.checkAuth()) return;
      // Anything planned while offline (guest store) belongs in the account.
      await this.migrateLocalTripsToCloud();
      await this.refreshData('online');
    });
  }
});
