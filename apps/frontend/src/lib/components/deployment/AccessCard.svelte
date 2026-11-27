<script lang="ts">
	import { onMount } from 'svelte';
	import { Trash2 } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Alert,
		Button,
		Dropdown,
		Field,
		Input,
		List,
		ListRow,
		SectionCard
	} from '$lib/components/ui';

	interface Grant {
		userId: string;
		email: string;
		username: string;
		name: string | null;
		role: 'viewer' | 'member';
	}

	let { deploymentId }: { deploymentId: string } = $props();

	const formId = $props.id();
	const ROLES = [
		{ value: 'member', label: 'Member: logs, shell, env, restart' },
		{ value: 'viewer', label: 'Viewer: read only' }
	];

	let grants = $state<Grant[]>([]);
	let loading = $state(true);
	let denied = $state(false);
	let email = $state('');
	let role = $state('member');
	let saving = $state(false);

	const base = $derived(`/apiv1/deployments/${encodeURIComponent(deploymentId)}/access`);

	async function load() {
		loading = true;
		try {
			const res = await apiFetch(base);
			if (res.status === 403 || res.status === 404) {
				denied = true;
				return;
			}
			if (!res.ok) throw new Error("Couldn't load who has access");
			grants = await res.json();
		} catch (e) {
			toasts.add({
				title: "Couldn't load access",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			loading = false;
		}
	}

	async function submit() {
		const value = email.trim();
		if (!value || saving) return;
		saving = true;
		try {
			const res = await apiFetch(base, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: value, role })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || "Couldn't share this app");
			}
			email = '';
			await load();
		} catch (e) {
			toasts.add({
				title: "Couldn't share this app",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function remove(grant: Grant) {
		try {
			const res = await apiFetch(`${base}/${encodeURIComponent(grant.userId)}`, {
				method: 'DELETE'
			});
			if (!res.ok) throw new Error("Couldn't remove access");
			grants = grants.filter((g) => g.userId !== grant.userId);
		} catch (e) {
			toasts.add({
				title: "Couldn't remove access",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		}
	}

	onMount(load);
</script>

<SectionCard
	title="Share this app"
	description="Give an organization member a role on this app only. They see nothing else in the project."
>
	{#if denied}
		<Alert tone="info" title="Only project admins can share this app." />
	{:else}
		<form
			id={formId}
			class="flex flex-wrap items-end gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<div class="min-w-48 flex-1">
				<Field label="Organization member" for="{formId}-email">
					<Input
						id="{formId}-email"
						type="email"
						bind:value={email}
						placeholder="teammate@example.com"
						autocomplete="off"
					/>
				</Field>
			</div>
			<div class="w-64">
				<Field label="Role">
					<Dropdown bind:value={role} ariaLabel="Role" options={ROLES} />
				</Field>
			</div>
			<Button type="submit" variant="primary" loading={saving} disabled={!email.trim()}>
				Share
			</Button>
		</form>

		{#if grants.length > 0}
			<List label="People with access">
				{#each grants as grant (grant.userId)}
					<ListRow title={grant.name ?? grant.username} subtitle="{grant.email} · {grant.role}">
						{#snippet actions()}
							<Button
								variant="ghost"
								size="sm"
								aria-label="Remove access for {grant.email}"
								onclick={() => remove(grant)}
							>
								<Trash2 class="h-4 w-4" />
							</Button>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{:else if !loading}
			<p class="text-sm text-muted">Not shared with anyone yet.</p>
		{/if}
	{/if}
</SectionCard>
