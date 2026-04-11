<script lang="ts">
	import { uiState, closeModal, toastSuccess, toastError } from '$stores/ui';
	import { addWaypoint, addJournalEntry, updateJournalEntry, updateWaypoint } from '$stores/trip';
	import { currentTrip } from '$stores/trip';
	import * as api from '$lib/api';
	import type { Waypoint, JournalEntry } from '$types';

	const ui = $derived($uiState);
	const trip = $derived($currentTrip);

	/* ---------- Add Waypoint ---------- */
	let wpName = $state('');
	let wpType = $state('stop');
	let wpNotes = $state('');

	async function submitWaypoint() {
		const data = ui.modalData as { lat: number; lng: number } | undefined;
		if (!data || !wpName.trim()) return;
		await addWaypoint({
			name: wpName.trim(),
			type: wpType as any,
			lat: data.lat,
			lng: data.lng,
			notes: wpNotes.trim() || undefined,
		});
		toastSuccess('Waypoint added');
		resetWp();
		closeModal();
	}

	function resetWp() {
		wpName = '';
		wpType = 'stop';
		wpNotes = '';
	}

	/* ---------- Add / Edit Journal ---------- */
	let jTitle = $state('');
	let jContent = $state('');
	let jPrivate = $state(false);
	let jTags = $state('');

	$effect(() => {
		if (ui.modal === 'editJournal' && ui.modalData) {
			const e = ui.modalData as JournalEntry;
			jTitle = e.title || '';
			jContent = e.content || '';
			jPrivate = !!e.isPrivate;
			jTags = (e.tags || []).join(', ');
		}
		if (ui.modal === 'addJournal') {
			jTitle = ''; jContent = ''; jPrivate = false; jTags = '';
		}
	});

	async function submitJournal() {
		if (!jTitle.trim()) return;
		const tags = jTags.split(',').map(t => t.trim()).filter(Boolean);

		if (ui.modal === 'editJournal' && ui.modalData) {
			const entry = ui.modalData as JournalEntry;
			await updateJournalEntry(entry.id, {
				title: jTitle.trim(),
				content: jContent.trim(),
				is_private: jPrivate,
				tags,
			});
			toastSuccess('Note updated');
		} else {
			await addJournalEntry({
				title: jTitle.trim(),
				content: jContent.trim(),
				is_private: jPrivate,
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
		if (ui.modal === 'share' && trip) {
			isPublic = !!(trip.isPublic || (trip as any).is_public);
			const code = trip.shareCode || (trip as any).share_code;
			shareUrl = code ? `${window.location.origin}/${code}` : '';
			if (!shareUrl) generateShareLink();
		}
	});

	async function generateShareLink() {
		if (!trip) return;
		try {
			const result = await api.trips.share(trip.id);
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
		if (!trip) return;
		try {
			await api.trips.update(trip.id, { is_public: !isPublic });
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
</script>

{#if ui.modal}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={onOverlayClick} onkeydown={e => e.key === 'Escape' && closeModal()}>
	<div class="modal-sheet" role="dialog" aria-modal="true">
		<div class="modal-handle"></div>

		{#if ui.modal === 'addWaypoint'}
			<h2 class="modal-title">Add Waypoint</h2>
			<form class="modal-form" onsubmit={e => { e.preventDefault(); submitWaypoint(); }}>
				<input class="field" type="text" placeholder="Waypoint name" bind:value={wpName} required />
				<select class="field" bind:value={wpType}>
					{#each wpTypes as t}
						<option value={t.value}>{t.label}</option>
					{/each}
				</select>
				<textarea class="field" placeholder="Notes (optional)" bind:value={wpNotes} rows="2"></textarea>
				<button class="btn-primary" type="submit">Add Waypoint</button>
			</form>

		{:else if ui.modal === 'addJournal' || ui.modal === 'editJournal'}
			<h2 class="modal-title">{ui.modal === 'editJournal' ? 'Edit Note' : 'New Note'}</h2>
			<form class="modal-form" onsubmit={e => { e.preventDefault(); submitJournal(); }}>
				<input class="field" type="text" placeholder="Title" bind:value={jTitle} required />
				<textarea class="field" placeholder="What happened?" bind:value={jContent} rows="4"></textarea>
				<input class="field" type="text" placeholder="Tags (comma-separated)" bind:value={jTags} />
				<label class="toggle-row">
					<input type="checkbox" bind:checked={jPrivate} />
					<span>Private note</span>
				</label>
				<button class="btn-primary" type="submit">{ui.modal === 'editJournal' ? 'Save' : 'Add Note'}</button>
			</form>

		{:else if ui.modal === 'share'}
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

		{:else if ui.modal === 'waypointDetail'}
			{@const wp = ui.modalData as Waypoint}
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
			<p class="muted">Unknown modal: {ui.modal}</p>
		{/if}

		<button class="modal-close" onclick={closeModal} aria-label="Close">
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
	}
</style>
