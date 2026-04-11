<script lang="ts">
	import { currentTrip, deleteJournalEntry } from '$stores/trip';
	import { openModal } from '$stores/ui';
	import type { JournalEntry } from '$types';

	const trip = $derived($currentTrip);
	const entries = $derived(
		((trip?.journalEntries ?? trip?.journal) ?? []).slice().sort(
			(a, b) => new Date(b.createdAt ?? b.created_at ?? 0).getTime() - new Date(a.createdAt ?? a.created_at ?? 0).getTime()
		)
	);

	function formatDate(d: string | undefined) {
		if (!d) return '';
		return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function confirmDelete(entry: JournalEntry) {
		if (confirm(`Delete "${entry.title}"?`)) {
			deleteJournalEntry(entry.id);
		}
	}
</script>

<div class="journal-view">
	<div class="view-header">
		<h2>Journal</h2>
		<span class="count-badge">{entries.length}</span>
		<button class="btn-primary small" onclick={() => openModal('addJournal')}>+ Note</button>
	</div>

	{#if entries.length === 0}
		<div class="empty-state">
			<svg viewBox="0 0 24 24"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
			<h3>No journal entries</h3>
			<p>Capture thoughts, photos, and memories from your trip</p>
		</div>
	{:else}
		<div class="journal-list">
			{#each entries as entry (entry.id)}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<article class="journal-card" onclick={() => openModal('editJournal', entry)}>
					{#if entry.attachments?.length}
						<div class="card-thumb">
							<img src={entry.attachments[0].url} alt="" loading="lazy" />
						</div>
					{/if}
					<div class="card-body">
						<h3 class="card-title">{entry.title || 'Untitled'}</h3>
						{#if entry.content}
							<p class="card-excerpt">{entry.content.slice(0, 120)}{entry.content.length > 120 ? '…' : ''}</p>
						{/if}
						<div class="card-meta">
							<span class="card-date">{formatDate(entry.createdAt ?? entry.created_at)}</span>
							{#if entry.tags?.length}
								<div class="card-tags">
									{#each entry.tags as tag}
										<span class="tag">{tag}</span>
									{/each}
								</div>
							{/if}
							{#if entry.isPrivate}
								<span class="private-badge">Private</span>
							{/if}
						</div>
					</div>
					<button class="icon-btn card-delete" onclick={(e) => { e.stopPropagation(); confirmDelete(entry); }} aria-label="Delete">
						<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
					</button>
				</article>
			{/each}
		</div>
	{/if}
</div>

<style>
	.journal-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow-y: auto;
		padding: 16px;
		gap: 12px;
	}

	.view-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.view-header h2 { font-size: 1.15rem; font-weight: 600; color: var(--text-primary); }

	.view-header .btn-primary.small {
		margin-left: auto;
		padding: 6px 14px;
		font-size: 0.78rem;
	}

	.count-badge {
		padding: 2px 8px; border-radius: 10px;
		background: var(--bg-elevated); color: var(--text-muted);
		font-size: 0.72rem; font-weight: 600;
	}

	.empty-state {
		flex: 1; display: flex; flex-direction: column;
		align-items: center; justify-content: center; text-align: center;
		color: var(--text-muted); padding: 40px 20px;
	}
	.empty-state svg { width: 48px; height: 48px; fill: var(--text-muted); opacity: 0.4; margin-bottom: 12px; }
	.empty-state h3 { font-size: 1rem; margin-bottom: 6px; color: var(--text-secondary); }
	.empty-state p { font-size: 0.82rem; max-width: 260px; }

	.journal-list { display: flex; flex-direction: column; gap: 10px; }

	.journal-card {
		display: flex;
		gap: 12px;
		padding: 12px;
		border-radius: var(--radius-lg);
		background: var(--bg-surface);
		border: 1px solid var(--border-glass);
		cursor: pointer;
		transition: background 0.15s;
		position: relative;
	}
	.journal-card:hover { background: var(--bg-elevated); }

	.card-thumb {
		width: 64px; height: 64px; flex-shrink: 0;
		border-radius: var(--radius-md); overflow: hidden;
	}
	.card-thumb img { width: 100%; height: 100%; object-fit: cover; }

	.card-body { flex: 1; min-width: 0; }
	.card-title { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; }
	.card-excerpt { font-size: 0.78rem; color: var(--text-secondary); line-height: 1.4; margin-bottom: 6px; }

	.card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.card-date { font-size: 0.68rem; color: var(--text-muted); }
	.card-tags { display: flex; gap: 4px; }
	.tag {
		padding: 1px 6px; border-radius: 4px;
		background: var(--bg-elevated); color: var(--text-muted);
		font-size: 0.62rem; font-weight: 500;
	}
	.private-badge {
		padding: 1px 6px; border-radius: 4px;
		background: rgba(248, 81, 73, 0.15); color: var(--red);
		font-size: 0.62rem; font-weight: 600;
	}

	.card-delete {
		position: absolute; top: 8px; right: 8px;
		opacity: 0; transition: opacity 0.15s;
	}
	.journal-card:hover .card-delete { opacity: 1; }
</style>
