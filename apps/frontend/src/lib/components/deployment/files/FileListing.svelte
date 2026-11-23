<script lang="ts" module>
	export type RowAction = 'open' | 'download' | 'copy-path' | 'rename' | 'delete';
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import {
		ChevronDown,
		ChevronUp,
		ChevronsUpDown,
		Copy,
		Download,
		Eye,
		File,
		FileArchive,
		FileCode,
		FileImage,
		FileSymlink,
		FileText,
		FileWarning,
		Folder,
		FolderOpen,
		FolderSymlink,
		MoreHorizontal,
		PenLine,
		Trash2
	} from 'lucide-svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import Table, { type TableColumn } from '$lib/components/ui/Table.svelte';
	import {
		formatFileSize,
		isDanglingLink,
		isDownloadable,
		isHiddenName,
		isPreviewableImage,
		holdsMount,
		joinPath,
		languageFor,
		mountLabel,
		mountRootAt,
		opensAsFolder,
		type PodFileEntry,
		type PodFileSort,
		type PodMount
	} from '$lib/utils/pod-files';

	let {
		entries,
		path,
		mounts,
		sort = $bindable(null),
		selected = null,
		canWrite,
		readOnlyReason,
		busy = false,
		downloadHref,
		onopen,
		onaction,
		onup
	}: {
		entries: PodFileEntry[];
		path: string;
		mounts: PodMount[];
		sort?: PodFileSort | null;
		selected?: string | null;
		canWrite: boolean;
		readOnlyReason: string;
		busy?: boolean;
		downloadHref: (entry: PodFileEntry) => string;
		onopen: (entry: PodFileEntry) => void;
		onaction: (action: RowAction, entry: PodFileEntry) => void;
		onup: () => void;
	} = $props();

	let width = $state(800);
	const layout = $derived(width < 520 ? 'narrow' : width < 760 ? 'medium' : 'wide');

	const columns = $derived<TableColumn<PodFileEntry>[]>(
		layout === 'narrow'
			? [{ id: 'name' }, { id: 'size', width: '5rem' }, { id: 'menu', width: '2.5rem' }]
			: layout === 'medium'
				? [
						{ id: 'name' },
						{ id: 'size', width: '5.5rem' },
						{ id: 'modified', width: '6.5rem' },
						{ id: 'menu', width: '2.5rem' }
					]
				: [
						{ id: 'name' },
						{ id: 'size', width: '5.5rem' },
						{ id: 'modified', width: '6.5rem' },
						{ id: 'mode', width: '7.5rem' },
						{ id: 'owner', width: '6rem' },
						{ id: 'menu', width: '2.5rem' }
					]
	);
	const template = $derived(columns.map((c) => c.width ?? 'minmax(0, 1fr)').join(' '));

	function cycleSort(key: PodFileSort['key']) {
		if (sort?.key !== key) sort = { key, dir: key === 'name' ? 'asc' : 'desc' };
		else if (sort.dir === (key === 'name' ? 'asc' : 'desc'))
			sort = { key, dir: key === 'name' ? 'desc' : 'asc' };
		else sort = null;
	}

	function sortLabel(key: PodFileSort['key'], label: string): string {
		if (sort?.key !== key) return `Sort by ${label}`;
		return `Sorted by ${label}, ${sort.dir === 'asc' ? 'ascending' : 'descending'}`;
	}

	const OVERSCAN = 12;
	let rowHeight = $state(44);
	let listEl = $state<HTMLDivElement | null>(null);
	let viewport = $state(0);
	let scrollTop = $state(0);
	let listFocused = false;

	$effect(() => {
		void path;
		scrollTop = 0;
		if (listEl) listEl.scrollTop = 0;
		if (listFocused && document.activeElement === document.body)
			void tick().then(() => focusRow(0));
	});

	const windowRange = $derived.by(() => {
		const total = entries.length;
		const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
		const end = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
		return { start, end: Math.max(start, end), total };
	});

	const visibleEntries = $derived(entries.slice(windowRange.start, windowRange.end));

	$effect(() => {
		void visibleEntries;
		const height = listEl?.querySelector<HTMLElement>('.tr')?.getBoundingClientRect().height;
		if (height) rowHeight = height;
	});

	function iconFor(entry: PodFileEntry) {
		if (entry.kind === 'dir') return selected === entry.name ? FolderOpen : Folder;
		if (opensAsFolder(entry)) return FolderSymlink;
		if (entry.kind === 'symlink') return isDanglingLink(entry) ? FileWarning : FileSymlink;
		if (entry.kind === 'other') return File;
		if (isPreviewableImage(entry.name)) return FileImage;
		if (/\.(gz|tgz|zip|tar|xz|bz2|7z)$/i.test(entry.name)) return FileArchive;
		if (languageFor(entry.name)) return FileCode;
		if (/\.(txt|log|md)$/i.test(entry.name)) return FileText;
		return File;
	}

	function rowIndex(name: string) {
		return entries.findIndex((e) => e.name === name);
	}

	async function focusRow(index: number) {
		if (!listEl || index < 0 || index >= entries.length) return;
		const top = index * rowHeight;
		if (top < listEl.scrollTop) listEl.scrollTop = top;
		else if (top + rowHeight > listEl.scrollTop + listEl.clientHeight)
			listEl.scrollTop = top + rowHeight - listEl.clientHeight;
		scrollTop = listEl.scrollTop;
		await tick();
		const label = `Open ${entries[index].name}`;
		const hit = [...listEl.querySelectorAll<HTMLButtonElement>('button.hit')].find(
			(b) => b.getAttribute('aria-label') === label
		);
		hit?.focus();
	}

	function focusedName(): string | null {
		const el = document.activeElement as HTMLElement | null;
		const label = el?.closest('button.hit')?.getAttribute('aria-label');
		return label?.startsWith('Open ') ? label.slice(5) : null;
	}

	export function focusFirst() {
		const at = selected ? rowIndex(selected) : -1;
		void focusRow(at >= 0 ? at : 0);
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.target as HTMLElement).closest('[role="menu"], input, textarea')) return;
		const name = focusedName();
		const at = name ? rowIndex(name) : -1;
		const entry = at >= 0 ? entries[at] : null;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				void focusRow(Math.min(entries.length - 1, at + 1));
				break;
			case 'ArrowUp':
				e.preventDefault();
				void focusRow(Math.max(0, at - 1));
				break;
			case 'Home':
				e.preventDefault();
				void focusRow(0);
				break;
			case 'End':
				e.preventDefault();
				void focusRow(entries.length - 1);
				break;
			case 'Backspace':
				e.preventDefault();
				onup();
				break;
			case 'Delete':
				if (entry && canWrite && !holdsMount(joinPath(path, entry.name), mounts)) {
					e.preventDefault();
					onaction('delete', entry);
				}
				break;
			case 'F2':
				if (entry && canWrite && !holdsMount(joinPath(path, entry.name), mounts)) {
					e.preventDefault();
					onaction('rename', entry);
				}
				break;
		}
	}
