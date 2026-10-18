/**
 * The itinerary planning model, shared with the browser. public/js/itinerary.js
 * is a classic script that sets RideItinerary on window (browser) or globalThis
 * (Worker, Node tests); importing it here runs it once in the Worker bundle.
 * The "Update this itinerary" guards and preview therefore run the same code
 * in the UI and in POST /api/trips/:id/itinerary/preview and /apply.
 */
import '../public/js/itinerary.js';

export const RideItinerary = globalThis.RideItinerary;
if (!RideItinerary?.planningUpdatePreview) throw new Error('Itinerary model failed to load');
