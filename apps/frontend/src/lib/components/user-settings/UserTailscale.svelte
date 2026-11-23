<script lang="ts">
	import { Globe } from 'lucide-svelte';
	import {
		Button,
		Field,
		Input,
		List,
		ListRow,
		Modal,
		ModalIntro,
		SecretInput,
		SectionCard,
		ToneTile
	} from '$lib/components/ui';

	let {
		tailscaleLoading,
		tailscaleLinked,
		tailscaleTailnet,
		unlinkingTailscale,
		showTailscaleForm = $bindable(false),
		tailscaleApiKey = $bindable(''),
		tailscaleLoginServer = $bindable(''),
		linkingTailscale,
		onLink,
		onUnlink
	}: {
		tailscaleLoading: boolean;
		tailscaleLinked: boolean;
		tailscaleTailnet: string | null;
		unlinkingTailscale: boolean;
		showTailscaleForm: boolean;
		tailscaleApiKey: string;
		tailscaleLoginServer?: string;
		linkingTailscale: boolean;
		onLink: () => void;
		onUnlink: () => void;
		index?: number;
	} = $props();

	const uid = $props.id();

	function reset() {
		tailscaleApiKey = '';
		tailscaleLoginServer = '';
	}

	function cancel() {
		showTailscaleForm = false;
		reset();
	}
</script>

<SectionCard title="Tailscale" description="Reach your apps from your private network">
	{#snippet actions()}
		{#if !tailscaleLoading && !tailscaleLinked}
			<Button size="sm" onclick={() => (showTailscaleForm = true)}>Connect</Button>
		{/if}
	{/snippet}
	{#if !tailscaleLoading && tailscaleLinked}
		<List inset={false} label="Tailnet">
			<ListRow flush pinned title={tailscaleTailnet ?? ''}>
				{#snippet leading()}<ToneTile size={32}><Globe size={16} /></ToneTile>{/snippet}
				{#snippet actions()}
					<Button size="sm" variant="ghost" loading={unlinkingTailscale} onclick={onUnlink}
						>Disconnect</Button
					>
				{/snippet}
			</ListRow>
		</List>
	{/if}
</SectionCard>

<Modal
	bind:open={showTailscaleForm}
	size="md"
	closable={false}
	dismissable
	labelledby="{uid}-title"
	onclose={reset}
>
	<form
		id="{uid}-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			if (tailscaleApiKey.trim()) onLink();
		}}
	>
		<ModalIntro
			id="{uid}-title"
			icon={Globe}
			tone="accent"
			title="Connect Tailscale"
			description="Paste an auth key from your tailnet."
		/>
		<ol class="steps">
			<li>
				Open <a
					href="https://login.tailscale.com/admin/settings/keys"
					target="_blank"
					rel="noopener noreferrer">Settings, Keys</a
				>
				in the Tailscale admin and click <strong>Generate auth key</strong>
			</li>
			<li>Turn on <strong>Reusable</strong> and <strong>Ephemeral</strong>, leave tags empty</li>
			<li>Set it to expire in <strong>90 days</strong>, the longest Tailscale allows</li>
		</ol>
		<Field label="Auth key" for="{uid}-key">
			<SecretInput id="{uid}-key" bind:value={tailscaleApiKey} placeholder="tskey-auth-..." />
		</Field>
		<Field
			label="Login server (optional)"
			for="{uid}-server"
			hint="Only for a self-hosted control server such as Headscale. Paste a reusable pre-auth key from that server above."
		>
			<Input
				id="{uid}-server"
				type="url"
				inputmode="url"
				autocomplete="off"
				spellcheck="false"
				bind:value={tailscaleLoginServer}
				placeholder="https://headscale.example.com"
			/>
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="ghost" disabled={linkingTailscale} onclick={cancel}>Cancel</Button>
		<Button
			variant="primary"
			loading={linkingTailscale}
			disabled={!tailscaleApiKey.trim()}
			type="submit"
			form="{uid}-form">Connect</Button
		>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.steps {
		margin: 0;
		padding-left: 1.25rem;
		list-style: decimal;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.steps strong {
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.steps a {
		color: var(--text-link);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
