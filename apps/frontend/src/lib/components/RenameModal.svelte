<script lang="ts">
	import { tick } from 'svelte';
	import { PenLine } from 'lucide-svelte';
	import type { Icon } from '$lib/components/ui/types';
	import { Modal, ModalIntro, Button, Input, Field } from '$lib/components/ui';

	let {
		open = $bindable(false),
		title = 'Rename',
		label = 'Name',
		value = '',
		placeholder = 'Name',
		saving = false,
		icon = PenLine,
		actionLabel = 'Rename',
		mono = false,
		validate = undefined,
		error = null,
		onSave
	}: {
		open?: boolean;
		title?: string;
		label?: string;
		value?: string;
		placeholder?: string;
		saving?: boolean;
		icon?: Icon;
		actionLabel?: string;
		mono?: boolean;
		validate?: (name: string) => string | null;
		error?: string | null;
		onSave: (name: string) => void;
	} = $props();

	const uid = $props.id();
	let name = $state('');

	$effect(() => {
		if (open) {
			name = value;
			touched = false;
		}
	});

	const next = $derived(name.trim());
	let touched = $state(false);
	let editedSinceError = $state(false);

	$effect(() => {
		void error;
		editedSinceError = false;
	});

	const shownError = $derived(editedSinceError ? null : error);
	const problem = $derived(validate && touched ? validate(name) : null);
	const canSave = $derived(!!next && next !== value && !(validate && validate(name)));

	function focusOnOpen(el: HTMLInputElement) {
		void tick().then(() => {
			el.focus();
			const dot = mono ? el.value.lastIndexOf('.') : -1;
			if (dot > 0) el.setSelectionRange(0, dot);
			else el.select();
		});
	}

	function submit() {
		if (canSave && !saving) onSave(next);
	}
</script>

<Modal bind:open size="sm" closable={false} dismissable labelledby="{uid}-title">
	<form
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<ModalIntro id="{uid}-title" {icon} {title} />
		<Field {label} for="{uid}-input" error={problem ?? shownError}>
			<Input
				id="{uid}-input"
				bind:value={name}
				{placeholder}
				{mono}
				error={!!(problem ?? shownError)}
				autocomplete="off"
				spellcheck={false}
				oninput={() => {
					touched = true;
					editedSinceError = true;
				}}
				{@attach focusOnOpen}
			/>
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="ghost" disabled={saving} onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" loading={saving} disabled={!canSave} onclick={submit}
			>{actionLabel}</Button
		>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
