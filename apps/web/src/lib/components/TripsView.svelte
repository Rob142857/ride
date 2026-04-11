<script lang="ts">
	import { tripState, loadTrip, createTrip, deleteTrip } from '$stores/trip';
	import { switchView } from '$stores/ui';
	import { haptic } from '$lib/utils';
	import type { Trip } from '$types';

	const trips = $derived.by(() => $tripState.list);

	function formatDate(d: string | undefined) {
		if (!d) return '';
		return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	async function selectTrip(trip: Trip) {
		haptic();
		await loadTrip(trip.id);
		switchView('map');
	}

	async function newTrip() {
		haptic();
		const name = prompt('Trip name:');
		if (!name?.trim()) return;
		await createTrip(name.trim());
		switchView('map');
	}

	function confirmDelete(e: Event, trip: Trip) {
		e.stopPropagation();
		if (confirm(`Delete "${trip.name}"? This cannot be undone.`)) {
			deleteTrip(trip.id);
		}
	}

	function tripStopCount(trip: Trip) {
		return trip.waypointCount ?? trip.waypoints?.length ?? 0;
	}
</script>

<div class="trips-view">
	<div class="view-header">
		<h2>My Trips</h2>
		<span class="count-badge">{trips.length}</span>
		<button class="btn-primary small" onclick={newTrip}>+ New Trip</button>
	</div>

	{#if $tripState.listLoading}
		<div class="trips-loading">
			{#each Array(3) as _}
				<div class="skeleton-card">
					<div class="skeleton skeleton-title"></div>
					<div class="skeleton skeleton-text"></div>
				</div>
			{/each}
		</div>
	{:else if trips.length === 0}
		<div class="empty-state">
			<svg viewBox="0 0 24 24"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/></svg>
			<h3>No trips yet</h3>
			<p>Create your first trip to start planning an adventure</p>
			<button class="btn-primary" onclick={newTrip}>Create Trip</button>
		</div>
	{:else}
		<div class="trip-grid">
			{#each trips as trip (trip.id)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="trip-card" class:active={$tripState.current?.id === trip.id} onclick={() => selectTrip(trip)} onkeydown={e => e.key === 'Enter' && selectTrip(trip)} role="button" tabindex="0">
					{#if (trip as any).coverImageUrl}
						<div class="card-cover">
							<img src={(trip as any).coverImageUrl} alt="" loading="lazy" />
						</div>
					{:else}
						<div class="card-cover placeholder">
							<svg viewBox="0 0 24 24"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/></svg>
						</div>
					{/if}
					<div class="card-body">
						<h3 class="card-name">{trip.name}</h3>
						<div class="card-meta">
							<span>{tripStopCount(trip)} stops</span>
							<span>{formatDate(trip.updatedAt)}</span>
						</div>
					</div>
					<button class="icon-btn card-delete" onclick={e => confirmDelete(e, trip)} aria-label="Delete">
						<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.trips-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow-y: auto;
		padding: 16px;
		gap: 14px;
	}

	.view-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.view-header h2 { font-size: 1.15rem; font-weight: 600; color: var(--text-primary); }
	.view-header .btn-primary.small { margin-left: auto; padding: 6px 14px; font-size: 0.78rem; }

	.count-badge {
		padding: 2px 8px; border-radius: 10px;
		background: var(--bg-elevated); color: var(--text-muted);
		font-size: 0.72rem; font-weight: 600;
	}

	.trips-loading { display: flex; flex-direction: column; gap: 10px; }
	.skeleton-card {
		padding: 16px; border-radius: var(--radius-lg);
		background: var(--bg-surface); border: 1px solid var(--border-glass);
	}
	.skeleton-title { height: 16px; width: 60%; border-radius: 4px; margin-bottom: 8px; }
	.skeleton-text { height: 12px; width: 40%; border-radius: 4px; }

	.empty-state {
		flex: 1; display: flex; flex-direction: column;
		align-items: center; justify-content: center; text-align: center;
		color: var(--text-muted); padding: 40px 20px; gap: 8px;
	}
	.empty-state svg { width: 56px; height: 56px; fill: var(--text-muted); opacity: 0.35; margin-bottom: 8px; }
	.empty-state h3 { font-size: 1.05rem; color: var(--text-secondary); }
	.empty-state p { font-size: 0.82rem; max-width: 260px; margin-bottom: 12px; }

	.trip-grid { display: flex; flex-direction: column; gap: 10px; }

	.trip-card {
		display: flex;
		gap: 14px;
		padding: 12px;
		border-radius: var(--radius-lg);
		background: var(--bg-surface);
		border: 1px solid var(--border-glass);
		cursor: pointer;
		text-align: left;
		transition: background 0.15s, border-color 0.15s;
		position: relative;
		width: 100%;
		outline: none;
	}
	.trip-card:hover { background: var(--bg-elevated); }
	.trip-card.active { border-color: var(--accent); }

	.card-cover {
		width: 72px; height: 56px; flex-shrink: 0;
		border-radius: var(--radius-md); overflow: hidden;
		background: var(--bg-elevated);
	}
	.card-cover img { width: 100%; height: 100%; object-fit: cover; }
	.card-cover.placeholder {
		display: flex; align-items: center; justify-content: center;
	}
	.card-cover.placeholder svg { width: 28px; height: 28px; fill: var(--text-muted); opacity: 0.3; }

	.card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
	.card-name { font-size: 0.92rem; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; }
	.card-meta {
		display: flex; gap: 10px; font-size: 0.7rem; color: var(--text-muted);
	}

	.card-delete { position: absolute; top: 8px; right: 8px; opacity: 0; transition: opacity 0.15s; }
	.trip-card:hover .card-delete { opacity: 1; }

	@media (min-width: 768px) {
		.trip-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
			gap: 12px;
		}
	}
</style>
