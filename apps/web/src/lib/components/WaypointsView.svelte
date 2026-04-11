<script lang="ts">
	import { currentTrip, currentWaypoints, deleteWaypoint, reorderWaypoints } from '$stores/trip';
	import { openModal, switchView } from '$stores/ui';
	import { setAddingWaypoint } from '$stores/map';
	import { haptic } from '$lib/utils';
	import type { Waypoint } from '$types';

	const WP_ICONS: Record<string, string> = {
		stop: '📍', scenic: '🏞️', fuel: '⛽', food: '🍽️', lodging: '🏨', custom: '⭐',
	};

	const waypoints = $derived.by(() => $currentWaypoints);

	let dragId = $state<string | null>(null);
	let overIdx = $state<number | null>(null);

	function startDrag(e: DragEvent, wp: Waypoint) {
		dragId = wp.id;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', wp.id);
		}
	}

	function onDragOver(e: DragEvent, idx: number) {
		e.preventDefault();
		overIdx = idx;
	}

	function onDrop(e: DragEvent, targetIdx: number) {
		e.preventDefault();
		if (!dragId || !$currentTrip) return;
		const sourceIdx = waypoints.findIndex(w => w.id === dragId);
		if (sourceIdx === -1 || sourceIdx === targetIdx) { cleanup(); return; }

		const ids = waypoints.map(w => w.id);
		const [moved] = ids.splice(sourceIdx, 1);
		ids.splice(targetIdx, 0, moved);
		reorderWaypoints(ids);
		haptic();
		cleanup();
	}

	function cleanup() {
		dragId = null;
		overIdx = null;
	}

	function confirmDelete(wp: Waypoint) {
		if (confirm(`Delete waypoint "${wp.name}"?`)) {
			deleteWaypoint(wp.id);
		}
	}

	function addStop() {
		haptic();
		switchView('map');
		setAddingWaypoint(true);
		openModal('addWaypoint');
	}

	function moveWaypoint(wp: Waypoint, direction: -1 | 1) {
		const currentIndex = waypoints.findIndex((item) => item.id === wp.id);
		const targetIndex = currentIndex + direction;
		if (currentIndex < 0 || targetIndex < 0 || targetIndex >= waypoints.length) return;

		const ids = waypoints.map((item) => item.id);
		const [moved] = ids.splice(currentIndex, 1);
		ids.splice(targetIndex, 0, moved);
		reorderWaypoints(ids);
		haptic();
	}
</script>

<div class="waypoints-view">
	<div class="view-header">
		<h2>Waypoints</h2>
		<span class="count-badge">{waypoints.length}</span>
		<button class="btn-primary small" onclick={addStop}>+ Stop</button>
	</div>

	{#if waypoints.length === 0}
		<div class="empty-state">
			<svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
			<h3>No waypoints yet</h3>
			<p>Switch to the map and tap + to add your first stop</p>
			<button class="btn-primary" onclick={addStop}>Add Stop</button>
		</div>
	{:else}
		<div class="waypoint-list" role="list">
			{#each waypoints as wp, i (wp.id)}
				<div
					class="waypoint-item"
					class:dragging={dragId === wp.id}
					class:dragover={overIdx === i && dragId !== wp.id}
					draggable="true"
					role="listitem"
					ondragstart={e => startDrag(e, wp)}
					ondragover={e => onDragOver(e, i)}
					ondrop={e => onDrop(e, i)}
					ondragend={cleanup}
				>
					<div class="wp-handle" aria-hidden="true">
						<svg viewBox="0 0 24 24"><path d="M10 4h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2zm4-12h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z"/></svg>
					</div>
					<span class="wp-icon">{WP_ICONS[wp.type] ?? '📍'}</span>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="wp-info" onclick={() => openModal('waypointDetail', wp)} onkeydown={e => e.key === 'Enter' && openModal('waypointDetail', wp)} role="button" tabindex="0">
						<span class="wp-name">{i + 1}. {wp.name}</span>
						{#if wp.address}
							<span class="wp-address">{wp.address}</span>
						{/if}
					</div>
					<div class="wp-actions">
						<button class="icon-btn compact" onclick={() => moveWaypoint(wp, -1)} aria-label="Move waypoint up" disabled={i === 0}>
							<svg viewBox="0 0 24 24"><path d="M7.41 14.59 12 10l4.59 4.59L18 13.17l-6-6-6 6z"/></svg>
						</button>
						<button class="icon-btn compact" onclick={() => moveWaypoint(wp, 1)} aria-label="Move waypoint down" disabled={i === waypoints.length - 1}>
							<svg viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
						</button>
						<button class="icon-btn" onclick={() => confirmDelete(wp)} aria-label="Delete">
							<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.waypoints-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow-y: auto;
		padding: 16px;
		gap: 12px;
	}

	.view-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.view-header h2 {
		font-size: 1.15rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.count-badge {
		padding: 2px 8px;
		border-radius: 10px;
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.72rem;
		font-weight: 600;
	}

	.empty-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		color: var(--text-muted);
		padding: 40px 20px;
	}

	.empty-state svg {
		width: 48px;
		height: 48px;
		fill: var(--text-muted);
		opacity: 0.4;
		margin-bottom: 12px;
	}

	.empty-state h3 { font-size: 1rem; margin-bottom: 6px; color: var(--text-secondary); }
	.empty-state p { font-size: 0.82rem; max-width: 260px; }

	.waypoint-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.waypoint-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		border-radius: var(--radius-md);
		background: var(--bg-surface);
		border: 1px solid var(--border-glass);
		cursor: grab;
		transition: background 0.15s, transform 0.15s, opacity 0.15s;
		min-height: 52px;
	}

	.waypoint-item:hover { background: var(--bg-elevated); }
	.waypoint-item.dragging { opacity: 0.4; transform: scale(0.97); }
	.waypoint-item.dragover { border-color: var(--accent); background: rgba(99, 102, 241, 0.08); }

	.wp-handle {
		flex-shrink: 0;
		width: 20px;
		color: var(--text-muted);
		opacity: 0.5;
		cursor: grab;
	}

	.wp-handle svg { width: 18px; fill: currentColor; }

	.wp-icon { font-size: 1.3rem; flex-shrink: 0; }

	.wp-info {
		flex: 1;
		min-width: 0;
		cursor: pointer;
	}

	.wp-name {
		display: block;
		font-size: 0.88rem;
		font-weight: 500;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.wp-address {
		display: block;
		font-size: 0.72rem;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.wp-actions {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	:global(.icon-btn.compact) {
		width: 34px;
		height: 34px;
	}

	:global(.icon-btn.compact svg) {
		width: 18px;
		height: 18px;
	}
</style>
