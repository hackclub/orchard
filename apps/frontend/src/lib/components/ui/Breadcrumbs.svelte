<script lang="ts">
	import { ChevronRight } from 'lucide-svelte';
	import type { Icon } from './types';

	interface Crumb {
		label: string;
		href?: string;
		icon?: Icon;
	}

	let {
		crumbs,
		label = 'Breadcrumb',
		mono = false
	}: { crumbs: Crumb[]; label?: string; mono?: boolean } = $props();
</script>

<nav class="crumbs" class:crumbs--mono={mono} aria-label={label}>
	<ol class="trail">
		{#each crumbs as crumb, i (i)}
			{@const last = i === crumbs.length - 1}
			<li class="item">
				{#if i > 0}
					<span class="sep" aria-hidden="true"><ChevronRight size={14} strokeWidth={2} /></span>
				{/if}
				{#if crumb.href && !last}
					<a href={crumb.href} class="crumb crumb--link">
						{#if crumb.icon}
							{@const Glyph = crumb.icon}
							<Glyph size={14} aria-hidden="true" />
						{/if}
						<span class="text">{crumb.label}</span>
					</a>
				{:else}
					<span class="crumb" class:crumb--current={last} aria-current={last ? 'page' : undefined}>
						{#if crumb.icon}
							{@const Glyph = crumb.icon}
							<Glyph size={14} aria-hidden="true" />
						{/if}
						<span class="text">{crumb.label}</span>
					</span>
				{/if}
			</li>
		{/each}
	</ol>
</nav>

<style>
	.crumbs {
		min-width: 0;
	}
	.crumbs--mono .crumb {
		font-family: var(--font-mono);
		font-size: var(--text-callout);
	}
	.trail {
		display: flex;
		align-items: center;
		min-width: 0;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.item {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		min-width: 0;
	}
	.item:last-child {
		flex-shrink: 1;
	}
	.sep {
		display: flex;
		flex-shrink: 0;
		margin: 0 0.125rem;
		color: var(--text-faint);
		opacity: 0.8;
	}
	.crumb {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		height: 1.75rem;
		padding: 0 0.375rem;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		color: var(--text-muted);
		font-size: var(--text-body);
		font-weight: var(--weight-regular);
		text-decoration: none;
	}
	.item:first-child .crumb {
		margin-left: -0.375rem;
	}
	.crumb--link {
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.crumb--link:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}
	.item:last-child .text {
		max-width: none;
	}
	.crumb--current {
		color: var(--text-default);
		font-weight: var(--weight-medium);
	}
	.crumb :global(svg) {
		flex-shrink: 0;
		color: var(--text-faint);
	}
	.crumb--current :global(svg) {
		color: var(--text-muted);
	}
	.text {
		display: block;
		min-width: 0;
		max-width: 12rem;
		overflow-x: clip;
		padding-block: 0.3em;
		margin-block: -0.3em;
		white-space: nowrap;
		text-overflow: ellipsis;
		text-box: trim-both cap alphabetic;
	}
</style>
