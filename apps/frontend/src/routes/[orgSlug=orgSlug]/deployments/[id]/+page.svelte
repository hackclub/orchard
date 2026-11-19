<script lang="ts">
	import { escapeHtml } from '$lib/utils/html';
	import { settled } from '$lib/utils/view-transition';
	import './deployment-page.css';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import { Tabs } from 'melt/builders';
	import { createQuery } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import { loadTerminalTabs, saveTerminalTabs, terminalTabsKey } from '$lib/terminal/tabs-store';
	import { browser } from '$app/environment';
	import { deploymentQueryOptions } from '$lib/queries/deployment';
	import { mergeInto, syncListBy, shallowEq } from '$lib/utils/sync';
	import { toEnvWrite, type EditableEnvVar } from '$lib/utils/env-secrets';
	import { TailscaleController } from '$lib/components/deployment/tailscale.svelte';
	import { ServicesController } from '$lib/components/deployment/services.svelte';
	import { anyPublicPending } from '$lib/components/deployment/network/network';
	import { computeHealth, type Rollout } from '$health';
	import {
		podLabel,
		getNewestPod,
		formatBuildElapsed,
		sanitizeLogs
	} from '$lib/components/deployment/deployment-helpers';
	import {
		Field,
		ImageField,
		Modal,
		Skeleton,
		resourceStatus,
		statusMeta
	} from '$lib/components/ui';
	import {
		apiFetch,
		toasts,
		isSuperAdmin,
		user,
		selectedOrganization,
		subscribeOrgEvents,
		sseStatusFor,
		earlyAccessFlag,
		instanceFeatures
	} from '$lib/stores';
	import { env } from '$env/dynamic/public';
	import { invalidate } from '$app/navigation';
	import { focusDeployment, watchBuild } from '$lib/utils/sound';
	import { fetchAlertStates } from '$lib/components/notifications/alerts';
	import { registerShortcut } from '$lib/utils/shortcuts';
	import type { PageData } from './$types';
	import {
		Plus,
		Scale,
		ExternalLink,
		Lock,
		Webhook,
		GitBranch,
		GitCommit,
		WifiOff,
		RotateCw
	} from 'lucide-svelte';
	import Breadcrumbs from '$lib/components/ui/Breadcrumbs.svelte';
	import PageTabs from '$lib/components/ui/PageTabs.svelte';
	import GoldenReticle from '$lib/components/ui/GoldenReticle.svelte';
	import { Clock } from '@jis3r/icons';
	import { scale, fade, slide } from '$lib/utils/transitions';
	import { animate } from 'motion';
	import {
		Puzzle,
		ServerCog as TabOverview,
		Braces as TabVariables,
		History as TabActivity,
		Eye as TabObserve,
		FolderOpen as TabFiles,
		Globe as TabNetwork,
		Shield as TabSecurity,
		SlidersHorizontal as TabSettings
	} from 'lucide-svelte';
	import SecurityTab from '$lib/components/deployment/SecurityTab.svelte';
	import FilesTab from '$lib/components/deployment/FilesTab.svelte';
	import GraftMount from '$lib/grafts/GraftMount.svelte';
	import GraftCards from '$lib/grafts/GraftCards.svelte';
	import { graftHost } from '$lib/grafts/host.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Checkbox from '$lib/components/ui/Checkbox.svelte';
	import RenameModal from '$lib/components/RenameModal.svelte';
	import { anomalyFeed } from '$lib/components/anomalies/anomaly-feed.svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import { formatCpu as fmtCpuPreset, formatMemory as fmtMemoryPreset } from '$lib/presets';

	import DeploymentProgress from '$lib/components/DeploymentProgress.svelte';
	import CircleAlertIcon from '$lib/components/icons/CircleAlertIcon.svelte';
	import TriangleAlertIcon from '$lib/components/icons/TriangleAlertIcon.svelte';
	import { ansiBuildLines } from '$lib/utils/log-sources.svelte';
	import { parseBuildkitLogs } from '$lib/utils/buildkitParser';
	import BuildLog from '$lib/components/deployment/build/BuildLog.svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';

	import {
		motionPanel,
		pressSpringDelegate,
		decorativeMotion,
		functionalMotion
	} from '$lib/utils/motion.svelte';
	import {
		portal,
		ansiToHtml,
		formatCpu,
		formatMemory,
		formatRelativeTime,
		formatBuildDurationBetween
	} from '$lib/utils/format';
	import type {
		Pod,
		Service,
		ServicePortConfig,
		Ingress,
		IngressRoute,
		ImageHistory,
		Volume,
		AutoDeployStatus,
		DockerfileHealthCheck,
		GitHubAppInstallation,
		GitHubDeploymentRecord,
		ServicePortForm,
		ServiceFormState,
		WebhookToken,
		TerminalTabInfo,
		VolumeObservation
	} from '$lib/types/deployment';
	import type { Binding, BindingOption } from '$lib/components/deployment/bindings';
	import {
		createBinding,
		fetchBindingOptions,
		fetchBindings
	} from '$lib/components/deployment/bindings-api';
	import {
		EnvironmentTab,
		OverviewTab,
		NetworkTab,
		DeploymentHeader,
		BuildProgressModal,
		DeploymentAlerts,
		NextSteps,
		DeploysTab,
		ObserveTab,
		AppSettings
	} from '$lib/components/deployment';

	const APP_DOMAIN = env.PUBLIC_APP_DOMAIN ?? '';
	const INGRESS_CNAME = env.PUBLIC_INGRESS_CNAME ?? '';

	interface Deployment {
		id: string;
		name: string;
		icon?: string | null;
		status: string;
		buildStatus?: string;
		buildStep?: string | null;
		replicas: number;
		stopped: boolean;
		availableReplicas: number;
		image?: string;
		namespace?: string;
		env?: Array<{ key: string; value: string }>;
		volumes?: Volume[];
		pods?: Pod[];
		services?: Service[];
		ingresses?: Ingress[];
		imageHistory?: ImageHistory[];
		githubRepo?: string;
		githubBranch?: string;
		buildType?: 'dockerfile' | 'railpack';
		dockerfilePath?: string;
		buildFromRoot?: boolean;
		buildWithDepot?: boolean;
		persistentBuildCache?: boolean;
		builderOverride?: 'firecracker' | 'kubernetes' | null;
		buildLogs?: string;
		buildError?: string;
		buildStepTimestamps?: Record<string, number> | null;
		autoDeployEnabled?: boolean;
		autoDeployBranch?: string;
		autoDeployPaths?: string[];
		healthCheckEnabled?: boolean;
		healthCheckPath?: string;
		healthCheckPort?: number;
		healthCheckType?: string;
		healthCheckCommand?: string;
		livenessEnabled?: boolean;
		readinessEnabled?: boolean;
		startupEnabled?: boolean;
		healthCheckInterval?: number;
		healthCheckTimeout?: number;
		healthCheckRetries?: number;
		startupFailureThreshold?: number;
		dockerfileHealthCheck?: DockerfileHealthCheck | null;
		healthCheckOverride?: boolean;
		cpuRequestMilli?: number | null;
		memoryRequestBytes?: number | null;
		totalCpuUsage?: number | null;
		totalMemoryUsage?: number | null;
		deployStrategy?: 'rollingUpdate' | 'recreate' | 'blueGreen';
		imagePullPolicy?: 'Always' | 'IfNotPresent' | null;
		effectiveImagePullPolicy?: 'Always' | 'IfNotPresent';
		warnings?: Array<{ podName: string; message: string; timestamp: string }>;
		project?: {
			id: string;
			name: string;
			slug: string;
			backgroundImage?: string | null;
		};
		projectId?: string;
		tailscaleExposed?: boolean;
		tailscaleHostname?: string | null;
		envVars?: Array<{ key: string; value: string }>;
		rollout?: Rollout | null;
	}

	const tabSections = [
		{ id: 'overview', label: 'Overview', icon: TabOverview },
		{ id: 'variables', label: 'Variables', icon: TabVariables },
		{ id: 'deploys', label: 'Activity', icon: TabActivity },
		{ id: 'observe', label: 'Observe', icon: TabObserve },
		{ id: 'files', label: 'Files', icon: TabFiles },
		{ id: 'network', label: 'Network', icon: TabNetwork },
		{ id: 'security', label: 'Security', icon: TabSecurity },
		{ id: 'settings', label: 'Settings', icon: TabSettings }
	] as const;

	type TabId = (typeof tabSections)[number]['id'] | `graft-${string}`;

	let deployment = $state<Deployment | null>(null);
	const isDockerImageDeployment = $derived(!deployment?.githubRepo);
	const graftProps = $derived(
		deployment?.project && $selectedOrganization
			? {
					orgId: $selectedOrganization.id,
					orgSlug,
					projectId: deployment.project.id,
					projectSlug: deployment.project.slug,
					deploymentId
				}
			: null
	);
	const graftTabs = $derived(
		graftProps
			? graftHost.slot('deployment.tabs', graftProps).map(({ graftId, host, item }) => ({
					id: `graft-${graftId}-${item.id}` as TabId,
					label: item.label,
					icon: null,
					graftId,
					host,
					mount: item.mount
				}))
			: []
	);
	const visibleTabs: {
		id: TabId;
		label: string;
		icon: (typeof tabSections)[number]['icon'] | null;
	}[] = $derived([...tabSections, ...graftTabs]);

	const LEGACY_TAB_SECTIONS: Record<string, string> = {
		resources: 'resources',
		volumes: 'storage',
		build: 'source',
		advanced: 'source'
	};
	const SETTINGS_SECTIONS = [
		'source',
		'resources',
		'storage',
		'health',
		'behavior',
		'notifications',
		'audit',
		'danger'
	];

	function tabFromUrl(url: URL): TabId {
		const t = url.searchParams.get('tab');
		if (t === 'metrics') return 'observe';
		if (t === 'environment') return 'variables';
		if (t && t in LEGACY_TAB_SECTIONS) return 'settings';
		return t && visibleTabs.some((s) => s.id === t) ? (t as TabId) : 'overview';
	}

	function settingsSectionFromUrl(url: URL): string {
		const legacy = url.searchParams.get('tab');
		const s = url.searchParams.get('s');
		if (s && SETTINGS_SECTIONS.includes(s)) return s;
		if (legacy && legacy in LEGACY_TAB_SECTIONS) return LEGACY_TAB_SECTIONS[legacy];
		return 'source';
	}

	const settingsSection = $derived(settingsSectionFromUrl($page.url));

	function settingsHref(section: string): string {
		const url = new URL($page.url);
		url.searchParams.set('tab', 'settings');
		if (section === 'source') url.searchParams.delete('s');
		else url.searchParams.set('s', section);
		url.searchParams.delete('view');
		return url.pathname + url.search;
	}

	// The URL is the single source of truth for the active tab. melt reads it
	// through the value getter and every change request funnels through gotoTab,
	// which rewrites the URL; two-way sync effects deadlocked under rapid clicks.
	const tabs = new Tabs<TabId>({
		value: () => tabFromUrl($page.url),
		onValueChange: (v) => gotoTab(v),
		loop: true
	});

	let observeView = $state<string>($page.url.searchParams.get('view') ?? 'metrics');

	function gotoTab(v: TabId, view?: string) {
		const url = new URL(window.location.href);
		const effView = view ?? untrack(() => observeView);
		const wantView = v === 'observe' && effView !== 'metrics' ? effView : null;
		const prev = url.searchParams.get('tab');
		if (v === 'settings' && !url.searchParams.has('s') && prev && prev in LEGACY_TAB_SECTIONS) {
			if (LEGACY_TAB_SECTIONS[prev] !== 'source')
				url.searchParams.set('s', LEGACY_TAB_SECTIONS[prev]);
		}
		if (v === 'overview') url.searchParams.delete('tab');
		else url.searchParams.set('tab', v);
		if (v !== 'settings') url.searchParams.delete('s');
		if (wantView) url.searchParams.set('view', wantView);
		else url.searchParams.delete('view');
		if (wantView !== 'logs') for (const k of ['q', 'levels', 'pod']) url.searchParams.delete(k);
		if (url.href !== window.location.href) {
			goto(url, { replaceState: true, keepFocus: true, noScroll: true });
		}
	}

	function gotoSettings(section: string) {
		goto(settingsHref(section), { replaceState: true, keepFocus: true, noScroll: true });
	}

	$effect(() => {
		const fromUrl = tabFromUrl($page.url);
		const v = $page.url.searchParams.get('view');
		untrack(() => {
			if (fromUrl === 'observe' && v && v !== observeView) observeView = v;
		});
	});

	$effect(() => {
		const view = observeView;
		untrack(() => gotoTab(tabs.value, view));
	});

	let actionAnim = $state<Record<string, boolean>>({});
	function triggerActionAnim(id: string) {
		if (actionAnim[id] || !decorativeMotion()) return;
		actionAnim[id] = true;
		setTimeout(() => {
			actionAnim[id] = false;
		}, 650);
	}

	// Header card collapses (spring) when the user leaves the Overview tab: the
	// build provenance + domains belong with the overview, while the title and the
	// Redeploy/Restart/Delete actions stay visible everywhere.
	const headerCollapsed = $derived(tabs.value !== 'overview');

	let bindings = $state<Binding[]>([]);
	let bindingOptions = $state<BindingOption[]>([]);
	async function fetchBindingsForTab() {
		try {
			[bindings, bindingOptions] = await Promise.all([
				fetchBindings(deploymentId),
				fetchBindingOptions(deploymentId)
			]);
		} catch {
			bindings = [];
			bindingOptions = [];
		}
	}
	async function connectResource(option: BindingOption): Promise<Binding | null> {
		try {
			const created = await createBinding(deploymentId, {
				resourceType: option.resourceType,
				resourceId: option.resourceId,
				name: option.suggestedName,
				envKey: null
			});
			await fetchBindingsForTab();
			return created;
		} catch (e) {
			toasts.add({
				title: "Couldn't connect",
				description: e instanceof Error ? e.message : '',
				color: 'error'
			});
			return null;
		}
	}
	$effect(() => {
		void deploymentId;
		fetchBindingsForTab();
	});
	let loading = $state(true);
	let error = $state<string | null>(null);

	let projectBgImage = $derived(deployment?.project?.backgroundImage ?? null);

	let deletingIngressId = $state<string | null>(null);
	let protectionUpdatingId = $state<string | null>(null);
	let projectIngresses = $state<
		Array<{
			id: string;
			host: string;
			path?: string;
			deploymentId?: string | null;
			deploymentName?: string;
		}>
	>([]);

	let showDomainForm = $state(false);
	let newDomainHost = $state('');
	let newDomainPath = $state('/');
	let newDomainTlsEnabled = $state(true);
	let newDomainServiceKey = $state('');
	let newDomainRoutingMode = $state<'service' | 'redirect'>('service');
	let newDomainRedirectTarget = $state('');
	let newDomainRedirectStatus = $state('307');
	let showDomainAdvanced = $state(false);
	let creatingDomain = $state(false);
	let domainFormError = $state<string | null>(null);

	const domainServiceOptions = $derived.by(() => {
		const opts: Array<{ key: string; label: string; serviceName: string; port: number }> = [];
		for (const s of deployment?.services ?? []) {
			const ports = s.ports?.length
				? s.ports
				: [{ port: s.port, targetPort: s.targetPort, protocol: s.protocol }];
			for (const p of ports) {
				if (String(p.protocol ?? 'TCP').toUpperCase() === 'UDP') continue;
				opts.push({
					key: `${s.id}::${p.port}`,
					label: `Port ${p.targetPort ?? p.port}`,
					serviceName: s.name,
					port: p.port
				});
			}
		}
		return opts;
	});

	const newDomainNormalizedHost = $derived(newDomainHost.trim().toLowerCase());
	const newDomainNormalizedPath = $derived.by(() => {
		const p = newDomainPath.trim() || '/';
		return p.startsWith('/') ? p : `/${p}`;
	});

	const newDomainConflict = $derived.by(() => {
		if (!newDomainNormalizedHost) return null;
		const sameHost = projectIngresses.filter((i) => i.host === newDomainNormalizedHost);
		if (sameHost.length === 0) return null;
		const otherDeployment = sameHost.find((i) => i.deploymentId !== deployment?.id);
		const pathCollision =
			newDomainRoutingMode === 'redirect'
				? sameHost[0]
				: sameHost.find((i) => (i.path || '/') === newDomainNormalizedPath);
		return { otherDeployment: !!otherDeployment, pathCollision: !!pathCollision };
	});

	// Computed properties for template compatibility with API field names
	const repoUrl = $derived(deployment?.githubRepo);
	const branch = $derived(deployment?.githubBranch);

	const buildFailedActive = $derived.by(
		() =>
			debugAlerts ||
			(deployment?.buildStatus === 'failed' && !!(deployment?.buildError || deployment?.buildLogs))
	);
	// "App is down" only fires once no pod has been ready for a continuous
	// minute: pods flapping through restarts or a slow rollout shouldn't scream
	// that the app is offline, but a sustained zero-ready state must.
	const APP_DOWN_CONFIRM_MS = 60_000;
	const noPodsReadyNow = $derived(
		!deployment?.stopped &&
			(deployment?.replicas ?? 0) > 0 &&
			(deployment?.availableReplicas ?? 0) === 0
	);
	let noPodsReadyConfirmed = $state(false);
	let noPodsReadyTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (noPodsReadyNow) {
			noPodsReadyTimer ??= setTimeout(() => {
				noPodsReadyTimer = null;
				noPodsReadyConfirmed = true;
			}, APP_DOWN_CONFIRM_MS);
		} else {
			if (noPodsReadyTimer) {
				clearTimeout(noPodsReadyTimer);
				noPodsReadyTimer = null;
			}
			noPodsReadyConfirmed = false;
		}
		return () => {
			if (noPodsReadyTimer) {
				clearTimeout(noPodsReadyTimer);
				noPodsReadyTimer = null;
			}
		};
	});
	const noPodsReady = $derived(debugAlerts || noPodsReadyConfirmed);

	let healthNow = $state(Date.now());
	$effect(() => {
		const tick = setInterval(() => (healthNow = Date.now()), 5_000);
		return () => clearInterval(tick);
	});
	const health = $derived(
		computeHealth({
			pods: deployment?.pods ?? [],
			rollout: deployment?.rollout ?? null,
			replicas: deployment?.replicas ?? 0,
			stopped: !!deployment?.stopped,
			strategy: strategyValue,
			buildStatus: debugStatus === 'building' ? 'building' : deployment?.buildStatus,
			now: healthNow
		})
	);
	const APP_CHIP = {
		healthy: () => statusMeta('success', 'Running'),
		degraded: () => statusMeta('warning', 'Degraded'),
		down: () => statusMeta('error', 'Down'),
		starting: () => statusMeta('progress', 'Starting', true),
		stopped: () => statusMeta('neutral', 'Stopped'),
		unknown: () => statusMeta('neutral', 'Unknown')
	} as const;
	const deploymentStatusChip = $derived.by(() => {
		const forced = debugStatus;
		if (forced && forced !== 'building') return resourceStatus(forced);
		if (!deployment?.pods) return resourceStatus(deployment?.status ?? '');
		return APP_CHIP[health.app]();
	});
	const deployChip = $derived.by(() => {
		if (!health.deploy) return null;
		const v = health.current ? ` v${health.current.number}` : '';
		if (health.deploy === 'failed') return { meta: statusMeta('error', 'Deploy failed') };
		const fresh = health.pods.filter((p) => p.version === 'new');
		const steps = Array.from({ length: Math.max(1, health.desired) }, (_, i) => {
			const pod = fresh[i];
			if (!pod) return 'pending' as const;
			if (pod.state === 'running') return 'done' as const;
			if (pod.state === 'failing') return 'failed' as const;
			return 'active' as const;
		});
		if (health.deploy === 'stuck')
			return { meta: statusMeta('warning', `Deploy stuck${v}`), steps };
		return { meta: statusMeta('progress', `Deploying${v}`, true), tone: 'deploy' as const, steps };
	});
	const buildStatusChip = $derived.by(() => {
		if (health.build === 'building') return statusMeta('progress', 'Building', true);
		if (health.build === 'failed') return statusMeta('error', 'Build failed');
		return null;
	});
	const activePods = $derived.by(() => {
		const shown = new Set(health.pods.map((p) => p.name));
		return deployment?.pods?.filter((pod) => shown.has(pod.name)) ?? [];
	});

	let deletingPod = $state<string | null>(null);

	async function deletePod(podName: string) {
		if (!deployment?.namespace || deletingPod) return;
		deletingPod = podName;
		try {
			const res = await apiFetch(`/apiv1/pods/${podName}?namespace=${deployment.namespace}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || "Couldn't delete pod");
			}
			toasts.add({ title: 'Pod deleted', description: podName, color: 'success' });
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: "Couldn't delete pod",
				description: e instanceof Error ? e.message : "Couldn't delete pod",
				color: 'error'
			});
		} finally {
			deletingPod = null;
		}
	}

	let restarting = $state(false);
	let stopping = $state(false);
	let starting = $state(false);
	let scaling = $state(false);
	let deleting = $state(false);
	let showDeleteModal = $state(false);
	let showStopModal = $state(false);
	let rebuilding = $state(false);
	let renameOpen = $state(false);
	let renamingApp = $state(false);
	let appPictureOpen = $state(false);
	let appPictureValue = $state<string | null>(null);
	let uploadingAppPicture = $state(false);
	let savingEnv = $state(false);
	let savingVolumes = $state(false);
	let savingAdvanced = $state(false);
	let savingService = $state(false);
	let buildFromRoot = $state(false);
	let buildWithDepot = $state(false);
	let persistentBuildCache = $state(false);
	let builderOverride = $state<'' | 'firecracker' | 'kubernetes'>('');

	const tailscaleEnabled = earlyAccessFlag('tailscale-integration');
	const tailscale = new TailscaleController({
		deploymentId: () => deploymentId,
		isExposed: () => !!deployment?.tailscaleExposed,
		refetch: fetchDeployment
	});

	let autoDeployStatus = $state<AutoDeployStatus | null>(null);
	let autoDeployLoading = $state(false);
	let autoDeployBranch = $state('');
	let autoDeployPaths = $state('');
	let autoDeployPathsLoaded = false;
	let enablingAutoDeploy = $state(false);
	let disablingAutoDeploy = $state(false);
	let savingAutoDeployPaths = $state(false);
	let githubDeployments = $state<GitHubDeploymentRecord[]>([]);
	let githubAppInstallUrl = $state<string | null>(null);
	let loadingAppInstallUrl = $state(false);

	let healthCheckEnabled = $state(false);
	let healthCheckType = $state('http');
	let healthCheckPath = $state('/');
	let healthCheckPort = $state(80);
	let healthCheckCommand = $state('');
	let livenessEnabled = $state(true);
	let readinessEnabled = $state(true);
	let startupEnabled = $state(false);
	let healthCheckInterval = $state(30);
	let healthCheckTimeout = $state(5);
	let healthCheckRetries = $state(3);
	let startupFailureThreshold = $state(30);
	let healthCheckOverride = $state(false);
	let savingHealthCheck = $state(false);
	let isEditingHealthCheck = $state(false);

	// Resource-utilisation warning. Compare live aggregate usage against the
	// total guaranteed capacity (request × replicas, since requests == limits
	// here). Skip when unlimited (request === 0) or when no live metrics have
	// arrived yet. The user sees this in the resources tab.
	const NEAR_LIMIT_RATIO = 0.85;
	if (browser) instanceFeatures.load().catch(() => undefined);
	// Above this the CPU reading is not believable rather than alarming; see
	// resourcePressure below. Generous, because the honest ceiling is 1.0 and
	// rate smoothing can legitimately overshoot it a little.
	const CPU_RATIO_IMPLAUSIBLE = 1.5;
	const resourcePressure = $derived.by(() => {
		const noLimit = $instanceFeatures.resourceLimits === 'off' && !deployment?.limitsRestartPending;
		const cpuReq = noLimit ? null : (deployment?.cpuRequestMilli ?? null);
		const memReq =
			!noLimit && deployment?.memoryRequestBytes != null
				? Number(deployment.memoryRequestBytes)
				: null;
		const cpuUsage = deployment?.totalCpuUsage ?? null;
		const memUsage = deployment?.totalMemoryUsage ?? null;

		// The usage totals are a sum over the pods metrics-server actually
		// reported, so the budget has to be per-pod times that same count.
		// Dividing by `replicas` instead is how a single 200m app mid-rollout
		// reported 737% of its limit: two pods of usage over one pod of budget,
		// on top of a bad sample.
		const scale = deployment?.meteredPods ?? deployment?.replicas ?? 1;
		const cpuLimit = cpuReq != null && cpuReq > 0 && scale > 0 ? cpuReq * scale : null;
		const memLimit = memReq != null && memReq > 0 && scale > 0 ? memReq * scale : null;

		if (debugAlerts) {
			return {
				cpuLimit,
				memLimit,
				cpuRatio: 0.93,
				memRatio: 0.97,
				cpuNear: true,
				memNear: true,
				any: true
			};
		}

		const rawCpuRatio = cpuLimit != null && cpuUsage != null ? cpuUsage / cpuLimit : null;
		const memRatio = memLimit != null && memUsage != null ? memUsage / memLimit : null;

		// A CPU limit is enforced by the kernel's CFS quota, so a pod cannot
		// actually spend more than it. A ratio well past 1 is not an overloaded
		// app, it is a bad sample: metrics-server derives a rate from two
		// cAdvisor readings, and a container that restarted between them resets
		// the counter and produces a garbage spike. Crashlooping pods hit this
		// constantly, which is exactly when someone is looking at the page.
		// Drop it rather than render a number that cannot be true.
		const cpuRatio =
			rawCpuRatio != null && rawCpuRatio > CPU_RATIO_IMPLAUSIBLE ? null : rawCpuRatio;

		const cpuNear = cpuRatio != null && cpuRatio >= NEAR_LIMIT_RATIO;
		const memNear = memRatio != null && memRatio >= NEAR_LIMIT_RATIO;
		return {
			cpuLimit,
			memLimit,
			cpuRatio,
			memRatio,
			cpuNear,
			memNear,
			any: cpuNear || memNear
		};
	});

	// Deploy update strategy (RollingUpdate vs Recreate). PVC volumes force
	// Recreate; the picker disables RollingUpdate in that case.
	let strategyValue = $state<'rollingUpdate' | 'recreate' | 'blueGreen'>('rollingUpdate');
	let savingStrategy = $state(false);
	const hasPvcVolume = $derived(volumes.some((v) => v.type === 'pvc'));

	async function saveStrategy(next: 'rollingUpdate' | 'recreate' | 'blueGreen') {
		if (!deployment || savingStrategy || next === strategyValue) return;
		if (hasPvcVolume && next !== 'recreate') {
			toasts.add({
				title: 'Apps with volumes must use Recreate',
				color: 'warning'
			});
			return;
		}
		savingStrategy = true;
		const previous = strategyValue;
		strategyValue = next;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/strategy`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ strategy: next })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || "Couldn't update strategy");
			}
			toasts.add({ title: 'Strategy updated', color: 'success' });
			await fetchDeployment();
		} catch (e) {
			strategyValue = previous;
			toasts.add({
				title: "Couldn't update strategy",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			savingStrategy = false;
		}
	}

	let pdbMinAvailable = $state(1);
	let savingPdb = $state(false);

	async function savePdb() {
		if (!deployment || savingPdb) return;
		const next = Math.trunc(Number(pdbMinAvailable));
		if (!Number.isInteger(next) || next < 0) {
			toasts.add({
				title: 'Invalid disruption budget',
				description: 'Enter a whole number of pods, or 0 to turn the budget off.',
				color: 'warning'
			});
			return;
		}
		savingPdb = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/disruption-budget`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ minAvailable: next })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || "Couldn't update disruption budget");
			}
			toasts.add({ title: 'Disruption budget updated', color: 'success' });
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: "Couldn't update disruption budget",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			savingPdb = false;
		}
	}

	// null means automatic: derived from the image tag by the server.
	let pullPolicy = $state<'Always' | 'IfNotPresent' | null>(null);
	let savingPullPolicy = $state(false);

	async function savePullPolicy(next: 'Always' | 'IfNotPresent' | null) {
		if (!deployment || savingPullPolicy || next === pullPolicy) return;
		savingPullPolicy = true;
		const previous = pullPolicy;
		pullPolicy = next;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/pull-policy`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imagePullPolicy: next })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || "Couldn't update pull policy");
			}
			toasts.add({
				title:
					next === null
						? 'Back to automatic'
						: next === 'Always'
							? 'Now re-pulling on every start'
							: 'Using the cached image',
				description:
					next === null
						? 'Orchard picks the policy from the image tag again.'
						: next === 'Always'
							? 'Restart the app to pick up a new push to this tag.'
							: 'Restarting reuses the image already on the node.',
				color: 'success'
			});
			await fetchDeployment();
		} catch (e) {
			pullPolicy = previous;
			toasts.add({
				title: "Couldn't update pull policy",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			savingPullPolicy = false;
		}
	}

	// Container image edit (image-source deployments only: GitHub-built
	// deployments rebuild from source, so a manual image change would be
	// overwritten by the next build).
	let imageInput = $state('');
	let savingImage = $state(false);
	const isImageSourceDeployment = $derived(!deployment?.githubRepo);
	const imageDirty = $derived(
		!!deployment && imageInput.trim() !== '' && imageInput.trim() !== (deployment.image ?? '')
	);

	async function saveImage() {
		if (!deployment || !imageDirty) return;
		savingImage = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/image`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image: imageInput.trim() })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || "Couldn't update image");
			}
			toasts.add({
				title: 'Image updated',
				description: 'Your app restarts with the new image.',
				color: 'success'
			});
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: "Couldn't update image",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			savingImage = false;
		}
	}

	// Resources (CPU/memory request). Null = inherit org default.
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);
	let orgDefaultCpuMilli = $state<number | null>(null);
	let orgDefaultMemoryBytes = $state<number | null>(null);
	let effectiveCpuLimit = $state<number | null>(null);
	let effectiveMemLimit = $state<number | null>(null);
	let savingResources = $state(false);
	let resourcesDirty = $state(false);

	async function saveResources() {
		if (!deployment) return;
		savingResources = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/resources`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cpuRequestMilli: resourceCpuMilli,
					memoryRequestBytes: resourceMemoryBytes
				})
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || "Couldn't update resources");
			}
			toasts.add({
				title: 'Resources updated',
				description: 'Your app restarts with the new values.',
				color: 'success'
			});
			resourcesDirty = false;
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: "Couldn't update resources",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			savingResources = false;
		}
	}

	let selectedPod = $state<string>('');
	const selectedPodGone = $derived(
		!!selectedPod &&
			Array.isArray(deployment?.pods) &&
			!deployment.pods.some((p) => p.name === selectedPod)
	);
	const replacementPod = $derived(
		selectedPodGone ? (getNewestPod(deployment?.pods ?? [])?.name ?? null) : null
	);
	let selectedContainer = $state<string>('');
	let buildLogs = $state<string>('');
	let buildLogsLoading = $state(false);

	// Console tab management: 'logs' or a terminal tab id
	let activeConsoleTab = $state<string>('logs');

	let terminalTabs = $state<TerminalTabInfo[]>([]);
	let terminalCounter = 0;

	function openShell(podName: string, container: string) {
		terminalCounter++;
		const id = `term-${terminalCounter}-${crypto.randomUUID()}`;
		const label = `Shell ${terminalCounter}`;
		terminalTabs = [...terminalTabs, { id, podName, container, label }];
		activeConsoleTab = id;
	}

	function setTerminalTitle(id: string, title: string) {
		const tab = terminalTabs.find((t) => t.id === id);
		if (tab) tab.title = title.trim().slice(0, 80);
	}

	function setTerminalSession(id: string, handle: string) {
		const tab = terminalTabs.find((t) => t.id === id);
		if (tab) tab.sessionHandle = handle;
	}

	function setTerminalBell(id: string) {
		const tab = terminalTabs.find((t) => t.id === id);
		if (tab && activeConsoleTab !== id) tab.bell = true;
	}

	function closeTerminalTab(id: string) {
		terminalTabs = terminalTabs.filter((t) => t.id !== id);
		if (activeConsoleTab === id) {
			activeConsoleTab =
				terminalTabs.length > 0 ? terminalTabs[terminalTabs.length - 1].id : 'logs';
		}
	}

	const KILLED_PROBLEMS = new Set(['crash-loop', 'exited', 'liveness', 'out-of-memory']);

	function openPodLogs(podName: string, problem?: string) {
		if (problem && KILLED_PROBLEMS.has(problem)) {
			gotoTab('observe', 'killed');
			return;
		}
		selectLogsPod(podName);
		gotoTab('overview');
	}

	function selectLogsPod(podName: string, containerName?: string) {
		selectedPod = podName;
		const pod = (deployment?.pods ?? []).find((p) => p.name === podName);
		selectedContainer = containerName || pod?.containers?.[0]?.name || '';
	}

	let scaleReplicas = $state(1);
	// True while the slider holds an unapplied user edit. Server refetches only
	// sync the slider when this is false, so a crash-looping pod (which refetches
	// constantly) can't snap the value back before the user clicks Scale.
	let scaleDirty = $state(false);

	function setScaleValue(value: number) {
		scaleReplicas = value;
		scaleDirty = value !== (deployment?.replicas ?? value);
	}

	let envVars = $state<Array<{ key: string; value: string; secret?: boolean }>>([]);
	let volumes = $state<
		Array<
			{
				name: string;
				type: 'pvc' | 'hostPath' | 'emptyDir';
				mountPath: string;
				pvcName?: string;
				storageSize?: string;
				hostPath?: string;
				readOnly: boolean;
			} & VolumeObservation
		>
	>([]);
	let isEditingEnv = $state(false);
	let isEditingVolumes = $state(false);
	let isEditingBuildOptions = $state(false);
	const services = new ServicesController({
		deploymentId: () => deploymentId,
		getServices: () => deployment?.services ?? [],
		setDeployment: (d) => {
			deployment = d as Deployment;
		},
		refetch: fetchDeployment
	});

	let showBuildModal = $state(false);
	let expandedBuildLogId = $state<string | null>(null);
	let buildLogCache = $state<Record<string, string>>({});
	let buildLogLoading = $state<string | null>(null);
	let consoleExpanded = $state(false);
	let consoleAnimating = $state(false);
	let consoleRef = $state<HTMLDivElement | null>(null);
	let consoleInlineRect = $state<{
		top: number;
		left: number;
		width: number;
		height: number;
	} | null>(null);

	function toggleConsoleExpand() {
		const next = !consoleExpanded;
		const apply = () => {
			consoleExpanded = next;
			consoleInlineRect = null;
			return tick();
		};
		const el = consoleRef;
		if (!el || !document.startViewTransition || !functionalMotion()) {
			void apply();
			return;
		}
		el.style.viewTransitionName = 'console';
		const dir = next ? 'vt-console-open' : 'vt-console-close';
		document.documentElement.classList.add('vt-console', dir);
		consoleAnimating = true;
		const vt = document.startViewTransition(apply);
		settled(vt).finally(() => {
			el.style.viewTransitionName = '';
			document.documentElement.classList.remove('vt-console', dir);
			consoleAnimating = false;
		});
	}
	let showBuildCard = $state(false);
	let showBuildCardRender = $state(false);
	$effect(() => {
		if (showBuildCard && !showBuildModal) showBuildCardRender = true;
	});
	let buildStartTime = $state<number>(0);
	let buildElapsed = $state(0);
	let accumulatedBuildLogs = $state<string | null>(null);
	let buildElapsedInterval: ReturnType<typeof setInterval> | null = null;
	let buildModalStatus = $state<string>('pending');
	let buildModalStep = $state<string | null>(null);
	let buildModalError = $state<string | null>(null);
	let buildModalWarnings = $state<Array<{ podName: string; message: string; timestamp: string }>>(
		[]
	);
	let buildModalTimestamps = $state<Record<string, number> | null>(null);
	let cancelingBuild = $state(false);

	let webhookTokens = $state<WebhookToken[]>([]);
	let creatingWebhookToken = $state(false);
	let deletingWebhookTokenId = $state<string | null>(null);
	let newWebhookLabel = $state('');
	let newlyCreatedToken = $state<string | null>(null);
	let copiedWebhookToken = $state(false);
	let copiedWebhookUrl = $state(false);

	function startBuildPolling() {
		buildStartTime = Date.now();
		buildElapsed = 0;
		accumulatedBuildLogs = null;
		buildModalStatus = 'pending';
		buildModalStep = null;
		buildModalError = null;
		buildModalWarnings = [];
		buildModalTimestamps = null;

		// Local UI tick for the elapsed timer; not a network poll. Prefer the
		// server-recorded `__start` timestamp (seeded when build was triggered)
		// so the counter survives page reloads and matches the real build start.
		buildElapsedInterval = setInterval(() => {
			const serverStart = buildModalTimestamps?.__start;
			const startMs = serverStart && serverStart > 0 ? serverStart : buildStartTime;
			buildElapsed = Math.max(0, (Date.now() - startMs) / 1000);
		}, 100);

		// Build status, step, logs, and warnings all flow through SSE
		// (`build.changed` → fetchDeployment → syncBuildModalFromDeployment).
		// No client polling.
	}

	function syncBuildModalFromDeployment() {
		if (!deployment) return;
		buildModalStatus = (deployment.buildStatus ?? deployment.status) as any;
		buildModalStep = (deployment.buildStep ?? null) as any;
		buildModalError = (deployment.buildError ?? null) as any;
		buildModalWarnings = ((deployment as any).warnings ?? []) as any;
		buildModalTimestamps = ((deployment as any).buildStepTimestamps ?? null) as any;
		if ((deployment as any).buildLogs) {
			accumulatedBuildLogs = (deployment as any).buildLogs;
		}

		if (deployment.buildStatus === 'succeeded') {
			stopBuildPolling();
			setTimeout(() => {
				showBuildCard = false;
				fetchDeployment();
			}, 1500);
		} else if (
			deployment.buildStatus === 'failed' ||
			(deployment.buildStatus as any) === 'cancelled' ||
			(deployment.buildStatus as any) === 'canceled'
		) {
			stopBuildPolling();
		}
	}

	function stopBuildPolling() {
		if (buildElapsedInterval) {
			clearInterval(buildElapsedInterval);
			buildElapsedInterval = null;
		}
	}

	function minimizeBuildModal() {
		showBuildModal = false;
		showBuildCard = true;
	}

	function expandBuildCard() {
		showBuildCard = false;
		showBuildModal = true;
	}

	async function cancelBuildFromModal() {
		if (cancelingBuild) return;
		cancelingBuild = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/cancel`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't cancel deployment");
			}
			toasts.add({
				title: 'Deployment canceled',

				color: 'success'
			});
			stopBuildPolling();
			showBuildModal = false;
			showBuildCard = false;

			await new Promise((resolve) => setTimeout(resolve, 1000));
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: "Couldn't cancel deployment",
				description: e instanceof Error ? e.message : "Couldn't cancel deployment",
				color: 'error'
			});
		} finally {
			cancelingBuild = false;
		}
	}

	const buildProgressValue = $derived(() => {
		const steps = ['cloning', 'building', 'pushing', 'deploying', 'complete'];
		if (buildModalStatus === 'running' || buildModalStep === 'complete') return 100;
		if (!buildModalStep) return 0;
		const idx = steps.indexOf(buildModalStep);
		if (idx < 0) return 0;
		if (buildModalStatus === 'failed') return ((idx + 1) / steps.length) * 100;
		return ((idx + 0.5) / steps.length) * 100;
	});

	const canCancelBuild = $derived(
		buildModalStatus === 'building' || buildModalStatus === 'pending'
	);

	let { data } = $props<{ data: PageData }>();
	const deploymentId = $derived(data.deploymentId);
	let sseUnsub: (() => void) | null = null;
	// Track the last deploymentId we hard-reset for so SSE-driven loader
	// revalidations don't blow away page state (selected pod/container/logs).
	let lastSeenDeploymentId: string | null = null;
	const orgSlug = $derived($page.params.orgSlug);

	// SSE connection health: declared early so the query's refetchInterval can read it.
	let sseStatusValue = $state<'connecting' | 'connected' | 'disconnected'>('connecting');
	const sseDisconnected = $derived(sseStatusValue === 'disconnected');
	let sseReloadPrompt = $state(false);

	const debugAlerts = $derived($page.url.searchParams.has('debugAlerts'));
	const debugStatus = $derived($page.url.searchParams.get('debugStatus'));
	const DEBUG_CHIPS = [
		resourceStatus('', 'building'),
		resourceStatus('pending'),
		resourceStatus('scaling'),
		resourceStatus('restarting'),
		resourceStatus('unhealthy'),
		resourceStatus('failed'),
		resourceStatus('stopped'),
		resourceStatus('deleting'),
		resourceStatus('')
	];

	const TRANSIENT_DEPLOYMENT_STATUSES = new Set([
		'scaling',
		'restarting',
		'pending',
		'building',
		'unhealthy'
	]);
	const deploymentQuery = createQuery(() => ({
		...deploymentQueryOptions(deploymentId),
		enabled: !!deploymentId,
		refetchInterval: (() => {
			const status = (deployment?.status ?? '').toLowerCase();
			const buildSt = (deployment?.buildStatus ?? '').toLowerCase();
			const transient = TRANSIENT_DEPLOYMENT_STATUSES.has(status) || buildSt === 'building';
			const sseUp = sseStatusValue === 'connected';
			if (anyPublicPending(deployment?.services)) return 5_000;
			if (sseUp) return 60_000;
			return transient ? 3_000 : 10_000;
		})(),
		refetchIntervalInBackground: false
	}));

	/** Trigger a refetch of deployment data via TanStack Query. Call sites just
	 *  invalidate the cache and the $effect below applies the new data. */
	function fetchDeployment() {
		fetchBindingsForTab();
		queryClient.invalidateQueries({ queryKey: ['deployment', deploymentId] });
	}

	function applyPodDelta(payload: any) {
		if (!deployment || !payload) return;
		const batch: any[] = Array.isArray(payload.pods) ? payload.pods : [payload];
		if (!Array.isArray(deployment.pods)) deployment.pods = [];
		const pods = deployment.pods as any[];
		for (const next of batch) {
			if (!next?.name) continue;
			const idx = pods.findIndex((p) => p.name === next.name);
			if (next.deleted) {
				if (idx >= 0) pods.splice(idx, 1);
				continue;
			}
			if (idx < 0) {
				pods.push({ cpuUsage: null, memoryUsage: null, ...next });
				continue;
			}
			const { cpuUsage: _cpu, memoryUsage: _mem, ...facts } = next;
			mergeInto(pods[idx], facts);
		}
	}

	function applyMetricsDelta(payload: any) {
		if (!deployment || payload?.totalCpuUsage == null) return;
		const podMetrics = payload.pods ?? {};
		deployment.totalCpuUsage = payload.totalCpuUsage;
		deployment.totalMemoryUsage = payload.totalMemoryUsage;
		deployment.meteredPods = payload.meteredPods ?? null;
		for (const p of (deployment.pods as any[]) ?? []) {
			const m = podMetrics[p.name];
			if (m) {
				p.cpuUsage = m.cpuUsage;
				p.memoryUsage = m.memoryUsage;
			}
		}
	}

	let podsLiveInflight = false;
	async function refreshPodsLive() {
		if (!deployment || !deploymentId || podsLiveInflight) return;
		podsLiveInflight = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deploymentId}/pods-live`);
			if (!res.ok) return;
			const data = await res.json();
			if (!deployment) return;
			if (Array.isArray(data.pods)) {
				if (Array.isArray(deployment.pods)) syncListBy(deployment.pods, data.pods, 'name');
				else deployment.pods = data.pods;
			}
			if (data.warnings !== undefined && !shallowEq(deployment.warnings, data.warnings)) {
				deployment.warnings = data.warnings;
			}
			if (data.availableReplicas !== undefined) {
				deployment.availableReplicas = data.availableReplicas;
			}
			if (data.rollout !== undefined && !shallowEq(deployment.rollout, data.rollout)) {
				deployment.rollout = data.rollout;
			}
			if (data.totalCpuUsage !== undefined) deployment.totalCpuUsage = data.totalCpuUsage;
			if (data.totalMemoryUsage !== undefined) deployment.totalMemoryUsage = data.totalMemoryUsage;
		} catch {
		} finally {
			podsLiveInflight = false;
		}
	}

	// Apply query data to local state.
	let lastQueryData: any = null;
	let seededFor: string | null = null;
	$effect(() => {
		const qData = deploymentQuery.data;
		const qError = deploymentQuery.error;
		const qPending = deploymentQuery.isPending;
		untrack(() => {
			if (qPending && !lastQueryData) return; // still loading initial
			if (qError && !deployment) {
				error = qError instanceof Error ? qError.message : "Couldn't load app";
				loading = false;
				return;
			}
			if (!qData || qData === lastQueryData) return;
			lastQueryData = qData;
			applyDeploymentData(qData);
		});
	});

	function applyDeploymentData(data: any) {
		const wasUnloaded = !deployment;

		// If a build is in progress, either transitioning during the session or
		// already running when the page loaded, surface it immediately. Show the
		// floating card on first load so we don't blast the modal over the page
		// the user just navigated to; show the modal when a build kicks off mid-session.
		if (data.buildStatus === 'building' && data.githubRepo && !showBuildModal && !showBuildCard) {
			if (wasUnloaded) {
				showBuildCard = true;
			} else {
				showBuildModal = true;
			}
			stopBuildPolling();
			startBuildPolling();
		}

		if (!deployment) {
			deployment = data;
		} else {
			mergeInto(deployment, data);
		}
		if (showBuildModal || showBuildCard) syncBuildModalFromDeployment();
		if (wasUnloaded) void refreshPodsLive();

		tailscale.syncFromDeployment(data);

		// Skip overwriting form state while a build is in progress so the user can
		// keep editing settings. Two things this must not do: skip the payload
		// that seeds this app's form in the first place, and key off the build
		// card being on screen rather than a build actually running. The card
		// outlives a failed build, so both together left a page opened mid-build
		// showing no env vars, no volumes, and a scale of 1. The seed is tracked
		// per deployment id because this component is reused when you navigate
		// from one app to another, and the form must not keep the last app's env.
		const buildActive =
			seededFor === data.id && (data.buildStatus ?? '').toLowerCase() === 'building';

		if (!buildActive) {
			seededFor = data.id;
			if (!scaling && !scaleDirty) {
				if (data.replicas !== undefined && data.replicas !== null) {
					scaleReplicas = data.replicas;
				} else {
					scaleReplicas = 1;
				}
			}
			if (!services.showForm) {
				services.resetNewForm();
			}

			if (!isEditingEnv) seedEnv(data.envVars);

			if (!isEditingVolumes) {
				if (data.volumes && Array.isArray(data.volumes) && data.volumes.length > 0) {
					volumes = data.volumes.map((vol: Volume) => ({
						name: vol.name || '',
						type: vol.type || 'pvc',
						mountPath: vol.mountPath || '',
						pvcName: vol.pvcName || '',
						storageSize: vol.storageSize || '1Gi',
						hostPath: vol.hostPath || '',
						readOnly: vol.readOnly || false,
						observedCapacity: vol.observedCapacity ?? null,
						phase: vol.phase ?? null,
						resizeState: vol.resizeState ?? null,
						resizeMessage: vol.resizeMessage ?? null,
						observedAt: vol.observedAt ?? null
					}));
				} else {
					volumes = [];
				}
			}

			if (!isEditingBuildOptions) {
				if (data.buildFromRoot !== undefined) {
					buildFromRoot = data.buildFromRoot;
				}
				buildWithDepot = data.buildWithDepot ?? false;
				persistentBuildCache = data.persistentBuildCache ?? false;
				builderOverride = data.builderOverride ?? '';
			}

			// Initialize health check state from deployment data
			if (data.healthCheckEnabled !== undefined && !isEditingHealthCheck) {
				healthCheckEnabled = data.healthCheckEnabled;
				healthCheckType = data.healthCheckType || 'http';
				healthCheckPath = data.healthCheckPath || '/';
				healthCheckPort = data.healthCheckPort || 80;
				healthCheckCommand = data.healthCheckCommand || '';
				livenessEnabled = data.livenessEnabled ?? true;
				readinessEnabled = data.readinessEnabled ?? true;
				startupEnabled = data.startupEnabled ?? false;
				healthCheckInterval = data.healthCheckInterval ?? 30;
				healthCheckTimeout = data.healthCheckTimeout ?? 5;
				healthCheckRetries = data.healthCheckRetries ?? 3;
				startupFailureThreshold = data.startupFailureThreshold ?? 30;
				healthCheckOverride = data.healthCheckOverride ?? false;
			}

			// Sync resource state (unless user has unsaved edits).
			if (!resourcesDirty) {
				resourceCpuMilli = data.cpuRequestMilli ?? null;
				resourceMemoryBytes =
					data.memoryRequestBytes != null ? Number(data.memoryRequestBytes) : null;
			}

			// Seed image input from the deployment's current image, unless the
			// user already has unsaved edits in flight.
			if (!savingImage && imageInput.trim() === '') {
				imageInput = data.image ?? '';
			}

			// Seed deploy strategy from the persisted value.
			if (!savingStrategy) {
				strategyValue =
					(data.deployStrategy as 'rollingUpdate' | 'recreate' | 'blueGreen') ?? 'rollingUpdate';
			}

			if (!savingPdb) {
				pdbMinAvailable = data.pdbMinAvailable ?? 1;
			}

			if (!savingPullPolicy) {
				pullPolicy = (data.imagePullPolicy as 'Always' | 'IfNotPresent' | null) ?? null;
			}

			// Org quota defaults are fetched lazily when the resources tab is opened.
		}

		if (data.pods?.length && !selectedPod) {
			const newest = getNewestPod(data.pods);
			if (newest) {
				selectedPod = newest.name;
				selectedContainer = newest.containers?.[0]?.name || '';
			}
		}
		loading = false;
	}

	async function fetchBuildLogs() {
		if (!deployment || deployment.buildStatus !== 'building') return;

		buildLogsLoading = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/build-logs`);
			if (response.ok) {
				const data = await response.json();
				buildLogs = sanitizeLogs(data.logs || '');
			}
		} catch (e) {
			console.error('Failed to fetch build logs:', e);
		} finally {
			buildLogsLoading = false;
		}
	}

	async function restart() {
		restarting = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/restart`, {
				method: 'POST'
			});
			if (!response.ok) {
				throw new Error("Couldn't restart app");
			}
			toasts.add({
				title: 'App restarting',
				description:
					deployment?.deployStrategy === 'recreate'
						? 'Stops everything, then starts again'
						: 'New pods start before old ones stop',
				color: 'success'
			});
			fetchDeployment();
		} catch (e) {
			toasts.add({
				title: "Couldn't restart",
				description: e instanceof Error ? e.message : "Couldn't restart",
				color: 'error'
			});
		} finally {
			restarting = false;
		}
	}

	async function lifecycleAction(kind: 'stop' | 'start') {
		if (kind === 'stop') stopping = true;
		else starting = true;
		const build = kind === 'start' && !!deployment?.pendingPush;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/${kind}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(build ? { build: true } : {})
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || `Couldn't ${kind} app`);
			}
			toasts.add({
				title: kind === 'stop' ? 'App stopping' : build ? 'Building latest push' : 'App starting',
				description:
					kind === 'stop'
						? 'All replicas are stopping'
						: build
							? 'The app starts when the build finishes'
							: `Restoring ${deployment?.replicas ?? 1} replica(s)`,
				color: 'success'
			});
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: `Couldn't ${kind} app`,
				description: e instanceof Error ? e.message : `Couldn't ${kind} app`,
				color: 'error'
			});
		} finally {
			if (kind === 'stop') stopping = false;
			else starting = false;
		}
	}

	async function scaleDeployment() {
		scaling = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/scale`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ replicas: scaleReplicas })
			});
			const data = await response.json().catch(() => null);
			if (!response.ok) {
				throw new Error(data?.message || "Couldn't scale app");
			}
			toasts.add({
				title: data?.stopped ? 'App stopping' : 'App scaled',
				description: data?.stopped
					? 'All replicas are stopping'
					: `Scaled to ${data?.replicas ?? scaleReplicas} replica(s)`,
				color: 'success'
			});
			if (typeof data?.replicas === 'number') scaleReplicas = data.replicas;
			scaleDirty = false;
			fetchDeployment();
		} catch (e) {
			toasts.add({
				title: "Couldn't scale",
				description: e instanceof Error ? e.message : "Couldn't scale",
				color: 'error'
			});
		} finally {
			scaling = false;
		}
	}

	async function rebuild() {
		rebuilding = true;
		const previousStart = deployment?.buildStepTimestamps?.__start ?? null;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/rebuild`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't redeploy");
			}
			watchBuild(deploymentId);
			toasts.add({
				title: 'Deployment started',
				description: 'Building new image from repository',
				color: 'success'
			});

			accumulatedBuildLogs = '';
			buildModalStatus = 'building';
			buildModalStep = null;
			buildModalError = null;
			buildModalWarnings = [];
			buildModalTimestamps = null;
			buildStartTime = Date.now();

			showBuildModal = true;
			showBuildCard = false;
			startBuildPolling();
			if ((deployment?.buildStepTimestamps?.__start ?? null) !== previousStart) {
				syncBuildModalFromDeployment();
			}
		} catch (e) {
			toasts.add({
				title: "Couldn't redeploy",
				description: e instanceof Error ? e.message : "Couldn't redeploy",
				color: 'error'
			});
		} finally {
			rebuilding = false;
		}
	}

	async function deleteDeployment() {
		if (!deployment) return;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}`, {
				method: 'DELETE'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't delete app");
			}
			toasts.add({
				title: 'App deleted',
				color: 'success'
			});
			if (deployment.project?.slug) {
				goto(`/${orgSlug}/projects/${deployment.project.slug}`);
			} else {
				goto(`/${orgSlug}`);
			}
		} catch (e) {
			toasts.add({
				title: "Couldn't delete",
				description: e instanceof Error ? e.message : "Couldn't delete",
				color: 'error'
			});
		} finally {
			deleting = false;
		}
	}

	function seedEnv(list: unknown) {
		const saved = Array.isArray(list)
			? (list as { key: string; value: string; secret?: boolean }[])
			: [];
		envVars = saved.map((ev) => ({
			key: ev.key || '',
			value: ev.value || '',
			secret: Boolean(ev.secret),
			sealed: Boolean(ev.secret)
		}));
	}

	function discardEnv() {
		isEditingEnv = false;
		seedEnv(deployment?.envVars);
	}

	async function saveEnv() {
		savingEnv = true;
		isEditingEnv = false;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/env`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ env: toEnvWrite(envVars) })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't update environment variables");
			}
			toasts.add({
				title: 'Variables updated',
				description: 'Your app restarts with the new variables',
				color: 'success'
			});
			fetchDeployment();
		} catch (e) {
			isEditingEnv = true;
			toasts.add({
				title: "Couldn't update variables",
				description: e instanceof Error ? e.message : "Couldn't update variables",
				color: 'error'
			});
		} finally {
			savingEnv = false;
		}
	}

	async function fetchProjectIngresses() {
		if (!deployment?.project?.id) return;
		try {
			const response = await apiFetch(`/apiv1/projects/${deployment.project.id}`);
			if (!response.ok) return;
			const projectData = await response.json();
			const deploymentIngresses = (projectData.deployments ?? []).flatMap(
				(d: {
					id: string;
					name: string;
					ingresses?: Array<{ id: string; host: string; path?: string }>;
				}) =>
					(d.ingresses ?? []).map((i) => ({
						id: i.id,
						host: i.host,
						path: i.path ?? '/',
						deploymentId: d.id,
						deploymentName: d.name
					}))
			);
			projectIngresses = deploymentIngresses;
		} catch {
			/* silent */
		}
	}

	async function deleteIngress(ingressId: string) {
		if (!deployment?.project?.id) return;

		deletingIngressId = ingressId;
		try {
			const response = await apiFetch(
				`/apiv1/projects/${deployment.project.id}/ingresses/${ingressId}`,
				{ method: 'DELETE' }
			);
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't remove domain");
			}
			toasts.add({ title: 'Domain removed', color: 'success' });
			await fetchDeployment();
			await fetchProjectIngresses();
		} catch (e) {
			toasts.add({
				title: "Couldn't remove domain",
				description: e instanceof Error ? e.message : "Couldn't remove domain",
				color: 'error'
			});
		} finally {
			deletingIngressId = null;
		}
	}

	async function updateProtection(
		ingressId: string,
		mode: string,
		password?: string,
		bypassPaths?: string[],
		username?: string
	) {
		if (!deployment?.project?.id) return;
		protectionUpdatingId = ingressId;
		try {
			const response = await apiFetch(
				`/apiv1/projects/${deployment.project.id}/ingresses/${ingressId}/protection`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ mode, password, bypassPaths, username })
				}
			);
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't update protection");
			}
			toasts.add({
				title: mode === 'none' ? 'Protection disabled' : 'Protection enabled',
				color: 'success'
			});
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: "Couldn't update protection",
				description: e instanceof Error ? e.message : "Couldn't update protection",
				color: 'error'
			});
			throw e;
		} finally {
			protectionUpdatingId = null;
		}
	}

	let redirectUpdatingId = $state<string | null>(null);
	const anomalies = anomalyFeed(
		() => ({ kind: 'deployment', id: deploymentId }),
		() => ['error_spike', 'rollback']
	);
	async function updateRedirect(
		ingressId: string,
		data: { host: string; redirectTarget: string; redirectStatus: number }
	) {
		if (!deployment?.project?.id) return;
		redirectUpdatingId = ingressId;
		try {
			const response = await apiFetch(
				`/apiv1/projects/${deployment.project.id}/ingresses/${ingressId}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(data)
				}
			);
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body.message || "Couldn't update redirect");
			}
			toasts.add({ title: 'Redirect updated', description: data.host, color: 'success' });
			await fetchDeployment();
			await fetchProjectIngresses();
		} catch (e) {
			toasts.add({
				title: "Couldn't update redirect",
				description: e instanceof Error ? e.message : "Couldn't update redirect",
				color: 'error'
			});
			throw e;
		} finally {
			redirectUpdatingId = null;
		}
	}

	function resetDomainForm() {
		newDomainHost = '';
		newDomainPath = '/';
		newDomainTlsEnabled = true;
		newDomainServiceKey = domainServiceOptions[0]?.key ?? '';
		newDomainRoutingMode = 'service';
		newDomainRedirectTarget = '';
		newDomainRedirectStatus = '307';
		showDomainAdvanced = false;
		domainFormError = null;
	}

	const SLUG_ADJECTIVES = [
		'sunny',
		'mossy',
		'brave',
		'swift',
		'golden',
		'quiet',
		'wild',
		'fuzzy',
		'minty',
		'rosy',
		'lucky',
		'breezy',
		'peachy',
		'snowy',
		'zesty',
		'amber',
		'coral',
		'dapper',
		'misty',
		'tiny'
	];
	const SLUG_NOUNS = [
		'fox',
		'otter',
		'sprout',
		'acorn',
		'fern',
		'robin',
		'pebble',
		'willow',
		'comet',
		'badger',
		'plum',
		'birch',
		'wren',
		'clover',
		'hazel',
		'pine',
		'sage',
		'petal',
		'finch',
		'maple'
	];

	function generateRandomDomainForNew() {
		if (!APP_DOMAIN) return;
		const adjective = SLUG_ADJECTIVES[Math.floor(Math.random() * SLUG_ADJECTIVES.length)];
		const noun = SLUG_NOUNS[Math.floor(Math.random() * SLUG_NOUNS.length)];
		const number = Math.floor(Math.random() * 90) + 10;
		newDomainHost = `${adjective}-${noun}-${number}.${APP_DOMAIN}`;
	}

	async function checkDomainDns(domain: string): Promise<{
		valid: boolean;
		message: string;
		records: Array<{ type: string; name: string; value: string }>;
	}> {
		if (!deployment?.project?.id) throw new Error('Project not loaded');
		const response = await apiFetch('/apiv1/projects/ingresses/validate-dns', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: deployment.project.id, domain })
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.message || "Couldn't check DNS");
		return {
			valid: !!data.valid,
			message: data.message || '',
			records: Array.isArray(data.records) ? data.records : []
		};
	}

	async function createDomain(): Promise<boolean> {
		if (!deployment?.project?.id) return false;
		if (!newDomainNormalizedHost) {
			domainFormError = 'Enter a domain';
			return false;
		}
		if (newDomainConflict?.pathCollision) {
			domainFormError = `${newDomainNormalizedHost}${newDomainNormalizedPath} is already in use. Use a different path.`;
			return false;
		}
		const option = domainServiceOptions.find((o) => o.key === newDomainServiceKey);
		if (newDomainRoutingMode === 'service' && !option) {
			domainFormError = 'Select a port';
			return false;
		}
		if (newDomainRoutingMode === 'redirect' && !newDomainRedirectTarget.trim()) {
			domainFormError = 'Enter a redirect destination';
			return false;
		}

		creatingDomain = true;
		domainFormError = null;

		try {
			const response = await apiFetch(`/apiv1/projects/${deployment.project.id}/ingresses`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					newDomainRoutingMode === 'redirect'
						? {
								host: newDomainNormalizedHost,
								tlsEnabled: newDomainTlsEnabled,
								deploymentId: deployment.id,
								redirectTarget: newDomainRedirectTarget.trim(),
								redirectStatus: Number(newDomainRedirectStatus)
							}
						: {
								host: newDomainNormalizedHost,
								tlsEnabled: newDomainTlsEnabled,
								routes: [
									{
										path: newDomainNormalizedPath,
										serviceName: option!.serviceName,
										servicePort: option!.port
									}
								]
							}
				)
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't add domain");
			}

			toasts.add({
				title:
					newDomainRoutingMode === 'redirect'
						? 'Redirect added'
						: newDomainConflict
							? 'Route added'
							: 'Domain added',
				description: `${newDomainNormalizedHost}${newDomainNormalizedPath === '/' ? '' : newDomainNormalizedPath}`,
				color: 'success'
			});

			resetDomainForm();
			await fetchDeployment();
			await fetchProjectIngresses();
			return true;
		} catch (e) {
			domainFormError = e instanceof Error ? e.message : "Couldn't add domain";
			return false;
		} finally {
			creatingDomain = false;
		}
	}

	let logModalId = $state<string | null>(null);
	let logModalContent = $state<string | null>(null);
	let logModalLoading = $state(false);
	let logModalError = $state<string | null>(null);
	const logModalText = $derived(logModalContent ? sanitizeLogs(logModalContent) : '');
	const logModalLines = $derived(ansiBuildLines(logModalText));
	const logModalParsed = $derived(parseBuildkitLogs(logModalText));

	async function openLogModal(historyId: string) {
		logModalId = historyId;
		logModalError = null;
		logModalContent = buildLogCache[historyId] ?? null;
		if (logModalContent) return;
		logModalLoading = true;
		try {
			const response = await apiFetch(
				`/apiv1/deployments/${deploymentId}/image-history/${historyId}/logs`
			);
			if (!response.ok) throw new Error("Couldn't load deployment logs");
			const data = await response.json();
			const logs = data.logs || '';
			buildLogCache[historyId] = logs;
			logModalContent = logs;
		} catch {
			logModalError = "Couldn't load the build logs.";
		} finally {
			logModalLoading = false;
		}
	}

	function closeLogModal() {
		logModalId = null;
		logModalContent = null;
		logModalLoading = false;
		logModalError = null;
	}

	let rollingBackId = $state<string | null>(null);
	let rollbackTarget = $state<ImageHistory | null>(null);
	let showRollbackModal = $state(false);
	let rollbackRestoreDatabases = $state(false);
	const rollbackTargetTag = $derived(rollbackTarget?.image.split(':').pop() ?? '');

	function requestRollback(historyId: string) {
		if (rollingBackId) return;
		const history = deployment?.imageHistory?.find((h) => h.id === historyId);
		if (!history) return;
		rollbackTarget = history;
		rollbackRestoreDatabases = false;
		showRollbackModal = true;
	}

	function confirmRollback() {
		const id = rollbackTarget?.id;
		rollbackTarget = null;
		if (id) rollbackToImage(id, rollbackRestoreDatabases);
	}

	async function rollbackToImage(historyId: string, restoreDatabases = false) {
		if (rollingBackId) return;
		rollingBackId = historyId;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/rollback/${historyId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(restoreDatabases ? { restoreDatabases: true } : {})
			});
			if (!response.ok) {
				const data = await response.json().catch(() => null);
				throw new Error(data?.message || "Couldn't roll back");
			}
			const result = await response.json().catch(() => null);
			const restores = Array.isArray(result?.databaseRestores) ? result.databaseRestores.length : 0;
			toasts.add({
				title: 'Rollback started',
				description: restoreDatabases
					? restores > 0
						? `${restores} ${restores === 1 ? 'database is' : 'databases are'} going back to before that deploy.`
						: 'No bound database had a checkpoint from before that deploy.'
					: undefined,
				color: 'success'
			});
			fetchDeployment();
		} catch (e) {
			toasts.add({
				title: "Couldn't roll back",
				description: e instanceof Error ? e.message : "Couldn't roll back",
				color: 'error'
			});
		} finally {
			rollingBackId = null;
		}
	}

	function addVolume() {
		volumes = [
			...volumes,
			{ name: '', type: 'pvc', mountPath: '', pvcName: '', storageSize: '1Gi', readOnly: false }
		];
	}

	function removeVolume(index: number) {
		volumes = volumes.filter((_, i) => i !== index);
	}

	let savingBuildConfig = $state(false);

	async function saveBuildConfig(body: Record<string, string | null>) {
		if (!deployment) return;
		savingBuildConfig = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/build-config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't update build settings");
			}
			const updated = await response.json();
			if (deployment) mergeInto(deployment, updated);
			else deployment = updated;
			toasts.add({
				title: 'Build settings updated',
				description: 'They apply on the next build',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: "Couldn't update build settings",
				description: e instanceof Error ? e.message : "Couldn't update build settings",
				color: 'error'
			});
		} finally {
			savingBuildConfig = false;
		}
	}

	async function saveAdvanced() {
		if (!deployment) return;

		savingAdvanced = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/build-config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					buildFromRoot,
					buildWithDepot,
					persistentBuildCache,
					builderOverride: builderOverride || null
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't update build settings");
			}

			const updated = await response.json();
			if (deployment) mergeInto(deployment, updated);
			else deployment = updated;
			isEditingBuildOptions = false;

			toasts.add({
				title: 'Settings updated',

				color: 'success'
			});
		} catch (e) {
			isEditingBuildOptions = true;
			toasts.add({
				title: "Couldn't update build settings",
				description: e instanceof Error ? e.message : "Couldn't update build settings",
				color: 'error'
			});
		} finally {
			savingAdvanced = false;
		}
	}

	async function renameApp(name: string) {
		if (!deployment) return;
		renamingApp = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/name`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't rename");
			}
			const updated = await response.json();
			deployment.displayName = updated.displayName ?? null;
			renameOpen = false;
			toasts.add({ title: 'App renamed', color: 'success' });
		} catch (e) {
			toasts.add({
				title: "Couldn't rename",
				description: e instanceof Error ? e.message : "Couldn't rename",
				color: 'error'
			});
		} finally {
			renamingApp = false;
		}
	}

	function openAppPicture() {
		appPictureValue = deployment?.icon ?? null;
		appPictureOpen = true;
	}

	async function uploadAppPicture(file: File): Promise<string | null> {
		const currentDeployment = deployment;
		if (!currentDeployment) return null;

		try {
			const form = new FormData();
			form.append('file', file);
			const response = await apiFetch(`/apiv1/deployments/${currentDeployment.id}/icon`, {
				method: 'POST',
				body: form
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't update app picture");
			}
			const updated = await response.json();
			if (typeof updated.icon !== 'string') throw new Error("Couldn't update app picture");
			const icon = updated.icon;
			if (deployment?.id === currentDeployment.id) deployment = { ...deployment, icon };
			queryClient.setQueryData<Deployment>(['deployment', currentDeployment.id], (current) =>
				current ? { ...current, icon } : current
			);
			toasts.add({ title: 'App picture updated', color: 'success' });
			return icon;
		} catch (error) {
			toasts.add({
				title: "Couldn't update app picture",
				description: error instanceof Error ? error.message : 'Upload failed',
				color: 'error'
			});
			return null;
		}
	}

	function handleDeploymentUpdated(updated: Deployment) {
		if (deployment) mergeInto(deployment, updated);
		else deployment = updated;
	}

	function handleSourceUpdated(updated: Deployment) {
		if (deployment) mergeInto(deployment, updated);
		else deployment = updated;
		autoDeployBranch = '';
		autoDeployPaths = '';
		autoDeployPathsLoaded = false;
		loadAutoDeployStatus();
	}

	async function saveHealthCheck() {
		if (!deployment) return;

		savingHealthCheck = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/health-check`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					healthCheckEnabled,
					healthCheckType,
					healthCheckPath,
					healthCheckPort,
					healthCheckCommand,
					livenessEnabled,
					readinessEnabled,
					startupEnabled,
					healthCheckInterval,
					healthCheckTimeout,
					healthCheckRetries,
					startupFailureThreshold,
					healthCheckOverride
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't update health check settings");
			}

			const updated = await response.json();
			if (deployment) mergeInto(deployment, updated);
			else deployment = updated;
			isEditingHealthCheck = false;

			toasts.add({
				title: 'Settings updated',

				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: "Couldn't update health check settings",
				description: e instanceof Error ? e.message : "Couldn't update health check settings",
				color: 'error'
			});
		} finally {
			savingHealthCheck = false;
		}
	}

	async function loadAutoDeployStatus() {
		if (!deployment?.githubRepo) return;

		if (!autoDeployFetched) autoDeployLoading = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/auto-deploy`);
			if (response.ok) {
				autoDeployStatus = await response.json();
				if (!autoDeployBranch) {
					autoDeployBranch = autoDeployStatus?.branch || deployment.githubBranch || '';
				}
				if (!autoDeployPathsLoaded) {
					autoDeployPaths = (autoDeployStatus?.paths ?? []).join('\n');
					autoDeployPathsLoaded = true;
				}

				// If app is not installed, get the install URL
				if (!autoDeployStatus?.appInstalled && !githubAppInstallUrl) {
					loadGitHubAppInstallUrl();
				}
			}
		} catch (e) {
			console.error('Failed to load auto-deploy status:', e);
		} finally {
			autoDeployLoading = false;
		}
	}

	async function loadGitHubAppInstallUrl() {
		if (loadingAppInstallUrl) return;

		loadingAppInstallUrl = true;
		try {
			const response = await apiFetch('/apiv1/github/app/install');
			if (response.ok) {
				const data = await response.json();
				githubAppInstallUrl = data.url;
			}
		} catch (e) {
			console.error('Failed to load GitHub App install URL:', e);
		} finally {
			loadingAppInstallUrl = false;
		}
	}

	async function loadGitHubDeployments() {
		if (!deployment?.githubRepo) return;

		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/github-deployments`);
			if (response.ok) {
				githubDeployments = await response.json();
			}
		} catch (e) {
			console.error('Failed to load GitHub deployments:', e);
		}
	}

	function parseWatchPaths(value: string): string[] {
		return value
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
	}

	async function saveAutoDeployPaths() {
		if (!deployment || !autoDeployStatus?.branch) return;

		savingAutoDeployPaths = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/auto-deploy/enable`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					branch: autoDeployStatus.branch,
					paths: parseWatchPaths(autoDeployPaths)
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't save watch paths");
			}

			const result = await response.json();
			if (deployment) mergeInto(deployment, result);
			else deployment = result;

			autoDeployPaths = (result.autoDeployPaths ?? []).join('\n');

			toasts.add({
				title: 'Watch paths saved',
				description: result.autoDeployPaths?.length
					? 'Only pushes that change these paths build'
					: 'Every push to the branch builds',
				color: 'success'
			});

			await loadAutoDeployStatus();
		} catch (e) {
			toasts.add({
				title: "Couldn't save watch paths",
				description: e instanceof Error ? e.message : "Couldn't save watch paths",
				color: 'error'
			});
		} finally {
			savingAutoDeployPaths = false;
		}
	}

	async function enableAutoDeploy() {
		if (!deployment || !autoDeployBranch) return;

		enablingAutoDeploy = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/auto-deploy/enable`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					branch: autoDeployBranch,
					paths: parseWatchPaths(autoDeployPaths)
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't enable auto-deploy");
			}

			const result = await response.json();
			if (deployment) mergeInto(deployment, result);
			else deployment = result;

			toasts.add({
				title: 'Auto-deploy on',
				description: `Pushes to ${autoDeployBranch} now deploy`,
				color: 'success'
			});

			await loadAutoDeployStatus();
		} catch (e) {
			toasts.add({
				title: "Couldn't enable auto-deploy",
				description: e instanceof Error ? e.message : "Couldn't enable auto-deploy",
				color: 'error'
			});
		} finally {
			enablingAutoDeploy = false;
		}
	}

	async function disableAutoDeploy() {
		if (!deployment) return;

		disablingAutoDeploy = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/auto-deploy/disable`, {
				method: 'POST'
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't disable auto-deploy");
			}

			const result = await response.json();
			if (deployment) mergeInto(deployment, result);
			else deployment = result;
			autoDeployStatus = null;

			toasts.add({
				title: 'Auto-deploy off',
				description: 'Pushes no longer deploy',
				color: 'success'
			});

			await loadAutoDeployStatus();
		} catch (e) {
			toasts.add({
				title: "Couldn't disable auto-deploy",
				description: e instanceof Error ? e.message : "Couldn't disable auto-deploy",
				color: 'error'
			});
		} finally {
			disablingAutoDeploy = false;
		}
	}

	function openGitHubAppInstall() {
		if (githubAppInstallUrl) {
			window.open(githubAppInstallUrl, '_blank');
		}
	}

	function normalizeVolumeName(raw: string): string {
		return raw
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/-{2,}/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 63);
	}

	function normalizeStorageSize(raw: string): string {
		const s = raw.trim();
		if (/^\d+(\.\d+)?$/.test(s)) return `${s}Gi`;
		const m = s.match(/^(\d+(?:\.\d+)?)\s*(gib?|mib?|tib?|gb|mb|tb)$/i);
		if (m) {
			const unit = m[2].toLowerCase();
			const suffix = unit.startsWith('g') ? 'Gi' : unit.startsWith('m') ? 'Mi' : 'Ti';
			return `${m[1]}${suffix}`;
		}
		return s;
	}

	async function saveVolumes() {
		savingVolumes = true;
		try {
			const filteredVolumes = volumes
				.filter((v) => v.pvcName?.trim() && v.mountPath.trim())
				.map((v) => ({
					// Preserve the existing k8s volume name. Substituting pvcName here
					// renamed the volume on every save, which orphaned the volumeMount
					// and broke the strategic-merge patch (400) for any volume whose
					// name differs from its pvcName. New volumes start with name='',
					// so fall back to pvcName only then.
					name: normalizeVolumeName(v.name?.trim() || v.pvcName!),
					type: 'pvc' as const,
					mountPath: v.mountPath.trim(),
					readOnly: v.readOnly,
					pvcName: normalizeVolumeName(v.pvcName!),
					storageSize: normalizeStorageSize(v.storageSize || '') || '1Gi'
				}));

			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/volumes`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ volumes: filteredVolumes })
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || "Couldn't update volumes");
			}

			toasts.add({
				title: 'Storage updated',
				description: 'Your app restarts with the new storage.',
				color: 'success'
			});

			await fetchDeployment();
		} catch (e) {
			isEditingVolumes = true;
			toasts.add({
				title: "Couldn't update storage",
				description: e instanceof Error ? e.message : "Couldn't update storage",
				color: 'error'
			});
		} finally {
			savingVolumes = false;
		}
	}

	function formatBuildDuration(seconds: number): string {
		if (seconds < 60) {
			return `${seconds}s`;
		}
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = Math.floor(seconds % 60);
		return `${minutes}m ${remainingSeconds}s`;
	}

	function getBuildDuration(): string | null {
		const ts = deployment?.buildStepTimestamps as Record<string, number> | null;
		if (!ts) return null;
		const keys = Object.keys(ts);
		if (keys.length === 0) return null;
		const startTime = Math.min(...keys.map((k) => ts[k]));
		const endTime = ts['complete'];
		if (!endTime) return null;
		return formatBuildDuration(Math.max(0, Math.floor((endTime - startTime) / 1000)));
	}

	function getBuildStatusLabel(buildStatus: string) {
		switch (buildStatus?.toLowerCase()) {
			case 'succeeded': {
				const dur = getBuildDuration();
				return dur ? `Completed in ${dur}` : 'Succeeded';
			}
			case 'building':
				return 'Building';
			case 'failed':
				return 'Failed';
			default:
				return 'None';
		}
	}

	// Build logs are refreshed by fetchDeployment, which is triggered by SSE
	// `build.changed` events. Just kick off a single fetch on transition.
	$effect(() => {
		if (deployment?.buildStatus === 'building') {
			fetchBuildLogs();
		}
	});

	let projectIngressesFetched = false;
	$effect(() => {
		const projectId = deployment?.project?.id;
		if (!projectId) return;
		if (tabs.value === 'network') {
			fetchProjectIngresses();
			projectIngressesFetched = true;
		}
	});

	$effect(() => {
		if (showDomainForm && !newDomainServiceKey) {
			newDomainServiceKey = domainServiceOptions[0]?.key ?? '';
		}
	});

	// Subscribe to SSE status changes for the current org.
	$effect(() => {
		const id = $selectedOrganization?.id;
		if (!id) {
			sseStatusValue = 'connecting';
			return;
		}
		const store = sseStatusFor(id);
		return store.subscribe((v) => {
			sseStatusValue = v;
		});
	});

	$effect(() => {
		if (sseStatusValue !== 'disconnected') {
			sseReloadPrompt = false;
			return;
		}
		const t = setTimeout(() => {
			sseReloadPrompt = true;
		}, 6000);
		return () => clearTimeout(t);
	});

	// Reset page state when navigating to a different deployment.
	$effect(() => {
		if (!deploymentId) return;
		const isNewRoute = deploymentId !== lastSeenDeploymentId;
		if (!isNewRoute) return;
		lastSeenDeploymentId = deploymentId;

		loading = true;
		error = null;
		deployment = null;
		lastQueryData = null;
		selectedPod = '';
		selectedContainer = '';
		buildLogs = '';
		accumulatedBuildLogs = null;
		autoDeployFetched = false;
		autoDeployPathsLoaded = false;
		autoDeployPaths = '';
		projectIngressesFetched = false;

		const storedTabs = loadTerminalTabs(terminalTabsKey('deployment', deploymentId));
		terminalTabs = storedTabs ? storedTabs.tabs.map((t) => ({ ...t })) : [];
		activeConsoleTab = storedTabs ? storedTabs.active : 'logs';
		terminalCounter = storedTabs?.counter ?? 0;

		if ($tailscaleEnabled) tailscale.checkStatus();
	});

	$effect(() => {
		const id = deploymentId;
		const tabsSnapshot = terminalTabs.map((t) => ({
			id: t.id,
			podName: t.podName,
			container: t.container,
			label: t.label,
			title: t.title,
			sessionHandle: t.sessionHandle
		}));
		const active = activeConsoleTab;
		if (!id || id !== lastSeenDeploymentId) return;
		saveTerminalTabs(terminalTabsKey('deployment', id), {
			tabs: tabsSnapshot,
			active,
			counter: terminalCounter
		});
	});

	$effect(() => {
		focusDeployment(deploymentId);
		return () => focusDeployment(null);
	});

	const alertStatesQuery = createQuery(() => ({
		queryKey: ['alert-states', deploymentId],
		queryFn: () => fetchAlertStates($selectedOrganization?.id ?? '', deploymentId),
		enabled: !!deploymentId && !!$selectedOrganization?.id,
		refetchInterval: 60_000,
		refetchIntervalInBackground: false
	}));
	const metricAlerts = $derived(alertStatesQuery.data ?? []);

	// SSE subscription: invalidates the TanStack query instead of fetching directly.
	let sseOrgId: string | null = null;
	$effect(() => {
		const orgIdForSse = $selectedOrganization?.id ?? null;
		untrack(() => {
			if (orgIdForSse === sseOrgId) return;
			sseOrgId = orgIdForSse;
			sseUnsub?.();
			if (!orgIdForSse) return;
			sseUnsub = subscribeOrgEvents(orgIdForSse, (ev) => {
				const currentId = deploymentId;
				const relevant = ev.id === currentId || ev.projectId === deployment?.projectId;
				if (!relevant) return;
				if (ev.type === 'deployment.metrics') {
					if (ev.id === currentId) applyMetricsDelta(ev.payload);
				} else if (ev.type === 'pod.changed') {
					if (ev.id === currentId) applyPodDelta(ev.payload);
				} else if (ev.type === 'build.changed') {
					return;
				} else if (ev.id === currentId && ev.type === 'deployment.changed') {
					return;
				} else {
					queryClient.invalidateQueries({ queryKey: ['deployment', currentId] });
				}
			});
		});
	});

	onMount(() => {
		// Reserve scrollbar space so switching between tall/short tabs doesn't shift the
		// centered max-w container left/right when the scrollbar appears/disappears.
		const mainEl = document.querySelector<HTMLElement>('main.flex-1');
		const prevGutter = mainEl?.style.scrollbarGutter ?? '';
		if (mainEl) mainEl.style.scrollbarGutter = 'stable';

		const unregisterEscape = registerShortcut({
			id: 'console-collapse',
			key: 'Escape',
			label: 'Collapse the console',
			allowInInputs: true,
			when: () => consoleExpanded,
			run: toggleConsoleExpand
		});

		// movingicons.dev: by default each icon only animates when its own 14×14 wrapper
		// is hovered. Re-fire each icon's mouseenter when the user enters the parent
		// button/link, so the animation plays on parent hover everywhere.
		let lastHoverButton: HTMLElement | null = null;
		const iconHoverSelector =
			'button, a, .dep-action-btn, .console-tab-btn, .console-source-btn, .console-action-btn, .console-icon-btn, .dep-list-row';
		const onIconHover = (e: PointerEvent) => {
			const btn = (e.target as HTMLElement | null)?.closest?.(
				iconHoverSelector
			) as HTMLElement | null;
			if (btn === lastHoverButton) return;
			lastHoverButton = btn;
			if (!btn || !decorativeMotion()) return;
			// @jis3r icons render as <div role="img" aria-label="..."> with inner svg.
			btn.querySelectorAll<HTMLElement>('[role="img"][aria-label]').forEach((iconWrap) => {
				iconWrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
			});
		};
		document.addEventListener('pointermove', onIconHover, { passive: true });

		// Velocity-aware press lift on action buttons + tabs. Hover lifts ~2px;
		// press compresses proportional to pointer speed at click; release overshoots.
		const detachPress = pressSpringDelegate(
			document.body,
			'.dep-action-btn, .dep-meta-tabs button, .console-action-btn, .console-icon-btn, .console-source-btn, .btn-icon, .btn, .tabs-trigger, .dep-tab, .dep-tab2'
		);

		return () => {
			detachPress();
			if (mainEl) mainEl.style.scrollbarGutter = prevGutter;
			document.removeEventListener('pointermove', onIconHover);
			unregisterEscape();
		};
	});

	onDestroy(() => {
		stopBuildPolling();
		sseUnsub?.();
	});

	$effect(() => {
		if (deploymentId) {
			webhookTokens = [];
		}
	});

	// Refetch webhook tokens every time the deploys tab becomes active.
	$effect(() => {
		if (tabs.value === 'deploys' && deploymentId) {
			untrack(() => fetchWebhookTokens());
		}
	});

	// Same for auto-deploy status + GitHub deployment history on the advanced tab.
	let autoDeployFetched = false;
	$effect(() => {
		if (tabs.value === 'settings' && deployment?.githubRepo) {
			untrack(() => {
				loadAutoDeployStatus();
				loadGitHubDeployments();
				autoDeployFetched = true;
			});
		}
	});

	let quotaMeFetched = false;
	$effect(() => {
		const orgId = $selectedOrganization?.id;
		if (tabs.value === 'settings' && orgId && !quotaMeFetched) {
			quotaMeFetched = true;
			apiFetch(`/apiv1/organizations/${orgId}/quota/me`)
				.then((r) => (r.ok ? r.json() : null))
				.then((q) => {
					if (!q) return;
					if (q.effectiveLimit) {
						effectiveCpuLimit = q.effectiveLimit.cpuMilli ?? null;
						effectiveMemLimit = q.effectiveLimit.memoryBytes ?? null;
					}
				})
				.catch(() => {});
		}
	});

	// Lazy-load org quota defaults when resources tab is opened
	let orgQuotaFetched = false;
	$effect(() => {
		if (tabs.value === 'resources' && !orgQuotaFetched) {
			orgQuotaFetched = true;
			const orgId = $selectedOrganization?.id;
			if (orgId) {
				apiFetch(`/apiv1/organizations/${orgId}/quota`)
					.then((r) => (r.ok ? r.json() : null))
					.then((q) => {
						if (!q?.org) return;
						orgDefaultCpuMilli = q.org.defaultPodCpuMilli ?? null;
						orgDefaultMemoryBytes = q.org.defaultPodMemoryBytes ?? null;
					})
					.catch(() => {});
			}
		}
	});

	async function fetchWebhookTokens() {
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/webhook-tokens`);
			if (response.ok) {
				webhookTokens = await response.json();
			}
		} catch {
			// silent
		}
	}

	async function createWebhookToken() {
		creatingWebhookToken = true;
		newlyCreatedToken = null;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/webhook-tokens`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ label: newWebhookLabel || undefined })
			});
			if (response.ok) {
				const data = await response.json();
				newlyCreatedToken = data.token;
				newWebhookLabel = '';
				await fetchWebhookTokens();
				toasts.add({ title: 'Webhook token created', color: 'success' });
			} else {
				toasts.add({ title: "Couldn't create webhook token", color: 'error' });
			}
		} catch {
			toasts.add({ title: "Couldn't create webhook token", color: 'error' });
		} finally {
			creatingWebhookToken = false;
		}
	}

	async function deleteWebhookToken(tokenId: string) {
		deletingWebhookTokenId = tokenId;
		try {
			const response = await apiFetch(
				`/apiv1/deployments/${deploymentId}/webhook-tokens/${tokenId}`,
				{
					method: 'DELETE'
				}
			);
			if (response.ok) {
				await fetchWebhookTokens();
				toasts.add({ title: 'Webhook token deleted', color: 'success' });
			} else {
				toasts.add({ title: "Couldn't delete webhook token", color: 'error' });
			}
		} catch {
			toasts.add({ title: "Couldn't delete webhook token", color: 'error' });
		} finally {
			deletingWebhookTokenId = null;
		}
	}

	function copyToClipboard(text: string, type: 'token' | 'url') {
		navigator.clipboard.writeText(text);
		if (type === 'token') {
			copiedWebhookToken = true;
			setTimeout(() => (copiedWebhookToken = false), 2000);
		} else {
			copiedWebhookUrl = true;
			setTimeout(() => (copiedWebhookUrl = false), 2000);
		}
	}

	function getWebhookUrl(token: string): string {
		const base = window.location.origin;
		return `${base}/apiv1/webhooks/deploy/${token}`;
	}

	const webhookExamples = {
		restart: `curl -X POST YOUR_WEBHOOK_URL`,
		updateTag: `curl -X POST YOUR_WEBHOOK_URL \\
  -H "Content-Type: application/json" \\
  -d '{"tag": "v1.2.3"}'`,
		updateImage: `curl -X POST YOUR_WEBHOOK_URL \\
  -H "Content-Type: application/json" \\
  -d '{"image": "ghcr.io/org/app", "tag": "sha-abc123"}'`,
		githubActions: `# .github/workflows/deploy.yml
- name: Trigger deploy
  run: |
    curl -s -X POST \\
      \${{ secrets.WEBHOOK_URL }} \\
      -H "Content-Type: application/json" \\
      -d '{"tag": "\${{ github.sha }}"}'`
	};

	function handleViewBuildLogs() {
		buildModalStatus = 'failed';
		buildModalError = deployment?.buildError ?? null;
		accumulatedBuildLogs = deployment?.buildLogs ?? null;
		buildModalStep = null;
		buildModalWarnings = [];
		buildModalTimestamps = deployment?.buildStepTimestamps ?? null;
		showBuildModal = true;
	}

	function handleCloseBuildModal() {
		showBuildModal = false;
		showBuildCard = false;
		stopBuildPolling();
	}
</script>

{#if $page.url.searchParams.has('guides')}<GoldenReticle />{/if}

<div
	class="deployment-page dep-shell p-6 max-w-400 mx-auto"
	class:dep-shell--fit={tabs.value === 'overview' && !!deployment}
>
	{#if deployment?.project?.slug}
		<div class="mb-4">
			<Breadcrumbs
				crumbs={[
					{ label: 'Home', href: `/${orgSlug}` },
					{
						label: deployment.project.name || deployment.project.slug,
						href: `/${orgSlug}/projects/${deployment.project.slug}`
					},
					{ label: deployment.name }
				]}
			/>
		</div>
	{:else}
		<div class="mb-4">
			<Breadcrumbs
				crumbs={[{ label: 'Home', href: `/${orgSlug}` }, { label: deployment?.name || 'App' }]}
			/>
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error mb-6">{error}</div>
	{/if}

	{#if loading}
		<div class="dep-skeleton" aria-busy="true">
			<section class="dep-skeleton-head">
				<div class="dep-skeleton-row">
					<Skeleton width="12rem" height="2rem" />
					<Skeleton width="4.5rem" height="1.5rem" rounded="999px" />
					<span class="dep-skeleton-fill"></span>
					<Skeleton width="6rem" height="2.25rem" rounded="999px" />
					<Skeleton width="6rem" height="2.25rem" rounded="999px" />
				</div>
				<div class="dep-skeleton-row">
					<Skeleton width="16rem" height="0.875rem" />
					<Skeleton width="10rem" height="0.875rem" />
				</div>
			</section>
			<div class="dep-skeleton-tabs">
				{#each Array(7) as _, i (i)}
					<Skeleton width="6.5rem" height="2.25rem" rounded="999px" />
				{/each}
			</div>
		</div>
	{:else if deployment}
		{@const _activeBuild = deployment.imageHistory?.find((h) => h.isActive)}
		{@const _isBuilding =
			deployment.buildStatus === 'building' ||
			deployment.buildStatus === 'queued' ||
			deployment.buildStatus === 'pending'}
		{@const _buildFailed = deployment.buildStatus === 'failed'}
		{@const _activeFallbackMsg = _activeBuild?.commitSha
			? deployment.imageHistory?.find(
					(h) => h.commitMessage && h.commitSha === _activeBuild.commitSha
				)?.commitMessage
			: undefined}
		{@const _commitLead = deployment.githubRepo
			? _activeBuild
				? _activeBuild.commitMessage || _activeFallbackMsg || null
				: _isBuilding
					? `Deploying from ${deployment.githubBranch || 'main'}…`
					: _buildFailed
						? 'Last deployment failed'
						: null
			: deployment.image || null}
		{@const _commitLeadMono = !deployment.githubRepo && !!deployment.image}
		<div class="dep-stack">
			{#if sseReloadPrompt || debugAlerts}
				<div class="sse-reload-banner" role="alert" transition:slide={{ duration: 150 }}>
					<div class="sse-reload-icon"><WifiOff size={22} /></div>
					<div class="sse-reload-body">
						<span class="sse-reload-title">Live updates disconnected</span>
						<span class="sse-reload-text"
							>Orchard couldn't reconnect. What you see may be out of date. Reload to get the
							latest.</span
						>
					</div>
					<button class="sse-reload-btn" onclick={() => location.reload()}>
						<RotateCw size={16} />
						<span>Reload page</span>
					</button>
				</div>
			{/if}

			<Modal bind:open={appPictureOpen} title="App picture" size="sm">
				<Field label="Picture" for="app-picture-input">
					<ImageField
						id="app-picture-input"
						bind:value={appPictureValue}
						bind:busy={uploadingAppPicture}
						upload={uploadAppPicture}
						accept="image/jpeg,image/png,image/gif,image/webp"
						removable={false}
					/>
				</Field>
			</Modal>
			<DeploymentHeader
				{deployment}
				{headerCollapsed}
				{deploymentStatusChip}
				{buildStatusChip}
				{deployChip}
				debugChips={debugAlerts ? DEBUG_CHIPS : []}
				{repoUrl}
				{rebuilding}
				{restarting}
				stopped={deployment.stopped}
				{stopping}
				{starting}
				{deleting}
				{actionAnim}
				{_isBuilding}
				onRebuild={rebuild}
				onRestart={restart}
				onStop={() => (showStopModal = true)}
				onStart={() => lifecycleAction('start')}
				onRename={() => (renameOpen = true)}
				onChangePicture={openAppPicture}
				uploadingPicture={uploadingAppPicture}
				onShowDeleteModal={() => (showDeleteModal = true)}
				onTriggerActionAnim={triggerActionAnim}
				onViewBuildLogs={handleViewBuildLogs}
				{_commitLead}
				{_commitLeadMono}
				{_activeBuild}
				{_buildFailed}
				{branch}
			>
				{#snippet setup()}
					<NextSteps
						deploymentId={deployment?.id ?? ''}
						ready={!!deployment && deployment.buildStatus !== 'building' && !noPodsReady}
						onGoToTab={(t) => gotoTab(t as TabId)}
						onGoToSettings={gotoSettings}
					/>
				{/snippet}
			</DeploymentHeader>

			{#if deployment?.limitsRestartPending}
				<p class="limits-hint">Restart to apply the resource limits setting.</p>
			{/if}

			<div class="dep-tabs-bar">
				<PageTabs
					label="App sections"
					tabs={visibleTabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon ?? Puzzle }))}
					value={tabs.value}
					onchange={(v) => gotoTab(v)}
				/>
			</div>

			<DeploymentAlerts
				applyError={deployment?.applyError ?? ''}
				onRetryApply={async () => {
					try {
						const res = await apiFetch(`/apiv1/deployments/${deploymentId}/retry-apply`, {
							method: 'POST'
						});
						if (!res.ok) {
							const d = await res.json().catch(() => ({}));
							throw new Error(d.message || 'Try again.');
						}
						queryClient.invalidateQueries({ queryKey: ['deployment', deploymentId] });
					} catch (e) {
						toasts.add({
							title: "Couldn't retry",
							description: e instanceof Error ? e.message : undefined,
							color: 'error'
						});
					}
				}}
				buildFailed={buildFailedActive}
				buildLogs={deployment?.buildLogs ?? ''}
				buildError={debugAlerts
					? $page.url.searchParams.get('debugAlerts') === 'github'
						? 'Build failed: ERROR: GitHub authentication failed.'
						: 'Build failed: process "/bin/sh -c npm ci" did not complete successfully: exit code 1'
					: (deployment?.buildError ?? '')}
				problems={health.problems}
				serving={health.serving}
				onPodLogs={openPodLogs}
				{resourcePressure}
				onViewLogs={handleViewBuildLogs}
				onGoToResources={() => {
					gotoSettings('resources');
				}}
				githubRepoUrl={deployment?.githubRepo ?? ''}
				{metricAlerts}
				anomalies={anomalies.items}
				onGoToAlerts={() => gotoSettings('notifications')}
				canReconnectGithub={!!deployment?.createdBy && deployment.createdBy === $user?.id}
				onReconnectGithub={() => {
					const back = $page.url.pathname + $page.url.search;
					window.location.href = '/apiv1/github/link?redirect=' + encodeURIComponent(back);
				}}
			/>

			{#if deployment?.queuedCommitSha}
				<div class="deploy-queue-banner">
					<Clock size={15} class="deploy-queue-icon" />
					<div class="deploy-queue-text">
						<span class="deploy-queue-title">Next deploy queued</span>
						<span class="deploy-queue-detail">
							<span class="deploy-queue-sha">{deployment.queuedCommitSha.slice(0, 7)}</span>
							{#if deployment.queuedCommitMessage}
								· {deployment.queuedCommitMessage.split('\n')[0]}
							{/if}
							· builds when the current one finishes
						</span>
					</div>
				</div>
			{/if}

			{#each visibleTabs as tab (tab.id)}
				<section
					{...tabs.getContent(tab.id)}
					hidden={undefined}
					class="tab-panel"
					{@attach motionPanel(() => tabs.value === tab.id)}
				>
					{#if tab.id === 'overview'}
						<OverviewTab
							{deployment}
							consoleVisible={tabs.value === 'overview'}
							{activePods}
							{resourcePressure}
							bind:selectedPod
							podGone={selectedPodGone}
							{replacementPod}
							bind:selectedContainer
							bind:scaleReplicas
							{consoleExpanded}
							{consoleAnimating}
							bind:consoleRef
							{consoleInlineRect}
							{scaling}
							{deletingPod}
							bind:activeConsoleTab
							bind:terminalTabs
							onScaleDeployment={scaleDeployment}
							onScaleChange={setScaleValue}
							onDeletePod={deletePod}
							onToggleConsoleExpand={toggleConsoleExpand}
							onOpenShell={openShell}
							onCloseTerminalTab={closeTerminalTab}
							onTerminalTitle={setTerminalTitle}
							onTerminalBell={setTerminalBell}
							onTerminalSession={setTerminalSession}
							onSelectLogsPod={selectLogsPod}
							onSetTabMetrics={(view) => {
								observeView = view ?? 'metrics';
								gotoTab('observe');
							}}
							onRefreshPods={() => {
								queryClient.invalidateQueries({ queryKey: ['deployment', deploymentId] });
								refreshPodsLive();
							}}
							podVersions={health.pods}
							{podLabel}
						/>
						{#if graftProps}
							<GraftCards slot="deployment.overview.cards" props={graftProps} />
						{/if}
					{:else if tab.id === 'variables'}
						<EnvironmentTab
							bind:envVars
							bind:isEditing={isEditingEnv}
							{savingEnv}
							onSave={saveEnv}
							onDiscard={discardEnv}
							{bindings}
							resourceOptions={bindingOptions}
							onConnect={connectResource}
							conflicts={deployment?.envConflicts ?? []}
						/>
					{:else if tab.id === 'network'}
						<NetworkTab
							{deployment}
							tailscaleFeatureEnabled={$tailscaleEnabled}
							tailscaleLinked={tailscale.linked}
							tailscaleExposing={tailscale.exposing}
							tailscaleUnexposing={tailscale.unexposing}
							tailscaleDns={tailscale.dns}
							tailscaleIp={tailscale.ip}
							tailscaleHostname={tailscale.hostname}
							onExposeTailscale={() => tailscale.expose()}
							onUnexposeTailscale={() => tailscale.unexpose()}
							bind:showServiceForm={services.showForm}
							bind:newServiceForm={services.newForm}
							serviceFormError={services.formError}
							bind:serviceEditForms={services.editForms}
							serviceEditErrors={services.editErrors}
							creatingService={services.creating}
							serviceSavingId={services.savingId}
							serviceDeletingId={services.deletingId}
							portPublicBusyId={services.portPublicBusyId}
							bind:isEditingServices={services.isEditing}
							onCreateService={() => services.create()}
							onSaveServicePorts={(id) => services.savePorts(id)}
							onDeleteService={(id) => services.delete(id)}
							onToggleServiceEdit={(svc) => services.toggleEdit(svc)}
							onTogglePortPublic={(s, p, e) => services.togglePortPublic(s, p, e)}
							onResetNewServiceForm={() => services.resetNewForm()}
							onUpdateNewServicePort={(i, c) => services.updateNewPort(i, c)}
							onUpdateServiceEditPort={(id, i, c) => services.updateEditPort(id, i, c)}
							onCopyInternalUrl={(url, id) => services.copyInternalUrl(url, id)}
							copiedUrlId={services.copiedUrlId}
							bind:showDomainForm
							bind:newDomainHost
							bind:newDomainPath
							bind:newDomainTlsEnabled
							bind:newDomainServiceKey
							bind:newDomainRoutingMode
							bind:newDomainRedirectTarget
							bind:newDomainRedirectStatus
							bind:showDomainAdvanced
							{creatingDomain}
							{domainFormError}
							{domainServiceOptions}
							{newDomainNormalizedHost}
							{newDomainNormalizedPath}
							{newDomainConflict}
							{deletingIngressId}
							onCreateDomain={createDomain}
							{projectIngresses}
							onDeleteIngress={deleteIngress}
							onResetDomainForm={resetDomainForm}
							onGenerateRandomDomain={generateRandomDomainForNew}
							onCheckDns={checkDomainDns}
							onUpdateProtection={updateProtection}
							{protectionUpdatingId}
							onUpdateRedirect={updateRedirect}
							{redirectUpdatingId}
							{toasts}
						/>
					{:else if tab.id === 'observe'}
						<ObserveTab
							{deployment}
							active={tabs.value === 'observe'}
							bind:activeTab={observeView}
						/>
					{:else if tab.id === 'files'}
						<FilesTab
							deploymentId={deployment.id}
							namespace={deployment.namespace ?? ''}
							pods={deployment.pods ?? []}
							active={tabs.value === 'files'}
						/>
					{:else if tab.id === 'deploys'}
						<DeploysTab
							{deployment}
							{rebuilding}
							{rollingBackId}
							onRebuild={rebuild}
							onOpenLogModal={openLogModal}
							onRollback={requestRollback}
							onViewBuildLogs={handleViewBuildLogs}
							{isDockerImageDeployment}
							deploymentId={deployment.id}
							{webhookTokens}
							{creatingWebhookToken}
							{deletingWebhookTokenId}
							bind:newlyCreatedToken
							onCreateToken={(label) => {
								newWebhookLabel = label;
								createWebhookToken();
							}}
							onDeleteToken={deleteWebhookToken}
						/>
					{:else if tab.id === 'security'}
						<SecurityTab
							{deploymentId}
							image={deployment?.image ?? null}
							hasDomains={(deployment?.ingresses?.length ?? 0) > 0}
							active={tabs.value === 'security'}
						/>
					{:else if tab.id === 'settings'}
						<AppSettings
							{deployment}
							organizationId={$selectedOrganization?.id ?? null}
							activeSection={settingsSection}
							hrefFor={settingsHref}
							onSourceUpdated={handleSourceUpdated}
							onDeploymentUpdated={handleDeploymentUpdated}
							onRebuild={rebuild}
							{rebuilding}
							bind:strategyValue
							{savingStrategy}
							{hasPvcVolume}
							onSaveStrategy={saveStrategy}
							bind:pdbMinAvailable
							{savingPdb}
							onSavePdb={savePdb}
							bind:buildFromRoot
							bind:buildWithDepot
							bind:persistentBuildCache
							bind:builderOverride
							bind:buildOptionsDirty={isEditingBuildOptions}
							{savingAdvanced}
							onSaveAdvanced={saveAdvanced}
							{savingBuildConfig}
							onSaveBuildConfig={saveBuildConfig}
							{autoDeployStatus}
							{autoDeployLoading}
							bind:autoDeployBranch
							bind:autoDeployPaths
							{savingAutoDeployPaths}
							onSaveAutoDeployPaths={saveAutoDeployPaths}
							{enablingAutoDeploy}
							{disablingAutoDeploy}
							{githubDeployments}
							{githubAppInstallUrl}
							{loadingAppInstallUrl}
							onEnableAutoDeploy={enableAutoDeploy}
							onDisableAutoDeploy={disableAutoDeploy}
							onOpenGitHubAppInstall={openGitHubAppInstall}
							bind:healthCheckEnabled
							bind:healthCheckType
							bind:healthCheckPath
							bind:healthCheckPort
							bind:healthCheckCommand
							bind:livenessEnabled
							bind:readinessEnabled
							bind:startupEnabled
							bind:healthCheckInterval
							bind:healthCheckTimeout
							bind:healthCheckRetries
							bind:startupFailureThreshold
							bind:healthCheckOverride
							{savingHealthCheck}
							bind:isEditingHealthCheck
							onSaveHealthCheck={saveHealthCheck}
							bind:resourceCpuMilli
							bind:resourceMemoryBytes
							{orgDefaultCpuMilli}
							{orgDefaultMemoryBytes}
							{effectiveCpuLimit}
							{effectiveMemLimit}
							bind:resourcesDirty
							{savingResources}
							{isImageSourceDeployment}
							bind:imageInput
							{imageDirty}
							{savingImage}
							onSaveResources={saveResources}
							onSaveImage={saveImage}
							{pullPolicy}
							effectivePullPolicy={deployment?.effectiveImagePullPolicy ?? 'IfNotPresent'}
							{savingPullPolicy}
							onSavePullPolicy={savePullPolicy}
							bind:volumes
							bind:isEditingVolumes
							{savingVolumes}
							onSaveVolumes={saveVolumes}
							{deleting}
							onShowDeleteModal={() => (showDeleteModal = true)}
						/>
					{:else if graftProps}
						{@const graftTab = graftTabs.find((t) => t.id === tab.id)}
						{#if graftTab && tabs.value === tab.id}
							<GraftMount
								graftId={graftTab.graftId}
								mount={graftTab.mount}
								props={graftProps}
								host={graftTab.host}
							/>
						{/if}
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</div>

<BuildProgressModal
	{deployment}
	bind:showBuildModal
	{buildModalStatus}
	{buildModalStep}
	{buildModalError}
	{buildModalWarnings}
	{buildModalTimestamps}
	{accumulatedBuildLogs}
	{buildElapsed}
	{buildProgressValue}
	{canCancelBuild}
	{cancelingBuild}
	onMinimizeBuildModal={minimizeBuildModal}
	onCancelBuild={cancelBuildFromModal}
	onCloseBuildModal={handleCloseBuildModal}
	{formatBuildElapsed}
	bind:showBuildCard
	bind:showBuildCardRender
	onExpandBuildCard={expandBuildCard}
/>

{#if deployment}
	<RenameModal
		bind:open={renameOpen}
		title="Rename app"
		value={deployment.displayName || deployment.name}
		saving={renamingApp}
		onSave={renameApp}
	/>
	<ConfirmModal
		bind:open={showStopModal}
		title={`Stop "${deployment.displayName || deployment.name}"?`}
		description={`All ${deployment.replicas} replica${deployment.replicas === 1 ? '' : 's'} stop. You can start the app again with the same replica count.`}
		confirmLabel="Stop app"
		danger={false}
		onconfirm={() => lifecycleAction('stop')}
		oncancel={() => {}}
	/>
	<ConfirmModal
		bind:open={showDeleteModal}
		title={`Delete "${deployment.displayName || deployment.name}"?`}
		description="This permanently deletes <strong>this app</strong>, its pods, domains and build history. Its volumes and their data are deleted too. You can't undo this."
		html
		confirmLabel="Delete app"
		onconfirm={deleteDeployment}
		oncancel={() => {}}
	/>
{/if}

{#if rollbackTarget}
	<ConfirmModal
		bind:open={showRollbackModal}
		title="Promote this image to production?"
		description={`Your app restarts with the image tagged <strong>${escapeHtml(rollbackTargetTag)}</strong>.`}
		html
		confirmLabel="Promote"
		danger={false}
		onconfirm={confirmRollback}
		oncancel={() => (rollbackTarget = null)}
	>
		<Checkbox
			bind:checked={rollbackRestoreDatabases}
			label="Also restore bound databases to before this deploy"
			hint="Each goes back to its checkpoint from before the deploy."
		/>
	</ConfirmModal>
{/if}

<Modal bind:open={() => !!logModalId, (v) => !v && closeLogModal()} title="Build logs" size="xl">
	<div class="build-log-body">
		<BuildLog
			parsed={logModalParsed}
			lines={logModalLines}
			loading={logModalLoading}
			error={logModalError}
			filename="{deployment?.name ?? 'app'}-build"
		/>
	</div>
</Modal>

<style>
	.limits-hint {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
	.dep-skeleton {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	.dep-skeleton-head {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.5rem;
		border-radius: calc(var(--radius-widget) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.dep-skeleton-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.dep-skeleton-fill {
		flex: 1;
	}
	.dep-skeleton-tabs {
		display: flex;
		gap: 0.25rem;
		align-self: flex-start;
		max-width: 100%;
		overflow: hidden;
		padding: 0.25rem;
		border-radius: var(--radius-pill);
		background: var(--material-glass-bg);
	}
</style>
