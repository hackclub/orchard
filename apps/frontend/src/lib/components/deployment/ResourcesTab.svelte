<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import ResourcePicker, { formatCpu, formatMemory } from '$lib/components/ResourcePicker.svelte';
	import { Button, FormActions, SectionCard, SettingRow } from '$lib/components/ui';
	import { isDatabaseImage } from '$lib/presets';
	import { apiFetch, instanceFeatures, isSuperAdmin } from '$lib/stores';
	import NodePoolPicker from './NodePoolPicker.svelte';
	import DevicesCard from './DevicesCard.svelte';

	let {
		deployment,
		resourceCpuMilli = $bindable<number | null>(),
		resourceMemoryBytes = $bindable<number | null>(),
		orgDefaultCpuMilli,
		orgDefaultMemoryBytes,
		effectiveCpuLimit = null,
		effectiveMemLimit = null,
		resourcesDirty = $bindable<boolean>(),
		savingResources,
		onSaveResources,
		onDeploymentUpdated
	}: {
		deployment: any;
		resourceCpuMilli: number | null;
		resourceMemoryBytes: number | null;
		orgDefaultCpuMilli: number | null;
		orgDefaultMemoryBytes: number | null;
		effectiveCpuLimit?: number | null;
		effectiveMemLimit?: number | null;
		resourcesDirty: boolean;
		savingResources: boolean;
		onSaveResources: () => void;
		onDeploymentUpdated?: (updated: any) => void;
	} = $props();

	type Suggestion = {
		status: 'ok' | 'insufficient';
		reason: string | null;
		confidence: 'high' | 'medium' | null;
		unlimited?: boolean;
		memory: { current: number; recommended: number; change: string; reason: string };
		cpu: { current: number; recommended: number; change: string; reason: string };
	};

	const rightsizing = createQuery<Suggestion | null>(() => ({
		queryKey: ['rightsizing', deployment?.id],
		enabled: !!deployment?.id,
		staleTime: 10 * 60_000,
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/rightsizing`);
			return res.ok ? ((await res.json()) as Suggestion) : null;
		}
	}));

	const suggestion = $derived.by(() => {
		const s = rightsizing.data;
		if (!s || s.status !== 'ok' || s.unlimited) return null;
		const memory = s.memory.change !== 'none';
		const cpu = s.cpu.change !== 'none';
		if (!memory && !cpu) return null;
		const parts = [
			memory ? `${formatMemory(s.memory.recommended)} memory` : null,
			cpu ? formatCpu(s.cpu.recommended) : null
		].filter(Boolean);
		return {
			label: `Suggested: ${parts.join(', ')}`,
			hint: [memory ? s.memory.reason : null, cpu ? s.cpu.reason : null].filter(Boolean).join(' '),
			memoryBytes: s.memory.recommended,
			cpuMilli: s.cpu.recommended,
			applied:
				resourceMemoryBytes === s.memory.recommended && resourceCpuMilli === s.cpu.recommended
		};
	});

	function apply() {
		if (!suggestion) return;
		resourceMemoryBytes = suggestion.memoryBytes;
		resourceCpuMilli = suggestion.cpuMilli;
		resourcesDirty = true;
	}

	function discard() {
		resourceCpuMilli = deployment?.cpuRequestMilli ?? null;
		resourceMemoryBytes =
			deployment?.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null;
		resourcesDirty = false;
	}
</script>

<SectionCard title="CPU and memory">
	<div class="rt-body">
		<ResourcePicker
			bind:cpuMilli={resourceCpuMilli}
			bind:memoryBytes={resourceMemoryBytes}
			kind={isDatabaseImage(deployment?.image) ? 'database' : 'app'}
			defaultCpuMilli={orgDefaultCpuMilli}
			defaultMemoryBytes={orgDefaultMemoryBytes}
			showUnlimited={$isSuperAdmin}
			currentCpuUsage={deployment?.totalCpuUsage}
			currentMemUsage={deployment?.totalMemoryUsage}
			maxCpuMilli={effectiveCpuLimit}
			maxMemoryBytes={effectiveMemLimit}
			recommendedCpuMilli={suggestion?.cpuMilli ?? null}
			recommendedMemoryBytes={suggestion?.memoryBytes ?? null}
			onchange={() => (resourcesDirty = true)}
		/>
		{#if suggestion && $instanceFeatures.resourceLimits !== 'off'}
			<SettingRow label={suggestion.label} hint={suggestion.hint}>
				<Button size="sm" disabled={suggestion.applied} onclick={apply}>Apply</Button>
			</SettingRow>
		{/if}
		{#if $instanceFeatures.resourceLimits !== 'off'}
			<FormActions hint="Saving restarts your app.">
				<Button variant="ghost" disabled={!resourcesDirty || savingResources} onclick={discard}
					>Discard</Button
				>
				<Button
					variant="primary"
					disabled={!resourcesDirty}
					loading={savingResources}
					onclick={onSaveResources}>Save</Button
				>
			</FormActions>
		{/if}
	</div>
</SectionCard>

{#if deployment?.id}
	<NodePoolPicker
		deploymentId={deployment.id}
		nodePoolId={deployment.nodePoolId}
		onSaved={onDeploymentUpdated}
	/>
	<DevicesCard
		deploymentId={deployment.id}
		devices={deployment.devices}
		onSaved={onDeploymentUpdated}
	/>
{/if}

<style>
	.rt-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
</style>
