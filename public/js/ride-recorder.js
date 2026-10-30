/* Durable, private ride track recorder. Loaded as a classic browser script. */
(function (root) {
  'use strict';

  const MAX_POINTS = 1000;
  const MAX_PENDING_POINTS = 20_000;
  const CHECKPOINT_MS = 60_000;
  const GAP_MS = 30_000;
  const STATIONARY_MS = 5 * 60_000;
  const MAX_ACCURACY = 50;
  const MAX_SPEED_MPS = 70;
  const LEASE_MS = 2 * 60_000;
  const PREFIX = 'ride-recorder:v1:';

  function uuid() {
    if (root.crypto?.randomUUID) return root.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }

  function keyFor(userId, tripId) {
    return PREFIX + encodeURIComponent(String(userId)) + ':' + encodeURIComponent(String(tripId));
  }

  function haversine(a, b) {
    const rad = x => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  function parsedTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') return Date.parse(value);
    return NaN;
  }

  function read(storage, key) {
    try {
      const value = JSON.parse(storage.getItem(key) || 'null');
      if (value && value.version === 1 && Array.isArray(value.chunks) && Array.isArray(value.active)) return value;
    } catch (_) { return { version: 1, chunks: [], active: [], paused: true, reason: 'storage-error', corrupt: true }; }
    return { version: 1, chunks: [], active: [], paused: false, startedAt: null, lastPoint: null, stationaryAt: null, idleAnchor: null };
  }

  function serializeTrack(points) { return points.map(p => ({ lat: p.lat, lng: p.lng, t: p.t })); }

  function makeChunk(points, now) {
    if (!points.length) return null;
    const track = serializeTrack(points);
    const start = new Date(points[0].ms).toISOString();
    const end = new Date(points[points.length - 1].ms).toISOString();
    let distance = 0;
    for (let i = 1; i < points.length; i++) distance += haversine(points[i - 1], points[i]);
    return { client_log_id: uuid(), started_at: start, ended_at: end, distance_meters: distance,
      duration_seconds: Math.max(0, (points[points.length - 1].ms - points[0].ms) / 1000), track, queued_at: now() };
  }

  function pendingPointCount(data) {
    return data.active.length + data.chunks.reduce((sum, chunk) => sum + chunk.track.length, 0);
  }

  function mergeChunk(data, chunk) {
    if (chunk && !data.chunks.some(item => item.client_log_id === chunk.client_log_id)) data.chunks.push(chunk);
  }

  const RideRecorder = {
    create(options) {
      const { userId, tripId, saveLog, onStatus = () => {}, now = () => Date.now() } = options || {};
      if (!userId || !tripId || typeof saveLog !== 'function') throw new Error('RideRecorder requires userId, tripId, and saveLog');
      const storage = options.storage || root.localStorage;
      if (!storage) throw new Error('RideRecorder requires local storage');
      const key = keyFor(userId, tripId);
      const leaseKey = key + ':lease';
      const token = uuid();
      let data = read(storage, key);
      let state = data.paused ? 'paused' : 'recording';
      let flushing = null;
      let stopped = false;
      let ownsLease = false;
      let storageError = Boolean(data.corrupt);
      let leaseTimer = null;

      function publish() {
        try { onStatus(status()); } catch (_) { /* status display cannot interrupt capture */ }
      }

      function status() {
        const pendingLogs = data.chunks.length;
        const pendingPoints = data.chunks.reduce((sum, chunk) => sum + chunk.track.length, 0);
        const points = data.active.length + pendingPoints;
        const syncPending = pendingLogs > 0;
        const effective = storageError ? 'storage-error' : (!ownsLease && state === 'paused' ? 'paused' : (syncPending && state !== 'recording' ? 'sync-pending' : state));
        return { state: effective, recording: state === 'recording' && ownsLease && !storageError,
          paused: state === 'paused' || storageError, syncPending, pendingLogs, pendingPoints, points,
          unsavedPoints: storageError ? points : 0,
          reason: data.reason || (storageError ? 'storage-error' : null) };
      }

      function readLease() {
        try { return JSON.parse(storage.getItem(leaseKey) || 'null'); }
        catch (_) { return null; }
      }

      function claimLease() {
        try {
          const current = readLease();
          if (current && current.token !== token && current.expiresAt > now()) return false;
          storage.setItem(leaseKey, JSON.stringify({ token, expiresAt: now() + LEASE_MS }));
          ownsLease = readLease()?.token === token;
          return ownsLease;
        } catch (_) {
          storageError = true;
          data.reason = 'storage-error';
          state = 'paused';
          return false;
        }
      }

      function touchLease() {
        if (readLease()?.token !== token) {
          ownsLease = false;
          state = 'paused';
          data.paused = true;
          data.reason = 'another-tab';
          return false;
        }
        try {
          storage.setItem(leaseKey, JSON.stringify({ token, expiresAt: now() + LEASE_MS }));
          return true;
        } catch (_) {
          storageError = true;
          state = 'paused';
          data.paused = true;
          data.reason = 'storage-error';
          return false;
        }
      }

      function startLeaseHeartbeat() {
        if (leaseTimer || !root.setInterval) return;
        leaseTimer = root.setInterval(() => {
          if (ownsLease && !touchLease()) publish();
        }, Math.max(10_000, Math.floor(LEASE_MS / 3)));
      }

      function persist() {
        if (!ownsLease || !touchLease()) { publish(); return false; }
        try {
          storage.setItem(key, JSON.stringify(data));
          storageError = false;
          data.corrupt = false;
          publish();
          return true;
        } catch (_) {
          storageError = true;
          state = 'paused';
          data.paused = true;
          data.reason = 'storage-error';
          publish();
          return false;
        }
      }

      function queueActive() {
        while (data.active.length > 0) {
          const chunkPoints = data.active.splice(0, MAX_POINTS);
          mergeChunk(data, makeChunk(chunkPoints, now));
          if (data.active.length === 0) break;
          data.active.unshift(chunkPoints[chunkPoints.length - 1]);
        }
        data.startedAt = null;
        data.lastPoint = null;
        data.stationaryAt = null;
      }

      function checkpointActive() {
        if (data.active.length < 2) return;
        const boundary = data.active[data.active.length - 1];
        const completed = data.active.slice(0, -1);
        mergeChunk(data, makeChunk(completed, now));
        const sharedPoint = completed[completed.length - 1];
        data.active = [sharedPoint, boundary];
        data.startedAt = sharedPoint.t;
        data.lastPoint = boundary;
      }

      function recoverTailAndPersist() {
        if (data.active.length) mergeChunk(data, makeChunk(data.active, now));
        data.active = [];
        data.paused = true;
        data.startedAt = null;
        data.lastPoint = null;
        data.stationaryAt = null;
        data.idleAnchor = null;
        state = 'paused';
        return persist();
      }

      function record(position) {
        if (stopped || !ownsLease || storageError || !position) return false;
        const lat = Number(position.lat ?? position.latitude);
        const lng = Number(position.lng ?? position.lon ?? position.longitude);
        const accuracy = position.accuracy == null ? 0 : Number(position.accuracy);
        const ms = parsedTime(position.t ?? position.timestamp ?? now());
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180 ||
            !Number.isFinite(ms) || Math.abs(ms) > 8.64e15 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_ACCURACY || ms > now() + 120_000) return false;
        const point = { lat, lng, ms, t: new Date(ms).toISOString() };

        if (state === 'paused' && data.reason === 'stationary') {
          const moved = accuracy <= 25 && data.idleAnchor && haversine(data.idleAnchor, point) > 35;
          if (!moved) return false;
          // Start a fresh segment at the reliable movement fix; the idle gap is
          // intentionally absent from the route geometry.
          state = 'recording';
          data.paused = false;
          data.reason = null;
          data.active = [];
          data.startedAt = null;
          data.lastPoint = null;
          data.stationaryAt = ms;
          data.idleAnchor = point;
        } else if (state !== 'recording') return false;

        if (pendingPointCount(data) >= MAX_PENDING_POINTS) {
          state = 'paused';
          data.paused = true;
          data.reason = 'pending-limit';
          persist();
          void flush();
          return false;
        }
        const last = data.active[data.active.length - 1];
        if (last) {
          const elapsed = ms - last.ms;
          if (elapsed < 0) return false;
          const meters = haversine(last, point);
          if ((elapsed === 0 && meters > 0) || (elapsed > 0 && meters / (elapsed / 1000) > MAX_SPEED_MPS)) return false;
          if (elapsed > GAP_MS) {
            queueActive();
            data.stationaryAt = ms;
            data.idleAnchor = point;
          }
        }
        if (!data.startedAt) data.startedAt = point.t;
        if (!data.idleAnchor) {
          data.idleAnchor = point;
          data.stationaryAt = ms;
        } else if (accuracy <= 25 && haversine(data.idleAnchor, point) > 35) {
          data.idleAnchor = point;
          data.stationaryAt = ms;
        }
        data.active.push(point);
        data.lastPoint = point;
        if (data.active.length >= MAX_POINTS) {
          const lastPoint = data.active[data.active.length - 1];
          const chunkPoints = data.active.splice(0, MAX_POINTS);
          mergeChunk(data, makeChunk(chunkPoints, now));
          data.active.unshift(lastPoint);
          data.startedAt = lastPoint.t;
        }
        if (data.stationaryAt != null && ms - data.stationaryAt >= STATIONARY_MS &&
            data.idleAnchor && haversine(data.idleAnchor, point) <= 35) {
          queueActive();
          data.paused = true;
          data.reason = 'stationary';
          state = 'paused';
          const saved = persist();
          if (saved) void flush();
          return saved;
        }
        const activeStart = data.active[0]?.ms;
        if (activeStart != null && ms - activeStart >= CHECKPOINT_MS) checkpointActive();
        const saved = persist();
        if (data.chunks.length) void flush();
        return saved;
      }

      function pause(reason = 'paused') {
        if (stopped) return;
        if (data.active.length) queueActive();
        if (reason !== 'stationary') {
          data.stationaryAt = null;
          data.idleAnchor = null;
        }
        data.paused = true;
        data.reason = String(reason);
        state = 'paused';
        const saved = persist();
        if (reason === 'hidden' || reason === 'pagehide') {
          // Persist synchronously, then hand off ownership. An already-running
          // request may finish, but without this lease it cannot rewrite storage.
          releaseLease();
          publish();
          return;
        }
        if (saved) void flush();
      }

      function resume() {
        if (stopped) return false;
        if (state === 'recording' && ownsLease && !storageError) {
          if (data.chunks.length) void flush();
          return true;
        }
        if (state === 'paused' && data.reason === 'stationary') {
          if (!ownsLease) {
            if (!claimLease()) { publish(); return false; }
            startLeaseHeartbeat();
            data = read(storage, key);
            storageError = Boolean(data.corrupt);
            if (storageError) { state = 'paused'; publish(); return false; }
            state = data.paused ? 'paused' : 'recording';
            if (data.active.length && !recoverTailAndPersist()) return false;
            if (data.reason !== 'stationary') return resume();
          }
          if (data.chunks.length) void flush();
          publish();
          return false;
        }
        if (!ownsLease) {
          if (!claimLease()) {
            state = 'paused'; data.paused = true; data.reason = 'another-tab'; publish(); return false;
          }
          startLeaseHeartbeat();
          data = read(storage, key);
          storageError = Boolean(data.corrupt);
          if (data.active.length && !recoverTailAndPersist()) return false;
        }
        if (pendingPointCount(data) >= MAX_PENDING_POINTS) {
          state = 'paused'; data.paused = true; data.reason = 'pending-limit'; publish(); void flush(); return false;
        }
        data.paused = false;
        data.reason = null;
        data.startedAt = null;
        data.lastPoint = null;
        data.stationaryAt = null;
        data.idleAnchor = null;
        state = 'recording';
        const saved = persist();
        if (data.chunks.length) void flush();
        return saved;
      }

      function releaseLease() {
        if (!ownsLease) return;
        if (leaseTimer && root.clearInterval) root.clearInterval(leaseTimer);
        leaseTimer = null;
        try { if (readLease()?.token === token) storage.removeItem(leaseKey); } catch (_) { /* lease expires naturally */ }
        ownsLease = false;
      }

      function stop() {
        if (stopped) return flushing || Promise.resolve(status());
        if (data.active.length) queueActive();
        data.paused = true;
        data.reason = 'stopped';
        state = 'stopped';
        stopped = true;
        const saved = persist();
        if (!saved) {
          data.reason = 'unsaved-data';
          releaseLease();
          publish();
          return Promise.resolve(status());
        }
        return flush().finally(releaseLease);
      }

      function flush() {
        if (flushing) return flushing;
        if (!ownsLease || storageError || !persist()) return Promise.resolve(status());
        flushing = (async () => {
          while (data.chunks.length) {
            const chunk = data.chunks[0];
            try {
              await saveLog({ ...chunk, track: chunk.track.map(p => ({ ...p })) });
              if (data.chunks[0]?.client_log_id === chunk.client_log_id) data.chunks.shift();
              if (!persist()) break;
            } catch (error) {
              data.reason = error?.message || 'sync pending';
              persist();
              break;
            }
          }
          return status();
        })().finally(() => { flushing = null; publish(); });
        return flushing;
      }

      if (!data.corrupt && claimLease()) {
        // Read only after winning the lease so a stale pre-lock snapshot can never
        // replace newer fixes written by the previous lease holder.
        data = read(storage, key);
        storageError = Boolean(data.corrupt);
        state = data.paused ? 'paused' : 'recording';
        if (data.active.length) recoverTailAndPersist();
        startLeaseHeartbeat();
      } else {
        ownsLease = false;
        state = 'paused';
        data.paused = true;
        data.reason = data.corrupt ? 'storage-error' : 'another-tab';
        storageError = Boolean(data.corrupt);
      }
      if (ownsLease && data.reason === 'another-tab') { data.reason = null; state = data.paused ? 'paused' : 'recording'; }
      persistIfOwned();
      if (ownsLease && data.chunks.length) void flush();

      function persistIfOwned() { if (ownsLease && !data.corrupt) persist(); else publish(); }

      return { record, pause, resume, stop, flush, getStatus: status };
    },

    pendingFor(userId, tripId, storage = root.localStorage) {
      if (!storage || !userId || !tripId) return [];
      const item = read(storage, keyFor(userId, tripId));
      return item.chunks.map(chunk => ({ ...chunk, track: chunk.track.map(p => ({ ...p })) }));
    },

    async recover({ userId, tripId, saveLog, storage = root.localStorage, onStatus = () => {}, now = () => Date.now() }) {
      if (!storage || !userId || !tripId || typeof saveLog !== 'function') return { synced: 0, pendingLogs: 0 };
      const key = keyFor(userId, tripId);
      const leaseKey = key + ':lease';
      const token = uuid();
      let data;
      try {
        const lease = JSON.parse(storage.getItem(leaseKey) || 'null');
        if (lease && lease.expiresAt > now()) {
          onStatus({ state: 'paused', recording: false, paused: true, syncPending: true, reason: 'another-tab' });
          return { synced: 0, pendingLogs: RideRecorder.pendingFor(userId, tripId, storage).length, locked: true };
        }
        storage.setItem(leaseKey, JSON.stringify({ token, expiresAt: now() + LEASE_MS }));
        if (JSON.parse(storage.getItem(leaseKey) || 'null')?.token !== token) return { synced: 0, pendingLogs: RideRecorder.pendingFor(userId, tripId, storage).length, locked: true };
        data = read(storage, key);
        if (data.active.length) {
          mergeChunk(data, makeChunk(data.active, now));
          data.active = [];
          data.paused = true;
          storage.setItem(key, JSON.stringify(data));
        }
      } catch (error) {
        onStatus({ state: 'storage-error', recording: false, paused: true, syncPending: true, reason: error?.message || 'storage-error' });
        return { synced: 0, pendingLogs: RideRecorder.pendingFor(userId, tripId, storage).length, storageError: true };
      }

      let synced = 0;
      const renewLease = () => {
        try {
          const lease = JSON.parse(storage.getItem(leaseKey) || 'null');
          if (lease?.token !== token) return false;
          storage.setItem(leaseKey, JSON.stringify({ token, expiresAt: now() + LEASE_MS }));
          return true;
        } catch (_) { leaseLost = true; return false; }
      };
      const heartbeat = root.setInterval ? root.setInterval(renewLease, Math.max(10_000, Math.floor(LEASE_MS / 3))) : null;
      try {
        for (const chunk of [...data.chunks]) {
          if (!renewLease()) break;
          try {
            await saveLog({ ...chunk, track: chunk.track.map(p => ({ ...p })) });
            // The request may have taken longer than the lease. If another tab
            // took over, leave its current storage snapshot untouched; retry is
            // safe because the server log ID is stable.
            if (!renewLease()) break;
            const current = read(storage, key);
            current.chunks = current.chunks.filter(item => item.client_log_id !== chunk.client_log_id);
            storage.setItem(key, JSON.stringify(current));
            data = current;
            synced++;
          } catch (error) {
            onStatus({ state: 'sync-pending', recording: false, paused: true, syncPending: true, pendingLogs: data.chunks.length - synced, reason: error?.message || 'sync pending' });
            break;
          }
        }
      } finally {
        if (heartbeat && root.clearInterval) root.clearInterval(heartbeat);
        try { if (JSON.parse(storage.getItem(leaseKey) || 'null')?.token === token) storage.removeItem(leaseKey); } catch (_) { /* lease expires naturally */ }
      }
      return { synced, pendingLogs: RideRecorder.pendingFor(userId, tripId, storage).length };
    }
  };

  root.RideRecorder = RideRecorder;
})(typeof window !== 'undefined' ? window : globalThis);
