<script lang="ts">
	import { untrack } from 'svelte';
	import { Lazy } from '$lib/utils/lazy.svelte';
	import { registerShortcut } from '$lib/utils/shortcuts';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { env } from '$env/dynamic/public';
	import { sourceUrl } from '$lib/source-url';
	import { graftHost } from '$lib/grafts/host.svelte';
	import {
		Sprout,
		Timer,
		Gauge,
		Puzzle,
		Mail,
		Moon,
		Monitor,
		Settings,
		Shield,
		LogOut,
		KeyRound,
		Scale,
		Code,
		SquareTerminal,
		Sun,
		Palette
	} from 'lucide-svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { overviewQueryOptions } from '$lib/queries/overview';
	import { resourceStatus, Avatar, Badge, IconTile, MenuHeader } from '$lib/components/ui';
	import Monogram from '$lib/components/ui/Monogram.svelte';
	import Sidebar from '$lib/components/patterns/Sidebar.svelte';
	import type { SidebarSection } from '$lib/components/patterns/sidebar';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import MenuSeparator from '$lib/components/ui/MenuSeparator.svelte';
	import { motionEnabled, transition } from '$lib/utils/motion.svelte';
	import { animate } from 'motion';
	import {
		apiFetch,
		user,
		isSuperAdmin,
		instanceChecklist,
		instanceChecklistOutstanding,
		organizations,
		selectedOrganization,
		pinnedItems,
		pendingInvitations,
		mobileNavOpen,
		sidebarWidthPx,
		SIDEBAR_EXPANDED_W,
		SIDEBAR_COLLAPSED_W,
		MOBILE_NAV_QUERY,
		type Organization
	} from '$lib/stores';
	import { themeStore } from '$lib/stores/theme';
	import type { ThemeMode } from '$lib/theme/spec';
	import { fade } from '$lib/utils/transitions';
	import { formatPlan } from '$lib/utils/format';

	interface OverviewDep {
		id: string;
		name: string;
		displayName?: string | null;
		status: string;
		buildStatus: string;
		faviconUrl?: string | null;
	}

	const orgSlug = $derived($selectedOrganization?.slug ?? '');

	let linkedOrgs = $state<
		Array<{
			id: string;
			organization: { name: string; avatarUrl: string | null };
			loginUrl: string | null;
			disabled: boolean;
		}>
	>([]);
	let linkedFor: string | null = null;
	$effect(() => {
		const id = $user?.id ?? null;
		const confined = Boolean($user?.homeOrganizationId || $user?.sessionOrganizationId);
		if (!browser || !id || confined || linkedFor === id) return;
		linkedFor = id;
		void apiFetch('/apiv1/auth/links')
			.then((res) => (res.ok ? res.json() : []))
			.then((list) => (linkedOrgs = list))
			.catch(() => (linkedOrgs = []));
	});
	const canOpenOrgSettings = $derived(
		$selectedOrganization?.myRole === 'owner' || $selectedOrganization?.myRole === 'admin'
	);

	function selectOrg(org: Organization) {
		organizations.setSelected(org);
		goto(`/${org.slug}`);
	}

	const nav = $derived([
		{
			id: 'apps',
			label: 'Your apps',
			href: `/${orgSlug}`,
			icon: Sprout,
			active:
				$page.url.pathname === '/' + orgSlug ||
				$page.url.pathname.startsWith('/' + orgSlug + '/projects')
		},
		{
			id: 'jobs',
			label: 'Jobs',
			href: `/${orgSlug}/jobs`,
			icon: Timer,
			active: $page.url.pathname.startsWith('/' + orgSlug + '/jobs')
		},
		...($selectedOrganization?.myRole === 'guest'
			? []
			: [
					{
						id: 'usage',
						label: 'Usage',
						href: `/${orgSlug}/usage`,
						icon: Gauge,
						active: $page.url.pathname.startsWith('/' + orgSlug + '/usage')
					}
				]),
		...graftHost.slot('nav.primary').map(({ graftId, item }) => {
			const href = item.href.replaceAll('{org}', orgSlug ?? '');
			return {
				id: `graft:${graftId}:${item.id}`,
				label: item.label,
				href,
				icon: Puzzle,
				active: $page.url.pathname === href || $page.url.pathname.startsWith(`${href}/`)
			};
		})
	]);

	const overviewQuery = createQuery(() => ({
		...overviewQueryOptions(orgSlug),
		enabled: !!orgSlug,
		refetchInterval: 120_000,
		staleTime: 60_000
	}));

	const orgDeps: OverviewDep[] = $derived(overviewQuery.data?.deployments ?? []);
	const pinnedDeps = $derived.by(() => {
		const byId = new Map(orgDeps.map((d) => [d.id, d]));
		return $pinnedItems
			.filter((i) => i.type === 'deployment')
			.slice(0, 6)
			.map((i) => ({ ...i, live: byId.get(i.id) ?? null }));
	});

	$effect(() => {
		const data = overviewQuery.data;
		if (!data || !orgSlug) return;
		pinnedItems.pruneStale(
			orgSlug,
			(data.deployments ?? []).map((d: { id: string }) => d.id),
			(data.projects ?? []).map((p: { id: string }) => p.id)
		);
	});

	const EXPANDED_W = SIDEBAR_EXPANDED_W;
	const COLLAPSED_W = SIDEBAR_COLLAPSED_W;
	const RAIL_SWAP_T = 0.45;
	const COLLAPSE_KEY = 'sidebar-collapsed';

	let collapsed = $state(browser && localStorage.getItem(COLLAPSE_KEY) === '1');
	let asideEl: HTMLElement | undefined = $state();
	let isMobile = $state(false);
	let railed = $state(browser && localStorage.getItem(COLLAPSE_KEY) === '1');
	let cliOpen = $state(false);
	const cliModal = new Lazy(() => import('./CliModal.svelte'));
	const CliModal = $derived(cliModal.current);

	$effect(() => {
		if (cliOpen) untrack(() => cliModal.preload());
	});

	$effect(() => {
		const path = $page.url.pathname;
		if (path) mobileNavOpen.close();
	});

	$effect(() => {
		if (!browser) return;
		const mq = window.matchMedia(MOBILE_NAV_QUERY);
		const sync = () => {
			isMobile = mq.matches;
			if (!mq.matches) mobileNavOpen.close();
		};
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	$effect(() => {
		if (!browser) return;
		const locked = isMobile && $mobileNavOpen;
		document.body.style.overflow = locked ? 'hidden' : '';
		return () => {
			document.body.style.overflow = '';
		};
	});

	function toggleCollapsed() {
		collapsed = !collapsed;
		if (browser) localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
	}

	function publishWidth(px: number) {
		document.documentElement.style.setProperty('--app-sidebar-w', `${px}px`);
	}

	let widthInitialized = false;
	$effect(() => {
		const el = asideEl;
		const mobile = isMobile;
		const target = collapsed;
		if (!el) return;
		if (mobile) {
			el.style.width = '';
			widthInitialized = false;
			railed = false;
			publishWidth(0);
			return;
		}
		const toW = sidebarWidthPx(target, false);
		if (!widthInitialized || !motionEnabled()) {
			widthInitialized = true;
			el.style.width = `${toW}px`;
			el.style.setProperty('--rail-t', target ? '0' : '1');
			railed = target;
			publishWidth(toW);
			return;
		}
		const fromW = el.getBoundingClientRect().width || toW;
		document.documentElement.dataset.sidebarAnimating = 'true';
		const done = () => {
			delete document.documentElement.dataset.sidebarAnimating;
			publishWidth(toW);
		};
		animate(fromW, toW, {
			...transition('snap', { distance: Math.abs(toW - fromW) }),
			onUpdate: (v) => {
				el.style.width = `${v}px`;
				publishWidth(v);
				const t = Math.max(0, Math.min(1, (v - COLLAPSED_W) / (EXPANDED_W - COLLAPSED_W)));
				el.style.setProperty('--rail-t', String(t));
				const wantRail = t <= RAIL_SWAP_T;
				if (wantRail !== railed) railed = wantRail;
			}
		}).finished.then(done, done);
	});

	$effect(() => () => {
		if (browser) document.documentElement.style.removeProperty('--app-sidebar-w');
	});

	$effect(() =>
		registerShortcut({
			id: 'sidebar',
			key: 'b',
			mod: true,
			label: 'Toggle sidebar',
			run: toggleCollapsed
		})
	);

	let themeMode = $state<ThemeMode>('auto');
	$effect(() => {
		if (browser) themeStore.init();
		const unsub = themeStore.subscribe((val) => (themeMode = val.mode));
		return unsub;
	});

	const sections = $derived<SidebarSection[]>(
		orgSlug
			? [
					{
						label: 'Platform',
						items: nav.map((n) => ({
							label: n.label,
							href: n.href,
							icon: n.icon,
							active: n.active
						}))
					},
					...(pinnedDeps.length
						? [
								{
									label: 'Pinned',
									tiles: true,
									items: pinnedDeps.map((p) => ({
										label: depName(p),
										href: p.href,
										status: p.live ? resourceStatus(p.live.status, p.live.buildStatus) : undefined
									}))
								}
							]
						: [])
				]
			: []
	);

	function applyQuickTheme(mode: 'light' | 'dark' | 'system') {
		themeStore.setMode(mode === 'system' ? 'auto' : mode);
	}

	function depName(pin: { name: string; live: OverviewDep | null }) {
		return pin.live?.displayName || pin.live?.name || pin.name;
	}

	const invitationCount = $derived($pendingInvitations.length);
	const fullName = $derived(
		[$user?.firstName, $user?.lastName].filter(Boolean).join(' ') || ($user?.username ?? 'You')
	);

	$effect(() => {
		if ($isSuperAdmin) instanceChecklist.load();
	});

	const sourceHref = sourceUrl(env.PUBLIC_SOURCE_URL);
</script>

{#if isMobile && $mobileNavOpen}
	<div
		class="deck-scrim"
		role="presentation"
		onclick={() => mobileNavOpen.close()}
		transition:fade={{ duration: 160 }}
	></div>
{/if}

<aside
	bind:this={asideEl}
	class="deck-host"
	class:deck-host--drawer={isMobile}
	class:deck-host--drawer-open={isMobile && $mobileNavOpen}
	inert={isMobile && !$mobileNavOpen}
>
	<Sidebar
		org={{
			name: $selectedOrganization?.name ?? 'Select an organization',
			plan: formatPlan($selectedOrganization?.plan),
			avatar: $selectedOrganization?.avatarUrl ?? null
		}}
		user={{ handle: $user?.username ?? 'you' }}
		{sections}
		collapsed={railed && !isMobile}
		onToggle={toggleCollapsed}
		onSearch={() => window.dispatchEvent(new CustomEvent('open-quick-search'))}
		userBadge={invitationCount + ($isSuperAdmin ? $instanceChecklistOutstanding.length : 0)}
	>
		{#snippet orgMenu()}
			{#if $selectedOrganization}
				<MenuHeader
					title={$selectedOrganization.name}
					subtitle={formatPlan($selectedOrganization.plan) ?? 'Organization'}
				>
					{#snippet media()}
						<IconTile src={$selectedOrganization?.avatarUrl}>
							{#snippet fallback()}<Monogram
									name={$selectedOrganization?.name ?? '?'}
									size="lg"
								/>{/snippet}
						</IconTile>
					{/snippet}
				</MenuHeader>
			{/if}
			{#if canOpenOrgSettings}
				<MenuItem icon={Settings} href="/{orgSlug}/settings">Organization settings</MenuItem>
			{/if}
			{#if $organizations.length > 1}
				<MenuSeparator />
				{#each $organizations as org (org.id)}
					{#if org.id !== $selectedOrganization?.id}
						<MenuItem onclick={() => selectOrg(org)}>
							{#snippet leading()}
								<IconTile src={org.avatarUrl}>
									{#snippet fallback()}<Monogram name={org.name} />{/snippet}
								</IconTile>
							{/snippet}
							{org.name}
						</MenuItem>
					{/if}
				{/each}
			{/if}
			{#if linkedOrgs.length > 0}
				<MenuSeparator />
				{#each linkedOrgs as link (link.id)}
					{#if link.loginUrl && !link.disabled}
						<MenuItem href={link.loginUrl}>
							{#snippet leading()}
								<IconTile src={link.organization.avatarUrl}>
									{#snippet fallback()}<Monogram name={link.organization.name} />{/snippet}
								</IconTile>
							{/snippet}
							{link.organization.name}
							{#snippet trailing()}<Badge>SSO</Badge>{/snippet}
						</MenuItem>
					{/if}
				{/each}
			{/if}
		{/snippet}
		{#snippet userAvatar()}<Avatar user={$user} alive />{/snippet}
		{#snippet userMenu()}
			<MenuHeader title={fullName} subtitle={$user?.email ?? `@${$user?.username ?? 'you'}`}>
				{#snippet media()}<Avatar user={$user} size={32} />{/snippet}
			</MenuHeader>
			<div class="theme-row">
				<span>Theme</span>
				<SegmentedControl
					size="sm"
					iconOnly
					label="Theme"
					value={themeMode === 'auto' ? 'system' : themeMode}
					onchange={(v) => applyQuickTheme(v as 'light' | 'dark' | 'system')}
					options={[
						{ value: 'light', label: 'Light', icon: Sun },
						{ value: 'dark', label: 'Dark', icon: Moon },
						{ value: 'system', label: 'System', icon: Monitor }
					]}
				/>
			</div>
			<MenuSeparator />
			<MenuItem icon={Settings} href="/user/settings">Account settings</MenuItem>
			<MenuItem icon={Palette} href="/user/settings?tab=appearance">Appearance</MenuItem>
			<MenuItem icon={KeyRound} href="/user/settings?tab=tokens">API tokens</MenuItem>
			{#if invitationCount > 0}
				<MenuItem icon={Mail} href="/user/settings?tab=profile">
					Invitations
					{#snippet trailing()}<Badge tone="accent">{invitationCount}</Badge>{/snippet}
				</MenuItem>
			{/if}
			<MenuSeparator />
			{#if $isSuperAdmin}
				<MenuItem icon={Shield} href="/admin">
					Instance admin
					{#snippet trailing()}{#if $instanceChecklistOutstanding.length}<Badge tone="accent"
								>{$instanceChecklistOutstanding.length}</Badge
							>{/if}{/snippet}
				</MenuItem>
			{/if}
			<MenuItem icon={SquareTerminal} onclick={() => (cliOpen = true)}>Command line</MenuItem>
			<MenuItem icon={Scale} href="/third-party-notices.txt" target="_blank" rel="noopener"
				>Open source licenses</MenuItem
			>
			<MenuItem icon={Code} href={sourceHref} target="_blank" rel="noopener">Source</MenuItem>
			<MenuSeparator />
			<MenuItem icon={LogOut} danger onclick={() => user.signOut()}>Sign out</MenuItem>
		{/snippet}
	</Sidebar>
</aside>
{#if CliModal}
	<CliModal bind:open={cliOpen} />
{/if}

<style>
	.theme-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0 0.125rem 0.375rem 0.5rem;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		color: var(--text-default);
	}
	.deck-host {
		position: relative;
		z-index: var(--z-nav);
		width: 17.25rem;
		height: 100%;
		flex-shrink: 0;
		padding: 0.625rem;
	}
	.deck-scrim {
		position: fixed;
		inset: 0;
		z-index: 40;
		background-color: color-mix(in oklab, var(--neutral-10) 40%, transparent);
	}
	.deck-host--drawer {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		z-index: 50;
		width: min(18rem, 84vw);
		transform: translate3d(-102%, 0, 0);
		transition: transform var(--spring-snap-duration) var(--spring-snap);
		will-change: transform;
	}
	.deck-host--drawer-open {
		transform: none;
	}
	.deck-host--drawer :global(.panel) {
		background: var(--bg-raised);
	}
	.deck-host--drawer :global(.fold) {
		display: none;
	}
</style>
