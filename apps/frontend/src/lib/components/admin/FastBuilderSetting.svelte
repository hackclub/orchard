<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, instanceFeatures, toasts } from '$lib/stores';
	import { Alert, Badge, Button, SectionCard } from '$lib/components/ui';
	import RadioGroup from '$lib/components/ui/RadioGroup.svelte';

	type Routing = 'all' | 'per_app' | 'off' | 'flag';

	interface State {
		value: Routing;
		dbValue: Routing | null;
		fallback: Routing;
		available: boolean;
		flagConfigured?: boolean;
	}

	const DOCS_URL = 'https://docs.orchard.hackclub.com/operate/fast-builder/';

	const ORDER: Routing[] = ['all', 'per_app', 'off', 'flag'];

	const COPY: Record<Routing, { label: string; description: string; saved: string }> = {
		all: {
			label: 'All builds',
			description:
				"Every app uses the fast builder unless it's switched off in the app's settings.",
			saved: 'Every app uses the fast builder'
		},
		per_app: {
			label: 'Only apps that opt in',
			description:
				'Apps use the standard builder unless the fast builder is turned on in their settings.',
			saved: 'Only apps that opt in use the fast builder'
		},
		off: {
			label: 'Off',
			description:
				'Every build uses the standard builder, even apps that turned the fast builder on.',
			saved: 'Fast builder off'
		},
		flag: {
			label: 'PostHog flag',
			description: 'Auto follows the firecracker-builder feature flag.',
			saved: 'Fast builder follows the feature flag'
		}
	};

	let state = $state<State | null>(null);
	let saving = $state(false);
	let picked = $state<string>('flag');

	const options = $derived(
		ORDER.filter(
			(r) => r !== 'flag' || state?.value === 'flag' || state?.flagConfigured === true
		).map((r) => ({
			value: r,
			label: COPY[r].label,
			description: COPY[r].description,
			disabled: saving
		}))
	);

	async function load() {
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/fast-builder');
			if (!res.ok) return;
			state = await res.json();
			picked = state?.value ?? 'flag';
		} catch {
			state = null;
		}
	}

	async function choose(next: string) {
		if (!state || next === state.value) return;
		saving = true;
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/fast-builder', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: next })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.message || "Couldn't save");
			state = body;
			picked = body.value;
			await instanceFeatures.load(true);
			toasts.add({ title: COPY[next as Routing].saved, color: 'success' });
		} catch (e) {
			picked = state.value;
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

{#if state}
	<SectionCard title="Fast builder" description="Choose which apps build with the fast builder.">
		<div class="body">
			{#if !state.available}
				<Alert tone="info" title="Fast builder hosts aren't running">
					Every build uses the standard builder until they are. Run
					<code>orchardctl fast-builder enable</code> on the server to start them.
					{#snippet actions()}
						<Button
							size="sm"
							variant="ghost"
							href={DOCS_URL}
							target="_blank"
							rel="noopener noreferrer"
						>
							Read the guide
						</Button>
					{/snippet}
				</Alert>
			{/if}
			<RadioGroup
				label="Fast builder routing"
				variant="cards"
				columns={options.length === 4 ? 2 : 3}
				{options}
				bind:value={picked}
				onchange={choose}
			>
				{#snippet extra(opt)}
					{#if opt.value === state?.fallback}
						<Badge>Default</Badge>
					{/if}
				{/snippet}
			</RadioGroup>
		</div>
	</SectionCard>
{/if}

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
</style>
