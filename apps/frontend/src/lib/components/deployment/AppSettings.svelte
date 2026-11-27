<script lang="ts">
	import { ActionRow, Button, SectionCard, SettingsRail } from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import { ResourceNotifications, AlertRules } from '$lib/components/notifications';
	import { earlyAccessFlag } from '$lib/stores';
	import AccessCard from './AccessCard.svelte';
	import AutoDeployCard from './AutoDeployCard.svelte';
	import BuilderOptions from './BuilderOptions.svelte';
	import BuildTab from './BuildTab.svelte';
	import GitHubSourceCard from './GitHubSourceCard.svelte';
	import HealthChecks from './HealthChecks.svelte';
	import ImageSource from './ImageSource.svelte';
	import ResourcesTab from './ResourcesTab.svelte';
	import UpdatesCard from './UpdatesCard.svelte';
	import VolumesTab from './VolumesTab.svelte';
	import type { AutoDeployStatus, GitHubDeploymentRecord } from '$lib/types/deployment';

	let {
		deployment,
		organizationId = null,
		activeSection,
		hrefFor,
		onSourceUpdated,
		onDeploymentUpdated,
		onRebuild,
		rebuilding,
		strategyValue = $bindable<'rollingUpdate' | 'recreate' | 'blueGreen'>('rollingUpdate'),
		savingStrategy,
		pdbMinAvailable = $bindable(1),
		savingPdb,
		onSavePdb,
		hasPvcVolume,
		onSaveStrategy,
		buildFromRoot = $bindable(false),
		buildWithDepot = $bindable(false),
		persistentBuildCache = $bindable(false),
		builderOverride = $bindable<'' | 'firecracker' | 'kubernetes'>(''),
		buildOptionsDirty = $bindable(false),
		savingAdvanced,
		onSaveAdvanced,
		savingBuildConfig,
		onSaveBuildConfig,
		autoDeployStatus,
		autoDeployLoading,
		autoDeployBranch = $bindable(''),
		autoDeployPaths = $bindable(''),
		savingAutoDeployPaths,
		onSaveAutoDeployPaths,
		enablingAutoDeploy,
		disablingAutoDeploy,
		githubDeployments,
		githubAppInstallUrl,
		loadingAppInstallUrl,
		onEnableAutoDeploy,
		onDisableAutoDeploy,
		onOpenGitHubAppInstall,
		healthCheckEnabled = $bindable(false),
		healthCheckType = $bindable('http'),
		healthCheckPath = $bindable('/'),
		healthCheckPort = $bindable(80),
		healthCheckCommand = $bindable(''),
		livenessEnabled = $bindable(true),
		readinessEnabled = $bindable(true),
		startupEnabled = $bindable(false),
		healthCheckInterval = $bindable(30),
		healthCheckTimeout = $bindable(5),
		healthCheckRetries = $bindable(3),
		startupFailureThreshold = $bindable(30),
		healthCheckOverride = $bindable(false),
		savingHealthCheck,
		isEditingHealthCheck = $bindable(false),
		onSaveHealthCheck,
		resourceCpuMilli = $bindable(0),
		resourceMemoryBytes = $bindable(0),
		orgDefaultCpuMilli,
		orgDefaultMemoryBytes,
		effectiveCpuLimit,
		effectiveMemLimit,
		resourcesDirty = $bindable(false),
		savingResources,
		isImageSourceDeployment,
		imageInput = $bindable(''),
		imageDirty,
		savingImage,
		pullPolicy,
		effectivePullPolicy = 'IfNotPresent',
		savingPullPolicy,
		onSaveResources,
		onSaveImage,
		onSavePullPolicy,
		volumes = $bindable([]),
		isEditingVolumes = $bindable(false),
		savingVolumes,
		onSaveVolumes,
		deleting,
		onShowDeleteModal
	}: {
		deployment: any;
		organizationId?: string | null;
		activeSection: string;
		hrefFor: (id: string) => string;
		onSourceUpdated: (updated: any) => void;
		onDeploymentUpdated?: (updated: any) => void;
		onRebuild: () => void;
		rebuilding: boolean;
		strategyValue: 'rollingUpdate' | 'recreate' | 'blueGreen';
		savingStrategy: boolean;
		pdbMinAvailable: number;
		savingPdb: boolean;
		onSavePdb: () => void;
		hasPvcVolume: boolean;
		onSaveStrategy: (next: 'rollingUpdate' | 'recreate' | 'blueGreen') => void;
		buildFromRoot: boolean;
		buildWithDepot: boolean;
		persistentBuildCache: boolean;
		builderOverride?: '' | 'firecracker' | 'kubernetes';
		buildOptionsDirty?: boolean;
		savingAdvanced: boolean;
		onSaveAdvanced: () => void;
		savingBuildConfig: boolean;
		onSaveBuildConfig: (body: Record<string, string | null>) => void;
		autoDeployStatus: AutoDeployStatus | null;
		autoDeployLoading: boolean;
		autoDeployBranch: string;
		autoDeployPaths: string;
		savingAutoDeployPaths: boolean;
		onSaveAutoDeployPaths: () => void;
		enablingAutoDeploy: boolean;
		disablingAutoDeploy: boolean;
		githubDeployments: GitHubDeploymentRecord[];
		githubAppInstallUrl: string | null;
		loadingAppInstallUrl: boolean;
		onEnableAutoDeploy: () => void;
		onDisableAutoDeploy: () => void;
		onOpenGitHubAppInstall: () => void;
		healthCheckEnabled: boolean;
		healthCheckType: string;
		healthCheckPath: string;
		healthCheckPort: number;
		healthCheckCommand: string;
		livenessEnabled: boolean;
		readinessEnabled: boolean;
		startupEnabled: boolean;
		healthCheckInterval: number;
		healthCheckTimeout: number;
		healthCheckRetries: number;
		startupFailureThreshold: number;
		healthCheckOverride: boolean;
		savingHealthCheck: boolean;
		isEditingHealthCheck: boolean;
		onSaveHealthCheck: () => void;
		resourceCpuMilli: number;
		resourceMemoryBytes: number;
		orgDefaultCpuMilli: number | null;
		orgDefaultMemoryBytes: number | null;
		effectiveCpuLimit: number | null;
		effectiveMemLimit: number | null;
		resourcesDirty: boolean;
		savingResources: boolean;
		isImageSourceDeployment: boolean;
		imageInput: string;
		imageDirty: boolean;
		savingImage: boolean;
		pullPolicy?: 'Always' | 'IfNotPresent' | null;
		effectivePullPolicy?: 'Always' | 'IfNotPresent';
		savingPullPolicy?: boolean;
		onSaveResources: () => void;
		onSaveImage: () => void;
		onSavePullPolicy?: (next: 'Always' | 'IfNotPresent' | null) => void;
		volumes: any[];
		isEditingVolumes: boolean;
		savingVolumes: boolean;
		onSaveVolumes: () => void;
		deleting: boolean;
		onShowDeleteModal: () => void;
	} = $props();

	const notificationsEnabled = earlyAccessFlag('notifications');

	const RAIL = $derived([
		{
			label: 'App',
			items: [
				{ id: 'source', label: 'Source & build', href: hrefFor('source') },
				{ id: 'resources', label: 'Resources', href: hrefFor('resources') },
				{ id: 'storage', label: 'Storage', href: hrefFor('storage') }
			]
		},
		{
			label: 'Reliability',
			items: [
				{ id: 'health', label: 'Health checks', href: hrefFor('health') },
				{ id: 'behavior', label: 'Deploy behavior', href: hrefFor('behavior') },
				...($notificationsEnabled
					? [{ id: 'notifications', label: 'Notifications', href: hrefFor('notifications') }]
					: [])
			]
		},
		{
			label: 'Admin',
			items: [
				{ id: 'access', label: 'Sharing', href: hrefFor('access') },
				{ id: 'danger', label: 'Danger zone', href: hrefFor('danger') }
			]
		}
	]);
