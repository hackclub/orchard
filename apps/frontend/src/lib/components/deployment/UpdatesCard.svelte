<script lang="ts">
	import { onDestroy } from 'svelte';
	import { SectionCard, SegmentedControl, Stepper } from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';

	type Strategy = 'rollingUpdate' | 'recreate' | 'blueGreen';

	let {
		replicas,
		strategyValue,
		hasPvcVolume,
		onSaveStrategy,
		pdbMinAvailable = $bindable(1),
		onSavePdb
	}: {
		replicas: number;
		strategyValue: Strategy;
		hasPvcVolume: boolean;
		onSaveStrategy: (next: Strategy) => void;
		pdbMinAvailable: number;
		onSavePdb: () => void;
	} = $props();

	const uid = $props.id();

	const STRATEGIES = $derived([
		{ value: 'rollingUpdate', label: 'Rolling', disabled: hasPvcVolume },
		{ value: 'recreate', label: 'Recreate' },
		{ value: 'blueGreen', label: 'Blue/green', disabled: hasPvcVolume }
	]);

	const STRATEGY_HINTS: Record<Strategy, string> = {
		rollingUpdate: 'New pods start before old ones stop',
		recreate: 'Stops everything first, with brief downtime',
		blueGreen: 'Traffic moves once new pods are ready'
	};

	const strategyHint = $derived(
		hasPvcVolume
			? 'Apps with storage or devices stop everything first'
			: STRATEGY_HINTS[strategyValue]
	);

	let timer: ReturnType<typeof setTimeout> | undefined;
	let draft = $state(Number(pdbMinAvailable));

	$effect(() => {
		const saved = Number(pdbMinAvailable);
		if (!timer) draft = saved;
	});

	const keep = $derived(draft);
	const pdbHint = $derived(
		keep <= 0
			? 'A drain can take every pod down at once'
			: replicas > keep
				? 'Pods that stay up while a node drains'
				: `Applies above ${keep} ${keep === 1 ? 'replica' : 'replicas'}`
	);

	function flush() {
		timer = undefined;
		pdbMinAvailable = draft;
		onSavePdb();
	}

	function queuePdb() {
		clearTimeout(timer);
		timer = setTimeout(flush, 700);
	}

	onDestroy(() => {
		if (!timer) return;
		clearTimeout(timer);
		flush();
	});
</script>

<SectionCard title="Updates">
	<SettingsList>
		<SettingRow label="Strategy" hint={strategyHint}>
			<SegmentedControl
				label="Update strategy"
				options={STRATEGIES}
				bind:value={() => strategyValue, (next) => onSaveStrategy(next as Strategy)}
			/>
		</SettingRow>
		<SettingRow label="Keep ready during a drain" hint={pdbHint} for="{uid}-pdb">
			<Stepper
				id="{uid}-pdb"
				label="Pods kept ready during a drain"
				bind:value={draft}
				min={0}
				max={100}
				suffix="of {replicas}"
				onchange={queuePdb}
			/>
		</SettingRow>
	</SettingsList>
</SectionCard>
