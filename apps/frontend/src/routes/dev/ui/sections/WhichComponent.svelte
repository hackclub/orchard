<script lang="ts">
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Table, { type TableColumn } from '$lib/components/ui/Table.svelte';

	const TITLES: Record<string, string> = {
		foundations: 'Colour, radius, space',
		buttons: 'Buttons',
		menus: 'Menus',
		inputs: 'Inputs',
		forms: 'Choices and forms',
		settings: 'Settings rows and uploads',
		pickers: 'Pickers',
		tabs: 'Tabs',
		lists: 'Lists and cards',
		data: 'Tables, code and logs',
		status: 'Status',
		feedback: 'Toasts and alerts',
		progress: 'Progress and loading',
		overlays: 'Dialogs, sheets and popovers',
		small: 'Small things',
		patterns: 'App patterns'
	};

	type Row = { need: string; use: string[]; note?: string; section: string };

	const ROWS: Row[] = [
		{ need: 'App layout', use: ['AppFrame', 'Sidebar'], section: 'patterns' },
		{ need: 'Page', use: ['Page'], note: 'title, actions, aside, hero', section: 'patterns' },
		{ need: 'Small heading above a group', use: ['SectionTitle'], section: 'patterns' },
		{ need: 'Group of content', use: ['SectionCard'], section: 'foundations' },
		{
			need: 'Plain container',
			use: ['Card'],
			note: 'href or onclick makes it interactive',
			section: 'lists'
		},
		{
			need: 'A project and its resources',
			use: ['ProjectGroup', 'EntityCard'],
			section: 'patterns'
		},
		{ need: 'Project page header', use: ['ProjectHero', 'ProjectBackdrop'], section: 'patterns' },
		{ need: 'Rows of things', use: ['List', 'ListRow', 'EntityRow'], section: 'lists' },
		{
			need: 'Things deployed together',
			use: ['StackRow'],
			note: 'compose stacks',
			section: 'lists'
		},
		{ need: 'Table of data', use: ['Table'], section: 'data' },
		{ need: 'Numbers', use: ['Metric', 'Sparkline', 'Ring'], section: 'lists' },
		{ need: 'Inline facts', use: ['MetaList'], note: 'url, branch, commit', section: 'patterns' },
		{ need: 'Action', use: ['Button'], note: 'one primary per view', section: 'buttons' },
		{ need: 'Actions on a thing', use: ['Menu', 'MenuItem'], section: 'menus' },
		{ need: 'Pick a value', use: ['Select', 'Dropdown', 'Combobox'], section: 'pickers' },
		{
			need: 'Add people',
			use: ['Combobox', 'Avatar', 'Dropdown'],
			note: 'creatable invite by email, role beside it',
			section: 'pickers'
		},
		{ need: 'Text entry', use: ['Field', 'Input', 'Textarea'], section: 'inputs' },
		{ need: 'Numbers and ranges', use: ['Stepper', 'Slider'], section: 'forms' },
		{ need: 'On or off', use: ['Switch', 'ToggleRow', 'Checkbox'], section: 'inputs' },
		{
			need: 'A setting that is one action',
			use: ['ActionRow'],
			note: 'transfer, move, delete',
			section: 'settings'
		},
		{ need: 'Upload an image', use: ['ImageField'], note: 'preview well', section: 'settings' },
		{ need: 'One of few', use: ['SegmentedControl', 'RadioGroup'], section: 'inputs' },
		{ need: 'Sections of a page', use: ['Tabs', 'Breadcrumbs'], section: 'tabs' },
		{ need: 'Sidebar link', use: ['NavItem'], section: 'patterns' },
		{ need: 'Identity', use: ['Monogram', 'Avatar', 'AvatarStack', 'Aura'], section: 'data' },
		{ need: 'Something happened', use: ['toasts.add()'], section: 'feedback' },
		{ need: 'Something is wrong here', use: ['Alert'], section: 'feedback' },
		{
			need: 'Status',
			use: ['StatusBadge', 'StatusDot'],
			note: 'via ui/status.ts only',
			section: 'status'
		},
		{ need: 'Label that is not status', use: ['Badge'], section: 'status' },
		{ need: 'Short hint', use: ['Tooltip'], section: 'overlays' },
		{ need: 'Floating panel', use: ['PopoverPanel'], section: 'overlays' },
		{ need: 'Dialog', use: ['Modal', 'ConfirmModal'], section: 'overlays' },
		{ need: 'Side panel for create or edit', use: ['Sheet'], section: 'overlays' },
		{ need: 'Command palette', use: ['CommandMenu'], section: 'overlays' },
		{ need: 'Loading', use: ['Skeleton', 'Spinner', 'Progress', 'StepRail'], section: 'progress' },
		{ need: 'Nothing here', use: ['EmptyState'], note: 'always with an action', section: 'lists' },
		{
			need: 'Code and config',
			use: ['CodeBlock', 'Snippet', 'EnvVarRow', 'LogViewer'],
			note: 'syntax colours a known language',
			section: 'data'
		},
		{
			need: 'Edit a file',
			use: ['CodeEditor'],
			note: 'same colours as CodeBlock',
			section: 'data'
		},
		{ need: 'Keys and IDs', use: ['Kbd', 'CopyButton', 'MiddleTruncate'], section: 'small' },
		{ need: 'Featured banner', use: ['FeatureHero'], section: 'create' },
		{ need: 'Ways to start', use: ['Dock'], note: 'big tiles in one tray', section: 'create' },
		{ need: 'Row of things to pick', use: ['Shelf'], section: 'create' },
		{ need: 'Separator', use: ['Divider'], note: 'label for "or"', section: 'small' },
		{ need: 'Icon square', use: ['ToneTile'], note: 'status tones or accent', section: 'small' },
		{ need: 'One-time code', use: ['CodeInput'], section: 'vine' },
		{ need: 'Sign-in screen', use: ['AuthShell', 'SignInFlow'], section: 'vine' },
		{ need: 'Times', use: ['RelativeTime'], section: 'data' }
	];

	const columns: TableColumn<Row>[] = [
		{ id: 'need', label: 'Need', width: 'minmax(12rem, 1fr)' },
		{ id: 'use', label: 'Use', width: 'minmax(0, 1.6fr)' },
		{ id: 'section', label: 'See', width: '13rem' }
	];
</script>

<SectionCard
	title="Pick by need"
	description="Every need maps to exactly one answer. If it is not in this table, add it to the kit first."
	flush
>
	<Table
		{columns}
		rows={ROWS}
		dense
		inset={false}
		label="Which component to use"
		rowKey={(r) => r.need}
		rowHref={(r) => `#${r.section}`}
		rowLabel={(r) => `${r.need}: see ${TITLES[r.section]}`}
	>
		{#snippet cell(r, col)}
			{#if col.id === 'need'}
				<span class="text-body text-fg">{r.need}</span>
			{:else if col.id === 'use'}
				<span class="flex min-w-0 items-baseline gap-2">
					<span class="names">
						{#each r.use as name (name)}<span class="font-mono text-callout text-fg">{name}</span
							>{/each}
					</span>
					{#if r.note}<span class="min-w-0 truncate text-callout text-faint">{r.note}</span>{/if}
				</span>
			{:else}
				<span class="text-callout text-link">{TITLES[r.section]}</span>
			{/if}
		{/snippet}
	</Table>
</SectionCard>

<style>
	.names {
		display: inline-flex;
		gap: 0.75rem;
		flex-shrink: 0;
		white-space: nowrap;
	}
</style>