</script>

<div class="as-grid">
	<SettingsRail groups={RAIL} activeId={activeSection} label="App settings sections" />
	<div class="as-stack">
		{#if activeSection === 'source'}
			{#if isImageSourceDeployment}
				<ImageSource
					{deployment}
					bind:imageInput
					{imageDirty}
					{savingImage}
					{onSaveImage}
					{pullPolicy}
					{effectivePullPolicy}
					{onSavePullPolicy}
				/>
			{:else}
				{#if deployment.githubRepo}
					<GitHubSourceCard {deployment} onUpdated={onSourceUpdated} {onRebuild} {rebuilding} />
				{/if}
				<BuildTab {deployment} saving={savingBuildConfig} onSave={onSaveBuildConfig} />
				{#if deployment.githubRepo}
					<BuilderOptions
						bind:buildFromRoot
						bind:buildWithDepot
						bind:persistentBuildCache
						bind:builderOverride
						bind:buildOptionsDirty
						onSave={onSaveAdvanced}
					/>
				{/if}
			{/if}
		{:else if activeSection === 'resources'}
			<ResourcesTab
				{deployment}
				bind:resourceCpuMilli
				bind:resourceMemoryBytes
				{orgDefaultCpuMilli}
				{orgDefaultMemoryBytes}
				{effectiveCpuLimit}
				{effectiveMemLimit}
				bind:resourcesDirty
				{savingResources}
				{onSaveResources}
				{onDeploymentUpdated}
			/>
		{:else if activeSection === 'storage'}
			<VolumesTab
				bind:volumes
				bind:isEditing={isEditingVolumes}
				{savingVolumes}
				onSave={onSaveVolumes}
			/>
		{:else if activeSection === 'health'}
			<HealthChecks
				{deployment}
				bind:healthCheckEnabled
				bind:healthCheckType
				bind:healthCheckPath
				bind:healthCheckPort
				bind:healthCheckCommand
				bind:livenessEnabled
				bind:readinessEnabled
				bind:startupEnabled
				bind:healthCheckInterval
				bind:healthCheckTimeout
				bind:healthCheckRetries
				bind:startupFailureThreshold
				bind:healthCheckOverride
				{savingHealthCheck}
				bind:isEditingHealthCheck
				{onSaveHealthCheck}
			/>
		{:else if activeSection === 'behavior'}
			<UpdatesCard
				replicas={Number(deployment.replicas ?? 1)}
				{strategyValue}
				{hasPvcVolume}
				{onSaveStrategy}
				bind:pdbMinAvailable
				{onSavePdb}
			/>
			{#if deployment.githubRepo}
				<AutoDeployCard
					{deployment}
					{autoDeployStatus}
					{autoDeployLoading}
					bind:autoDeployBranch
					bind:autoDeployPaths
					{savingAutoDeployPaths}
					{onSaveAutoDeployPaths}
					{enablingAutoDeploy}
					{disablingAutoDeploy}
					{githubDeployments}
					{githubAppInstallUrl}
					{loadingAppInstallUrl}
					{onEnableAutoDeploy}
					{onDisableAutoDeploy}
					{onOpenGitHubAppInstall}
				/>
			{/if}
		{:else if activeSection === 'notifications'}
			{#if deployment?.id && organizationId}
				<AlertRules {organizationId} scopeType="deployment" scopeId={deployment.id} />
				<ResourceNotifications {organizationId} scopeType="deployment" scopeId={deployment.id} />
			{/if}
		{:else if activeSection === 'access'}
			{#if deployment?.id}
				<AccessCard deploymentId={deployment.id} />
			{/if}
		{:else if activeSection === 'danger'}
			<SectionCard title="Danger zone" tone="danger">
				<SettingsList>
					<ActionRow label="Delete this app">
						<Button variant="danger" size="sm" onclick={onShowDeleteModal} loading={deleting}>
							Delete app
						</Button>
					</ActionRow>
				</SettingsList>
			</SectionCard>
		{/if}
	</div>
</div>

<style>
	.as-grid {
		display: grid;
		grid-template-columns: 12rem minmax(0, 1fr);
		gap: var(--space-6);
		align-items: start;
	}
	.as-stack {
		--section-r: var(--radius-widget);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}
	@media (max-width: 900px) {
		.as-grid {
			grid-template-columns: 1fr;
			gap: var(--space-4);
		}
	}
</style>
