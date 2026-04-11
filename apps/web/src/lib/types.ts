/* ── Ride Type Definitions ──────────────────────────────────────────── */

export interface User {
	id: string;
	email: string;
	name: string;
	picture?: string;
	provider: string;
	role: 'user' | 'admin';
	createdAt: string;
}

export interface Trip {
	id: string;
	userId: string;
	name: string;
	description?: string;
	isPublic: boolean;
	shareCode?: string;
	shortCode?: string;
	shortUrl?: string;
	coverImageUrl?: string;
	coverImageId?: string;
	coverFocusX?: number;
	coverFocusY?: number;
	contactInfo?: string;
	settings?: TripSettings;
	waypoints: Waypoint[];
	journalEntries: JournalEntry[];
	journal?: JournalEntry[];
	attachments: Attachment[];
	routeData?: RouteData;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface TripSettings {
	waypointOrder?: string[];
	routingProfile?: 'car' | 'bike' | 'foot';
}

export interface Waypoint {
	id: string;
	tripId: string;
	name: string;
	address?: string;
	lat: number;
	lng: number;
	type: WaypointType;
	notes?: string;
	order: number;
	attachments: Attachment[];
	createdAt: string;
	// aliases used by components
	latitude?: number;
	longitude?: number;
}

export type WaypointType =
	| 'start'
	| 'end'
	| 'stop'
	| 'fuel'
	| 'food'
	| 'scenic'
	| 'camp'
	| 'lodging'
	| 'accommodation'
	| 'custom';

export interface JournalEntry {
	id: string;
	tripId: string;
	title: string;
	content: string;
	tags: string[];
	isPrivate: boolean;
	attachments: Attachment[];
	createdAt: string;
	updatedAt: string;
}

export interface Attachment {
	id: string;
	tripId: string;
	originalName: string;
	contentType: string;
	size: number;
	url: string;
	isCover: boolean;
	isPrivate: boolean;
	caption?: string;
	journalEntryId?: string;
	waypointId?: string;
	createdAt: string;
}

export interface RouteData {
	coordinates?: [number, number][];
	geometry?: unknown;
	distance: number;
	duration: number;
	instructions?: RouteInstruction[];
}

export interface RouteInstruction {
	text: string;
	distance: number;
	time?: number;
	duration?: number;
	type?: string;
	road?: string;
	direction?: string;
	index?: number;
}

export interface PlaceResult {
	name: string;
	address: string;
	lat: number;
	lng: number;
	rating?: number;
	types?: string[];
}

export type AuthStatus = 'unknown' | 'checking' | 'authenticated' | 'unauthenticated' | 'error';
export type AppView = 'map' | 'waypoints' | 'journal' | 'trips';
export type ModalType =
	| null
	| 'login'
	| 'tripDetails'
	| 'waypoint'
	| 'waypointDetail'
	| 'waypointDetails'
	| 'addWaypoint'
	| 'journal'
	| 'addJournal'
	| 'editJournal'
	| 'share'
	| 'placeSearch'
	| 'confirm';

export interface ToastMessage {
	id: number;
	text: string;
	type: 'success' | 'error' | 'info';
	duration: number;
}
