<script lang="ts">
	import { env } from '$env/dynamic/public';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { Service, ServiceFormState, ServicePortForm } from '$lib/types/deployment';
	import { Plug } from 'lucide-svelte';
	import { Alert, Button, Modal, ModalIntro } from '$lib/components/ui';
	import Checkbox from '$lib/components/ui/Checkbox.svelte';
	import DomainsCard from './network/DomainsCard.svelte';
	import PortsCard from './network/PortsCard.svelte';
	import DomainModal from './network/DomainModal.svelte';
	import ProtectionModal from './network/ProtectionModal.svelte';
	import RedirectModal from './network/RedirectModal.svelte';
	import DnsModal from './network/DnsModal.svelte';
	import PortModal from './network/PortModal.svelte';
	import {
		displayHost,
		portEntries,
		portKeyOf,
		type DnsCheck,
		type PortEntry,
		type ProtectionMode
	} from './network/network';

	const APP_DOMAIN = env.PUBLIC_APP_DOMAIN ?? '';

	let {
		deployment,
		tailscaleFeatureEnabled = false,
		tailscaleLinked,
		tailscaleExposing,
		tailscaleUnexposing,
		tailscaleDns,
		tailscaleIp,
		onExposeTailscale,
		onUnexposeTailscale,
		showServiceForm = $bindable(),
		newServiceForm = $bindable(),
		serviceFormError,
		serviceEditForms = $bindable(),
		serviceEditErrors,
		creatingService,
		serviceSavingId,
		serviceDeletingId,
		portPublicBusyId,
		isEditingServices = $bindable(),
		onCreateService,
		onSaveServicePorts,
		onDeleteService,
		onToggleServiceEdit,
		onTogglePortPublic,
		onResetNewServiceForm,
		onUpdateNewServicePort,
		onUpdateServiceEditPort,
		showDomainForm = $bindable(),
		newDomainHost = $bindable(),
		newDomainPath = $bindable(),
		newDomainTlsEnabled = $bindable(),
		newDomainServiceKey = $bindable(),
		newDomainRoutingMode = $bindable(),
		newDomainRedirectTarget = $bindable(),
		newDomainRedirectStatus = $bindable(),
		showDomainAdvanced = $bindable(),
		creatingDomain,
		domainFormError,
		domainServiceOptions,
		newDomainNormalizedHost,
		newDomainNormalizedPath,
		newDomainConflict,
		deletingIngressId,
		onCreateDomain,
		onDeleteIngress,
		onResetDomainForm,
		onGenerateRandomDomain,
		onCheckDns,
		onUpdateProtection,
		onUpdateRedirect,
		redirectUpdatingId = null,
		protectionUpdatingId,
		projectIngresses = []
	}: {
		deployment: any;
		tailscaleFeatureEnabled?: boolean;
		tailscaleLinked: boolean;
		tailscaleExposing: boolean;
		tailscaleUnexposing: boolean;
		tailscaleDns: string | null;
		tailscaleIp: string | null;
		tailscaleHostname: string | null;
		onExposeTailscale: () => void;
		onUnexposeTailscale: () => void;
		showServiceForm: boolean;
		newServiceForm: ServiceFormState;
		serviceFormError: string | null;
		serviceEditForms: Record<string, ServiceFormState>;
		serviceEditErrors: Record<string, string | null>;
		creatingService: boolean;
		serviceSavingId: string | null;
		serviceDeletingId: string | null;
		portPublicBusyId: string | null;
		isEditingServices: boolean;
		onCreateService: () => void;
		onSaveServicePorts: (serviceId: string) => void;
		onDeleteService: (serviceId: string) => void;
		onToggleServiceEdit: (service: Service) => void;
		onTogglePortPublic: (
			serviceId: string,
			portId: string,
			currentlyEnabled: boolean,
			preserveClientIp?: boolean
		) => void;
		onResetNewServiceForm: () => void;
		onUpdateNewServicePort: (index: number, changes: Partial<ServicePortForm>) => void;
		onUpdateServiceEditPort: (
			serviceId: string,
			index: number,
			changes: Partial<ServicePortForm>
		) => void;
		onCopyInternalUrl?: (url: string | undefined, serviceId: string) => void;
		copiedUrlId?: string | null;
		showDomainForm: boolean;
		newDomainHost: string;
		newDomainPath: string;
		newDomainTlsEnabled: boolean;
		newDomainServiceKey: string;
		newDomainRoutingMode: 'service' | 'redirect';
		newDomainRedirectTarget: string;
		newDomainRedirectStatus: string;
		showDomainAdvanced: boolean;
		creatingDomain: boolean;
		domainFormError: string | null;
		domainServiceOptions: Array<{ key: string; label: string; serviceName: string; port: number }>;
		newDomainNormalizedHost: string;
		newDomainNormalizedPath: string;
		newDomainConflict: { otherDeployment: boolean; pathCollision: boolean } | null;
		deletingIngressId: string | null;
		onCreateDomain: () => void;
		onDeleteIngress: (ingressId: string) => void;
		onResetDomainForm: () => void;
		onGenerateRandomDomain: () => void;
		onCheckDns?: (domain: string) => Promise<DnsCheck>;
		onUpdateRedirect?: (
			ingressId: string,
			data: { host: string; redirectTarget: string; redirectStatus: number }
		) => Promise<void>;
		redirectUpdatingId?: string | null;
		onUpdateProtection?: (
			ingressId: string,
			mode: string,
			password?: string,
			bypassPaths?: string[],
			username?: string
		) => Promise<void> | void;
		protectionUpdatingId?: string | null;
		toasts?: unknown;
		projectIngresses?: Array<{
			host: string;
			path?: string;
			deploymentId?: string | null;
			deploymentName?: string;
		}>;
	} = $props();

	const ingresses = $derived<any[]>(deployment.ingresses ?? []);
	const services = $derived<any[]>(deployment.services ?? []);
	const entries = $derived(portEntries(deployment.services));
	const tailnet = $derived({
		enabled: tailscaleFeatureEnabled,
		linked: tailscaleLinked,
		exposed: !!deployment.tailscaleExposed,
		busy: tailscaleExposing || tailscaleUnexposing,
		host: tailscaleDns || tailscaleIp || null,
		onExpose: onExposeTailscale,
		onUnexpose: onUnexposeTailscale
	});

	let protectionOpen = $state(false);
	let protectionFor = $state<any | null>(null);
	let redirectOpen = $state(false);
	let redirectFor = $state<any | null>(null);
	let dnsOpen = $state(false);
	let dnsFor = $state<any | null>(null);
	let removeDomainOpen = $state(false);
	let removeDomainFor = $state<any | null>(null);
	let removePortOpen = $state(false);
	let removePortFor = $state<PortEntry | null>(null);
	let unexposeOpen = $state(false);
	let unexposeFor = $state<PortEntry | null>(null);
	let editingServiceId = $state<string | null>(null);
	let openPortFor = $state<PortEntry | null>(null);
	let openPortOpen = $state(false);
	let openPortPreserveClientIp = $state(false);

	const webPorts = $derived(
		entries.filter((e) => (e.port.protocol || 'TCP').toUpperCase() !== 'UDP')
	);

	function portOf(ingress: any): number | null {
		if (ingress.redirectTarget || webPorts.length < 2) return null;
		const key = portKeyOf(ingress, entries);
		return entries.find((e) => e.key === key)?.port.targetPort ?? null;
	}

	function setPublic(entry: PortEntry, on: boolean) {
		if (!entry.port.id) return;
		if (on) {
			openPortFor = entry;
			openPortPreserveClientIp = false;
			openPortOpen = true;
		} else {
			unexposeFor = entry;
			unexposeOpen = true;
		}
	}

	function confirmOpenPort() {
		const entry = openPortFor;
		openPortOpen = false;
		if (entry?.port.id)
			onTogglePortPublic(entry.service.id, entry.port.id, false, openPortPreserveClientIp);
	}

	function setPreserveClientIp(entry: PortEntry, on: boolean) {
		if (entry.port.id) onTogglePortPublic(entry.service.id, entry.port.id, false, on);
	}

	const editForm = $derived(editingServiceId ? serviceEditForms[editingServiceId] : undefined);
	const removePortSiblings = $derived(
		removePortFor
			? entries
					.filter((e) => e.service.id === removePortFor!.service.id)
					.map((e) => e.port.targetPort)
			: []
	);

	function openAddPort() {
		showServiceForm = true;
		isEditingServices = true;
	}

	function cancelAddPort() {
		showServiceForm = false;
		onResetNewServiceForm();
		if (Object.keys(serviceEditForms).length === 0) isEditingServices = false;
	}

	function openEditPort(entry: PortEntry) {
		editingServiceId = entry.service.id;
		if (!serviceEditForms[entry.service.id]) onToggleServiceEdit(entry.service);
	}

	function cancelEditPort() {
		const id = editingServiceId;
		editingServiceId = null;
		const service = services.find((s) => s.id === id);
		if (service && serviceEditForms[service.id]) onToggleServiceEdit(service);
	}

	function sharedWith(ingress: any): string | null {
		const path = ingress.path || '/';
		const others = projectIngresses.filter(
			(r) => r.host === ingress.host && (r.path || '/') !== path
		);
		if (others.length === 0) return null;
		const names = others.map(
			(r) =>
				`${r.deploymentId === deployment.id ? 'this app' : (r.deploymentName ?? 'another app')} at ${r.path || '/'}`
		);
		if (names.length > 2) return `Shared with ${names.length} other paths`;
		return `Shared with ${names.join(' and ')}`;
	}

	function openProtection(ingress: any) {
		protectionFor = ingress;
		protectionOpen = true;
	}

	function openRedirect(ingress: any) {
		redirectFor = ingress;
		redirectOpen = true;
	}

	function openDns(ingress: any) {
		dnsFor = ingress;
		dnsOpen = true;
	}

	function askRemoveDomain(ingress: any) {
		removeDomainFor = ingress;
		removeDomainOpen = true;
	}

	async function saveProtection(
		mode: ProtectionMode,
		password?: string,
		paths?: string[],
		username?: string
	) {
		if (!protectionFor || !onUpdateProtection) return;
		try {
			await onUpdateProtection(protectionFor.id, mode, password, paths, username);
			protectionOpen = false;
		} catch {
			protectionOpen = true;
		}
	}

	async function saveRedirect(data: {
		host: string;
		redirectTarget: string;
		redirectStatus: number;
	}) {
		if (!redirectFor || !onUpdateRedirect) return;
		try {
			await onUpdateRedirect(redirectFor.id, data);
			redirectOpen = false;
		} catch {
			redirectOpen = true;
		}
	}
