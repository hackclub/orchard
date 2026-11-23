<script lang="ts">
	import { Check, CircleAlert, RotateCcw, Upload, X } from 'lucide-svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Progress from '$lib/components/ui/Progress.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { formatFileSize } from '$lib/utils/pod-files';
	import { presence } from '$lib/utils/transitions';
	import type { UploadQueue } from './upload-queue.svelte';

	let { queue }: { queue: UploadQueue } = $props();

	const total = $derived(queue.items.filter((i) => i.status !== 'canceled').length);
	const done = $derived(queue.count('done'));
	const failed = $derived(queue.count('failed'));
	const conflicts = $derived(queue.count('conflict'));
	const percent = $derived(Math.round(queue.progress * 100));

	const title = $derived.by(() => {
		if (queue.active)
			return `Uploading ${total === 1 ? '1 file' : `${total} files`} to ${queue.dir}`;
		if (failed) return `${failed} of ${total} ${total === 1 ? 'upload' : 'uploads'} failed`;
		if (conflicts) return `${conflicts} ${conflicts === 1 ? 'file is' : 'files are'} already there`;
		return `Uploaded ${done === 1 ? '1 file' : `${done} files`} to ${queue.dir}`;
	});

	const shown = $derived(
		[...queue.items]
			.filter((i) => i.status !== 'canceled')
			.sort((a, b) => order(a.status) - order(b.status))
			.slice(0, 50)
	);

	function order(status: string) {
		return ['uploading', 'failed', 'conflict', 'waiting', 'done'].indexOf(status);
	}
</script>

<section class="tray" aria-label="Uploads" aria-live="polite">
	<header class="top">
		<span class="lead" aria-hidden="true">
			{#if queue.active}<Upload size={16} />{:else if failed}<CircleAlert size={16} />{:else}<Check
					size={16}
				/>{/if}
		</span>
		<div class="summary">
			<p class="title" {title}>{title}</p>
			{#if queue.active}
				<Progress value={percent} size="sm" label="Upload progress" labelHidden />
			{/if}
		</div>
		{#if queue.active}
			<span class="pct">{percent}%</span>
			<span class="trail"
				><Button size="sm" shape="capsule" variant="ghost" onclick={() => queue.cancel()}
					>Cancel</Button
				></span
			>
		{:else}
			<button
				type="button"
				class="icon-btn icon-btn--trail"
				aria-label="Dismiss uploads"
				onclick={() => queue.clear()}
			>
				<X size={14} aria-hidden="true" />
			</button>
		{/if}
	</header>
	<ul class="rows">
		{#each shown as item (item.id)}
			<li class="row" in:presence out:presence>
				<span class="state" aria-hidden="true">
					{#if item.status === 'uploading'}
						<Spinner size={12} />
					{:else if item.status === 'done'}
						<Check size={13} />
					{:else if item.status === 'failed'}
						<CircleAlert size={13} />
					{:else}
						<span class="dot"></span>
					{/if}
				</span>
				<span class="file" title={item.target}>{item.name}</span>
				{#if item.status === 'failed'}
					<span class="err" title={item.error ?? ''}>{item.error}</span>
					<button
						type="button"
						class="icon-btn"
						aria-label="Retry {item.name}"
						onclick={() => queue.retry(item.id)}
					>
						<RotateCcw size={13} aria-hidden="true" />
					</button>
				{:else if item.status === 'conflict'}
					<span class="note">Already exists</span>
				{:else if item.status === 'uploading'}
					<span class="bar"
						><Progress
							value={item.sent}
							max={item.size || 1}
							size="sm"
							labelHidden
							label="Progress of {item.name}"
						/></span
					>
					<span class="size">{formatFileSize(item.sent)} of {formatFileSize(item.size)}</span>
				{:else}
					<span class="size">{formatFileSize(item.size)}</span>
				{/if}
			</li>
		{/each}
	</ul>
</section>

<style>
	.tray {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		border-radius: calc(var(--section-r, var(--radius-card)) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.lead {
		display: flex;
		flex-shrink: 0;
		color: var(--text-muted);
	}
	.summary {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		flex: 1;
		min-width: 0;
	}
	.title {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.pct {
		flex-shrink: 0;
		min-width: 2.5rem;
		text-align: end;
		color: var(--text-muted);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
	}
	.trail {
		display: flex;
		margin-right: -0.625rem;
	}
	.icon-btn--trail {
		margin-right: -0.3125rem;
	}
	.rows {
		display: flex;
		flex-direction: column;
		max-height: 10rem;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 1.75rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}
	.state {
		display: flex;
		justify-content: center;
		flex-shrink: 0;
		width: 1rem;
		color: var(--text-faint);
	}
	.row:has(.err) .state {
		color: var(--status-error);
	}
	.dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 999px;
		background: var(--border-strong);
	}
	.file {
		flex: 1;
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		color: var(--text-default);
	}
	.bar {
		flex: 0 1 8rem;
		min-width: 3rem;
	}
	.size,
	.note {
		flex-shrink: 0;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.err {
		flex: 0 1 auto;
		min-width: 0;
		max-width: 50%;
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--status-error);
	}
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		border: none;
		border-radius: 999px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}
	.icon-btn:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}
	.icon-btn:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
	}
</style>
