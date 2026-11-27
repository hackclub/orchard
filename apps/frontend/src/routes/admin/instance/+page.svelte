<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { apiFetch, instanceChecklist, instanceFeatures, toasts } from '$lib/stores';
	import { STORAGE_PROVIDERS, storageProvider } from '$lib/storage-providers';
	import {
		Alert,
		Button,
		Disclosure,
		Dropdown,
		Field,
		FieldGrid,
		FormActions,
		Input,
		SecretInput,
		SectionCard,
		SettingsList,
		Skeleton,
		Stack,
		Swap,
		ToggleRow
	} from '$lib/components/ui';
	import { presence } from '$lib/utils/transitions';
	import McpToggle from '$lib/components/admin/McpToggle.svelte';
	import ResourceLimitsSetting from '$lib/components/admin/ResourceLimitsSetting.svelte';
	import NewOrgDefaults from '$lib/components/admin/NewOrgDefaults.svelte';
	import DatabaseSettings from '$lib/components/admin/DatabaseSettings.svelte';
	import ImageScanning from '$lib/components/admin/ImageScanning.svelte';
	import FastBuilderSetting from '$lib/components/admin/FastBuilderSetting.svelte';
	import TelemetryToggle from '$lib/components/admin/TelemetryToggle.svelte';
	import SettingCommand from '$lib/components/setup/SettingCommand.svelte';
	import {
		settingChanges,
		type SettingChange,
		type SettingChanges
	} from '$lib/components/setup/setting-changes';
	import type { SetupOverview } from '$lib/components/setup/setup-overview';

	type Section = {
		id: string;
		configured: boolean;
		values: Record<string, string | null>;
		lockedFields: string[];
		secretFields: string[];
		boolFields: string[];
		graft?: {
			id: string;
			title: string;
			description?: string;
			fields: Record<string, { label: string; help?: string }>;
		};
	};

	type Meta = { title: string; description: string; fields: Record<string, string> };

	function metaFor(section: Section): Meta {
		if (META[section.id]) return META[section.id];
		const g = section.graft!;
		return {
			title: g.title,
			description: `${g.description ? `${g.description} ` : ''}Added by the ${g.id} graft.`,
			fields: Object.fromEntries(Object.entries(g.fields).map(([name, f]) => [name, f.label]))
		};
	}

	const LOCKED_CHANGES: Record<string, keyof SettingChanges> = {
		appDomain: 'apps',
		publicIp: 'public-ip',
		cname: 'custom-domains'
	};

	let overview = $state<SetupOverview | null>(null);
	const changes = $derived(settingChanges(overview));

	function lockedChanges(section: Section): SettingChange[] {
		return section.lockedFields
			.map((name) => changes[LOCKED_CHANGES[name]])
			.filter((change): change is SettingChange => !!change);
	}

	async function loadOverview() {
		const response = await apiFetch('/apiv1/setup/overview');
		if (response.ok) overview = await response.json();
	}

	function hintFor(section: Section, name: string) {
		return section.graft ? section.graft.fields[name]?.help : HINTS[name];
	}

	const META: Record<string, Meta> = {
		storage: {
			title: 'Object storage',
			description:
				'Holds database backups, uploads and build contexts. Any S3-compatible provider works. The access key needs list, read, write and delete on each bucket.',
			fields: {
				endpoint: 'Endpoint',
				region: 'Region',
				accessKeyId: 'Access key ID',
				secretAccessKey: 'Secret access key',
				backupBucket: 'Backup bucket',
				bucketName: 'Uploads bucket',
				pathStyle: 'Path-style addressing',
				publicUrl: 'Public base URL',
				buildContextBucket: 'Build context bucket',
				accountId: 'Account ID'
			}
		},
		email: {
			title: 'Email',
			description:
				'Sends invitations and sign-in codes. Without it, invitations still work as links you copy.',
			fields: {
				host: 'Host',
				port: 'Port',
				user: 'Username',
				pass: 'Password',
				from: 'From address',
				fromName: 'From name',
				secure: 'Implicit TLS'
			}
		},
		ingress: {
			title: 'Custom domains',
			description:
				"The hostname people point their own domains at with a CNAME. Without it, Orchard can't check DNS before issuing a certificate.",
			fields: { cname: 'CNAME target' }
		},
		wildcard: {
			title: 'Wildcard certificate',
			description:
				'One certificate for all generated app URLs. Without it, each URL gets its own, with a limit of 50 per week per domain.',
			fields: {
				appDomain: 'App domain',
				domains: 'Wildcard domains',
				sourceNamespace: 'Certificate namespace'
			}
		},
		network: {
			title: 'Public exposure',
			description:
				'The address for public TCP and UDP ports and public databases. An organization can set its own.',
			fields: { publicIp: 'Default public IP' }
		},
		'git-gitlab': {
			title: 'GitLab sign-in',
			description:
				'Lets people connect their GitLab account. Register an OAuth application with the callback URL below.',
			fields: { baseUrl: 'GitLab URL', clientId: 'Application ID', clientSecret: 'Secret' }
		},
		'git-bitbucket': {
			title: 'Bitbucket sign-in',
			description:
				'Lets people connect their Bitbucket Cloud account. Create an OAuth consumer with repository read access and the callback URL below.',
			fields: { key: 'Key', secret: 'Secret' }
		},
		turnstile: {
			title: 'Bot protection',
			description:
				'Adds a Cloudflare Turnstile challenge to sign-in pages and password-protected apps. Off until you set both keys. Wrong keys block sign-in: to get back in, set TURNSTILE_ENABLED=false on the server.',
			fields: {
				siteKey: 'Site key',
				secretKey: 'Secret key',
				enabled: 'Challenge the sign-in pages',
				strict: 'Refuse sign-in when Cloudflare is unreachable'
			}
		}
	};

	const HINTS: Record<string, string> = {
		domains: 'Suffix and secret name, for example .apps.example.com=wildcard-tls',
		secure: 'Turn on for port 465.',
		accountId: 'Cloudflare R2 only. Fills in a blank endpoint.',
		bucketName: 'Uploads and cached images. Can be the backup bucket.',
		buildContextBucket: 'Used by orchard up. Empty uses the uploads bucket.',
		publicUrl: 'Empty serves uploads through Orchard, so the bucket stays private.',
		region: 'Empty means auto, which Cloudflare R2 expects.',
		pathStyle: 'On sends requests to <endpoint>/<bucket>, off to <bucket>.<endpoint>.',
		publicIp: 'Leave blank to require one per organization.',
		siteKey: 'From the Turnstile widget in your Cloudflare dashboard',
		secretKey: 'Never leaves the server. Leave blank to keep the stored one.',
		enabled: 'Ignored until you set both keys. Turning this off keeps the keys.',
		strict: 'When off, sign-in skips the challenge if Cloudflare is unreachable, and logs it.',
		baseUrl: 'Leave blank for gitlab.com. Callback URL: <origin>/apiv1/git/oauth/gitlab/callback',
		clientId: 'Scopes: read_api, read_repository, read_user',
		key: 'Callback URL: <origin>/apiv1/git/oauth/bitbucket/callback'
	};

	const PLACEHOLDERS: Record<string, string> = {
		endpoint: 'https://s3.eu-west-1.amazonaws.com',
		region: 'auto',
		publicIp: '203.0.113.10'
	};

	const TEXT_FLAG_DEFAULTS: Record<string, boolean> = { pathStyle: true, secure: false };

	const ADVANCED: Record<string, string[]> = {
		storage: ['accountId', 'buildContextBucket', 'publicUrl', 'pathStyle']
	};

	let sections = $state<Section[]>([]);
	let drafts = $state<Record<string, Record<string, string>>>({});
	let saving = $state<string | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	function draftOf(section: Section) {
		const next: Record<string, string> = {};
		for (const [name, value] of Object.entries(section.values)) next[name] = value ?? '';
		return next;
	}

	async function load() {
		const response = await apiFetch('/apiv1/admin/instance-config');
		if (!response.ok) throw new Error(`Couldn't load the configuration (${response.status})`);
		const all: Section[] = await response.json();
		sections = all.filter((s) => s.id in META || !!s.graft);
		drafts = Object.fromEntries(sections.map((s) => [s.id, draftOf(s)]));
	}

	const isFlag = (section: Section, name: string) =>
		section.boolFields.includes(name) || name in TEXT_FLAG_DEFAULTS;

	function namesIn(section: Section, meta: Meta) {
		const advanced = ADVANCED[section.id] ?? [];
		const names = Object.keys(meta.fields).filter((name) => !advanced.includes(name));
		return {
			fields: names.filter((name) => !isFlag(section, name)),
			flags: names.filter((name) => isFlag(section, name)),
			advancedFields: advanced.filter((name) => !isFlag(section, name)),
			advancedFlags: advanced.filter((name) => isFlag(section, name))
		};
	}

	function flagOn(section: Section, name: string) {
		const value = drafts[section.id][name];
		return value ? value === 'true' : (TEXT_FLAG_DEFAULTS[name] ?? false);
	}

	function toggleFlag(section: Section, name: string) {
		if (section.lockedFields.includes(name)) return;
		drafts[section.id][name] = String(!flagOn(section, name));
	}

	const isDirty = (section: Section) =>
		Object.entries(drafts[section.id] ?? {}).some(
			([name, value]) => value !== (section.values[name] ?? '')
		);

	function advancedNote(section: Section, names: string[]) {
		const count = names.filter((name) => drafts[section.id][name]).length;
		return count ? `${count} set` : undefined;
	}

	function discard(section: Section) {
		drafts[section.id] = draftOf(section);
		if (section.id === 'storage') {
			storagePreset = '';
			storagePlace = '';
			storageResult = null;
		}
	}

	async function save(section: Section) {
		saving = section.id;
		try {
			const response = await apiFetch(`/apiv1/admin/instance-config/${section.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(drafts[section.id] ?? {})
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || "Couldn't save");
			}
			const updated: Section = await response.json();
			sections = sections.map((s) => (s.id === updated.id ? updated : s));
			drafts[updated.id] = draftOf(updated);
			await instanceChecklist.load(true);
			if (section.id === 'storage') await instanceFeatures.load(true);
			toasts.add({ title: `${metaFor(section).title} saved`, color: 'success' });
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't save",
				color: 'error'
			});
		} finally {
			saving = null;
		}
	}

	let storagePreset = $state('');
	let storagePlace = $state('');
	let storageTesting = $state(false);
	let storageResult = $state<{ ok: boolean; message?: string } | null>(null);
	const presetProvider = $derived(storagePreset ? storageProvider(storagePreset) : null);
	const providerOptions = STORAGE_PROVIDERS.map((provider) => ({
		value: provider.id,
		label: provider.label
	}));

	function applyStoragePreset() {
		if (!presetProvider || !drafts.storage) return;
		const place = storagePlace.trim() || presetProvider.placeDefault;
		const locked = sections.find((s) => s.id === 'storage')?.lockedFields ?? [];
		const set = (name: string, value: string) => {
			if (!locked.includes(name)) drafts.storage[name] = value;
		};
		if (presetProvider.placeLabel) {
			set('endpoint', presetProvider.endpoint(place));
			set('region', presetProvider.region(place));
		}
		set('pathStyle', String(presetProvider.pathStyle));
		storageResult = null;
	}

	async function testStorage() {
		storageTesting = true;
		try {
			const response = await apiFetch('/apiv1/admin/instance-config/storage/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(drafts.storage ?? {})
			});
			const body = await response.json().catch(() => ({}));
			storageResult =
				response.ok && typeof body.ok === 'boolean'
					? body
					: { ok: false, message: body?.message || 'The connection test failed.' };
		} catch {
			storageResult = { ok: false, message: 'The connection test failed.' };
		} finally {
			storageTesting = false;
		}
	}

	async function scrollToHash() {
		const target = document.getElementById(window.location.hash.slice(1));
		if (!target) return;
		const nextFrame = () => new Promise(requestAnimationFrame);
		await nextFrame();
		await nextFrame();
		let morphing = target.closest('[data-morphing]');
		while (morphing) {
			await Promise.allSettled(morphing.getAnimations().map((a) => a.finished));
			await nextFrame();
			morphing = target.closest('[data-morphing]');
		}
		target.scrollIntoView();
	}

	onMount(async () => {
		try {
			await Promise.all([load(), loadOverview()]);
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Couldn't load the configuration";
		}
		loading = false;
		instanceFeatures.load(true).catch(() => undefined);
		await tick();
		await scrollToHash();
	});
</script>

{#snippet field(section: Section, meta: Meta, name: string)}
	{@const locked = section.lockedFields.includes(name)}
	{@const placeholder = section.secretFields.includes(name)
		? section.configured
			? 'Unchanged'
			: ''
		: (PLACEHOLDERS[name] ?? '')}
	<Field
		label={meta.fields[name]}
		for="{section.id}-{name}"
		hint={locked
			? changes[LOCKED_CHANGES[name]]
				? "Can't be edited here."
				: 'Set by the environment'
			: hintFor(section, name)}
	>
		{#if section.secretFields.includes(name)}
			<SecretInput
				id="{section.id}-{name}"
				disabled={locked}
				{placeholder}
				bind:value={drafts[section.id][name]}
			/>
		{:else}
			<Input
				id="{section.id}-{name}"
				disabled={locked}
				{placeholder}
				bind:value={drafts[section.id][name]}
			/>
		{/if}
	</Field>
{/snippet}

{#snippet fieldGroup(section: Section, meta: Meta, names: string[])}
	{#if names.length === 1}
		{@render field(section, meta, names[0])}
	{:else if names.length > 1}
		<FieldGrid>
			{#each names as name (name)}
				{@render field(section, meta, name)}
			{/each}
		</FieldGrid>
	{/if}
{/snippet}

{#snippet flagList(section: Section, meta: Meta, names: string[])}
	{#if names.length}
		<SettingsList>
			{#each names as name (name)}
				{@const locked = section.lockedFields.includes(name)}
				<ToggleRow
					label={meta.fields[name] ?? name}
					hint={locked ? 'Set by the environment' : hintFor(section, name)}
					disabled={locked}
					checked={flagOn(section, name)}
					onchange={() => toggleFlag(section, name)}
				/>
			{/each}
		</SettingsList>
	{/if}
{/snippet}

<Swap key={loading ? 'loading' : 'ready'}>
	{#if loading}
		<Stack>
			<Skeleton height="28rem" rounded="var(--radius-widget)" />
			<Skeleton height="14rem" rounded="var(--radius-widget)" />
		</Stack>
	{:else}
		<Stack>
			{#if loadError}
				<Alert tone="error" title="Couldn't load the configuration">{loadError}</Alert>
			{/if}

			{#each sections as section (section.id)}
				{@const meta = metaFor(section)}
				{@const allLocked = section.lockedFields.length === Object.keys(meta.fields).length}
				{@const names = namesIn(section, meta)}
				<div id={section.id}>
					<SectionCard title={meta.title} description={meta.description}>
						<div class="form">
							{#if section.id === 'storage' && !allLocked}
								{#if $instanceFeatures.storage.backups === 'local'}
									<Alert tone="warning">
										Backups are on this server. If you lose the server, you lose the backups.
									</Alert>
								{/if}
								<FieldGrid>
									<Field label="Provider" for="storage-preset">
										<Dropdown
											id="storage-preset"
											placeholder="Fills in the fields"
											options={providerOptions}
											bind:value={storagePreset}
											onchange={applyStoragePreset}
										/>
									</Field>
									{#if presetProvider?.placeLabel}
										<Field label={presetProvider.placeLabel} for="storage-place">
											<Input
												id="storage-place"
												placeholder={presetProvider.placeDefault}
												bind:value={storagePlace}
												oninput={applyStoragePreset}
											/>
										</Field>
									{/if}
								</FieldGrid>
							{/if}
							{#if allLocked && lockedChanges(section).length === 0}
								<Alert tone="info" title="Set by the environment">
									Every field here comes from an environment variable. To change one, edit your
									values file and restart.
								</Alert>
							{/if}

							{@render fieldGroup(section, meta, names.fields)}

							{#each lockedChanges(section) as change (change.title)}
								<SettingCommand {change} />
							{/each}

							{@render flagList(section, meta, names.flags)}

							{#if names.advancedFields.length || names.advancedFlags.length}
								<Disclosure title="Advanced" note={advancedNote(section, names.advancedFields)}>
									{@render fieldGroup(section, meta, names.advancedFields)}
									{@render flagList(section, meta, names.advancedFlags)}
								</Disclosure>
							{/if}

							{#if section.id === 'storage' && storageResult}
								<div in:presence out:presence>
									<Alert tone={storageResult.ok ? 'success' : 'error'}>
										{storageResult.ok ? 'Connection works.' : storageResult.message}
									</Alert>
								</div>
							{/if}

							{#if !allLocked}
								<FormActions
									hint={section.id === 'storage'
										? 'Only new databases use this. Existing ones keep their storage and backups.'
										: undefined}
								>
									{#if section.id === 'storage'}
										<Button loading={storageTesting} onclick={testStorage}>Test connection</Button>
									{/if}
									<Button
										variant="ghost"
										disabled={!isDirty(section) || saving === section.id}
										onclick={() => discard(section)}
									>
										Discard
									</Button>
									<Button
										variant="primary"
										loading={saving === section.id}
										disabled={!isDirty(section)}
										onclick={() => save(section)}
									>
										Save
									</Button>
								</FormActions>
							{/if}
						</div>
					</SectionCard>
				</div>
			{/each}

			<ResourceLimitsSetting change={changes.limits} />
			<NewOrgDefaults />
			<McpToggle change={changes.mcp} />
			<ImageScanning />
			<FastBuilderSetting />
			<DatabaseSettings />
			<TelemetryToggle />
		</Stack>
	{/if}
</Swap>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
</style>