</script>

<div class="network">
	<DomainsCard
		domains={ingresses}
		appDomain={APP_DOMAIN}
		{portOf}
		canAdd={!!deployment.project?.id && domainServiceOptions.length > 0}
		canProtect={!!onUpdateProtection}
		canEditRedirect={!!onUpdateRedirect}
		{deletingIngressId}
		{sharedWith}
		onAdd={() => (showDomainForm = true)}
		onProtection={openProtection}
		onRedirect={openRedirect}
		onDns={openDns}
		onRemove={askRemoveDomain}
	/>
	<PortsCard
		{entries}
		{tailnet}
		busyPortId={portPublicBusyId}
		deletingServiceId={serviceDeletingId}
		onAdd={openAddPort}
		onPublic={setPublic}
		onPreserveClientIp={setPreserveClientIp}
		onEdit={openEditPort}
		onRemove={(entry) => {
			removePortFor = entry;
			removePortOpen = true;
		}}
	/>
</div>

<Modal bind:open={openPortOpen} size="sm" closable={false} dismissable labelledby="open-port-title">
	<div class="open-port">
		<ModalIntro
			id="open-port-title"
			icon={Plug}
			tone="success"
			solid
			title="Make port {openPortFor?.port.targetPort ?? ''} public"
		/>
		<Alert tone="warning">Anyone on the internet can reach this port.</Alert>
		<Checkbox
			bind:checked={openPortPreserveClientIp}
			label="Keep client addresses"
			hint="The app sees each visitor's real IP, which mail servers and IP rate limits need. Only nodes running the app answer on this port."
		/>
	</div>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (openPortOpen = false)}>Cancel</Button>
		<Button variant="primary" onclick={confirmOpenPort}>Make public</Button>
	{/snippet}
