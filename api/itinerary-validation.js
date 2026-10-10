/** Validate planner structure at the account API boundary without logging contents. */
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export function validateTripSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'Settings must be an object';
  const plan = settings.itinerary;
  if (plan === undefined) return null;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.version !== 1 || !Array.isArray(plan.stops) || !plan.stops.length) return 'A version 1 itinerary with stops is required';
  if (!validDate(plan.startDate)) return 'A valid itinerary departure date is required';
  if (plan.fuel && [plan.fuel.pricePerLitre, plan.fuel.litresPer100Km].some(value => !Number.isFinite(value) || value <= 0)) return 'Itinerary fuel values must be positive numbers';
  if (plan.dailyBudgetHours) {
    if (typeof plan.dailyBudgetHours !== 'object' || Array.isArray(plan.dailyBudgetHours)) return 'Daily time allocations must be an object';
    const hours = Object.values(plan.dailyBudgetHours);
    if (hours.some(value => !Number.isFinite(value) || value < 0) || hours.reduce((sum, value) => sum + value, 0) > 24) return 'Daily time allocations must be non-negative and total no more than 24 hours';
  }
  const ids = new Set();
  for (const stop of plan.stops) {
    if (!stop || typeof stop !== 'object' || typeof stop.id !== 'string' || !stop.id || ids.has(stop.id)) return 'Itinerary stop IDs must be unique strings';
    ids.add(stop.id);
    if (typeof stop.name !== 'string' || !stop.name) return 'Every itinerary stop needs a name';
    const nights = [stop.minNights, stop.plannedNights, stop.maxNights];
    if (nights.some(value => !Number.isInteger(value) || value < 0) || nights[0] > nights[1] || nights[1] > nights[2]) return 'Itinerary nights must be whole numbers within the permitted range';
    if (stop.fixedDate && (!validDate(stop.fixedDate) || !['arrival', 'departure', 'withinStay'].includes(stop.anchorMode || 'arrival'))) return 'Itinerary fixed-date anchor is invalid';
    if (stop.leg && [stop.leg.distanceKm, stop.leg.durationHours].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))) return 'Itinerary leg distance and hours must be non-negative numbers';
    for (const key of ['work', 'outreach', 'appointments', 'privateJournalRefs']) if (stop[key] !== undefined && !Array.isArray(stop[key])) return `Itinerary ${key} must be an array`;
  }
  return null;
}
