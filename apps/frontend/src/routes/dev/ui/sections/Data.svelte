<script lang="ts">
	import { Box, Database, Folder, Plus, Timer, Trash2 } from 'lucide-svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import List from '$lib/components/ui/List.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import Monogram from '$lib/components/ui/Monogram.svelte';
	import Table, { type TableColumn, type TableSort } from '$lib/components/ui/Table.svelte';
	import CodeBlock from '$lib/components/ui/CodeBlock.svelte';
	import CodeEditor from '$lib/components/ui/CodeEditor.svelte';
	import CommandSnippet from '$lib/components/ui/Snippet.svelte';
	import EnvVarRow from '$lib/components/ui/EnvVarRow.svelte';
	import LogViewer from '$lib/components/ui/LogViewer.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import AvatarStack from '$lib/components/ui/AvatarStack.svelte';
	import AvatarEdit from '$lib/components/ui/AvatarEdit.svelte';
	import ItemLabel from '$lib/components/ui/ItemLabel.svelte';
	import Breadcrumbs from '$lib/components/ui/Breadcrumbs.svelte';
	import { resourceStatus } from '$lib/components/ui/status';
	import type { LogLine } from '$lib/utils/log-sources.svelte';

	const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

	type Row = {
		id: string;
		name: string;
		kind: 'deployment' | 'database' | 'job';
		state: string;
		build?: string;
		region: string;
		cpu: number;
		memory: number;
		rpm: number | null;
		updated: string;
	};

	const ROWS: Row[] = [
		{
			id: '1',
			name: 'web',
			kind: 'deployment',
			state: 'running',
			region: 'fsn1',
			cpu: 0.42,
			memory: 471,
			rpm: 12_480,
			updated: ago(3)
		},
		{
			id: '2',
			name: 'api',
			kind: 'deployment',
			state: 'running',
			build: 'building',
			region: 'fsn1',
			cpu: 0.88,
			memory: 812,
			rpm: 8_210,
			updated: ago(0.4)
		},
		{
			id: '3',
			name: 'postgres',
			kind: 'database',
			state: 'running',
			region: 'fsn1',
			cpu: 0.21,
			memory: 2_048,
			rpm: null,
			updated: ago(60 * 26)
		},
		{
			id: '4',
			name: 'worker',
			kind: 'deployment',
			state: 'crashing',
			region: 'hel1',
			cpu: 0.02,
			memory: 509,
			rpm: 0,
			updated: ago(12)
		},
		{
			id: '5',
			name: 'nightly-sync',
			kind: 'job',
			state: 'stopped',
			region: 'hel1',
			cpu: 0,
			memory: 0,
			rpm: null,
			updated: ago(60 * 9)
		},
		{
			id: '6',
			name: 'redis',
			kind: 'database',
			state: 'running',
			region: 'fsn1',
			cpu: 0.05,
			memory: 96,
			rpm: null,
			updated: ago(60 * 50)
		},
		{
			id: '7',
			name: 'docs',
			kind: 'deployment',
			state: 'running',
			region: 'ash',
			cpu: 0.11,
			memory: 188,
			rpm: 1_920,
			updated: ago(60 * 3)
		},
		{
			id: '8',
			name: 'og-images',
			kind: 'deployment',
			state: 'running',
			region: 'ash',
			cpu: 0.64,
			memory: 640,
			rpm: 4_402,
			updated: ago(45)
		},
		{
			id: '9',
			name: 'leaderboard',
			kind: 'deployment',
			state: 'running',
			region: 'fsn1',
			cpu: 0.33,
			memory: 356,
			rpm: 3_118,
			updated: ago(60 * 7)
		},
		{
			id: '10',
			name: 'mailer',
			kind: 'job',
			state: 'running',
			region: 'hel1',
			cpu: 0.08,
			memory: 128,
			rpm: null,
			updated: ago(20)
		},
		{
			id: '11',
			name: 'clickhouse',
			kind: 'database',
			state: 'running',
			region: 'hel1',
			cpu: 1.42,
			memory: 3_870,
			rpm: null,
			updated: ago(60 * 80)
		}
	];

	const KIND_ICON = { deployment: Box, database: Database, job: Timer };
	const fmt = new Intl.NumberFormat('en');

	const columns: TableColumn<Row>[] = [
		{ id: 'name', label: 'Name', sortable: true, width: 'minmax(10rem, 1.6fr)' },
		{ id: 'status', label: 'Status', width: 'minmax(7rem, 1fr)', sortValue: (r) => r.state },
		{ id: 'region', label: 'Region', sortable: true, width: '6rem' },
		{ id: 'cpu', label: 'CPU', numeric: true, sortable: true, width: '6rem' },
		{ id: 'memory', label: 'Memory', numeric: true, sortable: true, width: '7rem' },
		{ id: 'rpm', label: 'Requests/min', numeric: true, sortable: true, width: '8rem' },
		{
			id: 'updated',
			label: 'Updated',
			align: 'end',
			sortable: true,
			width: '7rem',
			sortValue: (r) => -new Date(r.updated).getTime()
		}
	];

	let sort = $state<TableSort | null>({ id: 'cpu', dir: 'desc' });
	let clicked = $state<string | null>(null);

	const ENV = [
		{
			name: 'DATABASE_URL',
			value: 'postgres://orchard:example-password@postgres.hackclub-site:5432/app',
			secret: true
		},
		{ name: 'REDIS_URL', value: 'redis://redis.hackclub-site:6379/0', secret: true, shared: true },
		{ name: 'STRIPE_SECRET_KEY', value: 'sk_test_example_not_a_real_key', secret: true },
		{ name: 'NODE_ENV', value: 'production', secret: false },
		{ name: 'PORT', value: '3000', secret: false },
		{ name: 'SENTRY_DSN', value: '', secret: true }
	];

	const DOCKERFILE = `FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]`;

	const TOML = `[build]
command = "pnpm build"

[deploy]
replicas = 2
region = "fsn1"
health_check = "/healthz"`;

	const ts = (s: string) => `<span class="log-ts">${s}</span>`;
	const RAW: [string, LogLine['level'], string][] = [
		['14:02:09.880', 'info', 'Starting container web-7d9f4c6b8-x2kqp'],
		['14:02:10.114', 'debug', 'Loaded 14 environment variables from orchard'],
		['14:02:10.402', 'info', 'Prisma schema loaded from prisma/schema.prisma'],
		['14:02:10.951', 'info', 'Connected to postgres at postgres.hackclub-site:5432'],
		['14:02:11.204', 'info', 'Listening on http://0.0.0.0:3000'],
		['14:02:14.677', 'info', '<span class="ansi-green-fg">GET</span> /api/sponsors 200 in 38ms'],
		['14:02:15.020', 'info', '<span class="ansi-green-fg">GET</span> / 200 in 112ms'],
		[
			'14:02:19.336',
			'warn',
			'Slow query on sponsors.findMany took 1204ms, consider an index on sponsors.tier'
		],
		['14:02:21.880', 'info', '<span class="ansi-cyan-fg">POST</span> /api/rsvp 201 in 64ms'],
		[
			'14:02:24.513',
			'error',
			'Unhandled rejection: StripeAuthenticationError: Invalid API Key provided: sk_test_exa************************'
		],
		[
			'14:02:24.514',
			'error',
			'    at StripeResource._makeRequest (node_modules/stripe/cjs/StripeResource.js:197:23)'
		],
		['14:02:26.042', 'info', '<span class="ansi-green-fg">GET</span> /healthz 200 in 2ms'],
		['14:02:31.700', 'info', '<span class="ansi-green-fg">GET</span> /events/arcade 200 in 91ms']
	];
	const LINES: LogLine[] = RAW.map(([t, level, msg], i) => ({
		key: `l${i}`,
		lineNo: i + 1,
		level,
		html: `${ts(t)}${msg}`
	}));
	let wrap = $state(true);
	let editing = $state(`import Fastify from 'fastify';

const app = Fastify({ logger: true });
app.get('/healthz', async () => ({ ok: true }));
await app.listen({ port: Number(process.env.PORT ?? 3000) });
`);

	const PEOPLE = [
		{ seed: 'seb', name: 'seb' },
		{ seed: 'zach', name: 'Zach' },
		{ seed: 'kara', name: 'Kara' },
		{ seed: 'max', name: 'Max' },
		{ seed: 'nora', name: 'Nora' },
		{ seed: 'ian', name: 'Ian' },
		{ seed: 'deven', name: 'Deven' }
	];