</Modal>

<DomainModal
	bind:open={showDomainForm}
	bind:host={newDomainHost}
	bind:path={newDomainPath}
	bind:tls={newDomainTlsEnabled}
	bind:serviceKey={newDomainServiceKey}
	bind:routing={newDomainRoutingMode}
	bind:redirectTarget={newDomainRedirectTarget}
	bind:redirectStatus={newDomainRedirectStatus}
	bind:advanced={showDomainAdvanced}
	appDomain={APP_DOMAIN}
	creating={creatingDomain}
	error={domainFormError}
	serviceOptions={domainServiceOptions}
	normalizedHost={newDomainNormalizedHost}
	normalizedPath={newDomainNormalizedPath}
	deploymentId={deployment.id}
	projectRoutes={projectIngresses}
	onCreate={onCreateDomain}
	onReset={onResetDomainForm}
	onGenerate={onGenerateRandomDomain}
	{onCheckDns}
/>

<ProtectionModal
	bind:open={protectionOpen}
	ingress={protectionFor}
	projectId={deployment.project?.id}
	saving={!!protectionFor && protectionUpdatingId === protectionFor.id}
	onSave={saveProtection}
/>

<RedirectModal
	bind:open={redirectOpen}
	ingress={redirectFor}
	saving={!!redirectFor && redirectUpdatingId === redirectFor.id}
	onSave={saveRedirect}
