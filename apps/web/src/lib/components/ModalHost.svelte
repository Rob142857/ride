<script lang="ts">
	import { uiState, closeModal, toastSuccess, toastError } from '$stores/ui';
	import { addWaypoint, addJournalEntry, updateJournalEntry, updateWaypoint } from '$stores/trip';
	import { currentTrip } from '$stores/trip';
	import { setAddingWaypoint } from '$stores/map';
	import * as api from '$lib/api';
	import type { Waypoint, JournalEntry } from '$types';

	/* ---------- Add Waypoint ---------- */
	let wpName = $state('');
	let wpType = $state('stop');
	let wpNotes = $state('');
	let wpAddress = $state('');
	let wpLat = $state<number | null>(null);
	let wpLng = $state<number | null>(null);
	let placeQuery = $state('');
	let placeResults = $state<import('$types').PlaceResult[]>([]);
	let placeSearchLoading = $state(false);
	let placeSearchError = $state('');
	let addWaypointOpen = $state(false);

	$effect(() => {
		if ($uiState.modal !== 'addWaypoint') {
			addWaypointOpen = false;
			return;
		}
		if (!addWaypointOpen) {
			resetWp();
			addWaypointOpen = true;
		}
		const data = $uiState.modalData as { lat: number; lng: number } | undefined;
		if (data) {
			wpLat = data.lat;
			wpLng = data.lng;
		}
	});

	async function submitWaypoint() {
		if (wpLat == null || wpLng == null || !wpName.trim()) return;
		const waypoint = await addWaypoint({
			name: wpName.trim(),
			type: wpType as any,
			address: wpAddress.trim() || undefined,
			lat: wpLat,
			lng: wpLng,
			notes: wpNotes.trim() || undefined,
		});
		if (!waypoint) return;
		toastSuccess('Waypoint added');
		setAddingWaypoint(false);
		resetWp();
		closeModal();
	}

	function resetWp() {
		wpName = '';
		wpType = 'stop';
		wpNotes = '';
		wpAddress = '';
		wpLat = null;
		wpLng = null;
		placeQuery = '';
		placeResults = [];
		placeSearchError = '';
	}

	function requestCurrentPosition(): Promise<GeolocationPosition> {
		return new Promise((resolve, reject) => {
			if (!navigator.geolocation) {
				reject(new Error('Geolocation is not available on this device.'));
				return;
			}
			navigator.geolocation.getCurrentPosition(resolve, reject, {
				enableHighAccuracy: true,
				timeout: 15000,
				maximumAge: 0
			});
		});
	}

	async function useCurrentLocation() {
		try {
			const position = await requestCurrentPosition();
			wpLat = position.coords.latitude;
			wpLng = position.coords.longitude;
			if (!wpName.trim()) wpName = 'Current Location';
			toastSuccess('Using current location');
		} catch (error) {
			toastError(error instanceof Error ? error.message : 'Unable to get current location');
		}
	}

	function pickOnMap() {
		setAddingWaypoint(true);
		toastSuccess('Tap the map to place the stop');
	}

	async function searchPlaces() {
		const query = placeQuery.trim();
		if (!query) return;
		placeSearchLoading = true;
		placeSearchError = '';
		try {
			const result = await api.places.search(query, wpLat ?? undefined, wpLng ?? undefined);
			if (result.ok) {
				placeResults = result.data ?? [];
				if (!placeResults.length) placeSearchError = 'No places found.';
			} else {
				placeResults = [];
				placeSearchError = result.error ?? 'Place search failed.';
			}
		} catch (error) {
			placeResults = [];
			placeSearchError = error instanceof Error ? error.message : 'Place search failed.';
		} finally {
			placeSearchLoading = false;
		}
	}

	function applyPlace(place: import('$types').PlaceResult) {
		wpName = place.name || wpName;
		wpAddress = place.address || '';
		wpLat = place.lat;
		wpLng = place.lng;
		placeResults = [];
		placeQuery = place.name || '';
		toastSuccess('Place applied to waypoint');
	}

	/* ---------- Add / Edit Journal ---------- */
	let jTitle = $state('');
	let jContent = $state('');
	let jPrivate = $state(false);
	let jTags = $state('');

	$effect(() => {
		if ($uiState.modal === 'editJournal' && $uiState.modalData) {
			const e = $uiState.modalData as JournalEntry;
			jTitle = e.title || '';
			jContent = e.content || '';
			jPrivate = !!e.isPrivate;
			jTags = (e.tags || []).join(', ');
		}
		if ($uiState.modal === 'addJournal') {
			jTitle = ''; jContent = ''; jPrivate = false; jTags = '';
		}
	});

	async function submitJournal() {
		if (!jTitle.trim()) return;
		const tags = jTags.split(',').map(t => t.trim()).filter(Boolean);

		if ($uiState.modal === 'editJournal' && $uiState.modalData) {
			const entry = $uiState.modalData as JournalEntry;
			await updateJournalEntry(entry.id, {
				title: jTitle.trim(),
				content: jContent.trim(),
				isPrivate: jPrivate,
				tags,
			});
			toastSuccess('Note updated');
		} else {
			await addJournalEntry({
				title: jTitle.trim(),
				content: jContent.trim(),
				isPrivate: jPrivate,
				tags,
			});
			toastSuccess('Note added');
		}
		closeModal();
	}

	/* ---------- Share ---------- */
	let shareUrl = $state('');
	let isPublic = $state(false);

	$effect(() => {
		if ($uiState.modal === 'share' && $currentTrip) {
			isPublic = !!($currentTrip.isPublic || ($currentTrip as any).is_public);
			const code = $currentTrip.shareCode || ($currentTrip as any).share_code;
			shareUrl = code ? `${window.location.origin}/${code}` : '';
			if (!shareUrl) generateShareLink();
		}
	});

	async function generateShareLink() {
		if (!$currentTrip) return;
		try {
			const result = await api.trips.share($currentTrip.id);
			if (result.ok && result.data) {
				shareUrl = `${window.location.origin}/${result.data}`;
			}
		} catch {
			toastError('Failed to generate share link');
		}
	}

	async function copyLink() {
		try {
			await navigator.clipboard.writeText(shareUrl);
			toastSuccess('Link copied');
		} catch {
			toastError('Copy failed');
		}
	}

	async function togglePublic() {
		if (!$currentTrip) return;
		try {
			await api.trips.update($currentTrip.id, { isPublic: !isPublic });
			isPublic = !isPublic;
		} catch {
			toastError('Failed to update');
		}
	}

	/* ---------- Waypoint type options ---------- */
	const wpTypes = [
		{ value: 'stop', label: '📍 Stop' },
		{ value: 'scenic', label: '🏞️ Scenic' },
		{ value: 'fuel', label: '⛽ Fuel' },
		{ value: 'food', label: '🍽️ Food' },
		{ value: 'lodging', label: '🏨 Lodging' },
		{ value: 'custom', label: '⭐ Custom' },
	];

	function onOverlayClick(e: MouseEvent) {
		if ((e.target as HTMLElement).classList.contains('modal-overlay')) closeModal();
	}

	function dismissModal() {
		setAddingWaypoint(false);
		closeModal();
	}
