<script lang="ts">
	import { createQuery, keepPreviousData, useQueryClient } from '@tanstack/svelte-query';
	import { browser } from '$app/environment';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		ArrowUp,
		Boxes,
		ChevronDown,
		Eye,
		EyeOff,
		FileUp,
		FolderPlus,
		FolderUp,
		HardDrive,
		Lock,
		ScrollText,
		Timer,
		TerminalSquare,
		TriangleAlert,
		Upload
	} from 'lucide-svelte';
	import type { Pod } from '$lib/types/deployment';
	import { getNewestPod, podLabel } from './deployment-helpers';
	import Alert from '$lib/components/ui/Alert.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import SearchField from '$lib/components/ui/SearchField.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import SelectTrigger from '$lib/components/ui/SelectTrigger.svelte';
	import Sheet from '$lib/components/ui/Sheet.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import RenameModal from '$lib/components/RenameModal.svelte';
	import { toasts } from '$lib/stores/toast';
	import {
		describeFileError,
		filterPodEntries,
		folderStorage,
		hiddenCount,
		joinPath,
		mountLabel,
		opensAsFolder,
		parentPath,
		pathFromUrl,
		sortPodEntries,
		validFileName,
		type PodFileEntry,
		type PodFileSort,
		type PodListing
	} from '$lib/utils/pod-files';
	import FileListing, { type RowAction } from './files/FileListing.svelte';
	import FilePreview from './files/FilePreview.svelte';
	import PathBar from './files/PathBar.svelte';
	import UploadTray from './files/UploadTray.svelte';
	import { UploadQueue } from './files/upload-queue.svelte';
	import { carriesFiles, collectDrop, collectInput } from './files/collect-files';
	import {
		deleteEntry,
		downloadArchive,
		downloadUrl,
		fileErrorOf,
		listFolder,
		makeFolder,
		moveEntry,
		type PodTarget
	} from './files/pod-files-client';

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

	const queryClient = useQueryClient();

	const runningPods = $derived(
		pods.filter((p) => ['running', 'ready'].includes(p.status?.toLowerCase() ?? ''))
	);

	let chosenPod = $state<string>('');
	const podName = $derived(
		runningPods.some((p) => p.name === chosenPod)
			? chosenPod
			: (getNewestPod(runningPods)?.name ?? '')
	);
	const podContainer = $derived(
		runningPods.find((p) => p.name === podName)?.containers?.[0]?.name ?? ''
	);
	const target = $derived<PodTarget>({ pod: podName, namespace, container: podContainer });

	const path = $derived(pathFromUrl($page.url.searchParams.get('path')));
	const selectedName = $derived($page.url.searchParams.get('file'));

	function hrefFor(next: { path?: string; file?: string | null }): string {
		const url = new URL($page.url);
		url.searchParams.set('tab', 'files');
		const p = next.path ?? path;
		if (p === '/') url.searchParams.delete('path');
		else url.searchParams.set('path', p);
		const file = 'file' in next ? next.file : selectedName;
		if (file) url.searchParams.set('file', file);
		else url.searchParams.delete('file');
		return url.pathname + url.search;
	}

	function navigate(next: string) {
		void goto(hrefFor({ path: next, file: null }), { noScroll: true, keepFocus: true });
	}

	function select(name: string | null) {
		void goto(hrefFor({ file: name }), { replaceState: true, noScroll: true, keepFocus: true });
	}

	const listingKey = $derived(['pod-files', deploymentId, podName, path]);

	const listingQuery = createQuery(() => ({
		queryKey: listingKey,
		queryFn: () => listFolder(target, path),
		enabled: active && !!deploymentId && !!podName,
		placeholderData: keepPreviousData,
		staleTime: 10_000,
		retry: false
	}));

	const listing = $derived(listingQuery.data as PodListing | undefined);
	const listingError = $derived(listingQuery.error ? fileErrorOf(listingQuery.error) : null);
	const noShell = $derived(listingError?.code === 'no_shell');
	const stale = $derived(listingQuery.isPlaceholderData);
	const current = $derived(listing && !stale ? listing : undefined);

	function refresh() {
		void queryClient.invalidateQueries({ queryKey: ['pod-files', deploymentId, podName] });
	}

	let filter = $state('');
	let showHidden = $state(false);
	let sort = $state<PodFileSort | null>(null);

	let lastPath = '';
	$effect(() => {
		if (path === lastPath) return;
		lastPath = path;
		filter = '';
	});

	const entries = $derived(listing?.entries ?? []);
	const shown = $derived(
		sortPodEntries(filterPodEntries(entries, { query: filter, showHidden }), sort)
	);
	const hidden = $derived(hiddenCount(entries));
	const mounts = $derived(listing?.mounts ?? []);
	const storage = $derived(
		listing ? folderStorage(listing.path, listing.mounts, listing.writable) : null
	);
	const canWrite = $derived(!!current && storage?.kind !== 'read-only');

	const readOnlyReason = $derived.by(() => {
		if (!storage || storage.kind !== 'read-only') return '';
		if (storage.mount?.type === 'config') return 'Config mounts are read-only';
		if (storage.mount?.type === 'secret') return 'Secret mounts are read-only';
		if (storage.mount?.readOnly) return 'This volume is mounted read-only';
		return "The app's user can't write here";
	});

	const saveHint = $derived.by(() => {
		if (!storage) return '';
		if (storage.kind === 'volume') return `Saved on volume ${storage.mount.volume}`;
		if (storage.kind === 'temporary') return 'Cleared when the pod restarts';
		if (storage.kind === 'container') return 'Lost when the pod restarts or redeploys';
		return '';
	});

	const selectedEntry = $derived(
		selectedName && listing ? (entries.find((e) => e.name === selectedName) ?? null) : null
	);
	const previewEntry = $derived(
		selectedEntry && !opensAsFolder(selectedEntry) ? selectedEntry : null
	);

	let width = $state(1000);
	const split = $derived(width >= 820);
	const compact = $derived(width < 560);

	let dirty = $state(false);
	let discardOpen = $state(false);
	let pendingDiscard: (() => void) | null = null;

	function guard(action: () => void) {
		if (!dirty) return action();
		pendingDiscard = action;
		discardOpen = true;
	}

	beforeNavigate((nav) => {
		if (!dirty || !nav.to) return;
		const to = nav.to.url;
		if (nav.type === 'leave') {
			nav.cancel();
			return;
		}
		const same =
			to.pathname === $page.url.pathname &&
			to.searchParams.get('tab') === 'files' &&
			pathFromUrl(to.searchParams.get('path')) === path &&
			to.searchParams.get('file') === selectedName;
		if (same) return;
		nav.cancel();
		const href = to.pathname + to.search;
		pendingDiscard = () => goto(href, { noScroll: true, keepFocus: true });
		discardOpen = true;
	});

	function discard() {
		dirty = false;
		const action = pendingDiscard;
		pendingDiscard = null;
		queueMicrotask(() => action?.());
	}

	$effect(() => {
		if (!browser || !dirty) return;
		const warn = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener('beforeunload', warn);
		return () => window.removeEventListener('beforeunload', warn);
	});

	let lastOpenAt = 0;

	function open(entry: PodFileEntry) {
		if (stale) return;
		if (opensAsFolder(entry)) {
			const now = Date.now();
			if (now - lastOpenAt < 400) return;
			lastOpenAt = now;
			navigate(joinPath(path, entry.name));
			return;
		}
		if (entry.name === selectedName) return;
		select(entry.name);
	}

	function goUp() {
		if (path !== '/') navigate(parentPath(path));
	}

	let renameTarget = $state<PodFileEntry | null>(null);
	let renameOpen = $state(false);
	let renaming = $state(false);
	let renameError = $state<string | null>(null);

	let newFolderOpen = $state(false);
	let creating = $state(false);
	let createError = $state<string | null>(null);

	let deleteTarget = $state<PodFileEntry | null>(null);
	let deleteOpen = $state(false);

	async function downloadFolder(entry: PodFileEntry) {
		const name = `${entry.name}.tar.gz`;
		const id = toasts.add({ title: `Packing ${name}`, color: 'loading' });
		try {
			const blob = await downloadArchive(target, joinPath(path, entry.name));
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = name;
			document.body.append(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 30_000);
			toasts.update(id, { title: `Downloaded ${name}`, color: 'success' });
		} catch (err) {
			toasts.update(id, {
				title: "Couldn't download the folder",
				description: describeFileError(fileErrorOf(err), 'download-folder'),
				color: 'error'
			});
		}
	}

	async function copyPath(entry: PodFileEntry) {
		try {
			await navigator.clipboard.writeText(joinPath(path, entry.name));
			toasts.add({ title: 'Path copied', color: 'success' });
		} catch {
			toasts.add({ title: "Couldn't copy the path", color: 'error' });
		}
	}

	function onaction(action: RowAction, entry: PodFileEntry) {
		switch (action) {
			case 'open':
				open(entry);
				break;
			case 'download':
				if (opensAsFolder(entry)) void downloadFolder(entry);
				break;
			case 'copy-path':
				void copyPath(entry);
				break;
			case 'rename':
				renameTarget = entry;
				renameError = null;
				renameOpen = true;
				break;
			case 'delete':
				deleteTarget = entry;
				deleteOpen = true;
				break;
		}
	}

	async function rename(name: string) {
		const entry = renameTarget;
		if (!entry) return;
		renaming = true;
		renameError = null;
		try {
			await moveEntry(target, joinPath(path, entry.name), joinPath(path, name));
			renameOpen = false;
			refresh();
			if (selectedName === entry.name) select(name);
			toasts.add({ title: 'Renamed', color: 'success' });
		} catch (err) {
			renameError = describeFileError(fileErrorOf(err), 'move');
		} finally {
			renaming = false;
		}
	}

	async function createFolder(name: string) {
		creating = true;
		createError = null;
		try {
			await makeFolder(target, joinPath(path, name));
			newFolderOpen = false;
			refresh();
			toasts.add({ title: 'Folder created', color: 'success' });
		} catch (err) {
			createError = describeFileError(fileErrorOf(err), 'mkdir');
		} finally {
			creating = false;
		}
	}

	async function remove() {
		const entry = deleteTarget;
		if (!entry) return;
		try {
			await deleteEntry(target, joinPath(path, entry.name));
			if (selectedName === entry.name) {
				dirty = false;
				select(null);
			}
			refresh();
			toasts.add({ title: `Deleted ${entry.name}`, color: 'success' });
		} catch (err) {
			toasts.add({
				title: `Couldn't delete ${entry.name}`,
				description: describeFileError(fileErrorOf(err), 'delete'),
				color: 'error'
			});
		}
	}

	const deleteCopy = $derived.by(() => {
		const entry = deleteTarget;
		if (!entry) return { title: '', description: '', confirm: null as string | null };
		const folder = entry.kind === 'dir';
		const lasting = storage?.kind === 'volume';
		const after = lasting
			? "It is gone from the volume and can't be recovered."
			: storage?.kind === 'container'
				? 'Anything that came with the image returns on the next deploy.'
				: "This can't be undone.";
		return folder
			? {
					title: `Delete ${entry.name} and everything in it?`,
					description: `Every file and folder inside ${entry.name} is deleted. ${after}`,
					confirm: entry.name
				}
			: {
					title: `Delete ${entry.name}?`,
					description: entry.kind === 'symlink' ? `Only the link is removed. ${after}` : after,
					confirm: null
				};
	});

	let replaceOpen = $state(false);
	let replaceIds = $state<number[]>([]);
	let replaceNames = $state<string[]>([]);

	const queue = new UploadQueue(
		() => target,
		(q) => {
			refresh();
			const conflicts = q.conflicts;
			if (conflicts.length) {
				replaceIds = conflicts.map((c) => c.id);
				replaceNames = conflicts.map((c) => c.name);
				replaceOpen = true;
				return;
			}
			const failed = q.count('failed');
			const done = q.count('done');
			if (!failed && done) {
				toasts.add({
					title: done === 1 ? 'File uploaded' : `${done} files uploaded`,
					color: 'success'
				});
			}
		},
		() => refresh()
	);

	let fileInput = $state<HTMLInputElement | null>(null);
	let folderInput = $state<HTMLInputElement | null>(null);

	function onPicked(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		if (input.files?.length && canWrite) queue.add(collectInput(input.files, path));
		input.value = '';
	}

	let dragDepth = $state(0);
	const dragging = $derived(dragDepth > 0);

	function ondragenter(e: DragEvent) {
		if (!carriesFiles(e)) return;
		e.preventDefault();
		dragDepth += 1;
	}

	function ondragover(e: DragEvent) {
		if (!carriesFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = canWrite ? 'copy' : 'none';
	}

	function ondragleave(e: DragEvent) {
		if (!carriesFiles(e)) return;
		dragDepth = Math.max(0, dragDepth - 1);
	}

	async function ondrop(e: DragEvent) {
		if (!carriesFiles(e) || !e.dataTransfer) return;
		e.preventDefault();
		dragDepth = 0;
		if (!canWrite) return;
		const batch = await collectDrop(e.dataTransfer, path);
		if (batch.plan.files.length || batch.plan.folders.length) queue.add(batch);
	}

	let listingRef = $state<FileListing | null>(null);

	function closePreview() {
		guard(() => {
			dirty = false;
			select(null);
		});
	}

	function onsaved() {
		refresh();
	}

	function choosePod(name: string) {
		guard(() => (chosenPod = name));
	}
</script>

{#snippet headerActions()}
	{#if current && !noShell}
		{#if canWrite}
			<Button
				size="sm"
				shape="capsule"
				variant="ghost"
				icon={FolderPlus}
				onclick={() => {
					createError = null;
					newFolderOpen = true;
				}}
			>
				New folder
			</Button>
			<Menu placement="bottom-end">
				{#snippet trigger(attrs)}
					<Button size="sm" shape="capsule" icon={Upload} iconRight={ChevronDown} {...attrs}>
						Upload
					</Button>
				{/snippet}
				<MenuItem icon={FileUp} onclick={() => fileInput?.click()}>Files</MenuItem>
				<MenuItem icon={FolderUp} onclick={() => folderInput?.click()}>Folder</MenuItem>
			</Menu>
		{:else}
			<Tooltip text={readOnlyReason}>
				<Button size="sm" shape="capsule" variant="ghost" icon={FolderPlus} disabled>
					New folder
				</Button>
			</Tooltip>
			<Tooltip text={readOnlyReason}>
				<Button size="sm" shape="capsule" icon={Upload} disabled>Upload</Button>
			</Tooltip>
		{/if}
	{/if}
{/snippet}

{#snippet location()}
	{#if storage}
		<p class="where where--{storage.kind}">
			{#if storage.kind === 'volume'}
				<HardDrive size={14} aria-hidden="true" />
				<span>Saved on volume <span class="strong">{storage.mount.volume}</span></span>
			{:else if storage.kind === 'temporary'}
				<Timer size={14} aria-hidden="true" />
				<span>Temporary storage, cleared when the pod restarts</span>
			{:else if storage.kind === 'read-only'}
				<Lock size={14} aria-hidden="true" />
				<span>
					Read-only{#if storage.mount && (storage.mount.type === 'config' || storage.mount.type === 'secret')}
						{' '}{mountLabel(storage.mount.type).toLowerCase()} mount
						<span class="strong">{storage.mount.volume}</span>{:else if storage.mount?.readOnly}
						{' '}volume <span class="strong">{storage.mount.volume}</span>{:else}, the app's user
						can't write here{/if}
				</span>
			{:else if storage.kind === 'mounted'}
				<HardDrive size={14} aria-hidden="true" />
				<span>On volume <span class="strong">{storage.mount.volume}</span></span>
			{:else}
				<TriangleAlert size={14} aria-hidden="true" />
				<span>Container filesystem. Changes here are lost when the pod restarts or redeploys.</span>
			{/if}
		</p>
	{/if}
{/snippet}

{#snippet preview(inSheet: boolean)}
	{#if previewEntry}
		<FilePreview
			{target}
			entry={previewEntry}
			path={joinPath(path, previewEntry.name)}
			{canWrite}
			{readOnlyReason}
			{saveHint}
			{inSheet}
			bind:dirty
			onclose={closePreview}
			{onsaved}
		/>
	{/if}
{/snippet}

<SectionCard title="Files" actions={headerActions}>
	{#if runningPods.length === 0}
		<EmptyState
			title="No running pods"
			description="Files are read from a running pod. Start the app to browse them."
		>
			<Button size="sm" href="?tab=overview">Open overview</Button>
		</EmptyState>
	{:else if noShell}
		<EmptyState
			title="This image has no shell"
			description="Orchard reads files through a shell inside the container, so this app's files can't be browsed. The terminal won't open either."
		>
			{#snippet icon()}<TerminalSquare size={20} />{/snippet}
			<Button size="sm" icon={ScrollText} href="?tab=observe&view=logs">View logs</Button>
		</EmptyState>
	{:else}
		<div class="files" bind:clientWidth={width}>
			<div class="toolbar">
				<div class="nav">
					<Button
						size="sm"
						shape="capsule"
						variant="ghost"
						icon={ArrowUp}
						label="Up one level"
						title="Up one level"
						disabled={path === '/'}
						onclick={goUp}
					/>
					<PathBar {path} hrefFor={(p) => hrefFor({ path: p, file: null })} onnavigate={navigate} />
				</div>
				<div class="tools">
					<div class="filter">
						<SearchField
							bind:value={filter}
							size="sm"
							placeholder="Filter this folder"
							aria-label="Filter this folder"
							onkeydown={(e: KeyboardEvent) => {
								if (e.key === 'Escape') filter = '';
								if (e.key === 'ArrowDown') {
									e.preventDefault();
									listingRef?.focusFirst();
								}
							}}
						/>
					</div>
					<Button
						size="sm"
						shape="capsule"
						variant="ghost"
						icon={showHidden ? Eye : EyeOff}
						aria-pressed={showHidden}
						label={compact ? (showHidden ? 'Hide dotfiles' : 'Show dotfiles') : undefined}
						title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
						onclick={() => (showHidden = !showHidden)}
					>
						{#if !compact}{hidden ? `${hidden} hidden` : 'Hidden'}{/if}
					</Button>
					{#if runningPods.length > 1}
						<span class="pod">
							<Menu placement="bottom-end">
								{#snippet trigger(attrs, isOpen)}
									<SelectTrigger
										shape="capsule"
										{...attrs}
										open={isOpen}
										size="sm"
										mono
										value={podLabel(podName)}
										placeholder="Pick a pod"
									/>
								{/snippet}
								{#each runningPods as pod (pod.name)}
									<MenuItem
										icon={Boxes}
										checked={pod.name === podName}
										onclick={() => choosePod(pod.name)}
									>
										{podLabel(pod.name)}
									</MenuItem>
								{/each}
							</Menu>
						</span>
					{/if}
				</div>
			</div>

			{@render location()}

			<div class="body" class:body--split={split && !!previewEntry}>
				<div
					class="drop"
					class:drop--over={dragging}
					role="region"
					aria-label="Files in {path}"
					{ondragenter}
					{ondragover}
					{ondragleave}
					{ondrop}
				>
					{#if listingError && !listing}
						{#if listingError.status === 404}
							<EmptyState title="This folder doesn't exist" description="{path} isn't in this pod.">
								<Button size="sm" icon={ArrowUp} onclick={goUp}>Up one level</Button>
							</EmptyState>
						{:else}
							<Alert tone="error" title="Could not read this folder">
								{describeFileError(listingError, 'list')}
								{#snippet actions()}
									<Button size="sm" variant="ghost" onclick={refresh}>Retry</Button>
								{/snippet}
							</Alert>
						{/if}
					{:else if !listing}
						<div class="loading" aria-busy="true">
							<Skeleton height="2.25rem" />
							<Skeleton height="2.25rem" />
							<Skeleton height="2.25rem" />
							<Skeleton height="2.25rem" />
						</div>
					{:else if listing.entries.length === 0}
						<div class="empty">
							<EmptyState
								title="Empty folder"
								description={canWrite ? 'Drop files here or upload them.' : undefined}
							>
								{#if canWrite}
									<Button size="sm" icon={Upload} onclick={() => fileInput?.click()}
										>Upload files</Button
									>
								{:else}
									<Button size="sm" icon={ArrowUp} onclick={goUp}>Up one level</Button>
								{/if}
							</EmptyState>
						</div>
					{:else if shown.length === 0}
						<div class="empty">
							<EmptyState
								title="Nothing matches"
								description={filter
									? `No names here contain “${filter}”.`
									: 'Every item here is hidden.'}
							>
								{#if filter}
									<Button size="sm" onclick={() => (filter = '')}>Clear filter</Button>
								{:else}
									<Button size="sm" icon={Eye} onclick={() => (showHidden = true)}
										>Show hidden</Button
									>
								{/if}
							</EmptyState>
						</div>
					{:else}
						<FileListing
							bind:this={listingRef}
							entries={shown}
							path={listing.path}
							{mounts}
							bind:sort
							selected={previewEntry?.name ?? null}
							{canWrite}
							{readOnlyReason}
							busy={stale}
							downloadHref={(e) => downloadUrl(target, joinPath(path, e.name))}
							onopen={open}
							{onaction}
							onup={goUp}
						/>
					{/if}
					{#if current?.truncated}
						<p class="more-note">
							This folder has more entries than Orchard lists. Showing the first {entries.length.toLocaleString()}.
						</p>
					{/if}
					{#if dragging}
						<div class="drop-cue" class:drop-cue--blocked={!canWrite}>
							{#if canWrite}
								<Upload size={18} aria-hidden="true" />
								<span>Drop to upload to <span class="mono">{path}</span></span>
							{:else}
								<Lock size={18} aria-hidden="true" />
								<span>{readOnlyReason}</span>
							{/if}
						</div>
					{/if}
				</div>
				{#if split && previewEntry}
					<aside class="side" aria-label="Preview of {previewEntry.name}">
						{@render preview(false)}
					</aside>
				{/if}
			</div>

			{#if queue.items.length}
				<UploadTray {queue} />
			{/if}
		</div>
	{/if}
</SectionCard>

<input bind:this={fileInput} type="file" multiple hidden onchange={onPicked} />
<input bind:this={folderInput} type="file" webkitdirectory hidden onchange={onPicked} />

{#if !split}
	<Sheet
		open={!!previewEntry}
		title={previewEntry?.name}
		size="lg"
		dismissable={!dirty}
		onclose={closePreview}
	>
		{@render preview(true)}
	</Sheet>
{/if}

<RenameModal
	bind:open={newFolderOpen}
	title="New folder"
	label="Name"
	placeholder="uploads"
	icon={FolderPlus}
	actionLabel="Create"
	mono
	saving={creating}
	validate={validFileName}
	error={createError}
	onSave={createFolder}
/>

<RenameModal
	bind:open={renameOpen}
	title="Rename {renameTarget?.name ?? ''}"
	label="New name"
	value={renameTarget?.name ?? ''}
	mono
	saving={renaming}
	validate={validFileName}
	error={renameError}
	onSave={rename}
/>

<ConfirmModal
	bind:open={deleteOpen}
	title={deleteCopy.title}
	description={deleteCopy.description}
	confirmText={deleteCopy.confirm}
	confirmLabel="Delete"
	onconfirm={remove}
	oncancel={() => (deleteTarget = null)}
/>

<ConfirmModal
	bind:open={replaceOpen}
	title={replaceNames.length === 1
		? `Replace ${replaceNames[0]}?`
		: `Replace ${replaceNames.length} files?`}
	description={replaceNames.length === 1
		? 'A file with this name is already here. Replacing it overwrites its contents.'
		: 'Files with these names are already here. Replacing them overwrites their contents.'}
	confirmLabel="Replace"
	onconfirm={() => queue.replace(replaceIds)}
	oncancel={() => queue.skip(replaceIds)}
>
	{#if replaceNames.length > 1}
		<ul class="names">
			{#each replaceNames.slice(0, 6) as name (name)}<li>{name}</li>{/each}
			{#if replaceNames.length > 6}<li class="more">and {replaceNames.length - 6} more</li>{/if}
		</ul>
	{/if}
</ConfirmModal>

<ConfirmModal
	bind:open={discardOpen}
	title="Discard your changes?"
	description="Your edits to {previewEntry?.name ?? 'this file'} haven't been saved."
	confirmLabel="Discard"
	cancelLabel="Keep editing"
	onconfirm={discard}
	oncancel={() => (pendingDiscard = null)}
/>

<style>
	.files {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.nav {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex: 1 1 22rem;
		min-width: 0;
	}
	.tools {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 0 1 auto;
		min-width: 0;
	}
	.filter {
		flex: 1 1 13rem;
		min-width: 8rem;
	}
	.pod {
		display: flex;
		flex-shrink: 0;
	}
	.where {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		color: var(--text-muted);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}
	.where :global(svg) {
		flex-shrink: 0;
	}
	.where--container {
		color: var(--status-warning);
	}
	.strong {
		color: var(--text-default);
		font-weight: var(--weight-medium);
	}
	.body {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		min-width: 0;
	}
	.body--split {
		grid-template-columns: minmax(0, 1fr) minmax(22rem, 1fr);
	}
	.more-note {
		margin: 0.5rem 0 0;
		padding-inline: 1rem;
		color: var(--text-faint);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}
	.drop {
		position: relative;
		min-width: 0;
	}
	.drop-cue {
		position: absolute;
		inset: 0;
		z-index: 3;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--accent-7) 10%, var(--bg-surface));
		box-shadow: inset 0 0 0 1.5px var(--accent-7);
		color: var(--text-default);
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
		pointer-events: none;
	}
	.drop-cue--blocked {
		background: color-mix(in oklab, var(--neutral-10) 6%, var(--bg-surface));
		box-shadow: inset 0 0 0 1px var(--border-strong);
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.loading {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.empty {
		padding-block: 1.5rem;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-sunken);
	}
	.side {
		display: flex;
		flex-direction: column;
		min-width: 0;
		height: 32.5rem;
		padding: 1rem;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.names {
		margin: 0;
		padding: 0.5rem 0.75rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-sunken);
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.5rem;
		list-style: none;
	}
	.names .more {
		font-family: var(--font-sans);
		color: var(--text-muted);
	}
</style>
