<script lang="ts">
	import MapView from '$components/MapView.svelte';
	import WaypointsView from '$components/WaypointsView.svelte';
	import JournalView from '$components/JournalView.svelte';
	import TripsView from '$components/TripsView.svelte';
	import RideOverlay from '$components/RideOverlay.svelte';
	import ModalHost from '$components/ModalHost.svelte';
	import { currentView } from '$stores/ui';
	import { isRiding } from '$stores/map';
</script>

<div class="views">
	<div class="view" class:active={$currentView === 'map'}>
		<MapView />
	</div>
	<div class="view" class:active={$currentView === 'waypoints'}>
		<WaypointsView />
	</div>
	<div class="view" class:active={$currentView === 'journal'}>
		<JournalView />
	</div>
	<div class="view" class:active={$currentView === 'trips'}>
		<TripsView />
	</div>
</div>

{#if $isRiding}
	<RideOverlay />
{/if}

<ModalHost />

<style>
	.views { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; }
	.view {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.2s ease;
		overflow: hidden;
	}
	.view.active {
		opacity: 1;
		pointer-events: auto;
	}
</style>
