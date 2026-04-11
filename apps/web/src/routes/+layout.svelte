<script lang="ts">
	import '../app.css';
	import TopBar from '$components/TopBar.svelte';
	import BottomNav from '$components/BottomNav.svelte';
	import SideMenu from '$components/SideMenu.svelte';
	import Toast from '$components/Toast.svelte';
	import AuthGate from '$components/AuthGate.svelte';
	import LandingGate from '$components/LandingGate.svelte';
	import { checkAuth, isAuthenticated, isChecking } from '$stores/auth';
	import { landingSeen } from '$stores/ui';
	import { loadTrips } from '$stores/trip';
	import { onMount } from 'svelte';

	let { children } = $props();
	let appReady = $state(false);

	onMount(async () => {
		const ok = await checkAuth();
		if (ok) await loadTrips();
		appReady = true;
	});
</script>

{#if !appReady}
	<!-- Loading skeleton -->
	<div class="app-loader">
		<img src="/icons/icon.svg" alt="Ride" class="app-loader-icon" />
		<span class="wordmark app-loader-title">Ride</span>
	</div>
{:else if !$landingSeen}
	<LandingGate />
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
		overflow: hidden;
	}

	.app-main {
		flex: 1;
		overflow: hidden;
		position: relative;
	}
</style>
