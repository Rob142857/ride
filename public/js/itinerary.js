/**
 * Dated itinerary calculations. Pure functions; all writes stay in the app controller.
 *
 * Shared by the browser (classic script, window.RideItinerary) and the Worker
 * (api/itinerary-plan.js imports this file, which sets globalThis.RideItinerary),
 * so the "Update this itinerary" preview and guards are the same code in both.
 * Keep it free of DOM access.
 */
(root => { root.RideItinerary = (() => {
  const DEFAULT_HOURS = Object.freeze({ reflection: 4, laptop: 4, sleep: 6, coffee: 1, meals: 1, setup: 1, breakdown: 1 });
  const DEFAULT_FUEL = Object.freeze({ pricePerLitre: 2.8, litresPer100Km: 10.5 });
  const clone = value => JSON.parse(JSON.stringify(value));
  const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  function validDate(value) {
    if (typeof value !== 'string' || !datePattern.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function addDays(value, days) {
    if (!validDate(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function fuelForDistance(distanceKm, fuel = DEFAULT_FUEL) {
    const km = Number(distanceKm);
    const rate = Number(fuel.litresPer100Km ?? DEFAULT_FUEL.litresPer100Km);
    const price = Number(fuel.pricePerLitre ?? DEFAULT_FUEL.pricePerLitre);
    if (![km, rate, price].every(Number.isFinite) || km < 0 || rate <= 0 || price <= 0) {
      return { litres: null, cost: null };
    }
    const litres = km * rate / 100;
    return { litres: round(litres), cost: round(litres * price) };
  }

  function normalize(input = {}) {
    const plan = clone(input);
    plan.version = plan.version ?? 1;
    plan.currency = plan.currency || 'AUD';
    plan.fuel = { ...DEFAULT_FUEL, ...(plan.fuel || {}) };
    plan.dailyBudgetHours = { ...DEFAULT_HOURS, ...(plan.dailyBudgetHours || {}) };
    plan.stops = (Array.isArray(plan.stops) ? plan.stops : []).map((stop, index) => {
      const plannedNights = stop.plannedNights ?? stop.nights ?? 1;
      return {
        ...stop,
        id: stop.id || `stop-${index + 1}`,
        name: stop.name || `Stop ${index + 1}`,
        plannedNights,
        minNights: stop.minNights ?? plannedNights,
        maxNights: stop.maxNights ?? Math.max(Number(plannedNights), 21),
        flexible: stop.flexible !== false,
        anchorMode: stop.anchorMode || 'arrival',
        outreach: Array.isArray(stop.outreach) ? stop.outreach.map(item => typeof item === 'string' ? { notes: item } : item) : [],
        work: Array.isArray(stop.work) ? stop.work.map(item => typeof item === 'string' ? { notes: item } : item) : [],
        appointments: Array.isArray(stop.appointments) ? stop.appointments.map(item => typeof item === 'string' ? { notes: item } : item) : [],
      };
    });
    return plan;
  }

  function validate(input) {
    const plan = normalize(input);
    const errors = [];
    const warnings = [];
    const issue = (message, stopId, code) => ({ message, stopId, code });
    if (plan.version !== 1) errors.push(issue('Unsupported itinerary version.', null, 'version'));
    if (!validDate(plan.startDate)) errors.push(issue('A valid departure date is required.', null, 'startDate'));
    if (!plan.stops.length) errors.push(issue('Add at least one itinerary stop.', null, 'stops'));
    const ids = new Set();
    plan.stops.forEach(stop => {
      if (ids.has(stop.id)) errors.push(issue('Stop IDs must be unique.', stop.id, 'duplicateId'));
      ids.add(stop.id);
      const nights = [stop.minNights, stop.plannedNights, stop.maxNights];
      if (!nights.every(n => Number.isInteger(n) && n >= 0)) errors.push(issue('Nights must be non-negative whole numbers.', stop.id, 'nights'));
      else if (stop.minNights > stop.plannedNights || stop.plannedNights > stop.maxNights) errors.push(issue('Planned nights must be within the minimum and maximum.', stop.id, 'nightRange'));
      if (stop.fixedDate && !validDate(stop.fixedDate)) errors.push(issue('The fixed date is invalid.', stop.id, 'fixedDate'));
      if (stop.fixedDate && !['arrival', 'withinStay', 'departure'].includes(stop.anchorMode)) errors.push(issue('Unknown fixed-date anchor mode.', stop.id, 'anchorMode'));
      if (stop.arrivalDate && !validDate(stop.arrivalDate)) errors.push(issue('The arrival date is invalid.', stop.id, 'arrivalDate'));
      if (stop.leg?.distanceKm !== undefined && (!Number.isFinite(Number(stop.leg.distanceKm)) || Number(stop.leg.distanceKm) < 0)) errors.push(issue('Leg distance must be non-negative.', stop.id, 'distance'));
      if (stop.leg?.durationHours !== undefined && (!Number.isFinite(Number(stop.leg.durationHours)) || Number(stop.leg.durationHours) < 0)) errors.push(issue('Leg driving hours must be non-negative.', stop.id, 'duration'));
      if (/hervey\s*bay/i.test(stop.name) && stop.minNights < 7) warnings.push(issue('Hervey Bay should allow at least seven nights; fourteen is the planned work base.', stop.id, 'herveyBayMinimum'));
    });
    const hours = Object.values(plan.dailyBudgetHours);
    if (!hours.every(h => Number.isFinite(Number(h)) && Number(h) >= 0)) errors.push(issue('Daily time allocations must be non-negative hours.', null, 'dailyHours'));
    else if (hours.reduce((sum, h) => sum + Number(h), 0) > 24) errors.push(issue('Daily reserved time exceeds 24 hours.', null, 'dailyHours'));
    if (fuelForDistance(100, plan.fuel).cost === null) errors.push(issue('Fuel consumption and price must be positive numbers.', null, 'fuel'));
    return { valid: errors.length === 0, errors, warnings };
  }

  function rescheduleItem(item, arrivalDate, previousArrival, fallbackLeadDays, town = '') {
    const updated = { ...item };
    const listedMeeting = /aa\s*meeting/i.test(item.type || item.kind || '') || item.dateReviewRequiredOnStayChange || /meetings\.aa\.org\.au/.test(item.sourceUrl || item.url || '');
    if (listedMeeting && previousArrival && previousArrival !== arrivalDate) {
      // A directory's weekly/monthly timetable belongs to the host. Moving our
      // stay cannot move that meeting to a different calendar day.
      return { ...updated, needsRescheduling: true, dateReviewRequired: true,
        selectedForItinerary: false, scheduled: false, selectedDates: [],
        fitsCurrentStay: false, calendarFitsCurrentStay: false, requiresRouteReview: true,
        rescheduleReason: `Stay moved from ${previousArrival} to ${arrivalDate}. Recheck the host timetable and select an actual meeting date.` };
    }
    const committed = item.status === 'published' || item.status === 'sent' || item.status === 'confirmed' || item.publishedAt || item.confirmed;
    const fixed = !!item.fixedDate;
    const delta = validDate(previousArrival) ? Math.round((new Date(`${arrivalDate}T00:00:00Z`) - new Date(`${previousArrival}T00:00:00Z`)) / 86400000) : 0;
    const shift = value => typeof value === 'string' && validDate(value.slice(0, 10)) ? addDays(value.slice(0, 10), delta) + value.slice(10) : value;
    for (const field of ['targetDate', 'date', 'scheduledDate']) {
      if (!item[field]) continue;
      const proposed = fixed ? item[field] : shift(item[field]);
      updated[`suggested${field[0].toUpperCase()}${field.slice(1)}`] = proposed;
      if (!committed && !fixed) updated[field] = proposed;
    }
    const lead = item.leadDays ?? item.daysBeforeArrival ?? fallbackLeadDays;
    if (lead !== null && lead !== undefined && Number.isFinite(Number(lead))) {
      updated.suggestedDate = addDays(arrivalDate, -Number(lead));
      if (!committed && !fixed) updated.dueDate = updated.suggestedDate;
    } else if (item.dueDate) {
      updated.suggestedDate = shift(item.dueDate);
      if (!committed && !fixed) updated.dueDate = updated.suggestedDate;
    }
    if (item.targetOffsetDays !== null && item.targetOffsetDays !== undefined && Number.isFinite(Number(item.targetOffsetDays))) {
      updated.suggestedTargetDate = addDays(arrivalDate, Number(item.targetOffsetDays));
      if (!committed && !fixed) updated.targetDate = updated.suggestedTargetDate;
    }
    if (!committed && !fixed) {
      const serviceDate = updated.targetDate || arrivalDate;
      const substitutions = { serviceDate, arrivalDate, postDate: updated.dueDate || arrivalDate, town: item.town || town };
      if (item.textTemplate) {
        updated.draftText = item.textTemplate.replace(/\{(serviceDate|arrivalDate|postDate|town)\}/g, (_match, key) => substitutions[key]);
        if (typeof item.text === 'string') updated.text = updated.draftText;
      } else if (item.targetDate && updated.targetDate && validDate(item.targetDate.slice(0, 10)) && validDate(updated.targetDate.slice(0, 10)) && item.targetDate !== updated.targetDate) {
        const oldDate = new Date(`${item.targetDate.slice(0, 10)}T00:00:00Z`);
        const newDate = new Date(`${updated.targetDate.slice(0, 10)}T00:00:00Z`);
        const pairs = [[item.targetDate.slice(0, 10), updated.targetDate.slice(0, 10)]];
        for (const options of [{ day: 'numeric', month: 'long', year: 'numeric' }, { weekday: 'long', day: 'numeric', month: 'long' }, { day: 'numeric', month: 'long' }, { day: 'numeric', month: 'short' }]) {
          const formatter = new Intl.DateTimeFormat('en-AU', { ...options, timeZone: 'UTC' });
          pairs.push([formatter.format(oldDate), formatter.format(newDate)]);
        }
        for (const field of ['draftText', 'draft', 'postText', 'message', 'text']) {
          if (typeof item[field] !== 'string') continue;
          updated[field] = pairs.reduce((value, [before, after]) => value.split(before).join(after), item[field]);
        }
      }
    }
    if (previousArrival && previousArrival !== arrivalDate && (committed || fixed)) {
      updated.needsRescheduling = true;
      updated.rescheduleReason = `Arrival moved from ${previousArrival} to ${arrivalDate}.`;
    }
    return updated;
  }

  function recalculate(input) {
    const plan = normalize(input);
    const validation = validate(plan);
    const conflicts = [...validation.errors];
    const warnings = [...validation.warnings];
    const reservedHours = round(Object.values(plan.dailyBudgetHours).reduce((sum, h) => sum + Number(h), 0));
    const totals = { distanceKm: 0, litres: 0, fuelCost: 0, nights: 0, reservedHours, availableHours: round(24 - reservedHours), campCost: 0, unknownCampNights: 0, estimatedIncome: 0, confirmedIncome: 0 };
    if (!validation.valid) return { itinerary: plan, conflicts, warnings, totals };
    let nextArrival = plan.startDate;
    plan.stops = plan.stops.map(stop => {
      const previousArrival = stop.arrivalDate;
      const arrivalDate = nextArrival;
      const departureDate = addDays(arrivalDate, stop.plannedNights);
      nextArrival = departureDate;
      const computed = { ...stop, arrivalDate, departureDate };
      if (stop.fixedDate) {
        const satisfied = stop.anchorMode === 'withinStay'
          ? arrivalDate <= stop.fixedDate && departureDate > stop.fixedDate
          : (stop.anchorMode === 'departure' ? departureDate : arrivalDate) === stop.fixedDate;
        if (!satisfied) conflicts.push({ code: 'fixedAnchor', stopId: stop.id, message: `${stop.name} must ${stop.anchorMode === 'withinStay' ? 'include' : 'meet'} ${stop.fixedDate}; calculated stay is ${arrivalDate} to ${departureDate}.` });
      }
      computed.outreach = stop.outreach.map(item => rescheduleItem(item, arrivalDate, previousArrival, 7, stop.name));
      computed.work = stop.work.map(item => rescheduleItem(item, arrivalDate, previousArrival, null, stop.name));
      computed.appointments = stop.appointments.map(item => rescheduleItem(item, arrivalDate, previousArrival, null, stop.name));
      for (const key of ['aaMeetings', 'meetings', 'onlineFallbacks']) if (Array.isArray(stop[key])) computed[key] = stop[key].map(item => rescheduleItem({ ...item, dateReviewRequiredOnStayChange: true }, arrivalDate, previousArrival, null, stop.name));
      if ([...(computed.appointments || []), ...(computed.aaMeetings || []), ...(computed.meetings || []), ...(computed.onlineFallbacks || [])].some(item => item.dateReviewRequired)) warnings.push({ code: 'meetingDateReview', stopId: stop.id, message: `${stop.name}: AA meeting dates and venue travel need rechecking after the stay changed; previous selections are no longer scheduled.` });
      const distanceKm = Number(stop.leg?.distanceKm || 0);
      const fuel = fuelForDistance(distanceKm, plan.fuel);
      if (stop.leg) computed.leg = { ...stop.leg, fuelLitres: fuel.litres, fuelCost: fuel.cost };
      totals.distanceKm += distanceKm;
      totals.nights += stop.plannedNights;
      const campRate = stop.camp?.nightlyCost ?? stop.camp?.pricePerNight;
      if (campRate === null || campRate === undefined) totals.unknownCampNights += stop.plannedNights;
      else totals.campCost += Number(campRate) * stop.plannedNights;
      for (const job of stop.work) {
        const income = Number(job.income ?? job.estimatedIncome ?? 0);
        if (Number.isFinite(income)) {
          totals.estimatedIncome += income;
          if (job.status === 'confirmed' || job.confirmed) totals.confirmedIncome += Number(job.confirmedIncome ?? income);
        }
      }
      const drivingHours = Number(stop.leg?.durationHours || 0);
      const activityHours = [...stop.work, ...stop.appointments].reduce((sum, activity) => sum + Number(activity.hours || 0), 0);
      if (drivingHours > totals.availableHours) warnings.push({ code: 'drivingCapacity', stopId: stop.id, message: `${stop.name}: driving alone exceeds the ${totals.availableHours} hours available on a travel day.` });
      if (drivingHours + activityHours > totals.availableHours && stop.plannedNights <= 1) warnings.push({ code: 'dailyCapacity', stopId: stop.id, message: `${stop.name}: driving and scheduled activities need more than the travel-day allowance.` });
      return computed;
    });
    const totalFuel = fuelForDistance(totals.distanceKm, plan.fuel);
    totals.litres = totalFuel.litres;
    totals.fuelCost = totalFuel.cost;
    ['distanceKm', 'campCost', 'estimatedIncome', 'confirmedIncome'].forEach(key => { totals[key] = round(totals[key]); });
    plan.endDate = nextArrival;
    return { itinerary: plan, conflicts, warnings, totals };
  }

  function previewExtendStay(input, stopId, days = 1) {
    const plan = normalize(input);
    const stop = plan.stops.find(item => item.id === stopId);
    if (!stop) throw new Error('Itinerary stop not found.');
    if (!Number.isInteger(days) || days < 1) throw new Error('Extension must be a positive number of whole days.');
    if (!stop.flexible) throw new Error('This stop has a fixed duration.');
    const before = recalculate(plan);
    stop.plannedNights += days;
    const result = recalculate(plan);
    result.changes = result.itinerary.stops.map((item, index) => ({ stopId: item.id, name: item.name, previousArrivalDate: before.itinerary.stops[index].arrivalDate, arrivalDate: item.arrivalDate, previousDepartureDate: before.itinerary.stops[index].departureDate, departureDate: item.departureDate })).filter(item => item.previousArrivalDate !== item.arrivalDate || item.previousDepartureDate !== item.departureDate);
    return result;
  }

  /** Fixed-date commitments added, changed or removed between two plans. */
  function fixedAnchorChanges(previousPlan, nextPlan) {
    const previous = new Map((previousPlan?.stops || []).map(stop => [stop.id, stop]));
    const next = new Map((nextPlan?.stops || []).map(stop => [stop.id, stop]));
    const anchor = stop => stop?.fixedDate ? { date: stop.fixedDate, mode: stop.anchorMode || 'arrival' } : null;
    const changes = [];
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const before = anchor(previous.get(id));
      const after = anchor(next.get(id));
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({
        stopId: id, name: next.get(id)?.name || previous.get(id)?.name,
        before, after, removedStop: !next.has(id),
      });
    }
    return changes;
  }

  /** Outreach and work drafts that are new, changed or gone, per stop. */
  function draftChanges(previousPlan, plan) {
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
  }

  /** Stops whose dates are new, changed or removed (the preview's change list). */
  function stopDateChanges(previousPlan, nextPlan) {
    const dates = stop => ({ arrivalDate: stop.arrivalDate ?? null, departureDate: stop.departureDate ?? null, plannedNights: stop.plannedNights ?? null });
    const oldById = new Map((previousPlan?.stops || []).map(stop => [stop.id, stop]));
    const changes = [];
    (nextPlan?.stops || []).forEach(stop => {
      const old = oldById.get(stop.id);
      if (!old || old.arrivalDate !== stop.arrivalDate || old.departureDate !== stop.departureDate || old.plannedNights !== stop.plannedNights) {
        changes.push({ stopId: stop.id, name: stop.name, change: old ? 'changed' : 'added', before: old ? dates(old) : null, after: dates(stop) });
      }
    });
    oldById.forEach(old => {
      if (!(nextPlan?.stops || []).some(stop => stop.id === old.id)) changes.push({ stopId: old.id, name: old.name, change: 'removed', before: dates(old), after: null });
    });
    return changes;
  }

  /**
   * Guards for "Update this itinerary": read only planning data from a mapped
   * planning file and check it belongs to this trip. Throws an Error with the
   * message the UI shows. `trip` is { id, settings, waypoints: [{ id }], journal: [{ id }] }.
   */
  function preparePlanningUpdate(data, trip) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !trip?.id || data.rideTripId !== trip.id) throw new Error('Choose the mapped planning file for this Ride trip. Its Ride trip ID must match the open trip.');
    const source = data.itinerary || data.settings?.itinerary;
    if (!source || !Array.isArray(source.stops)) throw new Error('This file needs a dated itinerary.');
    const result = recalculate(source);
    if (result.conflicts.length) throw new Error(result.conflicts[0].message);
    const waypointIds = new Set((trip.waypoints || []).map(waypoint => String(waypoint.id)));
    const journalIds = new Set((trip.journal || []).map(entry => String(entry.id)));
    if (data.waypoints !== undefined && !Array.isArray(data.waypoints)) throw new Error('File waypoints must be an array.');
    if ((data.waypoints || []).some(waypoint => !waypointIds.has(String(waypoint?.id)))) throw new Error('The file contains a waypoint outside the open Ride trip.');
    if (data.journal !== undefined && !Array.isArray(data.journal)) throw new Error('File journal entries must be an array.');
    if ((data.journal || []).some(entry => !journalIds.has(String(entry?.id)))) throw new Error('The file contains a journal note outside the open Ride trip.');
    for (const stop of result.itinerary.stops) {
      if (!stop.waypointId || !waypointIds.has(String(stop.waypointId))) throw new Error(`${stop.name}: waypoint does not belong to the open Ride trip.`);
      for (const key of ['fromWaypointId', 'toWaypointId']) if (stop.leg?.[key] && !waypointIds.has(String(stop.leg[key]))) throw new Error(`${stop.name}: leg waypoint does not belong to the open Ride trip.`);
      if (stop.privateJournalRefs !== undefined && (!Array.isArray(stop.privateJournalRefs) || stop.privateJournalRefs.some(id => !journalIds.has(String(id))))) throw new Error(`${stop.name}: private note does not belong to the open Ride trip.`);
    }
    result.anchorChanges = fixedAnchorChanges(trip.settings?.itinerary, result.itinerary);
    return result;
  }

  /**
   * Everything the "Update this itinerary" preview shows, as data: the plan
   * that would be saved, totals, stop date changes, fixed-date commitment
   * changes, draft changes, conflicts, warnings and validation errors.
   * Throws (like preparePlanningUpdate) when a guard refuses the file.
   */
  function planningUpdatePreview(data, trip) {
    const result = preparePlanningUpdate(data, trip);
    const previous = trip.settings?.itinerary;
    const validation = validate(result.itinerary);
    return {
      itinerary: result.itinerary,
      totals: result.totals,
      startDate: result.itinerary.startDate,
      endDate: result.itinerary.stops.at(-1)?.departureDate ?? null,
      stopChanges: stopDateChanges(previous, result.itinerary),
      anchorChanges: result.anchorChanges,
      draftChanges: draftChanges(previous, result.itinerary),
      conflicts: result.conflicts,
      warnings: result.warnings,
      validationErrors: validation.errors,
      canApply: validation.valid && !result.conflicts.length,
    };
  }

  return { normalize, validate, recalculate, previewExtendStay, fuelForDistance, addDays, validDate,
    fixedAnchorChanges, draftChanges, stopDateChanges, preparePlanningUpdate, planningUpdatePreview };
})(); })(typeof window !== 'undefined' ? window : globalThis);