/>

<DnsModal bind:open={dnsOpen} host={dnsFor?.host ?? ''} {onCheckDns} />

<PortModal
	open={showServiceForm}
	title="Add a port"
	submitLabel="Add port"
	ports={newServiceForm.ports}
	error={serviceFormError}
	saving={creatingService}
	onUpdate={onUpdateNewServicePort}
	onSubmit={onCreateService}
	onCancel={cancelAddPort}
/>

<PortModal
	open={!!editForm}
	title={(editForm?.ports.length ?? 0) > 1 ? 'Edit ports' : 'Edit port'}
	submitLabel="Save"
	ports={editForm?.ports ?? []}
	error={editingServiceId ? (serviceEditErrors[editingServiceId] ?? null) : null}
	saving={!!editingServiceId && serviceSavingId === editingServiceId}
	onUpdate={(index, changes) =>
		editingServiceId && onUpdateServiceEditPort(editingServiceId, index, changes)}
	onSubmit={() => editingServiceId && onSaveServicePorts(editingServiceId)}
	onCancel={cancelEditPort}
/>

<ConfirmModal
	bind:open={removeDomainOpen}
	title="Remove {removeDomainFor ? displayHost(removeDomainFor) : 'domain'}?"
	description="It stops serving right away."
	confirmLabel="Remove"
	onconfirm={() => removeDomainFor && onDeleteIngress(removeDomainFor.id)}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={removePortOpen}
	title={removePortSiblings.length > 1
		? `Remove ports ${removePortSiblings.join(' and ')}?`
		: `Remove port ${removePortFor?.port.targetPort ?? ''}?`}
	description={removePortSiblings.length > 1
		? 'Domains and apps that use them stop reaching this app.'
		: 'Domains and apps that use it stop reaching this app.'}
	confirmLabel="Remove"
	onconfirm={() => removePortFor && onDeleteService(removePortFor.service.id)}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={unexposeOpen}
	title="Make port {unexposeFor?.port.targetPort ?? ''} private?"
	description="Anyone connected loses the connection. Making it public again may give it a new address."
	confirmLabel="Make private"
	onconfirm={() =>
		unexposeFor?.port.id && onTogglePortPublic(unexposeFor.service.id, unexposeFor.port.id, true)}
	oncancel={() => {}}
/>

<style>
	.network {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.open-port {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.network :global(.net-pill) {
		border-radius: 999px;
		corner-shape: round;
	}
</style>
