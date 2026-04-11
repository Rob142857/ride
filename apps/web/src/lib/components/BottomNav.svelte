<script lang="ts">
	import { uiState, switchView } from '$stores/ui';
	import { currentTrip } from '$stores/trip';
	import { isRiding } from '$stores/map';
	import { haptic } from '$lib/utils';
	import type { AppView } from '$types';

	const tabs: { view: AppView; label: string; icon: string }[] = [
		{ view: 'map', label: 'Map', icon: 'M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z' },
		{ view: 'waypoints', label: 'Stops', icon: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z' },
		{ view: 'journal', label: 'Journal', icon: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z' },
		{ view: 'trips', label: 'Trips', icon: 'M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z' },
	];

	function onTab(view: AppView) {
		haptic();
		switchView(view);
	}
</script>

{#if !$isRiding}
<nav class="bottomnav" aria-label="Primary navigation">
	{#each tabs as tab}
		<button
			class="nav-tab"
			class:active={$uiState.view === tab.view}
			aria-pressed={$uiState.view === tab.view}
			onclick={() => onTab(tab.view)}
			disabled={tab.view !== 'trips' && tab.view !== 'map' && !$currentTrip}
		>
			<svg viewBox="0 0 24 24" class="nav-icon"><path d={tab.icon}/></svg>
			<span class="nav-label">{tab.label}</span>
		</button>
	{/each}
</nav>
{/if}

<style>
	.bottomnav {
		display: flex;
		align-items: center;
		justify-content: space-around;
		position: relative;
		height: var(--footer-height);
		padding-bottom: var(--safe-bottom);
		background: rgba(10, 14, 23, 0.88);
		backdrop-filter: blur(20px);
		border-top: 1px solid var(--border-glass);
		flex-shrink: 0;
		z-index: 1205;
	}

	.nav-tab {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3px;
		padding: 6px 0;
		min-height: 44px;
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		transition: color 0.2s;
		-webkit-tap-highlight-color: transparent;
	}

	.nav-tab:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.nav-tab.active {
		color: var(--accent-light);
	}

	.nav-icon {
		width: 22px;
		height: 22px;
		fill: currentColor;
	}

	.nav-label {
		font-size: 0.62rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	@media (min-width: 768px) {
		.bottomnav {
			padding-inline: 16px;
		}

		.nav-tab {
			flex-direction: row;
			gap: 8px;
		}

		.nav-label {
			font-size: 0.72rem;
		}
	}
</style>
