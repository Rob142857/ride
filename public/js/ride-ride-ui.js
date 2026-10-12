/* Small, non-modal status and feedback elements for Ride mode. */
(function () {
  'use strict';

  let deviationCallbacks = null;
  let undoCallback = null;
  let undoTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function setRecordingStatus(text) {
    const label = byId('rideRecordingStatus');
    const status = label?.parentElement;
    if (!label) return;

    const value = String(text || 'Waiting for GPS');
    label.textContent = value;
    if (status) {
      const normalized = value.toLowerCase();
      const state = normalized.includes('sync') ? 'sync'
        : normalized.includes('paus') || normalized.includes('unavailable') || normalized.includes('not saved') || normalized.includes('another tab') ? 'paused'
          : normalized.includes('gps') || normalized.includes('wait') ? 'waiting'
            : 'recording';
      status.dataset.state = state;
    }
  }

  function clearDeviation() {
    const banner = byId('rideDeviationBanner');
    const update = byId('rideDeviationUpdate');
    const keep = byId('rideDeviationKeep');
    if (banner) banner.classList.add('hidden');
    if (update) update.onclick = null;
    if (keep) keep.onclick = null;
    deviationCallbacks = null;
  }

  function showDeviation(options = {}) {
    const banner = byId('rideDeviationBanner');
    const text = byId('rideDeviationText');
    const update = byId('rideDeviationUpdate');
    const keep = byId('rideDeviationKeep');
    if (!banner || !text || !update || !keep) return;

    clearDeviation();
    text.textContent = String(options.text || 'Taking a different road. Update guidance to the next stop?');
    deviationCallbacks = {
      onUpdate: typeof options.onUpdate === 'function' ? options.onUpdate : null,
      onKeep: typeof options.onKeep === 'function' ? options.onKeep : null
    };
    update.onclick = () => {
      const callback = deviationCallbacks?.onUpdate;
      clearDeviation();
      callback?.();
    };
    keep.onclick = () => {
      const callback = deviationCallbacks?.onKeep;
      clearDeviation();
      callback?.();
    };
    banner.classList.remove('hidden');
  }

  function clearUndo() {
    if (undoTimer !== null) {
      window.clearTimeout(undoTimer);
      undoTimer = null;
    }
    undoCallback = null;
    const banner = byId('rideUndoBanner');
    const button = byId('rideUndoButton');
    if (banner) banner.classList.add('hidden');
    if (button) button.onclick = null;
  }

  function showUndo(options = {}) {
    const banner = byId('rideUndoBanner');
    const text = byId('rideUndoText');
    const button = byId('rideUndoButton');
    if (!banner || !text || !button) return;

    clearUndo();
    text.textContent = String(options.text || 'Guidance updated');
    undoCallback = typeof options.onUndo === 'function' ? options.onUndo : null;
    button.onclick = () => {
      const callback = undoCallback;
      clearUndo();
      callback?.();
    };
    banner.classList.remove('hidden');
    const duration = Number.isFinite(options.duration) ? Math.max(0, options.duration) : 10000;
    undoTimer = window.setTimeout(clearUndo, duration);
  }

  window.RideRideUI = {
    setRecordingStatus,
    showDeviation,
    clearDeviation,
    showUndo,
    clearUndo
  };
}());
