/**
 * Save guard — keeps trip saves from hammering the API.
 *
 * - Single-flight per key (trip id): one save in flight; calls made meanwhile
 *   coalesce into one follow-up save that reads the latest state.
 * - Transient failures (network, 408, 425, 429, 5xx) retry with exponential
 *   back-off and jitter (about 1s, 2s, 4s ... capped at 60s), honour
 *   Retry-After, and stop after maxRetries.
 * - A 409/412 conflict pauses the key: no request goes out until resume(key).
 *   The onConflict hook runs once per pause so the app can fetch the latest
 *   trip a single time and ask the user what to do.
 *
 * Loaded as a classic script (window.RideSaveGuard) and as CommonJS for tests.
 */
(function (root) {
  const DEFAULTS = {
    baseMs: 1000,
    maxMs: 60000,
    jitter: 0.25,
    maxRetries: 8,
    retryAfterCapMs: 10 * 60 * 1000,
  };

  function isConflictStatus(status) {
    return status === 409 || status === 412;
  }

  function isTransientStatus(status) {
    return status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  }

  /** Retry-After as delta-seconds or an HTTP date; returns ms or null. */
  function parseRetryAfter(value, nowMs = Date.now()) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Math.round(Number(text) * 1000));
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    return Math.max(0, at - nowMs);
  }

  /**
   * Delay before retry number `attempt` (0-based): base * 2^attempt, capped
   * at maxMs, spread by +/- jitter. Never shorter than Retry-After.
   */
  function backoffDelay(attempt, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const random = typeof o.random === 'function' ? o.random : Math.random;
    const exp = Math.min(o.maxMs, o.baseMs * Math.pow(2, Math.max(0, attempt)));
    const spread = exp * o.jitter * (random() * 2 - 1);
    let delay = Math.round(Math.min(o.maxMs, Math.max(o.baseMs / 2, exp + spread)));
    if (Number.isFinite(o.retryAfterMs) && o.retryAfterMs > delay) {
      delay = Math.min(o.retryAfterCapMs, Math.round(o.retryAfterMs));
    }
    return delay;
  }

  function createSaveGuard(options = {}) {
    const o = { ...DEFAULTS, ...options };
    const timers = {
      set: o.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
      clear: o.clearTimeout || (id => clearTimeout(id)),
    };
    const now = o.now || (() => Date.now());
    const hook = (name, ...args) => {
      try { if (typeof o[name] === 'function') o[name](...args); } catch (_) {}
    };
    const states = new Map();

    function state(key) {
      if (!states.has(key)) {
        states.set(key, { inFlight: null, follow: null, timer: null, attempt: 0, paused: false, task: null, retryAt: 0 });
      }
      return states.get(key);
    }

    function retryAfterOf(err) {
      return parseRetryAfter(err?.retryAfter ?? err?.headers?.get?.('Retry-After') ?? null, now());
    }

    async function execute(key) {
      const s = state(key);
      let result;
      try {
        const value = await s.task();
        s.attempt = 0;
        result = { ok: true, value };
      } catch (error) {
        const status = Number(error?.status ?? 0);
        if (isConflictStatus(status)) {
          s.attempt = 0;
          const first = !s.paused;
          s.paused = true;
          if (s.timer) { timers.clear(s.timer); s.timer = null; }
          if (first) hook('onConflict', key, error);
          result = { ok: false, reason: 'conflict', error };
        } else if (isTransientStatus(status) && s.attempt < o.maxRetries) {
          const delay = backoffDelay(s.attempt, { ...o, retryAfterMs: retryAfterOf(error) });
          s.attempt += 1;
          s.retryAt = now() + delay;
          s.timer = timers.set(() => {
            s.timer = null;
            if (s.paused) return;
            start(key);
          }, delay);
          hook('onRetryScheduled', key, { attempt: s.attempt, delayMs: delay, error });
          result = { ok: false, reason: 'retrying', delayMs: delay, attempt: s.attempt, error };
        } else {
          const gaveUp = isTransientStatus(status);
          s.attempt = 0;
          if (gaveUp) hook('onGiveUp', key, error);
          result = { ok: false, reason: gaveUp ? 'gave-up' : 'failed', error };
        }
      }
      return result;
    }

    function start(key) {
      const s = state(key);
      const run = execute(key).then(result => {
        s.inFlight = null;
        if (result.ok && s.background) hook('onRecovered', key, result);
        s.background = false;
        const follow = s.follow;
        s.follow = null;
        if (follow) {
          // Saves requested mid-flight run once more with the latest state,
          // unless the first one hit a conflict or is now backing off.
          if (s.paused) follow.resolve({ ok: false, reason: 'paused' });
          else if (s.timer) follow.resolve({ ok: false, reason: 'retrying', delayMs: Math.max(0, s.retryAt - now()) });
          else start(key).then(follow.resolve);
        }
        if (!result.ok && result.reason === 'retrying') s.background = true;
        return result;
      });
      s.inFlight = run;
      return run;
    }

    return {
      /** Save `key` with `task` (an async function that throws {status} on failure). */
      run(key, task) {
        const s = state(key);
        s.task = task;
        if (s.paused) return Promise.resolve({ ok: false, reason: 'paused' });
        if (s.timer) {
          // Backing off: the scheduled retry will carry the latest state.
          return Promise.resolve({ ok: false, reason: 'retrying', delayMs: Math.max(0, s.retryAt - now()) });
        }
        if (s.inFlight) {
          if (!s.follow) {
            let resolve;
            const promise = new Promise(r => { resolve = r; });
            s.follow = { promise, resolve };
          }
          return s.follow.promise;
        }
        return start(key);
      },
      isPaused(key) { return states.has(key) && state(key).paused; },
      isBusy(key) { return states.has(key) && !!(state(key).inFlight || state(key).timer); },
      pause(key) {
        const s = state(key);
        s.paused = true;
        if (s.timer) { timers.clear(s.timer); s.timer = null; }
      },
      resume(key) {
        const s = state(key);
        s.paused = false;
        s.attempt = 0;
      },
      cancel(key) {
        const s = state(key);
        if (s.timer) { timers.clear(s.timer); s.timer = null; }
        s.attempt = 0;
      },
    };
  }

  const api = { createSaveGuard, backoffDelay, parseRetryAfter, isTransientStatus, isConflictStatus, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RideSaveGuard = api;
})(typeof window !== 'undefined' ? window : null);
