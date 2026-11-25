<script lang="ts">
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { Loader2 } from 'lucide-svelte';
	import { StatusBadge, statusMeta } from '$lib/components/ui';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { motionStagger, stateEcho } from '$lib/utils/motion.svelte';
	import { formatRelativeTime } from '$lib/utils/format';
	import {
		componentCopy,
		durationLabel,
		loadStatusPage,
		overallCopy,
		STATUS_MISSING,
		statusApiUrl,
		uptimeLabel,
		type PublicStatusPage
	} from '$lib/components/status/status-page';

	let { data }: { data: { slug: string } } = $props();

	let page = $state<PublicStatusPage | null>(null);
	let error = $state<string | null>(null);
	let now = $state(Date.now());

	let inFlight = false;

	async function load() {
		if (inFlight) return;
		inFlight = true;
		try {
			const url = statusApiUrl(
				data.slug,
				location.hostname,
				env.PUBLIC_BASE_DOMAIN || '',
				env.PUBLIC_PLATFORM_ORIGIN || ''
			);
			const result = await loadStatusPage(url);
			if (result.kind === 'ok') {
				page = result.page;
				error = null;
				now = Date.now();
			} else if (result.kind === 'missing') {
				page = null;
				error = STATUS_MISSING;
			} else if (!page) {
				error = result.message;
			}
		} finally {
			inFlight = false;
		}
	}

	onMount(() => {
		void load();
		const timer = setInterval(() => {
			void load();
		}, 30_000);
		const onVisible = () => {
			if (document.visibilityState === 'visible') void load();
		};
		const onOnline = () => {
			void load();
		};
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('online', onOnline);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('online', onOnline);
		};
	});

	const overall = $derived(page ? overallCopy(page.overall) : null);
	const ongoing = $derived((page?.incidents ?? []).filter((i) => !i.endedAt));
	const past = $derived((page?.incidents ?? []).filter((i) => i.endedAt));
</script>

<svelte:head>
	<title>{page ? `${page.title}` : 'Status'}</title>
	<meta name="robots" content="index,follow" />
</svelte:head>