</script>

<div class="listing" bind:clientWidth={width}>
	<div class="head" style:grid-template-columns={template}>
		{#each columns as col (col.id)}
			<div class="hcell" class:hcell--end={col.id === 'size'}>
				{#if col.id === 'name' || col.id === 'size' || col.id === 'modified'}
					{@const key = col.id === 'name' ? 'name' : col.id === 'size' ? 'size' : 'modified'}
					{@const label = col.id === 'name' ? 'Name' : col.id === 'size' ? 'Size' : 'Modified'}
					<button
						type="button"
						class="sort"
						class:sort--on={sort?.key === key}
						aria-label={sortLabel(key, label.toLowerCase())}
						onclick={() => cycleSort(key)}
					>
						<span>{label}</span>
						{#if sort?.key === key && sort.dir === 'asc'}
							<ChevronUp size={14} aria-hidden="true" />
						{:else if sort?.key === key}
							<ChevronDown size={14} aria-hidden="true" />
						{:else}
							<ChevronsUpDown size={14} aria-hidden="true" class="sort-idle" />
						{/if}
					</button>
				{:else if col.id === 'mode'}
					<span>Permissions</span>
				{:else if col.id === 'owner'}
					<span>Owner</span>
				{/if}
			</div>
		{/each}
	</div>

	<div
		class="list"
		class:list--busy={busy}
		bind:this={listEl}
		bind:clientHeight={viewport}
		onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
		{onkeydown}
		onfocusin={() => (listFocused = true)}
		onfocusout={(e) => {
			const next = e.relatedTarget as Node | null;
			if (next && !e.currentTarget.contains(next)) listFocused = false;
		}}
		role="presentation"
	>
		<div style:height="{windowRange.start * rowHeight}px"></div>
		<Table
			{columns}
			rows={visibleEntries}
			rowKey={(e: PodFileEntry) => e.name}
			onRowClick={(e: PodFileEntry) => onopen(e)}
			rowSelected={(e: PodFileEntry) => e.name === selected}
			rowLabel={(e: PodFileEntry) => `Open ${e.name}`}
			inset={false}
			label="Files in {path}"
		>
			{#snippet cell(entry, col)}
				{@const mount = mountRootAt(joinPath(path, entry.name), mounts)}
				{@const pinned = !mount && holdsMount(joinPath(path, entry.name), mounts)}
				{#if col.id === 'name'}
					{@const Glyph = iconFor(entry)}
					<span class="name" class:name--dim={isDanglingLink(entry) || isHiddenName(entry.name)}>
						<span class="glyph" class:glyph--folder={opensAsFolder(entry)}>
							<Glyph size={16} aria-hidden="true" />
						</span>
						<span class="label-text" title={entry.name}>{entry.name}</span>
						{#if entry.kind === 'symlink' && entry.linkTo && layout !== 'narrow'}
							<span class="link" title="{entry.linkTo}{isDanglingLink(entry) ? ' (missing)' : ''}">
								<span aria-hidden="true">→</span>
								<span class="sr-only">links to</span>
								{entry.linkTo}
							</span>
							{#if isDanglingLink(entry)}<span class="missing">missing</span>{/if}
						{/if}
						{#if mount}
							<span class="badge"><Badge>{mountLabel(mount.type)}</Badge></span>
						{/if}
					</span>
				{:else if col.id === 'size'}
					<span class="num">
						{#if entry.kind === 'other'}
							special
						{:else if entry.size != null && !opensAsFolder(entry)}
							{formatFileSize(entry.size)}
						{/if}
					</span>
				{:else if col.id === 'modified'}
					<span class="muted"
						>{#if entry.mtime}<RelativeTime date={entry.mtime * 1000} />{/if}</span
					>
				{:else if col.id === 'mode'}
					<span class="mono">{entry.mode ?? ''}</span>
				{:else if col.id === 'owner'}
					<span class="muted ellipsis" title={entry.owner ?? ''}
						>{entry.owner ?? ''}{#if entry.group && entry.group !== entry.owner}<span class="faint"
								>:{entry.group}</span
							>{/if}</span
					>
				{:else}
					<span class="row-menu">
						<Menu placement="bottom-end">
							{#snippet trigger(attrs, isOpen)}
								<button
									type="button"
									class="more"
									class:more--open={isOpen}
									aria-label="Actions for {entry.name}"
									{...attrs}
								>
									<MoreHorizontal size={16} aria-hidden="true" />
								</button>
							{/snippet}
							{#if opensAsFolder(entry)}
								<MenuItem icon={FolderOpen} onclick={() => onaction('open', entry)}>Open</MenuItem>
								<MenuItem icon={Download} onclick={() => onaction('download', entry)}>
									Download as .tar.gz
								</MenuItem>
							{:else}
								<MenuItem
									icon={Eye}
									disabled={!isDownloadable(entry)}
									onclick={() => onaction('open', entry)}
								>
									Preview
								</MenuItem>
								<MenuItem
									icon={Download}
									disabled={!isDownloadable(entry)}
									href={isDownloadable(entry) ? downloadHref(entry) : undefined}
									download={entry.name}
								>
									Download
								</MenuItem>
							{/if}
							<MenuItem icon={Copy} onclick={() => onaction('copy-path', entry)}>Copy path</MenuItem
							>
							<MenuSeparator />
							<MenuItem
								icon={PenLine}
								shortcut="F2"
								disabled={!canWrite || !!mount || pinned}
								description={mount
									? 'Mounted volume'
									: pinned
										? 'Holds a mounted volume'
										: !canWrite
											? readOnlyReason
											: undefined}
								onclick={() => onaction('rename', entry)}
							>
								Rename
							</MenuItem>
							<MenuItem
								icon={Trash2}
								shortcut="Del"
								danger
								disabled={!canWrite || !!mount || pinned}
								description={mount
									? 'Mounted volume'
									: pinned
										? 'Holds a mounted volume'
										: !canWrite
											? readOnlyReason
											: undefined}
								onclick={() => onaction('delete', entry)}
							>
								Delete
							</MenuItem>
						</Menu>
					</span>
				{/if}
			{/snippet}
		</Table>
		<div style:height="{(windowRange.total - windowRange.end) * rowHeight}px"></div>
	</div>
</div>

<style>
	.listing {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		min-height: 0;
	}
	.head {
		display: grid;
		align-items: center;
		min-height: 2.25rem;
		color: var(--text-muted);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
	}
	.hcell {
		display: flex;
		align-items: center;
		min-width: 0;
		padding: 0 0.75rem;
		white-space: nowrap;
	}
	.hcell:first-child {
		padding-left: 1rem;
	}
	.hcell:last-child {
		padding-right: 1rem;
	}
	.hcell--end {
		justify-content: flex-end;
	}
	.sort {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.5rem;
		padding: 0 0.375rem;
		margin-inline: -0.375rem;
		border: 0;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.hcell--end .sort {
		flex-direction: row-reverse;
	}
	.sort--on,
	.sort:hover {
		color: var(--text-default);
	}
	.sort:hover {
		background: var(--bg-hover);
	}
	.sort:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
	}
	.sort :global(.sort-idle) {
		opacity: 0.45;
	}
	.list {
		position: relative;
		min-height: 0;
		max-height: 30rem;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-sunken);
		transition: opacity var(--fade-in) var(--curve-out);
	}
	.list--busy {
		opacity: 0.6;
	}
	.list :global(.tr--interactive:hover::after) {
		background: var(--bg-active);
	}
	.list :global(.tr--selected::after) {
		background: color-mix(in oklab, var(--accent-7) 14%, var(--bg-surface));
	}
	.list :global(.hit:focus-visible) {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
		border-radius: calc(var(--radius-card) - 0.375rem);
	}
	.name {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		max-width: 100%;
		color: var(--text-default);
	}
	.name--dim .label-text {
		color: var(--text-muted);
	}
	.glyph {
		display: flex;
		flex-shrink: 0;
		color: var(--text-muted);
	}
	.glyph--folder {
		color: var(--text-default);
	}
	.label-text {
		flex-shrink: 1;
		min-width: 2rem;
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.link {
		flex-shrink: 2;
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
		font-family: var(--font-mono);
		font-size: var(--text-caption);
	}
	.missing {
		flex-shrink: 0;
		color: var(--status-error);
		font-size: var(--text-caption);
	}
	.badge {
		display: flex;
		flex-shrink: 0;
	}
	.num {
		width: 100%;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-align: end;
	}
	.muted {
		color: var(--text-muted);
		white-space: nowrap;
	}
	.faint {
		color: var(--text-faint);
	}
	.ellipsis {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
	}
	.mono {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		white-space: nowrap;
	}
	.row-menu {
		display: flex;
		margin-inline-start: auto;
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}
	.list :global(.tr:is(:hover, :has(:focus-visible), .tr--selected) .row-menu),
	.row-menu:has(.more--open) {
		opacity: 1;
	}
	.more {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border: none;
		border-radius: 999px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.more:hover,
	.more--open {
		background: var(--bg-hover);
		color: var(--text-default);
	}
	.more:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (hover: none) {
		.row-menu {
			opacity: 1;
		}
	}
</style>
