<script lang="ts">
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import { browser } from '$app/environment';
	import {
		Boxes,
		ChevronDown,
		ChevronUp,
		ChevronsUpDown,
		Download,
		File,
		FileSymlink,
		Folder,
		FolderUp
	} from 'lucide-svelte';
	import { apiBase, apiFetch } from '$lib/stores/api';
	import {
		formatFileSize,
		sortPodEntries,
		type PodFileEntry,
		type PodFileSort
	} from '$lib/utils/pod-files';
	import type { Pod } from '$lib/types/deployment';
	import { getNewestPod, podLabel } from './deployment-helpers';
	import Alert from '$lib/components/ui/Alert.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import SelectTrigger from '$lib/components/ui/SelectTrigger.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import Table, { type TableColumn } from '$lib/components/ui/Table.svelte';

	type Entry = PodFileEntry;

	interface Listing {
		path: string;
		entries: Entry[];
	}

	let {
		deploymentId,
		namespace,
		pods = [],
		active = true
	}: {
		deploymentId: string;
		namespace: string;
		pods?: Pod[];
		active?: boolean;
	} = $props();

	const runningPods = $derived(
		pods.filter((p) => ['running', 'ready'].includes(p.status?.toLowerCase() ?? ''))
	);

	let chosenPod = $state<string>('');
	const podName = $derived(
		runningPods.some((p) => p.name === chosenPod)
			? chosenPod
			: (getNewestPod(runningPods)?.name ?? '')
	);

	function podChoice(pod: Pod | undefined): string {
		if (!pod) return '';
		const container = pod.containers?.[0]?.name;
		return container ? `${podLabel(pod.name)} / ${container}` : podLabel(pod.name);
	}

	let path = $state('/');

	const segments = $derived(path.split('/').filter(Boolean));

	function childPath(dir: string, name: string): string {
		return dir === '/' ? `/${name}` : `${dir}/${name}`;
	}

	function parentOf(dir: string): string {
		const parts = dir.split('/').filter(Boolean);
		parts.pop();
		return '/' + parts.join('/');
	}

	function crumbPath(index: number): string {
		return '/' + segments.slice(0, index + 1).join('/');
	}

	const podContainer = $derived(
		runningPods.find((p) => p.name === podName)?.containers?.[0]?.name ?? ''
	);

	function query(extra: Record<string, string> = {}): string {
		const params = new URLSearchParams({ namespace, ...extra });
		for (const [key, value] of [...params]) if (!value) params.delete(key);
		return params.toString();
	}

	async function errorMessage(res: Response): Promise<string> {
		try {
			const body = await res.json();
			if (typeof body?.message === 'string') return body.message;
		} catch {
			return res.statusText || `Request failed (${res.status})`;
		}
		return res.statusText || `Request failed (${res.status})`;
	}

	const listingQuery = createQuery(() => ({
		queryKey: ['deployment-files', deploymentId, podName, path],
		queryFn: async (): Promise<Listing> => {
			const res = await apiFetch(
				`/apiv1/pods/${encodeURIComponent(podName)}/files?${query({ path, container: podContainer })}`
			);
			if (!res.ok) throw new Error(await errorMessage(res));
			return (await res.json()) as Listing;
		},
		enabled: active && !!deploymentId && !!podName,
		placeholderData: keepPreviousData,
		staleTime: 10_000,
		retry: false
	}));

	const listing = $derived(listingQuery.data as Listing | undefined);

	let sort = $state<PodFileSort | null>(null);

	const SMALL_QUERY = '(max-width: 40rem)';
	let narrow = $state(false);

	const activeSort = $derived(narrow && sort?.key === 'size' ? null : sort);

	function cycleSort(key: PodFileSort['key']) {
		if (sort?.key !== key) sort = { key, dir: 'asc' };
		else if (sort.dir === 'asc') sort = { key, dir: 'desc' };
		else sort = null;
	}

	function sortLabel(key: PodFileSort['key']): string {
		if (activeSort?.key !== key) return `Sort by ${key}`;
		return activeSort.dir === 'asc' ? `Reverse sort by ${key}` : `Stop sorting by ${key}`;
	}

	const OVERSCAN = 12;
	let rowHeight = $state(44);
	let listEl = $state<HTMLDivElement | null>(null);
	let viewport = $state(0);
	let scrollTop = $state(0);

	$effect(() => {
		void path;
		scrollTop = 0;
		if (listEl) listEl.scrollTop = 0;
	});

	const windowRange = $derived.by(() => {
		const total = shownEntries.length;
		const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
		const end = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
		return { start, end: Math.max(start, end), total };
	});

	const visibleEntries = $derived(shownEntries.slice(windowRange.start, windowRange.end));

	$effect(() => {
		void visibleEntries;
		const height = listEl?.querySelector<HTMLElement>('.tr')?.getBoundingClientRect().height;
		if (height) rowHeight = height;
	});

	const shownEntries = $derived(sortPodEntries(listing?.entries ?? [], activeSort));
	const loadError = $derived(
		listingQuery.error && !listing ? (listingQuery.error as Error).message : null
	);

	$effect(() => {
		if (!browser) return;
		const mq = window.matchMedia(SMALL_QUERY);
		const sync = () => (narrow = mq.matches);
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	const columns = $derived<TableColumn<Entry>[]>(
		narrow
			? [{ id: 'name' }, { id: 'action', align: 'end', width: 'max-content' }]
			: [
					{ id: 'name' },
					{ id: 'size', align: 'end', numeric: true, width: '6rem' },
					{ id: 'action', align: 'end', width: '7rem' }
				]
	);

	function downloadHref(name: string): string {
		return `${$apiBase}/apiv1/pods/${encodeURIComponent(podName)}/files/download?${query({
			path: childPath(path, name),
			container: podContainer
		})}`;
	}

	let lastOpenAt = 0;

	function open(name: string) {
		if (listingQuery.isPlaceholderData) return;
		const now = Date.now();
		if (now - lastOpenAt < 600) return;
		lastOpenAt = now;
		path = childPath(path, name);
	}
</script>

<SectionCard title="Files">
	{#if runningPods.length === 0}
		<EmptyState title="No running pods" description="Files are read from a running pod." />
	{:else}
		<div class="files">
			<div class="toolbar">
				<Menu placement="bottom-start">
					{#snippet trigger(attrs, isOpen)}
						<SelectTrigger
							shape="capsule"
							{...attrs}
							open={isOpen}
							size="sm"
							mono
							value={podChoice(runningPods.find((p) => p.name === podName))}
							placeholder="Pick a pod"
						/>
					{/snippet}
					{#each runningPods as pod (pod.name)}
						<MenuItem
							icon={Boxes}
							checked={pod.name === podName}
							onclick={() => (chosenPod = pod.name)}
						>
							{podChoice(pod)}
						</MenuItem>
					{/each}
				</Menu>
				<div class="location">
					<Button
						variant="ghost"
						size="sm"
						icon={FolderUp}
						disabled={path === '/'}
						onclick={() => (path = parentOf(path))}
					>
						Up one level
					</Button>
					<nav class="crumbs" aria-label="Current folder">
						<Button variant="ghost" size="sm" onclick={() => (path = '/')}>/</Button>
						{#each segments as segment, i (i)}
							<Button variant="ghost" size="sm" onclick={() => (path = crumbPath(i))}>
								{segment}
							</Button>
						{/each}
					</nav>
				</div>
			</div>

			<div class="listing">
				<div class="head" class:head--narrow={narrow}>
					<button
						type="button"
						class="sort"
						aria-label={sortLabel('name')}
						onclick={() => cycleSort('name')}
					>
						<span>Name</span>
						{#if activeSort?.key === 'name' && activeSort.dir === 'asc'}
							<ChevronUp size={14} aria-hidden="true" />
						{:else if activeSort?.key === 'name'}
							<ChevronDown size={14} aria-hidden="true" />
						{:else}
							<ChevronsUpDown size={14} aria-hidden="true" class="sort-idle" />
						{/if}
					</button>
					{#if !narrow}
						<button
							type="button"
							class="sort sort--end"
							aria-label={sortLabel('size')}
							onclick={() => cycleSort('size')}
						>
							<span>Size</span>
							{#if activeSort?.key === 'size' && activeSort.dir === 'asc'}
								<ChevronUp size={14} aria-hidden="true" />
							{:else if activeSort?.key === 'size'}
								<ChevronDown size={14} aria-hidden="true" />
							{:else}
								<ChevronsUpDown size={14} aria-hidden="true" class="sort-idle" />
							{/if}
						</button>
					{/if}
					<span></span>
				</div>
				{#if loadError}
					<Alert tone="error" title="Could not read this folder">{loadError}</Alert>
				{:else if !listing}
					<div class="loading" aria-busy="true">
						<Skeleton height="2rem" />
						<Skeleton height="2rem" />
						<Skeleton height="2rem" />
					</div>
				{:else if listing.entries.length === 0}
					<EmptyState title="Empty folder" />
				{:else}
					<div
						class="list"
						bind:this={listEl}
						bind:clientHeight={viewport}
						onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
					>
						<div style:height="{windowRange.start * rowHeight}px"></div>
						<Table
							{columns}
							rows={visibleEntries}
							rowKey={(e: Entry) => e.name}
							onRowClick={(e: Entry) => open(e.name)}
							rowActive={(e: Entry) => e.kind === 'dir'}
							rowLabel={(e: Entry) => `Open ${e.name}`}
							inset={false}
							label="Files in {path}"
						>
							{#snippet cell(entry, col)}
								{#if col.id === 'name'}
									<span class="name" title={entry.name}>
										{#if entry.kind === 'dir'}
											<Folder size={16} aria-hidden="true" />
										{:else if entry.kind === 'symlink'}
											<FileSymlink size={16} aria-hidden="true" />
										{:else}
											<File size={16} aria-hidden="true" />
										{/if}
										<span>{entry.name}</span>
									</span>
								{:else if col.id === 'size'}
									<span class="muted">
										{#if entry.kind === 'other'}
											special file
										{:else if entry.kind === 'file' && entry.size != null}
											{formatFileSize(entry.size)}
										{/if}
									</span>
								{:else if (entry.kind === 'file' || entry.kind === 'symlink') && !listingQuery.isPlaceholderData}
									<a
										class="download"
										href={downloadHref(entry.name)}
										download={entry.name}
										aria-label={narrow ? `Download ${entry.name}` : undefined}
										title={narrow ? `Download ${entry.name}` : undefined}
									>
										<Download size={14} aria-hidden="true" />
										{#if !narrow}<span>Download</span>{/if}
									</a>
								{/if}
							{/snippet}
						</Table>
						<div style:height="{(windowRange.total - windowRange.end) * rowHeight}px"></div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</SectionCard>

<style>
	.files {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
	}

	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
	}

	.listing {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 6rem 7rem;
		align-items: center;
		padding: 0.5rem 1rem;
		background: color-mix(in oklab, var(--bg-sunken) 88%, var(--text-default));
		border-radius: 0.875rem;
		color: var(--text-muted);
		font-size: 0.8125rem;
		font-weight: 550;
	}

	.head--narrow {
		grid-template-columns: minmax(0, 1fr) max-content;
	}

	.sort {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		justify-self: start;
		padding: 0.125rem 0.25rem;
		margin-inline: -0.25rem;
		border: 0;
		border-radius: 0.375rem;
		background: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.sort--end {
		justify-self: end;
		margin-inline: -0.25rem 1rem;
	}

	.sort:hover {
		color: var(--text-default);
		background: var(--bg-hover);
	}

	.sort:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 1px;
	}

	.sort :global(.sort-idle) {
		opacity: 0.5;
	}

	.list {
		background: var(--bg-sunken);
		border-radius: 0.875rem;
		max-height: 32rem;
		overflow-x: hidden;
		overflow-y: auto;
	}

	.list :global(.tr--interactive:hover::after) {
		background: var(--bg-active);
	}

	.loading {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.name {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		max-width: 100%;
		color: var(--text-default, inherit);
	}

	.name > span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.muted {
		color: var(--text-muted, inherit);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		padding-inline-end: 1.5rem;
	}

	.download {
		white-space: nowrap;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--accent, inherit);
		text-decoration: none;
	}

	.download:hover {
		text-decoration: underline;
	}

	.location {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}
</style>
