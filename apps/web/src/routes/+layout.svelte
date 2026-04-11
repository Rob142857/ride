<script lang="ts">
	import '../app.css';
	import TopBar from '$components/TopBar.svelte';
	import BottomNav from '$components/BottomNav.svelte';
	import SideMenu from '$components/SideMenu.svelte';
	import Toast from '$components/Toast.svelte';
	import AuthGate from '$components/AuthGate.svelte';
	import { checkAuth, isAuthenticated } from '$stores/auth';
	import { loadTrips } from '$stores/trip';

	let { children } = $props();
	let initDone = $state(false);
	let initStarted = $state(false);
	const LEGACY_SW_CLEANED_KEY = 'ride_legacy_sw_cleared_v1';

	async function clearLegacyServiceWorkers() {
		if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
		if (window.localStorage.getItem(LEGACY_SW_CLEANED_KEY) === '1') return;

		try {
			const registrations = await navigator.serviceWorker.getRegistrations();
			if (registrations.length) {
				await Promise.all(registrations.map((registration) => registration.unregister()));
			}

			if ('caches' in window) {
				const cacheNames = await caches.keys();
				await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
			}

			window.localStorage.setItem(LEGACY_SW_CLEANED_KEY, '1');
		} catch (error) {
			console.warn('[Ride] Failed to clear legacy service workers:', error);
		}
	}

	$effect(() => {
		if (initStarted) return;
		initStarted = true;
		(async () => {
			try {
				await clearLegacyServiceWorkers();
				const ok = await checkAuth();
				if (ok) {
					await loadTrips();
				}
			} catch (e) {
				console.error('[Ride] Init failed:', e);
			} finally {
				initDone = true;
			}
		})();

		const t = setTimeout(() => {
			initDone = true;
		}, 4000);

		return () => clearTimeout(t);
	});
</script>

{#if !initDone}
	<div class="app-loader">
		<img src="/icons/icon.svg" alt="Ride" class="app-loader-icon" />
		<span class="wordmark app-loader-title">Ride</span>
	</div>
{:else if !$isAuthenticated}
	<AuthGate />
{:else}
	<div class="app-shell">
		<TopBar />
		<main class="app-main">
			{@render children()}
		</main>
		<BottomNav />
		<SideMenu />
	</div>
{/if}

<Toast />

<style>
	.app-loader {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		background: var(--bg-deep);
	}

	.app-loader-icon {
		width: 64px;
		height: 64px;
		border-radius: 16px;
		animation: pulse-glow 2s ease-in-out infinite;
	}

	.app-loader-title { font-size: 2rem; }

	@keyframes pulse-glow {
		0%, 100% { filter: brightness(1); }
		50% { filter: brightness(1.3) drop-shadow(0 0 20px rgba(99, 102, 241, 0.4)); }
	}

	.app-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 100dvh;
		overflow: hidden;
	}

	.app-main {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
		position: relative;
	}
</style>