</script>

<div class="flex flex-col gap-6">
	<div class="flex flex-col gap-3">
		<div class="flex items-center justify-between">
			<h2 class="text-headline text-fg">Table</h2>
			<span class="text-caption text-muted tabular-nums"
				>{clicked ? `Opened ${clicked}` : 'Click a row, or a header to sort'}</span
			>
		</div>
		<Table
			{columns}
			rows={ROWS}
			bind:sort
			maxHeight="22rem"
			label="Resources in hackclub-site"
			rowKey={(r) => r.id}
			rowLabel={(r) => `Open ${r.name}`}
			onRowClick={(r) => (clicked = r.name)}
		>
			{#snippet cell(r, col)}
				{#if col.id === 'name'}
					{@const Icon = KIND_ICON[r.kind]}
					<span class="flex min-w-0 items-center gap-2">
						<span class="flex shrink-0 text-faint"><Icon size={16} /></span>
						<span class="truncate font-medium text-fg">{r.name}</span>
					</span>
				{:else if col.id === 'status'}
					<StatusBadge variant="plain" meta={resourceStatus(r.state, r.build)} />
				{:else if col.id === 'region'}
					<span class="font-mono text-callout text-muted">{r.region}</span>
				{:else if col.id === 'cpu'}
					<span>{r.cpu.toFixed(2)}</span>
				{:else if col.id === 'memory'}
					<span>{fmt.format(r.memory)} <span class="text-faint">MB</span></span>
				{:else if col.id === 'rpm'}
					{#if r.rpm == null}<span class="text-faint">None</span>{:else}<span
							>{fmt.format(r.rpm)}</span
						>{/if}
				{:else if col.id === 'updated'}
					<span class="text-callout text-muted"><RelativeTime date={r.updated} /></span>
				{/if}
			{/snippet}
		</Table>
		<div class="grid grid-cols-2 gap-6">
			<Table
				dense
				columns={[
					{ id: 'key', label: 'Domain' },
					{ id: 'value', label: 'Certificate', align: 'end' }
				]}
				rows={[
					{ key: 'hackclub-site.orchard.my', value: 'Issued' },
					{ key: 'hackclub.com', value: 'Issued' },
					{ key: 'www.hackclub.com', value: 'Pending DNS' }
				]}
			/>
			<Table
				columns={[
					{ id: 'name', label: 'Volume' },
					{ id: 'size', label: 'Size', numeric: true }
				]}
				rows={[]}
				emptyText="No volumes attached to this deployment"
			/>
		</div>
	</div>

	<div class="grid grid-cols-2 gap-6">
		<div class="flex min-w-0 flex-col gap-3">
			<h2 class="text-headline text-fg">Code</h2>
			<CodeBlock
				code={DOCKERFILE}
				title="Dockerfile"
				language="Docker"
				lineNumbers
				highlight={[6, 12]}
			/>
		</div>
		<div class="flex min-w-0 flex-col gap-3">
			<h2 class="text-headline text-fg">Config and commands</h2>
			<CodeBlock code={TOML} language="TOML" syntax="toml" />
			<CodeEditor bind:value={editing} syntax="typescript" label="server.ts" minHeight="8rem" />
			<CodeBlock code={'{ "status": "ok", "uptime": 86412 }'} />
			<CommandSnippet command="orchard deploy" />
			<CommandSnippet
				command="curl -fsSL https://assets.orchard.my/install.sh | sh -s -- --channel stable"
			/>
			<CommandSnippet prompt="" command="orchard env pull --environment production > .env.local" />
		</div>
	</div>

	<SectionCard
		title="Environment variables"
		description="Secrets stay masked until you ask. Copy works either way."
		flush
	>
		{#snippet actions()}
			<Button size="sm" icon={Plus}>Add variable</Button>
		{/snippet}
		<div role="list">
			{#each ENV as v (v.name)}
				<EnvVarRow name={v.name} value={v.value} secret={v.secret} onedit={() => {}}>
					{#snippet badge()}{#if v.shared}<Badge>Shared</Badge>{/if}{/snippet}
					{#snippet actions()}<Button
							size="sm"
							variant="ghost"
							icon={Trash2}
							label="Delete {v.name}"
						/>{/snippet}
				</EnvVarRow>
			{/each}
		</div>
	</SectionCard>

	<div class="flex flex-col gap-3">
		<h2 class="text-headline text-fg">Logs</h2>
		<div class="grid grid-cols-2 gap-6">
			<div class="flex h-80 min-w-0 flex-col">
				<LogViewer surface="dark" lines={LINES} bind:wrap controls atStart />
			</div>
			<div class="flex flex-col gap-3">
				<div class="flex h-36 min-w-0 flex-col">
					<LogViewer surface="dark" lines={[]} loading />
				</div>
				<div class="flex h-40 min-w-0 flex-col">
					<LogViewer surface="dark" lines={[]} error="Pod web-7d9f4c6b8-x2kqp is not running" />
				</div>
			</div>
		</div>
	</div>

	<div class="grid grid-cols-2 gap-6">
		<SectionCard title="Avatars">
			<div class="flex flex-col gap-6">
				<div class="flex items-end gap-4">
					{#each [16, 20, 24, 32, 40, 56] as s (s)}<Avatar seed="seb" size={s} />{/each}
				</div>
				<div class="flex items-center gap-4">
					<Avatar seed="kara" size={32} mood="happy" />
					<Avatar seed="max" size={32} mood="thinking" />
					<Avatar seed="invite@example.test" size={32} mood="sleepy" />
					<Avatar seed="nora" size={32} mood="wink" />
				</div>
				<div class="flex items-center gap-6">
					<AvatarStack people={PEOPLE.slice(0, 3)} size={24} />
					<AvatarStack people={PEOPLE} size={24} />
					<AvatarStack people={PEOPLE} size={32} max={5} />
				</div>
				<div class="flex items-center gap-4">
					<AvatarEdit label="Change photo" removable onchange={() => {}} onremove={() => {}}>
						<Avatar seed="seb" />
					</AvatarEdit>
					<AvatarEdit label="Uploading" busy onchange={() => {}}>
						<Avatar seed="kara" />
					</AvatarEdit>
				</div>
				<div class="flex items-center gap-8">
					<ItemLabel title="Kara Lin" detail="kara@example.test">
						{#snippet leading()}<Avatar seed="kara" size={32} />{/snippet}
					</ItemLabel>
					<ItemLabel title="game-server" detail="terra · deployment" />
				</div>
			</div>
		</SectionCard>
		<SectionCard title="Breadcrumbs">
			<div class="flex flex-col gap-4">
				<Breadcrumbs
					crumbs={[
						{ label: 'Hack Club', href: '#data' },
						{ label: 'hackclub-site', href: '#data', icon: Folder },
						{ label: 'web' }
					]}
				/>
				<Breadcrumbs
					crumbs={[
						{ label: 'Projects', href: '#data' },
						{ label: 'arcade-leaderboard', href: '#data' },
						{ label: 'Databases', href: '#data' },
						{ label: 'postgres-primary-with-a-very-long-name' }
					]}
				/>
				<div class="flex items-center gap-2">
					<Monogram name="hackclub-site" size="sm" />
					<Breadcrumbs crumbs={[{ label: 'Deployments', href: '#data' }, { label: 'api' }]} />
				</div>
			</div>
		</SectionCard>
	</div>
</div>
