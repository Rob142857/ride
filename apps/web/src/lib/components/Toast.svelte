<script lang="ts">
	import { uiState } from '$stores/ui';
</script>

<div class="toast-container" aria-live="polite">
	{#each $uiState.toasts as toast (toast.id)}
		<div class="toast toast-{toast.type}" role="alert">
			<span class="toast-msg">{toast.text}</span>
		</div>
	{/each}
</div>

<style>
	.toast-container {
		position: fixed;
		bottom: calc(var(--footer-height) + var(--safe-bottom) + 12px);
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		gap: 8px;
		z-index: 900;
		pointer-events: none;
		width: min(90vw, 400px);
	}

	.toast {
		padding: 12px 20px;
		border-radius: var(--radius-lg);
		backdrop-filter: blur(20px);
		font-size: 0.85rem;
		font-weight: 500;
		text-align: center;
		animation: toastIn 0.3s ease, toastOut 0.3s ease 2.7s forwards;
		pointer-events: auto;
	}

	.toast-success {
		background: rgba(63, 185, 80, 0.9);
		color: #fff;
	}

	.toast-error {
		background: rgba(248, 81, 73, 0.9);
		color: #fff;
	}

	.toast-info {
		background: rgba(99, 102, 241, 0.9);
		color: #fff;
	}

	@keyframes toastIn {
		from { opacity: 0; transform: translateY(12px) scale(0.95); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}

	@keyframes toastOut {
		from { opacity: 1; transform: translateY(0) scale(1); }
		to { opacity: 0; transform: translateY(-8px) scale(0.95); }
	}
</style>
