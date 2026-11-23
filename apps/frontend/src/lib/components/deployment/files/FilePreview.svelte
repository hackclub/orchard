<script lang="ts">
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { AlertTriangle, Download, FileQuestion, PenLine, RefreshCw, X } from 'lucide-svelte';
	import Alert from '$lib/components/ui/Alert.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import CodeBlock from '$lib/components/ui/CodeBlock.svelte';
	import CodeEditor from '$lib/components/ui/CodeEditor.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import FormActions from '$lib/components/ui/FormActions.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import ModalIntro from '$lib/components/ui/ModalIntro.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { toasts } from '$lib/stores/toast';
	import {
		describeFileError,
		formatFileSize,
		isDownloadable,
		isPreviewableImage,
		languageFor,
		languageName,
		type PodFileContent,
		type PodFileEntry,
		type PodFileStat
	} from '$lib/utils/pod-files';
	import {
		downloadUrl,
		fileErrorOf,
		readFile,
		writeFile,
		type PodTarget
	} from './pod-files-client';

	let {
		target,
		entry,
		path,
		canWrite,
		readOnlyReason,
		saveHint,
		inSheet = false,
		dirty = $bindable(false),
		onclose,
		onsaved
	}: {
		target: PodTarget;
		entry: PodFileEntry;
		path: string;
		canWrite: boolean;
		readOnlyReason: string;
		saveHint: string;
		inSheet?: boolean;
		dirty?: boolean;
		onclose: () => void;
		onsaved: (stat: PodFileStat) => void;
	} = $props();

	const uid = $props.id();
	const queryClient = useQueryClient();

	const image = $derived(isPreviewableImage(entry.name));
	const language = $derived(languageFor(entry.name));
	const readable = $derived(isDownloadable(entry));

	const contentKey = $derived(['pod-file-content', target.pod, target.namespace, path]);

	const contentQuery = createQuery(() => ({
		queryKey: contentKey,
		queryFn: () => readFile(target, path),
		enabled: readable && !image && !!target.pod,
		staleTime: 5_000,
		retry: false
	}));

	const file = $derived(contentQuery.data as PodFileContent | undefined);
	const loadError = $derived(contentQuery.error ? fileErrorOf(contentQuery.error) : null);

	let editing = $state(false);
	let draft = $state('');
	let baseMtime = $state<number | null>(null);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let conflictOpen = $state(false);
	let imageSize = $state<{ w: number; h: number } | null>(null);
	let imageFailed = $state(false);

	let lastPath = '';
	$effect(() => {
		if (path === lastPath) return;
		lastPath = path;
		editing = false;
		draft = '';
		saveError = null;
		imageSize = null;
		imageFailed = false;
	});

	$effect(() => {
		dirty = editing && !!file && draft !== (file.content ?? '');
	});

	const size = $derived(file?.size ?? entry.size);
	const mtime = $derived(file?.mtime ?? entry.mtime ?? null);
	const canEdit = $derived(!!file && !file.binary && !file.truncated && file.content != null);

	function startEdit() {
		if (!file || !canEdit) return;
		draft = file.content ?? '';
		baseMtime = file.mtime;
		saveError = null;
		editing = true;
	}

	function cancelEdit() {
		editing = false;
		draft = '';
		saveError = null;
	}

	async function save(force = false) {
		if (saving || !editing) return;
		saving = true;
		saveError = null;
		try {
			const stat = await writeFile(target, path, draft, force ? null : baseMtime);
			queryClient.setQueryData<PodFileContent>(contentKey, (prev) =>
				prev ? { ...prev, content: draft, size: stat.size, mtime: stat.mtime } : prev
			);
			editing = false;
			conflictOpen = false;
			toasts.add({ title: 'File saved', color: 'success' });
			onsaved(stat);
		} catch (err) {
			const info = fileErrorOf(err);
			if (info.code === 'modified') conflictOpen = true;
			else saveError = describeFileError(info, 'write');
		} finally {
			saving = false;
		}
	}

	async function reloadTheirs() {
		conflictOpen = false;
		editing = false;
		await queryClient.invalidateQueries({ queryKey: contentKey });
		toasts.add({ title: 'Loaded the newer version', color: 'info' });
	}

	const href = $derived(downloadUrl(target, path));
	const imageSrc = $derived(downloadUrl(target, path, true));
</script>