</script>

{#if $uiState.modal}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="modal-overlay"
	class:passthrough={$uiState.modal === 'addWaypoint'}
	onclick={onOverlayClick}
	onkeydown={e => e.key === 'Escape' && dismissModal()}
>
	<div class="modal-sheet" class:waypoint-sheet={$uiState.modal === 'addWaypoint'} role="dialog" aria-modal={$uiState.modal === 'addWaypoint' ? 'false' : 'true'}>
		<div class="modal-handle"></div>

		{#if $uiState.modal === 'addWaypoint'}
			<h2 class="modal-title">Add Waypoint</h2>
			<form class="modal-form" onsubmit={e => { e.preventDefault(); submitWaypoint(); }}>
				<div class="waypoint-actions-row">
					<button class="btn-ghost small" type="button" onclick={pickOnMap}>Pick on map</button>
					<button class="btn-ghost small" type="button" onclick={useCurrentLocation}>Use my location</button>
				</div>
				<input class="field" type="text" placeholder="Waypoint name" bind:value={wpName} required />
				<input class="field" type="text" placeholder="Address or place details (optional)" bind:value={wpAddress} />
				<select class="field" bind:value={wpType}>
					{#each wpTypes as t}
						<option value={t.value}>{t.label}</option>
					{/each}
				</select>
				<div class="place-search-block">
					<div class="place-search-row">
						<input class="field" type="text" placeholder="Search cafe, fuel, landmark..." bind:value={placeQuery} />
						<button class="btn-ghost small" type="button" onclick={searchPlaces} disabled={placeSearchLoading}>
							{placeSearchLoading ? 'Searching...' : 'Search'}
						</button>
					</div>
					{#if placeSearchError}
						<p class="muted">{placeSearchError}</p>
					{/if}
					{#if placeResults.length}
						<div class="place-results">
							{#each placeResults as place}
								<button class="place-result" type="button" onclick={() => applyPlace(place)}>
									<span class="place-name">{place.name}</span>
									<span class="place-address">{place.address}</span>
								</button>
							{/each}
						</div>
					{/if}
				</div>
				{#if wpLat != null && wpLng != null}
					<p class="muted coords-row">Tap the map to reposition. {wpLat.toFixed(5)}, {wpLng.toFixed(5)}</p>
				{:else}
					<p class="muted coords-row">Choose a place, use your location, or tap the map to set coordinates.</p>
				{/if}
				<textarea class="field" placeholder="Notes (optional)" bind:value={wpNotes} rows="2"></textarea>
				<button class="btn-primary" type="submit" disabled={wpLat == null || wpLng == null || !wpName.trim()}>Add Waypoint</button>
			</form>

		{:else if $uiState.modal === 'addJournal' || $uiState.modal === 'editJournal'}
			<h2 class="modal-title">{$uiState.modal === 'editJournal' ? 'Edit Note' : 'New Note'}</h2>
			<form class="modal-form" onsubmit={e => { e.preventDefault(); submitJournal(); }}>
				<input class="field" type="text" placeholder="Title" bind:value={jTitle} required />
				<textarea class="field" placeholder="What happened?" bind:value={jContent} rows="4"></textarea>
				<input class="field" type="text" placeholder="Tags (comma-separated)" bind:value={jTags} />
				<label class="toggle-row">
					<input type="checkbox" bind:checked={jPrivate} />
					<span>Private note</span>
				</label>
				<button class="btn-primary" type="submit">{$uiState.modal === 'editJournal' ? 'Save' : 'Add Note'}</button>
			</form>

		{:else if $uiState.modal === 'share'}
			<h2 class="modal-title">Share Trip</h2>
			<div class="modal-form">
				<label class="toggle-row">
					<input type="checkbox" checked={isPublic} onchange={togglePublic} />
					<span>Public trip</span>
				</label>
				{#if shareUrl}
					<div class="share-link-row">
						<input class="field" type="text" value={shareUrl} readonly />
						<button class="btn-primary small" onclick={copyLink}>Copy</button>
					</div>
				{:else}
					<p class="muted">Generating share link…</p>
				{/if}
			</div>

		{:else if $uiState.modal === 'waypointDetail'}
			{@const wp = $uiState.modalData as Waypoint}
			<h2 class="modal-title">{wp?.name || 'Waypoint'}</h2>
			<div class="modal-form">
				{#if wp?.address}<p class="muted">{wp.address}</p>{/if}
				{#if wp?.notes}<p>{wp.notes}</p>{/if}
				<div class="detail-meta">
					<span>Type: {wp?.type}</span>
					{#if wp?.lat}<span>Lat: {wp.lat.toFixed(5)}</span>{/if}
					{#if wp?.lng}<span>Lng: {wp.lng.toFixed(5)}</span>{/if}
				</div>
			</div>

		{:else}
			<p class="muted">Unknown modal: {$uiState.modal}</p>
		{/if}

		<button class="modal-close" onclick={dismissModal} aria-label="Close">
			<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
		</button>
	</div>
</div>
{/if}

<style>
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(4px);
		z-index: 300;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		animation: fadeIn 0.15s ease;
	}

	.modal-overlay.passthrough {
		background: transparent;
		backdrop-filter: none;
		pointer-events: none;
		align-items: flex-end;
	}

	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

	.modal-sheet {
		width: 100%;
		max-width: 440px;
		max-height: 85vh;
		overflow-y: auto;
		background: var(--bg-surface);
		border-radius: var(--radius-xl) var(--radius-xl) 0 0;
		padding: 12px 20px 28px;
		padding-bottom: calc(28px + var(--safe-bottom));
		position: relative;
		animation: slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.modal-sheet.waypoint-sheet {
		pointer-events: auto;
		max-width: 520px;
		max-height: min(68vh, 560px);
		margin: 0 16px 16px;
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-modal);
	}

	@keyframes slideUp {
		from { transform: translateY(100%); }
		to { transform: translateY(0); }
	}

	.modal-handle {
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--text-muted);
		opacity: 0.4;
		margin: 0 auto 16px;
	}

	.modal-title {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 16px;
	}

	.modal-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.field {
		width: 100%;
		padding: 12px 14px;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-glass);
		background: var(--bg-elevated);
		color: var(--text-primary);
		font-size: 0.88rem;
		font-family: inherit;
		outline: none;
		transition: border-color 0.15s;
	}

	.field:focus { border-color: var(--accent); }
	.field::placeholder { color: var(--text-muted); }

	select.field { appearance: none; cursor: pointer; }
	textarea.field { resize: vertical; min-height: 60px; }

	.toggle-row {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 0.85rem;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.share-link-row {
		display: flex;
		gap: 8px;
	}

	.place-search-block {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.place-search-row {
		display: flex;
		gap: 8px;
	}

	.place-search-row .field {
		flex: 1;
	}

	.waypoint-actions-row {
		display: flex;
		gap: 8px;
	}

	.waypoint-actions-row :global(button) {
		flex: 1;
	}

	.place-results {
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-height: 140px;
		overflow-y: auto;
	}

	.place-result {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		padding: 10px 12px;
		border-radius: var(--radius-md);
		background: var(--bg-elevated);
		border: 1px solid var(--border-glass);
		text-align: left;
	}

	.place-name {
		font-size: 0.84rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.place-address {
		font-size: 0.74rem;
		color: var(--text-muted);
	}

	.share-link-row .field { flex: 1; }
	.share-link-row .btn-primary.small { padding: 10px 16px; font-size: 0.8rem; white-space: nowrap; }

	.detail-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		font-size: 0.78rem;
		color: var(--text-muted);
	}

	.muted { color: var(--text-muted); font-size: 0.82rem; }
	.coords-row { margin-top: -4px; }

	.modal-close {
		position: absolute;
		top: 12px;
		right: 12px;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--bg-elevated);
		border: none;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: color 0.15s;
	}

	.modal-close:hover { color: var(--text-primary); }
	.modal-close svg { width: 18px; height: 18px; fill: currentColor; }

	@media (min-width: 768px) {
		.modal-overlay { align-items: center; }
		.modal-sheet { border-radius: var(--radius-xl); margin: 20px; }
		.modal-overlay.passthrough {
			align-items: flex-end;
		}
	}
</style>
