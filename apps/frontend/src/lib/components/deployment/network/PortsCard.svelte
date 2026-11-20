<script lang="ts">
	import { Ellipsis, EthernetPort, MonitorSmartphone, PenLine, Plus, Trash2 } from 'lucide-svelte';
	import {
		Badge,
		Button,
		List,
		ListRow,
		Menu,
		MenuItem,
		MenuSeparator,
		Switch,
		ToneTile
	} from '$lib/components/ui';
	import Widget from '$lib/components/ui/Widget.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import PublicAddressLine from './PublicAddressLine.svelte';
	import { bareAddress, type PortEntry } from './network';

	let {
		entries,
		tailnet,
		busyPortId,
		deletingServiceId,
		onAdd,
		onPublic,
		onPreserveClientIp,
		onEdit,
		onRemove
	}: {
		entries: PortEntry[];
		tailnet: {
			enabled: boolean;
			linked: boolean;
			exposed: boolean;
			busy: boolean;
			host: string | null;
			onExpose: () => void;
			onUnexpose: () => void;
		};
		busyPortId: string | null;
		deletingServiceId: string | null;
		onAdd: () => void;
		onPublic: (entry: PortEntry, on: boolean) => void;
		onPreserveClientIp: (entry: PortEntry, on: boolean) => void;
		onEdit: (entry: PortEntry) => void;
		onRemove: (entry: PortEntry) => void;
	} = $props();

	function isPublic(entry: PortEntry) {
		return !!entry.port.publicEnabled && !!entry.port.publicPort;
	}
</script>

<Widget title="Ports">
	{#snippet meta()}
		<Button variant="ghost" size="sm" icon={Plus} onclick={onAdd}>Add port</Button>
	{/snippet}

	{#if entries.length === 0}
		<div class="empty">
			<span>No ports yet</span>
		</div>
	{:else}
		<List inset={false} label="Ports">
			{#each entries as entry (entry.key)}
				{@const open = isPublic(entry)}
				{@const busy = !!entry.port.id && busyPortId === entry.port.id}
				<ListRow flush pinned presence title="Port {entry.port.targetPort}">
					{#snippet leading()}
						<ToneTile tone="neutral" solid size={32}
							><EthernetPort size={15} strokeWidth={2.25} /></ToneTile
						>
					{/snippet}
					{#snippet titleSuffix()}
						<Badge>{(entry.port.protocol || 'TCP').toUpperCase()}</Badge>
						{#if open && entry.port.preserveClientIp}<Badge>Client IP</Badge>{/if}
					{/snippet}
					{#snippet subtitle()}
						<span class="addresses">
							{#if open && entry.port.publicAddress}
								<PublicAddressLine
									address={entry.port.publicAddress}
									status={entry.port.publicStatus}
								/>
							{:else if entry.internalUrl}
								<span class="address">{bareAddress(entry.internalUrl)}</span>
								<CopyButton value={entry.internalUrl} label="Copy private address" />
							{/if}
						</span>
					{/snippet}
					{#snippet actions()}
						<span class="acts">
							{#if entry.port.id}
								<label class="public">
									<span>Public</span>
									<Switch
										label="Public"
										disabled={busy}
										bind:checked={() => open, (on) => onPublic(entry, on)}
									/>
								</label>
							{/if}
							<Menu placement="bottom-end">
								{#snippet trigger(props)}
									<Button
										{...props}
										variant="ghost"
										size="sm"
										icon={Ellipsis}
										label="Port {entry.port.targetPort} actions"
										loading={deletingServiceId === entry.service.id || busy}
									/>
								{/snippet}
								{#if open && entry.internalUrl}
									<MenuItem onclick={() => navigator.clipboard.writeText(entry.internalUrl ?? '')}
										>Copy private address</MenuItem
									>
									<MenuSeparator />
								{/if}
								{#if open}
									<MenuItem onclick={() => onPreserveClientIp(entry, !entry.port.preserveClientIp)}
										>{entry.port.preserveClientIp
											? 'Stop keeping client addresses'
											: 'Keep client addresses'}</MenuItem
									>
									<MenuSeparator />
								{/if}
								<MenuItem icon={PenLine} onclick={() => onEdit(entry)}>Change port…</MenuItem>
								<MenuSeparator />
								<MenuItem icon={Trash2} danger onclick={() => onRemove(entry)}>Remove port</MenuItem
								>
							</Menu>
						</span>
					{/snippet}
				</ListRow>
			{/each}
			{#if tailnet.enabled}
				<ListRow flush pinned title="Tailscale">
					{#snippet leading()}
						<ToneTile tone="neutral" solid size={32}
							><MonitorSmartphone size={15} strokeWidth={2.25} /></ToneTile
						>
					{/snippet}
					{#snippet subtitle()}
						{#if tailnet.exposed && tailnet.host}
							<span class="addresses">
								<span class="address">{tailnet.host}</span>
								<CopyButton value={tailnet.host} label="Copy Tailscale address" />
							</span>
						{:else if !tailnet.linked}
							<a class="link" href="/user/settings">Link your account</a>
						{:else if tailnet.exposed}
							<span>Not connected to your tailnet yet</span>
						{/if}
					{/snippet}
					{#snippet actions()}
						<span class="acts">
							<label class="public">
								<span>On</span>
								<Switch
									label="Tailscale"
									disabled={tailnet.busy || !tailnet.linked}
									bind:checked={
										() => tailnet.exposed, (on) => (on ? tailnet.onExpose() : tailnet.onUnexpose())
									}
								/>
							</label>
							<span class="slot" aria-hidden="true"></span>
						</span>
					{/snippet}
				</ListRow>
			{/if}
		</List>
	{/if}
</Widget>

<style>
	.addresses {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		pointer-events: auto;
	}
	.address {
		min-width: 0;
		overflow-x: clip;
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.addresses :global(button) {
		width: 1.5rem;
		height: 1.5rem;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-right: -0.4375rem;
	}
	.public {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-muted);
		font-size: var(--text-footnote);
		cursor: pointer;
	}
	.slot {
		width: 2rem;
	}
	.link {
		color: var(--text-link);
	}
	.empty {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		min-height: 3rem;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
</style>
