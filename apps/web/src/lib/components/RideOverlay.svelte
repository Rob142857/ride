<script lang="ts">
	import { mapState, stopRide } from '$stores/map';
	import { formatDistance, formatDuration } from '$lib/utils';

	const ride = $derived($mapState.ride);

	function end() {
		if (confirm('End ride?')) stopRide();
	}
</script>

{#if ride.active}
<div class="ride-overlay">
	<div class="ride-hud">
		<div class="hud-speed">
			<span class="speed-value">{ride.speed ? Math.round(ride.speed * 3.6) : 0}</span>
			<span class="speed-unit">km/h</span>
		</div>

		{#if ride.nextInstruction}
			<div class="hud-instruction">
				<span class="instruction-text">{ride.nextInstruction.text}</span>
				{#if ride.nextInstruction.distance}
					<span class="instruction-dist">{formatDistance(ride.nextInstruction.distance / 1000)}</span>
				{/if}
			</div>
		{/if}

		<div class="hud-stats">
			{#if ride.position}
				<div class="hud-stat">
					<span class="stat-label">Heading</span>
					<span class="stat-value">{ride.heading ? `${Math.round(ride.heading)}°` : '—'}</span>
				</div>
			{/if}
			<div class="hud-stat">
				<span class="stat-label">Visited</span>
				<span class="stat-value">{ride.visitedWaypoints.size}</span>
			</div>
		</div>
	</div>

	<button class="ride-end-btn" onclick={end}>
		<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
		End Ride
	</button>
</div>
{/if}

<style>
	.ride-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 80;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 12px;
		padding-top: calc(var(--safe-top) + 8px);
		pointer-events: none;
	}

	.ride-hud {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 16px 24px;
		border-radius: var(--radius-xl);
		background: rgba(10, 14, 23, 0.88);
		backdrop-filter: blur(20px);
		border: 1px solid var(--border-glass);
		pointer-events: auto;
		min-width: 200px;
	}

	.hud-speed {
		display: flex;
		align-items: baseline;
		gap: 4px;
	}

	.speed-value {
		font-size: 2.8rem;
		font-weight: 700;
		color: var(--accent-light);
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}

	.speed-unit {
		font-size: 0.8rem;
		color: var(--text-muted);
		font-weight: 500;
	}

	.hud-instruction {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		border-radius: var(--radius-md);
		background: var(--bg-elevated);
		max-width: 280px;
	}

	.instruction-text {
		font-size: 0.82rem;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.instruction-dist {
		font-size: 0.72rem;
		color: var(--accent-light);
		font-weight: 600;
		flex-shrink: 0;
	}

	.hud-stats {
		display: flex;
		gap: 16px;
	}

	.hud-stat {
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.stat-label { font-size: 0.6rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
	.stat-value { font-size: 0.88rem; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }

	.ride-end-btn {
		margin-top: 12px;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 10px 20px;
		border-radius: var(--radius-lg);
		background: rgba(248, 81, 73, 0.9);
		color: #fff;
		border: none;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		pointer-events: auto;
		transition: transform 0.1s;
	}

	.ride-end-btn:active { transform: scale(0.95); }
	.ride-end-btn svg { width: 18px; height: 18px; fill: currentColor; }
</style>