<div class="sp">
	{#if error}
		<div class="sp-empty">
			<span class="sp-empty-title">{error}</span>
		</div>
	{:else if !page || !overall}
		<div class="sp-empty"><Loader2 class="h-5 w-5 animate-spin" data-motion="progress" /></div>
	{:else}
		<header class="sp-head" {@attach motionStagger({ index: 0, from: { y: 8 } })}>
			<span class="sp-org">{page.organization}</span>
			<h1 class="sp-title">{page.title}</h1>
			{#if page.description}<p class="sp-desc">{page.description}</p>{/if}
		</header>

		<section
			class="sp-overall sp-overall--{overall.tone} motion-echo echo--{overall.tone}"
			{@attach stateEcho(() => page?.overall)}
			{@attach motionStagger({ index: 1, from: { y: 8 } })}
		>
			<StatusDot meta={statusMeta(overall.tone, overall.label)} size={8} />
			<span class="sp-overall-label">{overall.label}</span>
			<span class="sp-overall-when">checked {formatRelativeTime(new Date(page.updatedAt))}</span>
		</section>

		{#if ongoing.length > 0}
			<section
				class="sp-incidents sp-incidents--live"
				{@attach motionStagger({ index: 2, from: { y: 8 } })}
			>
				{#each ongoing as inc (inc.componentId + inc.startedAt)}
					<div class="sp-incident">
						<span class="sp-incident-name" title={inc.componentName}>{inc.componentName}</span>
						<span class="sp-incident-meta"
							>Started {durationLabel(inc.startedAt, null, now)} ago</span
						>
					</div>
				{/each}
			</section>
		{/if}

		<section class="sp-components" aria-label="Components">
			{#each page.components as c, i (c.id)}
				{@const copy = componentCopy(c.status)}
				<div
					class="sp-comp motion-echo echo--{copy.tone}"
					{@attach stateEcho(() => c.status)}
					{@attach motionStagger({ index: 3 + i, from: { y: 6 } })}
				>
					<div class="sp-comp-row">
						<span class="sp-comp-name" title={c.name}>{c.name}</span>
						<span class="sp-comp-uptime">{uptimeLabel(c.uptime)}</span>
						<StatusBadge meta={statusMeta(copy.tone, copy.label, c.status === 'down')} />
					</div>
					{#if c.days.length}
						<div class="sp-bars" role="img" aria-label="Last {c.days.length} days">
							{#each c.days as d (d.day)}
								<span class="sp-bar sp-bar--{d.status}" title={d.day}></span>
							{/each}
						</div>
					{/if}
					{#if c.detail}<span class="sp-comp-detail">{c.detail}</span>{/if}
				</div>
			{/each}
		</section>

		{#if past.length > 0}
			<section
				class="sp-history"
				{@attach motionStagger({ index: 4 + page.components.length, from: { y: 6 } })}
			>
				<h2 class="sp-h2">Past incidents</h2>
				{#each past as inc (inc.componentId + inc.startedAt)}
					<div class="sp-incident sp-incident--past">
						<span class="sp-incident-name" title={inc.componentName}>{inc.componentName}</span>
						<span class="sp-incident-meta"
							>{new Date(inc.startedAt).toLocaleDateString(undefined, {
								day: 'numeric',
								month: 'short'
							})} · {durationLabel(inc.startedAt, inc.endedAt, now)}</span
						>
					</div>
				{/each}
			</section>
		{/if}

		<footer class="sp-foot">
			<span>30 day history</span>
			<a href="https://orchard.hackclub.com" rel="noopener">Powered by Orchard</a>
		</footer>
	{/if}
</div>

<style>
	.sp {
		max-width: 44rem;
		margin: 0 auto;
		padding: clamp(2rem, 6vw, 4.5rem) 1.25rem 3rem;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
	.sp-empty {
		min-height: 60vh;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-faint);
	}
	.sp-empty-title {
		font-size: var(--text-headline);
		color: var(--text-muted);
	}
	.sp-head {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.sp-org {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.sp-title {
		font-size: var(--text-title);
		line-height: var(--lh-title);
		font-weight: 700;
		letter-spacing: var(--track-title);
		color: var(--text-default);
		margin: 0;
	}
	.sp-desc {
		margin: 0;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		color: var(--text-muted);
	}
	.sp-overall {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-5);
		border-radius: var(--radius-xl);
		background: color-mix(in srgb, var(--sp-tone) 10%, var(--bg-raised));
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sp-tone) 25%, transparent);
	}
	.sp-overall--success {
		--sp-tone: var(--status-success);
	}
	.sp-overall--warning {
		--sp-tone: var(--status-warning);
	}
	.sp-overall--error {
		--sp-tone: var(--status-error);
	}
	.sp-overall-label {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 700;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
		flex: 1;
	}
	.sp-overall-when {
		font-size: var(--text-caption);
		color: var(--text-faint);
		white-space: nowrap;
	}
	.sp-incidents--live {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.sp-incident {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		background: var(--status-error-bg);
		box-shadow: inset 0 0 0 1px var(--status-error-border);
	}
	.sp-incident--past {
		background: var(--bg-raised);
		box-shadow: inset 0 0 0 1px var(--rule);
	}
	.sp-incident-name {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-callout);
		font-weight: 600;
		color: var(--text-default);
	}
	.sp-incident-meta {
		font-size: var(--text-caption);
		color: var(--text-muted);
		text-align: right;
		flex-shrink: 0;
	}
	.sp-components {
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-xl);
		background: var(--bg-raised);
		box-shadow: var(--elev-1);
		overflow: hidden;
	}
	.sp-comp {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-4) var(--space-5);
		border-top: 1px solid var(--rule);
	}
	.sp-comp:first-child {
		border-top: none;
	}
	.sp-comp-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.sp-comp-name {
		flex: 1;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sp-comp-uptime {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: var(--text-caption);
		color: var(--text-faint);
	}
	.sp-bars {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		gap: 3px;
		height: 1.5rem;
	}
	.sp-bar {
		border-radius: 2px;
		background: var(--status-success);
		opacity: 0.85;
	}
	.sp-bar--degraded {
		background: var(--status-warning);
	}
	.sp-bar--down {
		background: var(--status-error);
	}
	.sp-bar--none {
		background: var(--fill-quiet);
	}
	.sp-comp-detail {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
	.sp-history {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.sp-h2 {
		margin: 0 0 var(--space-1);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.sp-foot {
		display: flex;
		justify-content: space-between;
		font-size: var(--text-caption);
		color: var(--text-faint);
		padding-top: var(--space-3);
	}
	.sp-foot a {
		color: inherit;
		text-decoration: none;
	}
	.sp-foot a:hover {
		color: var(--text-muted);
	}
</style>
