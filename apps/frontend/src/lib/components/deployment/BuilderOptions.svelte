<script lang="ts">
	import { browser } from '$app/environment';
	import { instanceFeatures, isSuperAdmin } from '$lib/stores';
	import { SectionCard, SegmentedControl, ToggleRow } from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';

	type Builder = '' | 'firecracker' | 'kubernetes';

	let {
		buildFromRoot = $bindable(false),
		buildWithDepot = $bindable(false),
		persistentBuildCache = $bindable(false),
		builderOverride = $bindable<Builder>(''),
		buildOptionsDirty = $bindable(false),
		onSave
	}: {
		buildFromRoot: boolean;
		buildWithDepot: boolean;
		persistentBuildCache: boolean;
		builderOverride?: Builder;
		buildOptionsDirty?: boolean;
		onSave: () => void | Promise<void>;
	} = $props();

	const BUILDERS = [
		{ value: '', label: 'Auto' },
		{ value: 'firecracker', label: 'On' },
		{ value: 'kubernetes', label: 'Off' }
	];

	const AUTO_HINTS = {
		all: 'Auto uses the fast builder',
		per_app: 'Auto uses the standard builder',
		off: 'Turned off for this server, so every build uses the standard builder',
		flag: 'Auto lets Orchard decide'
	} as const;

	const autoHint = $derived(AUTO_HINTS[$instanceFeatures.fastBuilderRouting] ?? AUTO_HINTS.flag);

	if (browser) instanceFeatures.load().catch(() => undefined);

	let queue: Promise<void> = Promise.resolve();

	function commit(revert: () => void) {
		buildOptionsDirty = true;
		queue = queue.then(async () => {
			await onSave();
			if (buildOptionsDirty) {
				revert();
				buildOptionsDirty = false;
			}
		});
	}
</script>

<SectionCard title="Builder">
	<SettingsList>
		<ToggleRow
			label="Build from repository root"
			bind:checked={buildFromRoot}
			onchange={() => commit(() => (buildFromRoot = !buildFromRoot))}
		/>
		{#if $isSuperAdmin}
			<ToggleRow
				label="Persistent build cache"
				bind:checked={persistentBuildCache}
				onchange={() => commit(() => (persistentBuildCache = !persistentBuildCache))}
			/>
			{#if $instanceFeatures.superBuilds || buildWithDepot}
				<ToggleRow
					label="Orchard's super builds"
					bind:checked={buildWithDepot}
					onchange={() => commit(() => (buildWithDepot = !buildWithDepot))}
				/>
			{/if}
		{/if}
		{#if $instanceFeatures.fastBuilder}
			<SettingRow label="Fast builder" hint={autoHint}>
				<SegmentedControl
					label="Fast builder"
					options={BUILDERS}
					bind:value={
						() => builderOverride,
						(next) => {
							const previous = builderOverride;
							builderOverride = next as Builder;
							commit(() => (builderOverride = previous));
						}
					}
				/>
			</SettingRow>
		{/if}
	</SettingsList>
</SectionCard>
