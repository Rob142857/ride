/** Ride feedback and private track recovery, independent of the saved plan. */
Object.assign(App, {
  _isCurrentRideDetour(context) {
    return !!context && this.isRiding && context.tripId === this.currentTrip?.id &&
      context.sessionId === this._rideSessionId && context.targetWaypointId === this._rideNextWaypoint?.id;
  },

  offerRideDetour({ context, onUpdate, onKeep }) {
    if (!this._isCurrentRideDetour(context)) return;
    window.RideRideUI?.showDeviation({
      text: 'Taking a different road. Update guidance to the next stop?',
      onUpdate: () => { if (this._isCurrentRideDetour(context)) onUpdate?.(); },
      onKeep: () => { if (this._isCurrentRideDetour(context)) onKeep?.(); }
    });
  },

  adoptRideDetour(context) {
    if (!this._isCurrentRideDetour(context)) return;
    this._setRideNavigationRoute(context.routeData);
    if (this._lastRidePosition) this._updateRideHud(this._lastRidePosition);
    window.RideRideUI?.showUndo({
      text: 'Guidance updated · original plan kept',
      duration: 10000,
      onUndo: () => {
        if (!this._isCurrentRideDetour(context)) return;
        this._rideDetourDecisions.set(context.targetWaypointId, 'keep');
        const previous = context.priorNavigationRoute;
        if (previous && !previous._planned) this._setRideNavigationRoute(previous);
        else this._restorePlannedRideGuidance(context);
        if (this._lastRidePosition) this._updateRideHud(this._lastRidePosition);
        UI.showToast('Previous guidance restored. Recorded travel is kept.', 'info');
      }
    });
  },

  async flushPendingRides() {
    const userId = this.currentUser?.id;
    const tripId = this.currentTrip?.id;
    if (!userId || !tripId || !this.useCloud || !window.RideRecorder) return;
    if (this._rideRecorder && this._rideTripId === tripId) {
      await this._rideRecorder.flush();
      return;
    }
    // Requests retain the original account and trip, even across an async logout.
    const saveLog = payload => {
      if (this.currentUser?.id !== userId) throw new Error('Sign in to sync this ride');
      return API.rideLogs.save(tripId, payload);
    };
    await window.RideRecorder.recover({ userId, tripId, saveLog });
  },

  async refreshRideTracks() {
    const userId = this.currentUser?.id;
    const tripId = this.currentTrip?.id;
    if (!userId || !tripId || !this.useCloud) return;
    try {
      const logs = await API.rideLogs.list(tripId);
      if (this.currentUser?.id === userId && this.currentTrip?.id === tripId && !this.isRiding) {
        MapManager.drawRideLogs(logs);
      }
    } catch (_) { /* queued points remain available for the next connection */ }
  }
});