<div class="preview" class:preview--sheet={inSheet}>
	<header class="head">
		{#if !inSheet}
			<div class="title-row">
				<h3 class="name" title={entry.name}>{entry.name}</h3>
				<button type="button" class="close" aria-label="Close preview" onclick={onclose}>
					<X size={16} aria-hidden="true" />
				</button>
			</div>
		{/if}
		<div class="facts">
			{#if size != null}<span>{formatFileSize(size)}</span>{/if}
			{#if mtime}<span>Modified <RelativeTime date={mtime * 1000} /></span>{/if}
			{#if imageSize}<span>{imageSize.w} × {imageSize.h}</span>{/if}
			{#if !image && file && !file.binary}<span>{languageName(language)}</span>{/if}
		</div>
		{#if !editing}
			<div class="actions">
				{#if !image && file && canEdit}
					<span title={canWrite ? undefined : readOnlyReason}>
						<Button
							size="sm"
							shape="capsule"
							icon={PenLine}
							disabled={!canWrite}
							onclick={startEdit}>Edit</Button
						>
					</span>
				{/if}
				{#if readable}
					<Button size="sm" shape="capsule" icon={Download} {href} download={entry.name}
						>Download</Button
					>
				{/if}
			</div>
		{/if}
	</header>

	<div class="body">
		{#if !readable}
			<EmptyState
				title={entry.kind === 'symlink' ? 'This link points nowhere' : 'Nothing to preview'}
				description={entry.kind === 'symlink' && entry.linkTo
					? `${entry.linkTo} doesn't exist in this pod.`
					: 'Only regular files can be previewed.'}
			/>
		{:else if image}
			{#if imageFailed}
				<EmptyState
					title="This image could not be shown"
					description="Download it to open it locally."
				>
					<Button size="sm" icon={Download} {href} download={entry.name}>Download</Button>
				</EmptyState>
			{:else}
				<div class="well">
					<img
						src={imageSrc}
						alt={entry.name}
						onload={(e) =>
							(imageSize = {
								w: e.currentTarget.naturalWidth,
								h: e.currentTarget.naturalHeight
							})}
						onerror={() => (imageFailed = true)}
					/>
				</div>
			{/if}
		{:else if loadError}
			<Alert tone="error" title="Could not read this file">
				{describeFileError(loadError, 'read')}
			</Alert>
		{:else if !file}
			<div class="loading" aria-busy="true">
				<Skeleton height="1rem" width="70%" />
				<Skeleton height="1rem" width="88%" />
				<Skeleton height="1rem" width="54%" />
				<Skeleton height="1rem" width="76%" />
			</div>
		{:else if file.binary}
			<EmptyState
				title="Binary file"
				description="Preview shows text and images. Download it to open it locally."
			>
				{#snippet icon()}<FileQuestion size={20} />{/snippet}
				<Button size="sm" icon={Download} {href} download={entry.name}>Download</Button>
			</EmptyState>
		{:else if editing}
			<div class="editor">
				<CodeEditor
					bind:value={draft}
					syntax={language}
					label="Contents of {entry.name}"
					minHeight="12rem"
					class="editor-field"
					onsave={() => save()}
				/>
				{#if saveError}
					<Alert tone="error">{saveError}</Alert>
				{/if}
				<FormActions hint={saveHint}>
					<Button variant="ghost" shape="capsule" disabled={saving} onclick={cancelEdit}
						>Cancel</Button
					>
					<Button
						variant="primary"
						shape="capsule"
						loading={saving}
						disabled={!dirty}
						onclick={() => save()}>Save</Button
					>
				</FormActions>
			</div>
		{:else}
			{#if file.truncated}
				<Alert tone="info" title="Showing the first 1 MB">
					Download the file to read all {formatFileSize(file.size ?? 0)}.
				</Alert>
			{/if}
			<CodeBlock
				code={file.content ?? ''}
				syntax={(file.content?.length ?? 0) <= 200_000 ? language : null}
				lineNumbers
				fill
			/>
		{/if}
	</div>
</div>

<Modal bind:open={conflictOpen} size="md" closable={false} dismissable labelledby="{uid}-conflict">
	<ModalIntro
		id="{uid}-conflict"
		icon={AlertTriangle}
		tone="warning"
		title="{entry.name} changed while you were editing"
		description="Someone or something in the pod saved it after you opened it. Overwrite replaces their version with yours."
	/>
	{#snippet footer()}
		<Button variant="ghost" shape="capsule" onclick={() => (conflictOpen = false)}
			>Keep editing</Button
		>
		<Button shape="capsule" icon={RefreshCw} onclick={reloadTheirs}>Load theirs</Button>
		<Button variant="danger" shape="capsule" loading={saving} onclick={() => save(true)}>
			Overwrite
		</Button>
	{/snippet}
</Modal>

<style>
	.preview {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
		min-height: 0;
		height: 100%;
	}
	.head {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.title-row {
		--control-shift: calc(0.5cap - 0.875rem);
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-headline);
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow-x: clip;
		padding-block: 0.3em;
		margin-block: -0.3em;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: var(--weight-medium);
		color: var(--text-default);
		text-box: trim-both cap alphabetic;
	}
	.close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		margin-block: var(--control-shift);
		margin-right: var(--control-shift);
		border: none;
		border-radius: 999px;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.close:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}
	.close:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		color: var(--text-muted);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-variant-numeric: tabular-nums;
	}
	.facts > span {
		text-box: trim-both cap alphabetic;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		flex: 1;
		min-height: 0;
	}
	.editor {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		flex: 1;
		min-height: 0;
	}
	.editor > :global(.editor-field) {
		flex: 1;
	}
	.loading {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
	}
	.well {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		min-height: 12rem;
		padding: 1rem;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background-color: var(--bg-sunken);
		background-image:
			linear-gradient(45deg, var(--bg-hover) 25%, transparent 25%),
			linear-gradient(-45deg, var(--bg-hover) 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, var(--bg-hover) 75%),
			linear-gradient(-45deg, transparent 75%, var(--bg-hover) 75%);
		background-size: 16px 16px;
		background-position:
			0 0,
			0 8px,
			8px -8px,
			-8px 0;
	}
	.well img {
		display: block;
		max-width: 100%;
		max-height: 28rem;
		object-fit: contain;
		image-rendering: auto;
		box-shadow: var(--shadow-raised);
	}
</style>
