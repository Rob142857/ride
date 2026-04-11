<script lang="ts">
	import { currentTrip } from '$stores/trip';
	import { toggleSideMenu, openModal, switchView, toastError, toastInfo } from '$stores/ui';
	import { isRiding, startRide, routeData as routeDataStore, setAddingWaypoint, updateRidePosition } from '$stores/map';
	import { currentUser } from '$stores/auth';
	import { formatDistance, formatDuration } from '$lib/utils';

	function addWaypoint() {
		switchView('map');
		setAddingWaypoint(true);
		openModal('addWaypoint');
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

	async function beginRide() {
		switchView('map');
		try {
			const position = await requestCurrentPosition();
			updateRidePosition(position.coords);
			startRide();
			toastInfo('Ride tracking started.');
		} catch (error) {
			const geoError = error as GeolocationPositionError | Error;
			if ('code' in geoError) {
				if (geoError.code === 1) {
					toastError('Location permission was denied.');
					return;
				}
				if (geoError.code === 3) {
					toastError('Location request timed out.');
					return;
				}
			}
			toastError(geoError instanceof Error ? geoError.message : 'Unable to start ride tracking.');
		}
	}
</script>

<header class="topbar">
	<button class="icon-btn menu-btn" onclick={toggleSideMenu} aria-label="Menu">
		<svg viewBox="0 0 24 24"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
	</button>

	<div class="topbar-center">
		<img class="topbar-icon" src="/icons/icon.svg" alt="Ride" />
		<div class="topbar-info">
			<span class="topbar-label">Ride</span>
			<h1 class="topbar-title">{$currentTrip?.name ?? 'New Trip'}</h1>
		</div>
		{#if $routeDataStore}
			<div class="topbar-stats">
				<span class="stat-pill">{formatDistance($routeDataStore.distance / 1000)}</span>
				<span class="stat-pill">{formatDuration($routeDataStore.duration)}</span>
			</div>
		{/if}
	</div>

	<div class="topbar-actions">
		<button class="icon-btn" onclick={addWaypoint} aria-label="Add waypoint">
			<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
		</button>
		<button class="icon-btn" onclick={beginRide} aria-label="Start ride">
			<svg viewBox="0 0 24 24"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg>
		</button>
		<button class="icon-btn" onclick={() => openModal('share')} aria-label="Share">
			<svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>
		</button>
		<button class="icon-btn user-btn" onclick={() => openModal('login')} aria-label="Account">
			{#if $currentUser?.picture}
				<img class="avatar" src={$currentUser.picture} alt="" />
			{:else if $currentUser?.name}
				<span class="avatar-initial">{$currentUser.name[0]}</span>
			{:else}
				<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
			{/if}
		</button>
	</div>
</header>

<style>
	.topbar {
		display: flex;
		align-items: center;
		gap: 8px;
		position: relative;
		height: var(--header-height);
		padding: 0 12px;
		padding-top: var(--safe-top);
		background: rgba(10, 14, 23, 0.85);
		backdrop-filter: blur(20px);
		border-bottom: 1px solid var(--border-glass);
		z-index: 1205;
		flex-shrink: 0;
	}

	.topbar-center {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.topbar-icon {
		width: 34px;
		height: 34px;
		border-radius: 8px;
		flex-shrink: 0;
	}

	.topbar-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 0;
	}

	.topbar-label {
		font-size: 0.62rem;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--accent-light);
		line-height: 1;
	}

	.topbar-title {
		font-size: 1rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1.3;
		color: rgba(255, 255, 255, 0.95);
	}

	.topbar-stats {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
		margin-left: auto;
	}

	.stat-pill {
		padding: 2px 8px;
		border-radius: 6px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.topbar-actions {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
	}

	.avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
	}

	.avatar-initial {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--accent);
		color: #fff;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
		font-size: 0.8rem;
	}

	@media (max-width: 767px) {
		.topbar { padding: 0 8px; padding-top: var(--safe-top); gap: 6px; }
		.topbar-icon { width: 30px; height: 30px; border-radius: 7px; }
		.topbar-stats { display: none; }
		.topbar-title { font-size: 0.92rem; }
	}
</style>
