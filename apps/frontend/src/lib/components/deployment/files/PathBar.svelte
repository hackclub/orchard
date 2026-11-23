<script lang="ts">
	import { tick } from 'svelte';
	import { HardDrive, Pencil } from 'lucide-svelte';
	import Breadcrumbs from '$lib/components/ui/Breadcrumbs.svelte';
	import Input from '$lib/components/ui/Input.svelte';
	import { pathSegments, resolvePath } from '$lib/utils/pod-files';

	let {
		path,
		hrefFor,
		onnavigate
	}: {
		path: string;
		hrefFor: (path: string) => string;
		onnavigate: (path: string) => void;
	} = $props();

	let editing = $state(false);
	let draft = $state('');
	let invalid = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);
	let trailEl = $state<HTMLDivElement | null>(null);

	const crumbs = $derived([
		{ label: '/', href: hrefFor('/'), icon: HardDrive },
		...pathSegments(path).map((s) => ({ label: s.name, href: hrefFor(s.path) }))
	]);

	$effect(() => {
		void crumbs;
		if (trailEl) trailEl.scrollLeft = trailEl.scrollWidth;
	});

	async function edit() {
		draft = path;
		invalid = false;
		editing = true;
		await tick();
		inputEl?.focus();
		inputEl?.select();
	}

	function commit() {
		const next = resolvePath(draft, path);
		if (!next) {
			invalid = true;
			return;
		}
		editing = false;
		if (next !== path) onnavigate(next);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			commit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			editing = false;
		}
	}
</script>

{#if editing}
	<div class="bar bar--editing">
		<Input
			bind:element={inputEl}
			bind:value={draft}
			size="sm"
			shape="capsule"
			mono
			error={invalid}
			aria-label="Folder path"
			autocomplete="off"
			spellcheck={false}
			{onkeydown}
			oninput={() => (invalid = false)}
			onblur={() => (editing = false)}
		/>
	</div>
{:else}
	<div class="bar">
		<div
			class="trail"
			bind:this={trailEl}
			role="presentation"
			onclick={(e) => {
				if (!(e.target as HTMLElement).closest('a')) edit();
			}}
		>
			<Breadcrumbs {crumbs} label="Folder" mono />
		</div>
		<button type="button" class="edit" aria-label="Type a path" title="Type a path" onclick={edit}>
			<Pencil size={13} aria-hidden="true" />
		</button>
	</div>
{/if}

<style>
	.bar {
		display: flex;
		align-items: center;
		flex: 1 1 16rem;
		min-width: 0;
		height: 2rem;
		padding-inline: 0.75rem 0.25rem;
		border-radius: 999px;
		background: color-mix(in oklab, var(--neutral-10) 5%, transparent);
		box-shadow: inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 6%, transparent);
	}
	.bar--editing {
		padding: 0;
		background: none;
		box-shadow: none;
	}
	.trail {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
		cursor: text;
	}
	.trail::-webkit-scrollbar {
		display: none;
	}
	.trail :global(a) {
		cursor: pointer;
	}
	.edit {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		border: none;
		border-radius: 999px;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.edit:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}
	.edit:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
	}
</style>
