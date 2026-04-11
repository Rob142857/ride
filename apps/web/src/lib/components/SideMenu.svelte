<script lang="ts">
	import { uiState, toggleSideMenu, switchView } from '$stores/ui';
	import { tripList, createTrip } from '$stores/trip';
	import { logout, currentUser } from '$stores/auth';
	import { haptic } from '$lib/utils';
	import type { AppView } from '$types';

	function navTo(view: AppView) {
		haptic();
		switchView(view);
		toggleSideMenu();
	}

	async function newTrip() {
		haptic();
		await createTrip('New Trip');
		switchView('map');
		toggleSideMenu();
	}

	function doLogout() {
		haptic();
		logout();
		toggleSideMenu();
	}
</script>

{#if $uiState.sideMenuOpen}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={toggleSideMenu} onkeydown={e => e.key === 'Escape' && toggleSideMenu()}></div>
<aside class="sidemenu" aria-label="Menu">
	<div class="menu-header">
		<img class="menu-logo" src="/icons/icon.svg" alt="" />
		<span class="menu-brand wordmark">Ride</span>
	</div>

	{#if $currentUser}
		<div class="menu-user">
			{#if $currentUser.picture}
				<img class="menu-avatar" src={$currentUser.picture} alt="" />
			{/if}
			<span class="menu-username">{$currentUser.name ?? $currentUser.email}</span>
		</div>
	{/if}

	<div class="menu-section">
		<button class="menu-item" onclick={newTrip}>
			<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
			New Trip
		</button>
		<button class="menu-item" onclick={() => navTo('trips')}>
			<svg viewBox="0 0 24 24"><path d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z"/></svg>
			My Trips ({$tripList.length})
		</button>
	</div>

	<div class="menu-divider"></div>

	<div class="menu-section">
		<a class="menu-item" href="/about.html" target="_blank">
			<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
			About
		</a>
		<a class="menu-item" href="https://github.com/Ride-App" target="_blank" rel="noopener">
			<svg viewBox="0 0 24 24"><path d="M12 2A10 10 0 002 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0012 2z"/></svg>
			GitHub
		</a>
		<a class="menu-item" href="/privacy.html" target="_blank">
			<svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
			Privacy
		</a>
	</div>

	{#if $currentUser}
		<div class="menu-footer">
			<button class="menu-item logout" onclick={doLogout}>
				<svg viewBox="0 0 24 24"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>
				Sign Out
			</button>
		</div>
	{/if}
</aside>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(3px);
		z-index: 1300;
		animation: fadeIn 0.2s ease;
	}

	.sidemenu {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		width: min(300px, 80vw);
		background: var(--bg-surface);
		border-right: 1px solid var(--border-glass);
		z-index: 1301;
		display: flex;
		flex-direction: column;
		padding: var(--safe-top) 0 var(--safe-bottom);
		animation: slideInLeft 0.25s cubic-bezier(0.16, 1, 0.3, 1);
		overflow-y: auto;
	}

	@keyframes slideInLeft {
		from { transform: translateX(-100%); }
		to { transform: translateX(0); }
	}

	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	.menu-header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 20px 20px 16px;
	}

	.menu-logo {
		width: 40px;
		height: 40px;
		border-radius: 10px;
	}

	.menu-brand {
		font-family: var(--font-serif);
		font-size: 1.5rem;
		font-style: italic;
		font-weight: 700;
		color: var(--text-primary);
	}

	.menu-user {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 20px 16px;
	}

	.menu-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		object-fit: cover;
	}

	.menu-username {
		font-size: 0.85rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.menu-divider {
		height: 1px;
		background: var(--border-glass);
		margin: 4px 16px;
	}

	.menu-section {
		display: flex;
		flex-direction: column;
		padding: 4px 8px;
	}

	.menu-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border-radius: var(--radius-md);
		font-size: 0.88rem;
		color: var(--text-secondary);
		background: none;
		border: none;
		text-decoration: none;
		cursor: pointer;
		min-height: 44px;
		transition: background 0.15s, color 0.15s;
	}

	.menu-item:hover {
		background: var(--bg-elevated);
		color: var(--text-primary);
	}

	.menu-item svg {
		width: 20px;
		height: 20px;
		fill: currentColor;
		flex-shrink: 0;
	}

	.menu-footer {
		margin-top: auto;
		padding: 4px 8px;
		border-top: 1px solid var(--border-glass);
	}

	.logout { color: var(--red); }
	.logout:hover { background: rgba(248, 81, 73, 0.1); }
</style>
