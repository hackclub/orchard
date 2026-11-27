<script lang="ts">
	import { browser } from '$app/environment';
	import { apiFetch, instanceFeatures, toasts } from '$lib/stores';
	import { Dropdown, SectionCard } from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';
	import ToggleRow from '$lib/components/ui/ToggleRow.svelte';

	let {
		deploymentId,
		devices = {},
		onSaved
	}: {
		deploymentId: string;
		devices?: Record<string, number> | null;
		onSaved?: (updated: Record<string, unknown>) => void;
	} = $props();

	const uid = $props.id();

	if (browser) instanceFeatures.load().catch(() => undefined);

	let current = $state<Record<string, number>>({});
	let saving = $state(false);

	$effect(() => {
		if (!saving) current = { ...(devices ?? {}) };
	});

	const rows = $derived.by(() => {
		const offered = $instanceFeatures.devices ?? [];
		const known = new Set(offered.map((d) => d.resource));
		const extra = Object.keys(current)
			.filter((resource) => !known.has(resource))
			.map((resource) => ({ resource, label: resource, max: 0, offered: false }));
		return [...offered.map((d) => ({ ...d, offered: true })), ...extra].map((row) => {
			const kept = devices?.[row.resource] ?? 0;
			return { ...row, kept, limit: Math.max(row.max, kept) };
		});
	});

	async function save(resource: string, count: number) {
		const previous = current;
		const next = { ...current, [resource]: count };
		if (count <= 0) delete next[resource];
		current = next;
		saving = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deploymentId}/devices`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ devices: next })
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.message || "Couldn't update devices");
			}
			const updated = await res.json().catch(() => null);
			if (updated) onSaved?.(updated);
			toasts.add({
				title: count > 0 ? 'Device attached' : 'Device detached',
				description: 'Your app restarts to pick it up.',
				color: 'success'
			});
		} catch (e) {
			current = previous;
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	function countOptions(max: number, kept: number) {
		const counts = Array.from({ length: max + 1 }, (_, n) => n);
		if (kept > max) counts.push(kept);
		return counts.map((n) => ({ value: String(n), label: n === 0 ? 'None' : String(n) }));
	}
</script>

{#if rows.length > 0}
	<SectionCard title="Devices">
		<SettingsList>
			{#each rows as row (row.resource)}
				{#if row.limit <= 1 && row.offered}
					<ToggleRow
						label={row.label}
						hint={row.resource}
						disabled={saving}
						bind:checked={
							() => (current[row.resource] ?? 0) > 0, (on) => save(row.resource, on ? 1 : 0)
						}
					/>
				{:else}
					<SettingRow
						label={row.label}
						hint={row.offered ? row.resource : 'Attached outside Orchard'}
						for="{uid}-{row.resource}"
					>
						<div class="dc-count">
							<Dropdown
								id="{uid}-{row.resource}"
								disabled={saving}
								bind:value={
									() => String(current[row.resource] ?? 0), (v) => save(row.resource, Number(v))
								}
								options={countOptions(row.max, row.kept)}
							/>
						</div>
					</SettingRow>
				{/if}
			{/each}
		</SettingsList>
	</SectionCard>
{/if}

<style>
	.dc-count {
		width: 8rem;
		min-width: 0;
	}
</style>
