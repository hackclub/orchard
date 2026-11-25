<script lang="ts">
	import { apiFetch, toasts } from '$lib/stores';
	import { Button, RelativeTime, Switch } from '$lib/components/ui';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';

	type Blocker = 'no_image' | 'source' | 'platform' | 'digest' | 'pull_policy';

	type Status = {
		image: string | null;
		tracked: boolean;
		blocker: Blocker | null;
		autoUpdate: boolean;
		runningDigest: string | null;
		latestDigest: string | null;
		updateAvailable: boolean;
		pending: boolean;
		checkedAt: string | null;
		error: string | null;
		updatedAt: string | null;
	};

	let {
		deploymentId,
		image,
		effectivePullPolicy,
		stopped = false
	}: {
		deploymentId: string;
		image: string | null | undefined;
		effectivePullPolicy: 'Always' | 'IfNotPresent';
		stopped?: boolean;
	} = $props();

	const uid = $props.id();

	let status = $state<Status | null>(null);
	let toggling = $state(false);
	let checking = $state(false);
	let updating = $state(false);

	const BLOCKERS: Record<Blocker, string> = {
		no_image: 'Set an image first',
		source: 'Builds from source, so redeploys pick up changes',
		platform: 'Built by Orchard, so redeploys pick up changes',
		digest: 'Pinned to a digest, so the image never moves',
		pull_policy: 'Pinned to a version. Set the pull policy to Always pull to follow this tag'
	};

	function failure(reason: string): string {
		if (reason === 'http_404') return "the registry doesn't have this tag";
		if (/^(http_401|http_403|unauthorized|token_refused)$/.test(reason))
			return 'the registry wants a credential';
		if (reason.startsWith('blocked')) return "Orchard can't reach this registry";
		return "the registry didn't answer";
	}

	function short(digest: string | null): string {
		return digest ? digest.replace(/^sha256:/, '').slice(0, 12) : '';
	}

	async function request(path: string, init?: RequestInit): Promise<Status> {
		const res = await apiFetch(`/apiv1/deployments/${deploymentId}/image-update${path}`, init);
		const data = await res.json().catch(() => null);
		if (!res.ok) throw new Error(data?.message || 'Something went wrong');
		return data as Status;
	}

	$effect(() => {
		void image;
		void effectivePullPolicy;
		if (!deploymentId) return;
		request('')
			.then((next) => (status = next))
			.catch(() => (status = null));
	});

	async function toggle(next: boolean) {
		toggling = true;
		try {
			status = await request('', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ autoUpdate: next })
			});
			toasts.add({
				title: next ? 'Auto-update on' : 'Auto-update off',
				description: next
					? 'New pushes to this tag roll out within a few hours.'
					: 'The app stays on the image it runs until you update it.',
				color: 'success'
			});
		} catch (e) {
			if (status) status = { ...status, autoUpdate: !next };
			toasts.add({
				title: "Couldn't change auto-update",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			toggling = false;
		}
	}

	async function check() {
		checking = true;
		try {
			status = await request('/check', { method: 'POST' });
		} catch (e) {
			toasts.add({
				title: "Couldn't check for updates",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			checking = false;
		}
	}

	async function update() {
		updating = true;
		try {
			status = await request('', { method: 'POST' });
			toasts.add({
				title: 'Pulling the newest image',
				description: 'Your app is restarting on it.',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: "Couldn't update the image",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			updating = false;
		}
	}
</script>

{#snippet autoHint()}
	{#if !status}
		Checking the registry
	{:else if !status.tracked && status.blocker}
		{BLOCKERS[status.blocker]}
	{:else if status.autoUpdate}
		Rolls out a new push of this tag within a few hours
	{:else}
		Roll out a new push of this tag by itself
	{/if}
{/snippet}

{#snippet newestHint()}
	{#if stopped}
		Start the app to check for a newer image
	{:else if status?.pending}
		Rolling out {short(status.latestDigest)}, checking the pods shortly
	{:else if status?.error?.startsWith('restart_failed')}
		Couldn't restart on {short(status.latestDigest)}, auto-update waits for a new push or Update now
	{:else if status?.error && !status.latestDigest}
		Couldn't check: {failure(status.error)}
	{:else if status?.updateAvailable}
		{short(status.latestDigest)} is out, running {short(status.runningDigest)}
	{:else if status?.latestDigest}
		Up to date on {short(status.latestDigest)}
	{:else}
		Not checked yet
	{/if}
	{#if status?.checkedAt}
		<span class="iu-when">· checked <RelativeTime date={status.checkedAt} /></span>
	{/if}
{/snippet}

<SettingRow label="Auto-update" hint={autoHint} for="{uid}-auto">
	<Switch
		id="{uid}-auto"
		label="Auto-update the image"
		checked={status?.autoUpdate ?? false}
		disabled={!status?.tracked || toggling}
		onchange={toggle}
	/>
</SettingRow>
{#if status?.tracked}
	<SettingRow label="Newest image" hint={newestHint}>
		<div class="iu-actions">
			{#if status.updateAvailable}
				<Button size="sm" variant="primary" loading={updating} onclick={update}>Update now</Button>
			{:else}
				<Button size="sm" variant="ghost" loading={checking} disabled={stopped} onclick={check}
					>Check now</Button
				>
			{/if}
		</div>
	</SettingRow>
{/if}

<style>
	.iu-actions {
		display: flex;
		gap: var(--space-2);
	}
	.iu-when {
		white-space: nowrap;
	}
</style>
