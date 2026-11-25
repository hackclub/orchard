<script lang="ts">
	import { Button, FormActions, Input, SectionCard, SegmentedControl } from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';
	import { isMutableTag } from './deployment-helpers';
	import ImageUpdates from './ImageUpdates.svelte';
	import RegistryAccess from './RegistryAccess.svelte';

	type Policy = 'Always' | 'IfNotPresent';

	let {
		deployment,
		imageInput = $bindable(''),
		imageDirty,
		savingImage,
		onSaveImage,
		pullPolicy = null,
		effectivePullPolicy = 'IfNotPresent',
		onSavePullPolicy
	}: {
		deployment: any;
		imageInput: string;
		imageDirty: boolean;
		savingImage: boolean;
		onSaveImage: () => void;
		pullPolicy?: Policy | null;
		effectivePullPolicy?: Policy;
		onSavePullPolicy?: (next: Policy | null) => void;
	} = $props();

	const uid = $props.id();

	const POLICIES = [
		{ value: 'auto', label: 'Automatic' },
		{ value: 'IfNotPresent', label: 'Use cached' },
		{ value: 'Always', label: 'Always pull' }
	];

	const tagCanMove = $derived(isMutableTag(deployment?.image));

	const policyHint = $derived.by(() => {
		if (pullPolicy == null) {
			return effectivePullPolicy === 'Always'
				? 'This tag can move, so every start pulls it again'
				: 'This tag is pinned, so pods reuse the cached image';
		}
		if (pullPolicy === 'Always') return 'Every start pulls the image again';
		return tagCanMove
			? "Restarts won't pick up a new push to this tag"
			: 'Pods reuse the image already on the node';
	});
</script>

<SectionCard title="Source">
	<div class="is-body">
		<SettingsList>
			<SettingRow label="Image" for="{uid}-image" wide>
				<Input
					id="{uid}-image"
					bind:value={imageInput}
					placeholder="ghcr.io/org/image:tag"
					disabled={savingImage}
					mono
				/>
			</SettingRow>
		</SettingsList>
		<FormActions hint="Saving restarts your app with the new image.">
			<Button
				variant="ghost"
				disabled={!imageDirty || savingImage}
				onclick={() => (imageInput = deployment?.image ?? '')}>Discard</Button
			>
			<Button variant="primary" disabled={!imageDirty} loading={savingImage} onclick={onSaveImage}
				>Save</Button
			>
		</FormActions>
	</div>
</SectionCard>

<SectionCard title="Pulling">
	<SettingsList>
		<SettingRow label="Pull policy" hint={policyHint}>
			<SegmentedControl
				label="Image pull policy"
				options={POLICIES}
				bind:value={
					() => pullPolicy ?? 'auto',
					(next) => onSavePullPolicy?.(next === 'auto' ? null : (next as Policy))
				}
			/>
		</SettingRow>
		<ImageUpdates
			deploymentId={deployment?.id ?? ''}
			image={deployment?.image}
			{effectivePullPolicy}
			stopped={!!deployment?.stopped}
		/>
		<RegistryAccess
			projectId={deployment?.projectId ?? ''}
			image={imageInput || deployment?.image || ''}
		/>
	</SettingsList>
</SectionCard>

<style>
	.is-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
</style>
