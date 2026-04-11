<script lang="ts">
	import { dismissLanding } from '$stores/ui';

	function enter() {
		dismissLanding();
	}
</script>

<div class="landing-gate">
	<div class="landing-content">
		<img class="landing-logo" src="/icons/icon.svg" alt="Ride" />
		<h1 class="landing-title wordmark-shimmer">Ride</h1>
		<p class="landing-tagline">Your roads.<br/>Your stories.<br/>Your way.</p>

		<div class="landing-features">
			<div class="feature">
				<span class="feature-icon">🗺️</span>
				<span>Interactive route planning</span>
			</div>
			<div class="feature">
				<span class="feature-icon">📓</span>
				<span>Trip journals with photos</span>
			</div>
			<div class="feature">
				<span class="feature-icon">🧭</span>
				<span>Real-time ride navigation</span>
			</div>
		</div>

		<button class="btn-primary landing-cta" onclick={enter}>
			Get Started
		</button>

		<div class="landing-links">
			<a href="https://github.com/Ride-App" target="_blank" rel="noopener">Open Source</a>
			<span class="dot">·</span>
			<a href="/about.html" target="_blank">About</a>
			<span class="dot">·</span>
			<a href="/privacy.html" target="_blank">Privacy</a>
		</div>
	</div>
</div>

<style>
	.landing-gate {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-base);
		z-index: 600;
		padding: 20px;
		overflow-y: auto;
	}

	.landing-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		max-width: 400px;
		width: 100%;
		animation: fadeSlideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@keyframes fadeSlideUp {
		from { opacity: 0; transform: translateY(24px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.landing-logo {
		width: 110px;
		height: 110px;
		border-radius: 26px;
		margin-bottom: 20px;
		filter: drop-shadow(0 0 40px rgba(99, 102, 241, 0.3));
		animation: float 4s ease-in-out infinite;
	}

	@keyframes float {
		0%, 100% { transform: translateY(0px); }
		50% { transform: translateY(-8px); }
	}

	.landing-title {
		font-family: var(--font-serif);
		font-size: 3.4rem;
		font-style: italic;
		font-weight: 700;
		line-height: 1;
		margin-bottom: 12px;
	}

	.landing-tagline {
		font-size: 1.15rem;
		color: var(--text-secondary);
		line-height: 1.6;
		margin-bottom: 28px;
	}

	.landing-features {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 32px;
		width: 100%;
	}

	.feature {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		border-radius: var(--radius-lg);
		background: var(--bg-surface);
		border: 1px solid var(--border-glass);
		font-size: 0.9rem;
		color: var(--text-secondary);
	}

	.feature-icon {
		font-size: 1.3rem;
		flex-shrink: 0;
	}

	.landing-cta {
		width: 100%;
		padding: 16px;
		font-size: 1.05rem;
		margin-bottom: 20px;
	}

	.landing-links {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.75rem;
	}

	.landing-links a {
		color: var(--accent-light);
		text-decoration: none;
	}

	.landing-links a:hover {
		text-decoration: underline;
	}

	.dot {
		color: var(--text-muted);
	}
</style>
