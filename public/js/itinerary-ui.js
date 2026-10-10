/** Private dated itinerary, independent of the map's route editing controls. */
(() => {
  const model = () => window.RideItinerary;
  const el = id => document.getElementById(id);
  const formatNumber = value => Number(value || 0).toLocaleString('en-AU', { maximumFractionDigits: 1 });
  const money = value => Number(value || 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
  const textNode = (tag, text, className) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const dateLabel = value => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value || 'Date pending';
    return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
  };
  const dateRange = stop => stop.plannedNights
    ? `${dateLabel(stop.arrivalDate)} → ${dateLabel(stop.departureDate)} · ${stop.plannedNights} night${stop.plannedNights === 1 ? '' : 's'}`
    : `${dateLabel(stop.arrivalDate)} · Day stop / finish`;
  const appendLink = (container, label, url) => {
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) return;
      const link = textNode('a', label);
      link.href = parsed.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      container.append(link);
    } catch { /* Invalid source URLs are not rendered as links. */ }
  };

  const planner = {
    pending: null,
    saving: false,
    visibleTripId: null,

    init() {
      document.querySelector('[data-view="itinerary"]')?.addEventListener('click', () => this.render());
      el('itineraryMenuBtn')?.addEventListener('click', () => {
        UI.closeMenu?.();
        el('sideMenu')?.classList.add('hidden');
        el('menuOverlay')?.classList.add('hidden');
        UI.switchView('itinerary');
        this.render();
      });
      el('closeItineraryBtn')?.addEventListener('click', () => UI.switchView('map'));
      el('itinerarySettingsForm')?.addEventListener('submit', event => {
        event.preventDefault();
        this.previewSettings();
      });
      el('itineraryPreviewCancel')?.addEventListener('click', () => this.closePreview());
      el('itineraryPreviewApply')?.addEventListener('click', () => this.savePreview());
      el('itineraryImportBtn')?.addEventListener('click', () => {
        if (!App.isSharedView) App.importTrip();
      });
      el('itineraryUpdateBtn')?.addEventListener('click', () => {
        if (!App.isSharedView && App.ensureEditable('update this itinerary')) el('itineraryUpdateFile')?.click();
      });
      el('itineraryUpdateFile')?.addEventListener('change', async event => {
        await this.previewFileUpdate(event.target.files?.[0]);
        event.target.value = '';
      });
      el('itineraryBackupBtn')?.addEventListener('click', () => {
        if (!App.isSharedView) Share.exportOwnerJSON?.();
      });
      window.addEventListener('ride:tripLoaded', () => {
        this.closePreview();
        this.render();
      });
      window.addEventListener('ride:auth-expired', () => {
        this.closePreview();
        this.renderUnavailable('Sign in again to view your private itinerary.');
      });
      window.addEventListener('ride:connection-lost', () => this.closePreview());
      this.render();
    },

    renderUnavailable(message) {
      el('itinerarySummary')?.replaceChildren(textNode('p', message, 'itinerary-empty'));
      el('itineraryStops')?.replaceChildren();
      el('itineraryStatus')?.replaceChildren();
      if (el('itinerarySettings')) el('itinerarySettings').hidden = true;
      if (el('itineraryBackupBtn')) el('itineraryBackupBtn').disabled = true;
      if (el('itineraryUpdateBtn')) el('itineraryUpdateBtn').disabled = true;
      if (el('itineraryImportBtn')) el('itineraryImportBtn').disabled = !!App.isSharedView;
    },

    render() {
      if (!el('itinerarySummary')) return;
      if (App.isSharedView) {
        this.renderUnavailable('Private itineraries are available only to the trip owner.');
        return;
      }
      const trip = App.currentTrip;
      this.visibleTripId = trip?.id;
      if (!trip || !App.currentUser || !App.useCloud || !model()) {
        this.renderUnavailable('Sign in and open a trip to plan its dates and overnight stops.');
        return;
      }
      el('itineraryImportBtn').disabled = false;
      el('itineraryBackupBtn').disabled = false;
      el('itineraryUpdateBtn').disabled = false;
      el('itineraryPrivacy').textContent = trip.isPublic ? 'Owner planning' : 'Private planning';
      const source = trip.settings?.itinerary;
      if (!source?.stops?.length) {
        this.renderUnavailable('This trip has no dated itinerary yet. Import a planned trip or start with its waypoints.');
        if (trip.waypoints?.length) {
          const start = textNode('button', 'Plan dates from these waypoints', 'primary-btn');
          start.addEventListener('click', () => this.startFromWaypoints());
          el('itinerarySummary').append(start);
        }
        el('itineraryBackupBtn').disabled = false;
        el('itineraryUpdateBtn').disabled = false;
        return;
      }
      const result = model().recalculate(source);
      const plan = result.itinerary;
      const totals = result.totals || {};
      el('itinerarySettings').hidden = false;
      el('itineraryStartDate').value = plan.startDate || '';
      el('itineraryConsumption').value = plan.fuel?.litresPer100Km ?? 10.5;
      el('itineraryFuelPrice').value = plan.fuel?.pricePerLitre ?? 2.8;

      const summary = el('itinerarySummary');
      summary.replaceChildren(textNode('p', `${dateLabel(plan.startDate)} → ${dateLabel(plan.stops.at(-1)?.departureDate)} · ${plan.stops.length} planned stops`, 'itinerary-dates'));
      const grid = textNode('div', '', 'itinerary-summary-grid');
      [
        [`${formatNumber(totals.distanceKm)} km`, 'Main route estimate'],
        [money(totals.fuelCost), `Fuel · ${formatNumber(totals.litres)} L`],
        [`${totals.nights || 0} nights`, 'Planned stays'],
        [money(totals.campCost), 'Known camp costs · quotes excluded'],
      ].forEach(([value, label]) => {
        const stat = textNode('div', '', 'itinerary-stat');
        stat.append(textNode('strong', value), textNode('span', label));
        grid.append(stat);
      });
      summary.append(grid);
      const budget = plan.dailyBudgetHours || {};
      const reserved = Number(totals.reservedHours || 0);
      const capacity = textNode('p', `Moving day: ${reserved} protected hours, ${formatNumber(totals.availableHours)} hours for driving, breaks, visits and other work. Reflection ${budget.reflection ?? 4}h · laptop ${budget.laptop ?? 4}h · sleep ${budget.sleep ?? 6}h · first-hour coffee ${budget.coffee ?? 1}h · meals ${budget.meals ?? 1}h · camp ${Number(budget.setup ?? 1) + Number(budget.breakdown ?? 1)}h.`, 'itinerary-capacity');
      summary.append(capacity);
      if (plan.notes) summary.append(textNode('p', plan.notes, 'itinerary-muted'));
      if (plan.optionalContinuation) {
        const next = plan.optionalContinuation;
        summary.append(textNode('p', `Optional: ${next.name} · ${formatNumber(next.distanceKm)} km · ${formatNumber(next.durationHours)}h · ${money(next.fuelCost ?? model().fuelForDistance(next.distanceKm || 0, plan.fuel).cost)} fuel${next.confirmed ? '' : ' · not confirmed'}`, 'itinerary-muted'));
      }
      this.renderMessages(el('itineraryStatus'), result);
      const stopList = el('itineraryStops');
      stopList.replaceChildren();
      let runningCost = 0;
      plan.stops.forEach((stop, index) => {
        const leg = stop.leg || {};
        const fuel = model().fuelForDistance(Number(leg.distanceKm || 0), plan.fuel);
        runningCost += Number(fuel.cost || 0) + Number(stop.camp?.nightlyCost || 0) * Number(stop.plannedNights || 0);
        stopList.append(this.renderStop(stop, index, fuel, runningCost));
      });
    },

    renderMessages(container, result) {
      container.replaceChildren();
      (result.conflicts || []).forEach(item => container.append(textNode('p', item.message || String(item), 'itinerary-conflict')));
      (result.warnings || []).forEach(item => container.append(textNode('p', item.message || String(item), 'itinerary-warning')));
    },

    renderStop(stop, index, fuel, runningCost) {
      const card = textNode('article', '', 'itinerary-stop');
      const heading = textNode('div', '', 'itinerary-stop-heading');
      const title = textNode('div', '');
      title.append(textNode('h3', `${index + 1}. ${stop.name}`), textNode('p', dateRange(stop), 'itinerary-muted'));
      heading.append(title);
      if (stop.plannedNights > 0) {
        const extend = textNode('button', '+1 night', 'cancel-btn itinerary-extend');
        extend.disabled = stop.flexible === false || (stop.maxNights != null && stop.plannedNights >= stop.maxNights);
        extend.title = extend.disabled ? 'Fixed duration or maximum stay reached' : 'Preview dates before extending this stay';
        extend.addEventListener('click', () => this.previewExtend(stop.id));
        heading.append(extend);
      }
      card.append(heading);
      if (stop.fixedDate) card.append(textNode('p', `Fixed commitment: ${dateLabel(stop.fixedDate)}`, 'itinerary-stop-note'));
      const metrics = textNode('div', '', 'itinerary-stop-metrics');
      if (stop.leg?.distanceKm != null) {
        metrics.append(textNode('span', `Leg ${formatNumber(stop.leg.distanceKm)} km`));
        metrics.append(textNode('span', `${formatNumber(stop.leg.durationHours)}h driving estimate`));
        metrics.append(textNode('span', `${money(fuel.cost)} fuel`));
      }
      metrics.append(textNode('span', `${money(runningCost)} running fuel + known camps`));
      card.append(metrics);
      if (stop.notes) card.append(textNode('p', stop.notes, 'itinerary-stop-note'));
      if (stop.camp) card.append(this.renderCamp(stop.camp, stop));
      ['outreach', 'work', 'appointments'].forEach(key => {
        if (stop[key]?.length) card.append(this.renderActivities(stop[key], key));
      });
      const notes = (App.currentTrip?.journal || []).filter(entry => (stop.privateJournalRefs || []).includes(entry.id) && entry.isPrivate);
      if (notes.length) {
        const details = textNode('details', '');
        details.append(textNode('summary', `Private contact notes · ${notes.length}`));
        const body = textNode('div', '', 'itinerary-stop-detail');
        notes.forEach(entry => body.append(textNode('p', entry.title), textNode('p', entry.content || '', 'itinerary-muted')));
        details.append(body);
        card.append(details);
      }
      const waypoint = (App.currentTrip?.waypoints || []).find(item => item.id === stop.waypointId);
      if (waypoint) {
        const mapButton = textNode('button', 'Show on map', 'cancel-btn itinerary-map-link');
        mapButton.addEventListener('click', () => {
          UI.switchView('map');
          MapManager.map?.setView([waypoint.lat, waypoint.lng], 12);
        });
        card.append(mapButton);
      }
      return card;
    },

    renderCamp(camp, stop) {
      const details = textNode('details', '');
      details.append(textNode('summary', `Camp: ${camp.name || 'To confirm'}`));
      const body = textNode('div', '', 'itinerary-stop-detail');
      const rate = camp.nightlyCost == null ? 'Quote needed' : `${money(camp.nightlyCost)} / night${camp.costBasis ? ` (${camp.costBasis})` : ''}`;
      body.append(textNode('p', `${rate}${camp.priceStatus ? ` · ${camp.priceStatus}` : ''}`));
      body.append(textNode('p', `${camp.tentPermitted === true ? 'Tents permitted' : camp.tentPermitted === false ? 'Tents not permitted — choose a different camp' : 'Tent permission to confirm'}${camp.bookingRequired === true ? ' · booking required' : ''}`));
      if (camp.facilities?.length) body.append(textNode('p', camp.facilities.join(' · ')));
      if (camp.notes) body.append(textNode('p', camp.notes));
      appendLink(body, 'Camp source', camp.sourceUrl);
      if (camp.verifiedDate) body.append(textNode('p', `Source checked ${dateLabel(camp.verifiedDate)}. Availability and access need checking before arrival.`, 'itinerary-muted'));
      (camp.alternatives || []).forEach(alternative => {
        const row = textNode('p', `Fallback: ${alternative.name || 'Alternative camp'}${alternative.nightlyCost == null ? ' · quote needed' : ` · ${money(alternative.nightlyCost)} / night`} `);
        appendLink(row, 'Details', alternative.sourceUrl);
        body.append(row);
      });
      if (stop.plannedNights > 1 && camp.nightlyCost != null) body.append(textNode('p', `${money(camp.nightlyCost * stop.plannedNights)} planned stay cost before discounts or surcharges.`, 'itinerary-muted'));
      details.append(body);
      return details;
    },

    renderActivities(items, type) {
      const details = textNode('details', '');
      const names = { outreach: 'Outreach and posting drafts', work: 'Work opportunities', appointments: 'Appointments' };
      details.append(textNode('summary', `${names[type]} · ${items.length}`));
      const body = textNode('div', '', 'itinerary-stop-detail');
      items.forEach(item => {
        if (typeof item === 'string') {
          body.append(textNode('p', item));
          return;
        }
        const date = item.dueDate || item.date || item.scheduledDate;
        const time = item.localTime || item.time;
        const heading = [item.title || item.name || item.type || 'Planned activity', date ? dateLabel(date) : '', time ? `${time} ${item.timeZone || 'local time'}` : '', item.status || (item.confirmed ? 'Confirmed' : 'Draft / not sent')].filter(Boolean).join(' · ');
        body.append(textNode('p', heading));
        if (item.targetDate) body.append(textNode('p', `Visit / work date: ${dateLabel(item.targetDate)}`, 'itinerary-muted'));
        if (item.description || item.notes) body.append(textNode('p', item.description || item.notes, 'itinerary-muted'));
        if (item.draft || item.content || item.text) body.append(textNode('p', item.draft || item.content || item.text));
        if (item.rescheduleRequired || item.needsRescheduling) body.append(textNode('p', item.dateReviewRequired ? 'Stay dates changed: recheck the host’s AA timetable and select an actual meeting date before scheduling it.' : 'Dates changed: review this post or appointment manually before use.', 'itinerary-warning'));
        if (item.url || item.sourceUrl) appendLink(body, 'Source / group', item.url || item.sourceUrl);
        if (item.estimatedIncome != null) body.append(textNode('p', `${money(item.estimatedIncome)} estimated income${item.confirmed ? ' · confirmed job' : ' · unconfirmed'}`, 'itinerary-muted'));
      });
      details.append(body);
      return details;
    },

    startFromWaypoints() {
      if (!App.ensureEditable('plan an itinerary')) return;
      const now = new Date();
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const waypoints = App.currentTrip.waypoints || [];
      const plan = {
        version: 1, startDate, currency: 'AUD',
        fuel: { litresPer100Km: 10.5, pricePerLitre: 2.8 },
        dailyBudgetHours: { reflection: 4, laptop: 4, sleep: 6, coffee: 1, meals: 1, setup: 1, breakdown: 1 },
        stops: waypoints.map((waypoint, index) => ({ id: `stop-${waypoint.id}`, waypointId: waypoint.id, name: waypoint.name || `Stop ${index + 1}`, plannedNights: index === waypoints.length - 1 ? 0 : 1, minNights: 0 })),
      };
      this.openPreview(model().recalculate(plan), 'Start a dated itinerary');
    },

    previewExtend(stopId) {
      if (!App.ensureEditable('extend a stay')) return;
      try {
        this.openPreview(model().previewExtendStay(App.currentTrip.settings.itinerary, stopId, 1), 'Stay one more night');
      } catch (error) {
        UI.showToast(error.message || 'This stay cannot be extended.', 'warning');
      }
    },

    previewSettings() {
      if (!App.ensureEditable('change itinerary dates')) return;
      const plan = model().normalize(App.currentTrip.settings.itinerary);
      plan.startDate = el('itineraryStartDate').value;
      plan.fuel = { ...plan.fuel, litresPer100Km: Number(el('itineraryConsumption').value), pricePerLitre: Number(el('itineraryFuelPrice').value) };
      this.openPreview(model().recalculate(plan), 'Review dates and fuel');
    },

    /** Read only planning data; never pass this file to the trip importer. */
    prepareFileUpdate(data, trip) {
      if (!data || typeof data !== 'object' || Array.isArray(data) || !trip?.id || data.rideTripId !== trip.id) throw new Error('Choose the mapped planning file for this Ride trip. Its Ride trip ID must match the open trip.');
      const source = data.itinerary || data.settings?.itinerary;
      if (!source || !Array.isArray(source.stops)) throw new Error('This file needs a dated itinerary.');
      const result = model().recalculate(source);
      if (result.conflicts.length) throw new Error(result.conflicts[0].message);
      const waypointIds = new Set((trip.waypoints || []).map(waypoint => waypoint.id));
      const journalIds = new Set((trip.journal || []).map(entry => entry.id));
      if (data.waypoints !== undefined && !Array.isArray(data.waypoints)) throw new Error('File waypoints must be an array.');
      if ((data.waypoints || []).some(waypoint => !waypointIds.has(waypoint.id))) throw new Error('The file contains a waypoint outside the open Ride trip.');
      if (data.journal !== undefined && !Array.isArray(data.journal)) throw new Error('File journal entries must be an array.');
      if ((data.journal || []).some(entry => !journalIds.has(entry.id))) throw new Error('The file contains a journal note outside the open Ride trip.');
      for (const stop of result.itinerary.stops) {
        if (!stop.waypointId || !waypointIds.has(stop.waypointId)) throw new Error(`${stop.name}: waypoint does not belong to the open Ride trip.`);
        for (const key of ['fromWaypointId', 'toWaypointId']) if (stop.leg?.[key] && !waypointIds.has(stop.leg[key])) throw new Error(`${stop.name}: leg waypoint does not belong to the open Ride trip.`);
        if (stop.privateJournalRefs !== undefined && (!Array.isArray(stop.privateJournalRefs) || stop.privateJournalRefs.some(id => !journalIds.has(id)))) throw new Error(`${stop.name}: private note does not belong to the open Ride trip.`);
      }
      for (const existing of trip.settings?.itinerary?.stops || []) {
        if (!existing.fixedDate) continue;
        const incoming = result.itinerary.stops.find(stop => stop.id === existing.id);
        if (!incoming || incoming.fixedDate !== existing.fixedDate || incoming.anchorMode !== (existing.anchorMode || 'arrival')) throw new Error(`${existing.name}: keep the existing fixed-date commitment in this planning file.`);
      }
      return result;
    },

    async previewFileUpdate(file) {
      if (!file || !App.currentUser || !App.useCloud || App.isSharedView || !App.ensureEditable('update this itinerary')) return;
      const trip = App.currentTrip;
      const version = Number(trip?.version);
      try {
        if (file.size > 15 * 1024 * 1024) throw new Error('Choose a planning file smaller than 15 MB.');
        const data = JSON.parse(await file.text());
        if (App.currentTrip?.id !== trip?.id || Number(App.currentTrip?.version) !== version) throw new Error('Trip changed while reading the file. Open the planning file again.');
        this.openPreview(this.prepareFileUpdate(data, trip), 'Update this itinerary', { planningFileUpdate: true });
      } catch (error) {
        this.closePreview();
        UI.showToast(error.message || 'Could not open this planning file.', 'error');
      }
    },

    draftChanges(previousPlan, plan) {
      const changes = [];
      const oldStops = new Map((previousPlan?.stops || []).map(stop => [stop.id, stop]));
      const fields = ['title', 'name', 'type', 'dueDate', 'date', 'scheduledDate', 'targetDate', 'localTime', 'time', 'timeZone', 'url', 'sourceUrl', 'draft', 'draftText', 'text', 'content', 'description', 'notes', 'status'];
      const signature = item => JSON.stringify(fields.map(key => item?.[key] ?? null));
      for (const stop of plan.stops) for (const key of ['outreach', 'work']) {
        const oldItems = oldStops.get(stop.id)?.[key] || [];
        const newItems = stop[key] || [];
        const oldById = new Map(oldItems.map((item, index) => [item.id || `item-${index}`, item]));
        newItems.forEach((item, index) => {
          const itemId = item.id || `item-${index}`;
          const old = oldById.get(itemId);
          oldById.delete(itemId);
          if (signature(old) !== signature(item)) changes.push({ town: stop.name, previous: old, item });
        });
        oldById.forEach(previous => changes.push({ town: stop.name, previous, item: null }));
      }
      return changes;
    },

    openPreview(result, title, options = {}) {
      const trip = App.currentTrip;
      const validation = model().validate(result.itinerary);
      this.pending = { result, tripId: trip.id, baseVersion: Number(trip.version), validation, ...options };
      el('itineraryPreviewTitle').textContent = title;
      const body = el('itineraryPreviewBody');
      body.replaceChildren(textNode('p', `${dateLabel(result.itinerary.startDate)} → ${dateLabel(result.itinerary.stops.at(-1)?.departureDate)} · ${result.totals?.nights || 0} nights · ${money(result.totals?.fuelCost)} fuel`));
      const oldById = new Map((trip.settings?.itinerary?.stops || []).map(stop => [stop.id, stop]));
      const list = textNode('ul', '', 'itinerary-change-list');
      result.itinerary.stops.forEach(stop => {
        const old = oldById.get(stop.id);
        if (!old || old.arrivalDate !== stop.arrivalDate || old.departureDate !== stop.departureDate || old.plannedNights !== stop.plannedNights) {
          list.append(textNode('li', `${stop.name}: ${old ? `${dateRange(old)} → ` : ''}${dateRange(stop)}`));
        }
      });
      oldById.forEach(old => {
        if (!result.itinerary.stops.some(stop => stop.id === old.id)) list.append(textNode('li', `${old.name}: ${dateRange(old)} → removed from planning`));
      });
      if (list.childElementCount) body.append(list);
      if (options.planningFileUpdate) {
        const draftChanges = this.draftChanges(trip.settings?.itinerary, result.itinerary);
        body.append(textNode('p', `${draftChanges.length} posting / work draft changes. This replaces planning data only. Your route, waypoints, journals, other settings and trip visibility stay as they are.`, 'itinerary-muted'));
        const schedule = item => item ? [item.dueDate || item.date || item.scheduledDate || 'No date', item.localTime || item.time, item.timeZone].filter(Boolean).join(' · ') : 'Absent';
        const draftText = item => item?.draft || item?.content || item?.text || item?.draftText || '';
        draftChanges.forEach(change => {
          const details = textNode('details', '');
          const activity = change.item || change.previous;
          details.append(textNode('summary', `${change.town} · ${activity.title || activity.name || activity.type || 'Draft'}: ${schedule(change.previous)} → ${schedule(change.item)}`));
          const before = draftText(change.previous);
          const after = draftText(change.item);
          if (before !== after) details.append(textNode('p', `Existing draft: ${before || '(none)'}`), textNode('p', `New draft: ${after || '(removed)'}`));
          const beforeGroup = change.previous?.url || change.previous?.sourceUrl;
          const afterGroup = change.item?.url || change.item?.sourceUrl;
          if (beforeGroup !== afterGroup) details.append(textNode('p', `Group / source: ${beforeGroup || '(none)'} → ${afterGroup || '(removed)'}`));
          body.append(details);
        });
      }
      const messages = textNode('div', '');
      this.renderMessages(messages, result);
      body.append(messages);
      (validation.errors || []).forEach(error => body.append(textNode('p', error.message || String(error), 'itinerary-conflict')));
      body.append(textNode('p', 'Draft deadlines move with their stops. Published posts and confirmed meetings need manual review; this app does not send or change anything externally.', 'itinerary-muted'));
      el('itineraryPreviewApply').disabled = !validation.valid || !!result.conflicts?.length || this.saving;
      UI.openModal('itineraryPreviewModal');
      el('itineraryPreviewCancel').focus();
    },

    closePreview() {
      this.pending = null;
      UI.closeModal('itineraryPreviewModal');
    },

    async savePreview() {
      const pending = this.pending;
      if (!pending || this.saving || !pending.validation.valid || pending.result.conflicts?.length) return;
      if (!App.ensureEditable('save an itinerary')) return;
      const trip = App.currentTrip;
      if (trip.id !== pending.tripId || Number(trip.version) !== pending.baseVersion) {
        this.closePreview();
        UI.showToast('Trip changed. Preview your itinerary change again.', 'warning');
        this.render();
        return;
      }
      this.saving = true;
      el('itineraryPreviewApply').disabled = true;
      try {
        const updated = await API.trips.update(trip.id, { settings: { itinerary: pending.result.itinerary } }, { headers: App.getTripIfMatchHeaders(trip) });
        if (!updated || !Number.isFinite(Number(updated.version))) throw new Error('Server did not confirm the saved itinerary.');
        trip.settings = { ...(trip.settings || {}), ...(updated.settings || {}), itinerary: pending.result.itinerary };
        trip.version = Number(updated.version);
        trip.updated_at = updated.updated_at;
        trip.updatedAt = updated.updatedAt || updated.updated_at;
        App.markTripWritten(trip.id);
        App.cacheTripData(trip);
        if (App.currentTrip?.id === trip.id) UI.updateTripStats(trip);
        this.closePreview();
        this.render();
        UI.showToast('Itinerary saved', 'success');
      } catch (error) {
        if (error.status === 409 || error.status === 412) {
          this.closePreview();
          await App.handleTripConflict(error);
        } else {
          UI.showToast(error.message || 'Could not save itinerary. Try again online.', 'error');
        }
      } finally {
        this.saving = false;
        if (this.pending) el('itineraryPreviewApply').disabled = !this.pending.validation.valid || !!this.pending.result.conflicts?.length;
      }
    },
  };

  window.RideItineraryUI = planner;
  document.addEventListener('DOMContentLoaded', () => planner.init());
})();
