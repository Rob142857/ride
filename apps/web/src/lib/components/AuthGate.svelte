<script lang="ts">
	const providers = [
		{ id: 'google', label: 'Continue with Google', icon: '🔵' },
		{ id: 'microsoft', label: 'Continue with Microsoft', icon: '🟦' },
	];
</script>

<div class="auth-gate">
	<div class="auth-card">
		<img class="auth-logo" src="/icons/icon.svg" alt="Ride" />
		<h1 class="auth-title wordmark">Ride</h1>
		<p class="auth-subtitle">Plan roads. Track journeys. Own your adventure.</p>

		<div class="auth-providers">
			{#each providers as p}
				<a class="auth-btn" href="/api/auth/login/{p.id}" data-sveltekit-reload>
					<span class="auth-btn-icon">{p.icon}</span>
					{p.label}
				</a>
			{/each}
		</div>

		<p class="auth-legal">
			By signing in you agree to our
			<a href="/terms.html" target="_blank">Terms</a> and
			<a href="/privacy.html" target="_blank">Privacy Policy</a>.
		</p>
	</div>
</div>

<style>
	.auth-gate {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-base);
		z-index: 500;
		padding: 20px;
	}

	.auth-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		max-width: 360px;
		width: 100%;
	}

	.auth-logo {
		width: 88px;
		height: 88px;
		border-radius: 20px;
		margin-bottom: 16px;
		filter: drop-shadow(0 0 30px rgba(99, 102, 241, 0.25));
	}

	.auth-title {
		font-family: var(--font-serif);
		font-size: 2.6rem;
		font-style: italic;
		font-weight: 700;
		line-height: 1.1;
		margin-bottom: 8px;
	}

	.auth-subtitle {
		font-size: 1rem;
		color: var(--text-secondary);
		margin-bottom: 32px;
		line-height: 1.5;
	}

	.auth-providers {
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: 100%;
	}

	.auth-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 14px 24px;
		border-radius: var(--radius-lg);
		font-size: 0.95rem;
		font-weight: 600;
		background: var(--bg-elevated);
		border: 1px solid var(--border-glass);
		color: var(--text-primary);
		text-decoration: none;
		cursor: pointer;
		min-height: 50px;
		transition: background 0.15s, border-color 0.15s, transform 0.1s;
	}

	.auth-btn:hover {
		background: var(--bg-surface);
		border-color: var(--accent);
	}

	.auth-btn:active {
		transform: scale(0.98);
	}

	.auth-btn-icon {
		font-size: 1.2rem;
	}

	.auth-legal {
		margin-top: 24px;
		font-size: 0.72rem;
		color: var(--text-muted);
		line-height: 1.5;
	}

	.auth-legal a {
		color: var(--accent-light);
		text-decoration: none;
	}

	.auth-legal a:hover {
		text-decoration: underline;
	}
</style>
