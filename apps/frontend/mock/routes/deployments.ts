import { freshId, sha, slugify, uid } from '../ids.ts';
import { BUCKET_MS, since, structured, tail } from '../logs.ts';
import type { MockContext } from '../plugin.ts';
import { STREAMING, notFound, reply, type Router } from '../router.ts';
import { openStream, writeMessage } from '../events.ts';
import { creator, deploymentSummary, ingress } from '../serialize.ts';
import { BUILD_FAILURES, SAMPLE_BUILD_LOG, type BuildFailureKind, type Store } from '../store.ts';
import type { MockDeployment } from '../types.ts';
import {
	POD_SCENARIOS,
	podFacts,
	podShape,
	scenarioOf,
	statusFromPods,
	type PodScenario
} from '../scenarios.ts';
import { metricSeries, metricsWindow } from './databases.ts';

const MIB = 1024 ** 2;

function namespaceOf(store: Store, d: MockDeployment) {
	return store.state.environments.find((e) => e.id === d.environmentId)?.namespace ?? 'default';
}

type PodPlan = {
	seed: string;
	index: number;
	scenario: PodScenario;
	booting?: boolean;
	slot?: number;
};

function planPods(store: Store, d: MockDeployment): PodPlan[] {
	const ro = d.rollout;
	const all = Array.from({ length: d.replicas }, (_, i) => i);
	if (!ro)
		return all.flatMap((i): PodPlan[] => {
			const scenario = scenarioOf(d, i);
			const plan = { seed: d.podSeed, index: i, scenario };
			if (scenario !== 'evicted') return [plan];
			return [plan, { seed: d.podSeed, index: i, scenario: 'healthy', slot: i + 100 }];
		});
	const elapsed = Date.now() - ro.startedAt;
	const plans: PodPlan[] = [];
	if (ro.outcome === 'healthy') {
		const started = Math.min(d.replicas, 1 + Math.floor(elapsed / 4_000));
		const lastAge = elapsed - (started - 1) * 4_000;
		const ready = lastAge >= 2_500 ? started : started - 1;
		for (let i = 0; i < d.replicas - ready; i++) {
			plans.push({ seed: ro.prev, index: i, scenario: scenarioOf(d, i) });
		}
		for (let i = 0; i < started; i++) {
			plans.push({ seed: ro.next, index: i, scenario: 'healthy', booting: i >= ready });
		}
	} else {
		for (const i of all) plans.push({ seed: ro.prev, index: i, scenario: scenarioOf(d, i) });
		plans.push({ seed: ro.next, index: 0, scenario: ro.outcome });
	}
	if (ro.middle) plans.push({ seed: ro.middle, index: 0, scenario: 'terminating' });
	return plans;
}

export function podsOf(store: Store, d: MockDeployment) {
	if (d.stopped || d.replicas === 0) return [];
	const count = d.replicas;
	const pods = planPods(store, d).map(({ seed, index: i, scenario, booting, slot }) => {
		const name = store.podName(d, slot ?? i, seed);
		const base = podShape(d, name, scenario);
		const shape = booting ? { ...base, status: 'starting', warnings: [], events: [] } : base;
		const share = 1 / count;
		const jitter = 0.85 + (parseInt(sha(name).slice(0, 4), 16) % 30) / 100;
		const ip = shape.scheduled ? `10.42.${1 + i}.${(d.name.length * 13 + i * 7) % 250}` : null;
		const startedAt =
			seed === d.podSeed
				? d.podStartedAt
				: new Date(d.rollout?.startedAt ?? Date.now()).toISOString();
		const image = store.revisionsOf(d).find((r) => r.seed === seed)?.image ?? d.image;
		const fromRollout = seed !== d.podSeed;
		const since = fromRollout
			? startedAt
			: new Date(d.podScenarioAt?.[i] ?? Date.parse(d.podStartedAt)).toISOString();
		const facts = podFacts(d, slot ? 'healthy' : scenario, shape, {
			since,
			startedAt,
			image,
			booting
		});
		return {
			id: uid(`pod:${name}`),
			name,
			status: shape.status,
			ip,
			podIp: ip,
			nodeName: shape.scheduled ? ['house', 'barn', 'shed'][i % 3] : null,
			revision: seed.slice(0, 9),
			restartCount: shape.restarts,
			startTime: shape.scheduled ? startedAt : null,
			cpuUsage: shape.running && !booting ? Math.round(d.cpuUsageMilli * share * jitter) : 0,
			memoryUsage: shape.running ? Math.round(d.memoryUsageBytes * share * jitter) : 0,
			...facts,
			events: shape.events.map((e) => ({
				...e,
				firstTimestamp: d.updatedAt,
				lastTimestamp: new Date(Date.now() - 30_000).toISOString()
			})),
			warningLines: shape.warnings
		};
	});
	store.notePods(
		d.id,
		pods.map((p) => p.name)
	);
	return pods;
}

export function rolloutOf(store: Store, d: MockDeployment) {
	const pods = podsOf(store, d);
	const current = (d.rollout ? d.rollout.next : d.podSeed).slice(0, 9);
	const revisions = store
		.revisionsOf(d)
		.map((r) => {
			const hash = r.seed.slice(0, 9);
			const mine = pods.filter((p) => p.revision === hash);
			return {
				hash,
				number: r.number,
				image: r.image,
				createdAt: r.createdAt,
				replicas: mine.length,
				ready: mine.filter((p) => p.status === 'ready').length
			};
		})
		.filter((r) => r.hash === current || r.replicas > 0)
		.sort((a, b) => b.number - a.number);
	const ready = pods.filter((p) => p.status === 'ready').length;
	const previous =
		store
			.revisionsOf(d)
			.filter((r) => r.seed.slice(0, 9) !== current)
			.sort((a, b) => b.number - a.number)
			.map((r) => ({
				hash: r.seed.slice(0, 9),
				number: r.number,
				image: r.image,
				createdAt: r.createdAt,
				replicas: 0,
				ready: 0
			}))[0] ?? null;
	return {
		currentRevision: current,
		revisions,
		previous: revisions.find((r) => r.hash !== current && r.ready > 0) ?? previous,
		desired: d.stopped ? 0 : d.replicas,
		updated: pods.filter((p) => p.revision === current).length,
		ready,
		available: ready,
		state: d.rollout ? (d.rollout.failed ? 'failed' : 'progressing') : 'stable',
		reason: d.rollout?.failed ? 'ProgressDeadlineExceeded' : null
	};
}

function warnings(store: Store, d: MockDeployment) {
	return podsOf(store, d).flatMap((p) =>
		p.warningLines.map((message) => ({
			podName: p.name,
			message,
			timestamp: new Date(Date.now() - 30_000).toISOString()
		}))
	);
}

function stripMock<T extends { warningLines?: string[] }>(pod: T) {
	const { warningLines: _, ...rest } = pod;
	return rest;
}

function service(store: Store, d: MockDeployment) {
	const ns = namespaceOf(store, d);
	const internalHost = `${d.name}.${ns}.svc.cluster.local`;
	return {
		id: uid(`svc:${d.id}`),
		deploymentId: d.id,
		name: d.name,
		type: d.host ? 'ingress' : 'internal',
		port: 80,
		targetPort: d.port,
		protocol: 'TCP',
		nodePort: null,
		externalIp: null,
		domain: d.host,
		internalHost,
		internalUrl: `http://${internalHost}`,
		internalUrls: [`http://${internalHost}`, `http://${d.name}`],
		ports: [
			{
				id: uid(`svcport:${d.id}`),
				serviceId: uid(`svc:${d.id}`),
				name: 'http',
				port: 80,
				targetPort: d.port,
				protocol: 'TCP',
				nodePort: null,
				publicEnabled: d.name === 'game-server',
				publicPort: d.name === 'game-server' ? 30565 : null,
				publicAddress: d.name === 'game-server' ? 'tcp.orchard.my:30565' : null,
				...(d.name === 'game-server'
					? { publicStatus: { state: 'ready', addresses: ['203.0.113.10'], reason: null } }
					: {}),
				internalUrl: `http://${internalHost}`
			},
			...(d.name === 'game-server'
				? [
						{
							id: uid(`svcport:${d.id}:query`),
							serviceId: uid(`svc:${d.id}`),
							name: 'query',
							port: 27015,
							targetPort: 27015,
							protocol: 'UDP',
							nodePort: null,
							publicEnabled: false,
							publicPort: null,
							publicAddress: null,
							internalUrl: `${internalHost}:27015`
						}
					]
				: [])
		],
		createdAt: d.createdAt,
		updatedAt: d.updatedAt
	};
}

function mockChanges(store: Store, d: MockDeployment, start: number, end: number) {
	const seb = store.user(store.state.meId);
	const actor = seb
		? { id: seb.id, name: [seb.firstName, seb.lastName].filter(Boolean).join(' ') }
		: null;
	const deploys = store
		.buildsOf(d.id)
		.filter((b) => b.status === 'succeeded')
		.map((b) => ({
			id: `release:${b.id}`,
			t: new Date(b.buildCompletedAt ?? b.createdAt).getTime(),
			kind: 'deploy',
			tone: 'deploy',
			label: `${b.commitSha ? b.commitSha.slice(0, 7) : b.image.split(':').at(-1)} went live`,
			detail: b.commitMessage?.split('\n')[0] ?? null,
			actor,
			imageHistoryId: b.id
		}));
	const now = Date.now();
	const extra = [
		{
			id: `audit:${d.id}:resources`,
			t: now - 3 * 3_600_000,
			kind: 'resources',
			tone: 'config',
			label: 'Resources changed',
			detail: 'memory 2 GB → 4 GB',
			actor
		},
		{
			id: `audit:${d.id}:env`,
			t: now - 95 * 60_000,
			kind: 'env',
			tone: 'config',
			label: 'Environment variables updated',
			detail: null,
			actor
		},
		{
			id: `cluster:${d.id}:evicted`,
			t: now - 5 * 3_600_000 - 12 * 60_000,
			kind: 'eviction',
			tone: 'platform',
			label: 'Pod evicted',
			detail: 'The node was low on resource: memory. · on house',
			actor: null
		}
	];
	const changes = [...deploys, ...extra]
		.filter((c) => c.t >= start && c.t <= end)
		.sort((a, b) => a.t - b.t);
	return { changes, truncated: false };
}

function mockVerdict(store: Store, d: MockDeployment) {
	if (d.name !== 'api') return null;
	const live = store.buildsOf(d.id).find((b) => b.isActive);
	if (!live) return null;
	const version = live.commitSha
		? live.commitSha.slice(0, 7)
		: (live.image.split(':').at(-1) ?? '');
	return {
		releaseId: `release:${live.id}`,
		imageHistoryId: live.id,
		at: new Date(Date.now() - 40 * 60_000).toISOString(),
		status: 'regressed',
		summary: `${version}: responses 38% slower (p95 180 → 248 ms); errors unchanged`,
		version,
		lines: [
			{ dimension: 'p95', status: 'regressed', text: 'Responses 38% slower (p95 180 → 248 ms)' },
			{ dimension: 'errors', status: 'unchanged', text: 'Errors unchanged' }
		],
		newErrorGroups: 0
	};
}

function imageHistory(store: Store, d: MockDeployment) {
	return store
		.buildsOf(d.id)
		.filter((b) => b.status !== 'building')
		.slice(0, 20)
		.map((b) => {
			const by = store.user(b.triggeredById);
			return {
				id: b.id,
				image: b.image,
				tag: b.image.split(':').at(-1),
				branch: b.branch,
				commitSha: b.commitSha,
				commitMessage: b.commitMessage,
				commitAuthorName: b.commitAuthorName,
				commitAuthorUsername: b.commitAuthorUsername,
				buildStartedAt: b.buildStartedAt,
				buildCompletedAt: b.buildCompletedAt,
				createdAt: b.createdAt,
				isActive: b.isActive,
				status: b.status,
				triggerType: b.triggerType === 'push' ? 'auto' : b.triggerType,
				triggeredBy: by
					? { id: by.id, username: by.username, firstName: by.firstName, lastName: by.lastName }
					: null
			};
		});
}

export function deploymentDetail(store: Store, d: MockDeployment) {
	const p = store.project(d.projectId)!;
	const env = store.state.environments.find((e) => e.id === d.environmentId);
	const pods = podsOf(store, d);
	const ready = pods.filter((x) => x.status === 'ready').length;
	const svc = service(store, d);
	return {
		...deploymentSummary(store, d),
		projectId: d.projectId,
		environmentId: d.environmentId,
		namespace: namespaceOf(store, d),
		buildStep: d.buildStep,
		buildStepTimestamps: d.buildStepTimestamps,
		buildLogs: d.buildLogs,
		buildError: d.buildError,
		availableReplicas: ready,
		specReplicas: d.stopped ? 0 : d.replicas,
		readyReplicas: ready,
		observedAt: new Date().toISOString(),
		meteredPods: pods.length,
		totalCpuUsage: pods.reduce((a, x) => a + (x.cpuUsage ?? 0), 0),
		totalMemoryUsage: pods.reduce((a, x) => a + (x.memoryUsage ?? 0), 0),
		cpuRequestMilli: d.cpuRequestMilli,
		memoryRequestBytes: String(d.memoryRequestBytes),
		githubRepo: d.githubRepo ? `https://github.com/${d.githubRepo}` : null,
		buildType: d.buildType,
		dockerfilePath: d.buildType === 'dockerfile' ? 'Dockerfile' : null,
		dockerfileTarget: null,
		buildFromRoot: false,
		buildWithDepot: false,
		persistentBuildCache: true,
		builderOverride: null,
		rootDirectory: null,
		framework: d.framework,
		installCommand: null,
		buildCommand: null,
		startCommand: null,
		outputDirectory: null,
		detectedConfig: d.framework
			? {
					framework: d.framework,
					providers: [d.framework === 'rails' ? 'ruby' : 'node'],
					isStatic: d.framework === 'vite',
					packageManager: d.framework === 'rails' ? null : 'pnpm',
					railpackVersion: '0.9.1'
				}
			: null,
		autoDeployEnabled: d.autoDeployEnabled,
		autoDeployBranch: d.githubBranch,
		autoDeployPaths: [],
		healthCheckEnabled: Boolean(d.host),
		healthCheckType: 'http',
		healthCheckPath: '/healthz',
		healthCheckPort: d.port,
		healthCheckCommand: null,
		livenessEnabled: true,
		readinessEnabled: true,
		startupEnabled: false,
		healthCheckInterval: 10,
		healthCheckTimeout: 3,
		healthCheckRetries: 3,
		startupFailureThreshold: 30,
		healthCheckOverride: false,
		dockerfileHealthCheck: null,
		deployStrategy: 'rollingUpdate',
		pdbMinAvailable: 0,
		imagePullPolicy: null,
		effectiveImagePullPolicy: 'IfNotPresent',
		tailscaleExposed: false,
		tailscaleHostname: null,
		createdBy: d.creatorId,
		applyError: null,
		queuedCommitSha: null,
		queuedCommitMessage: null,
		pendingPush: null,
		envConflicts: null,
		environment: env
			? { id: env.id, name: env.name, slug: env.slug, isDefault: env.isDefault }
			: null,
		project: { id: p.id, name: p.name, slug: p.slug, backgroundImage: p.backgroundImage },
		nodePoolId: null,
		pods: pods.map(stripMock),
		warnings: warnings(store, d),
		rollout: rolloutOf(store, d),
		latestVerdict: mockVerdict(store, d),
		limitsRestartPending: store.state.resourceLimits === 'off',
		services: [svc],
		ingresses: ingress(d).map((i) => ({
			...i,
			routes: [{ path: d.hostPath ?? '/', serviceName: svc.name, servicePort: 80 }],
			certificateStatus: 'ready',
			protectionBypassPaths: [],
			redirectTarget: null,
			redirectStatus: null,
			service: { id: svc.id, name: svc.name, port: 80 }
		})),
		volumes: d.volumes.map((v) => ({
			...v,
			deploymentId: d.id,
			pvcName: v.type === 'pvc' ? `${d.name}-${v.name}` : null,
			hostPath: null,
			observedCapacity: v.storageSize,
			phase: 'Bound',
			resizeState: null,
			resizeMessage: null,
			observedAt: new Date().toISOString()
		})),
		envVars: d.envVars.map((v) => ({
			id: uid(`env:${d.id}:${v.key}`),
			deploymentId: d.id,
			key: v.key,
			value: v.secret ? null : v.value,
			secret: v.secret,
			createdAt: d.createdAt,
			updatedAt: d.updatedAt
		})),
		imageHistory: imageHistory(store, d),
		creator: creator(store.user(d.creatorId)),
		...settingsOf(d)
	};
}

function settingsOf(d: MockDeployment): Record<string, unknown> {
	return (d as MockDeployment & { settings?: Record<string, unknown> }).settings ?? {};
}

function remember(d: MockDeployment, patch: Record<string, unknown>) {
	const held = d as MockDeployment & { settings?: Record<string, unknown> };
	held.settings = { ...held.settings, ...patch };
}

function timeline(store: Store, d: MockDeployment) {
	const entries: Record<string, unknown>[] = store.buildsOf(d.id).map((b) => {
		const by = store.user(b.triggeredById);
		return {
			id: `release:${b.id}`,
			at: b.createdAt,
			kind: b.status === 'succeeded' ? 'release' : 'build',
			actor: by
				? {
						id: by.id,
						username: by.username,
						email: by.email,
						firstName: by.firstName,
						lastName: by.lastName,
						imageUrl: by.imageUrl
					}
				: null,
			title: b.commitMessage ?? `Deployed ${b.image.split(':').at(-1)}`,
			detail: b.commitSha ? `${b.branch} · ${b.commitSha.slice(0, 7)}` : null,
			status: b.status,
			href: null,
			meta: {
				imageHistoryId: b.id,
				image: b.image,
				tag: b.image.split(':').at(-1),
				commitSha: b.commitSha,
				commitMessage: b.commitMessage,
				commitAuthorName: b.commitAuthorName,
				commitAuthorUsername: b.commitAuthorUsername,
				branch: b.branch,
				triggerType: b.triggerType === 'push' ? 'auto' : b.triggerType,
				isActive: b.isActive,
				buildStatus: b.status,
				buildStartedAt: b.buildStartedAt,
				buildCompletedAt: b.buildCompletedAt
			}
		};
	});
	if (d.crash) {
		entries.unshift({
			id: `pod:${d.id}:crash`,
			at: new Date(Date.now() - 40_000).toISOString(),
			kind: 'pod',
			actor: null,
			title: `${store.podName(d, 0)} crashed`,
			detail: d.crash.message,
			status: 'crashing',
			href: null,
			meta: {
				podName: store.podName(d, 0),
				fromStatus: 'ready',
				toStatus: 'crashing',
				reason: d.crash.reason
			} as any
		});
	}
	return entries;
}

function errorGroups(d: MockDeployment) {
	if (!d.host && !d.crash) return [];
	const now = Date.now();
	return [
		{
			fingerprint: sha(`${d.id}:err1`),
			type: d.crash ? 'RangeError' : 'PrismaClientKnownRequestError',
			message: d.crash
				? 'Invalid array length'
				: 'Unique constraint failed on the fields: (`slug`)',
			count: d.crash ? 412 : 37,
			status: 'unresolved',
			firstSeen: new Date(now - 86_400_000 * 2).toISOString(),
			lastSeen: new Date(now - 120_000).toISOString(),
			assignee: null,
			githubIssueUrl: null,
			stackTrace: `Error\n    at createProject (/app/src/projects.ts:88:11)\n    at async handler (/app/src/server.ts:41:5)`,
			firstDeploy: null,
			deployCount: 1,
			deploys: []
		}
	];
}

export function deploymentRoutes(r: Router, { store }: MockContext) {
	store.podsFor = (d) => podsOf(store, d).map(stripMock);
	const find = (id: string) => store.deployment(id);
	const changed = (d: MockDeployment) => {
		store.touch(d);
		store.emit('deployment.changed', d.projectId, d.id);
	};
	const withDep = (fn: (d: MockDeployment, ctx: any) => unknown) => (ctx: any) => {
		const d = find(ctx.params.id);
		return d ? fn(d, ctx) : notFound('Deployment not found');
	};

	r.get('/deployments', () => store.state.deployments.map((d) => deploymentSummary(store, d)));
	r.get('/ingresses', () => store.state.deployments.flatMap(ingress));
	r.get('/deployments/favicon', () => reply(404, { message: 'No favicon in mock mode' }));
	r.get(
		'/deployments/:id',
		withDep((d) => deploymentDetail(store, d))
	);
	r.post(
		'/deployments/:id/icon',
		withDep((d, { body }) => {
			const file = body?.files?.file;
			if (!file) return reply(400, { message: 'No file provided' });
			if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) {
				return reply(400, { message: 'Use a JPEG, PNG, GIF or WebP image' });
			}
			if (file.data.length > 2 * MIB) return reply(400, { message: 'Use a file under 2 MB' });
			d.icon = `data:${file.type};base64,${file.data.toString('base64')}`;
			changed(d);
			return deploymentDetail(store, d);
		})
	);
	r.get(
		'/deployments/:id/pods-live',
		withDep((d) => {
			const pods = podsOf(store, d);
			return {
				pods: pods.map(stripMock),
				warnings: warnings(store, d),
				rollout: rolloutOf(store, d),
				availableReplicas: pods.filter((p) => p.status === 'ready').length,
				totalCpuUsage: pods.reduce((a, p) => a + (p.cpuUsage ?? 0), 0),
				totalMemoryUsage: pods.reduce((a, p) => a + (p.memoryUsage ?? 0), 0),
				meteredPods: pods.length
			};
		})
	);
	r.post(
		'/__mock/deployments/:id/pods',
		withDep((d, { body }) => {
			const scenario = POD_SCENARIOS.includes(body?.scenario)
				? (body.scenario as PodScenario)
				: 'healthy';
			const indexes =
				typeof body?.index === 'number'
					? [body.index]
					: Array.from({ length: d.replicas }, (_, i) => i);
			d.podScenarios = { ...d.podScenarios };
			for (const i of indexes) {
				if (scenario === 'healthy') delete d.podScenarios[i];
				else d.podScenarios[i] = scenario;
			}
			d.podScenarioAt = { ...d.podScenarioAt };
			for (const i of indexes) d.podScenarioAt[i] = Date.now();
			if (scenario === 'healthy' && typeof body?.index !== 'number') d.crash = null;
			const pods = podsOf(store, d);
			d.status = statusFromPods(
				d,
				pods.map((p) => p.status)
			);
			store.touch(d);
			store.emit('pod.changed', d.projectId, d.id, store.podPayload(d));
			store.emit('deployment.changed', d.projectId, d.id);
			return { scenarios: d.podScenarios };
		})
	);
	r.post(
		'/__mock/deployments/:id/build',
		withDep((d, { body }) => {
			const failure =
				body?.failure in BUILD_FAILURES ? (body.failure as BuildFailureKind) : undefined;
			return store.redeploy(d.id, { failure }) ?? notFound();
		})
	);
	r.post(
		'/__mock/deployments/:id/rollout',
		withDep((d, { body }) => {
			if (body?.cancel) {
				store.cancelRollout(d.id);
				return { ok: true };
			}
			const outcome = POD_SCENARIOS.includes(body?.outcome)
				? (body.outcome as PodScenario)
				: 'healthy';
			store.startRollout(d.id, outcome, Boolean(body?.twice));
			return { ok: true };
		})
	);
	r.get(
		'/__mock/deployments/:id/pods',
		withDep((d) => ({
			options: POD_SCENARIOS,
			pods: podsOf(store, d).map((p, i) => ({ name: p.name, scenario: scenarioOf(d, i) }))
		}))
	);
	r.get(
		'/deployments/:id/build-logs',
		withDep((d) => ({ logs: d.buildLogs }))
	);
	r.get(
		'/deployments/:id/logs',
		withDep((d) => ({ logs: d.buildLogs }))
	);
	r.get(
		'/deployments/:id/build-runs',
		withDep((d) =>
			store
				.buildsOf(d.id)
				.slice(0, 20)
				.map((b) => ({
					id: b.id,
					status: b.status === 'canceled' ? 'canceled' : b.status,
					triggerType: b.triggerType,
					commitSha: b.commitSha,
					commitMessage: b.commitMessage,
					branch: b.branch,
					createdAt: b.createdAt
				}))
		)
	);
	r.get('/deployments/:id/image-history/:hid/logs', ({ params }) => {
		const b = store.state.builds.find((x) => x.id === params.hid);
		if (!b) return notFound();
		return {
			logs: b.logs || SAMPLE_BUILD_LOG.map((l) => l.replaceAll('{image}', b.image)).join('\n')
		};
	});
	const BINDINGS = new Map<string, Record<string, unknown>[]>();
	r.get('/deployments/:id/bindings', ({ params }) => BINDINGS.get(params.id) ?? []);
	r.post(
		'/deployments/:id/bindings',
		withDep((d, { body }) => {
			const db = store.databasesOf(d.projectId).find((x) => x.id === body?.resourceId);
			if (!db) return notFound();
			const binding = {
				id: uid(`binding:${d.id}:${db.id}`),
				name: String(body?.name || db.name),
				resourceType: 'database',
				resourceId: db.id,
				resource: { name: db.name, status: db.status },
				endpoint: `${db.name}-cluster-rw:5432`,
				fields: ['connection_string', 'host', 'port', 'database', 'user', 'password'],
				usedBy: [],
				createdAt: new Date().toISOString(),
				addedEnvKey: null
			};
			const list = (BINDINGS.get(d.id) ?? []).filter((b) => b.resourceId !== db.id);
			BINDINGS.set(d.id, [...list, binding]);
			return binding;
		})
	);
	r.get(
		'/deployments/:id/bindings/options',
		withDep((d) =>
			store.databasesOf(d.projectId).map((db) => ({
				resourceType: 'database',
				resourceId: db.id,
				name: db.name,
				status: db.status,
				endpoint: `${db.name}-cluster-rw:5432`,
				suggestedName: db.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
			}))
		)
	);
	r.get('/deployments/:id/anomalies', ({ params }) => {
		const d = store.deployment(params.id);
		if (!d?.crash) return { anomalies: [] };
		const o = store.orgOfProject(d.projectId)!;
		return {
			anomalies: [
				{
					id: `${d.id}:crashloop`,
					kind: 'crashloop',
					severity: 'critical',
					resource: { kind: 'deployment', id: d.id, name: d.name },
					title: 'keeps crashing',
					detail: `Last exit: ${d.crash.reason}`,
					since: d.updatedAt,
					href: `/${o.slug}/deployments/${d.id}`,
					action: {
						label: 'See why',
						href: `/${o.slug}/deployments/${d.id}?tab=observe&view=killed`
					}
				},
				{
					id: `${d.id}:error_spike`,
					kind: 'error_spike',
					severity: 'warning',
					resource: { kind: 'deployment', id: d.id, name: d.name },
					title: 'is logging errors',
					detail: `910 errors in the last hour, most often: [auth] hca failed: ActionController::InvalidAuthenticityToken (${d.crash.reason})`,
					since: d.updatedAt,
					href: `/${o.slug}/deployments/${d.id}`,
					action: {
						label: 'Errors',
						href: `/${o.slug}/deployments/${d.id}?tab=observe&view=errors`
					}
				}
			]
		};
	});
	r.get(
		'/deployments/:id/next-steps',
		withDep((d) => ({
			steps: [
				{ id: 'auto-deploy', applicable: Boolean(d.githubRepo), done: d.autoDeployEnabled },
				{ id: 'domain', applicable: true, done: Boolean(d.host) },
				{ id: 'resources', applicable: true, done: true },
				{ id: 'notifications', applicable: true, done: false },
				{ id: 'health-check', applicable: Boolean(d.host), done: Boolean(d.host) },
				{ id: 'cli', applicable: true, done: false }
			]
		}))
	);
	r.get('/deployments/:id/webhook-tokens', () => []);
	r.get(
		'/deployments/:id/auto-deploy',
		withDep((d) => ({
			enabled: d.autoDeployEnabled,
			branch: d.githubBranch ?? 'main',
			paths: (settingsOf(d).autoDeployPaths as string[] | undefined) ?? [],
			appInstalled: true,
			linked: true,
			deliverable: true,
			message: null,
			provider: null
		}))
	);
	r.get('/deployments/:id/github-deployments', () => []);
	r.get(
		'/deployments/:id/killed-containers',
		withDep((d) =>
			d.crash
				? [
						{
							entryId: uid(`killed:${d.id}`),
							pod: store.podName(d, 0),
							container: d.name,
							reason: d.crash.reason,
							exitCode: d.crash.exitCode,
							finishedAt: new Date(Date.now() - 40_000).toISOString(),
							capturedAt: new Date(Date.now() - 39_000).toISOString()
						}
					]
				: []
		)
	);
	r.get(
		'/deployments/:id/killed-containers/:entryId/logs',
		withDep((d) => {
			const lines = tail(d, [store.podName(d, 0)], 40).map((l) => l.line);
			return {
				entryId: uid(`killed:${d.id}`),
				pod: store.podName(d, 0),
				container: d.name,
				reason: d.crash?.reason ?? 'Completed',
				exitCode: d.crash?.exitCode ?? 0,
				finishedAt: new Date(Date.now() - 40_000).toISOString(),
				capturedAt: new Date(Date.now() - 39_000).toISOString(),
				logs: `${lines.join('\n')}\n`
			};
		})
	);
	r.get(
		'/deployments/:id/metrics',
		withDep((d, { query }) => {
			const base = metricSeries(query, d.cpuUsageMilli, Math.round(d.memoryUsageBytes / MIB));
			const throttle = d.cpuRequestMilli
				? base.data.cpu.map((pt) => ({
						x: pt.x,
						y: +Math.max(0, Math.min(100, (pt.y / d.cpuRequestMilli - 0.45) * 160)).toFixed(1)
					}))
				: [];
			const last = base.data.mem.at(-1);
			const forecast =
				d.name === 'game-server' && last
					? {
							pod: podsOf(store, d)[0]?.name ?? d.name,
							hitsLimitAt: Date.now() + 5 * 3_600_000,
							slopeBytesPerHour: ((d.memoryRequestBytes - last.y * MIB) / 5) | 0,
							confidence: 0.93,
							limitBytes: d.memoryRequestBytes,
							projection: [
								{ x: last.x, y: last.y * MIB },
								{ x: Date.now() + 5 * 3_600_000, y: d.memoryRequestBytes }
							]
						}
					: null;
			if (query.get('groupBy') !== 'pod') return { ...base, throttle, forecast };
			const pods = podsOf(store, d);
			const split = (key: 'cpu' | 'mem' | 'rx' | 'tx') =>
				pods.map((p, i) => ({
					key: p.name,
					points: base.data[key].map((pt) => ({
						x: pt.x,
						y: +((pt.y / pods.length) * (1 + (i - pods.length / 2) * 0.08)).toFixed(2)
					}))
				}));
			return {
				start: base.start,
				end: base.end,
				step: base.step,
				groupBy: 'pod',
				grouped: { cpu: split('cpu'), mem: split('mem'), rx: split('rx'), tx: split('tx') },
				throttle,
				forecast
			};
		})
	);
	r.get('/organizations/:orgId/metric-alerts/states', () => []);
	r.get('/organizations/:orgId/metric-alerts', () => []);
	r.get('/organizations/:orgId/metric-alerts/catalogue', () => []);
	r.get('/organizations/:orgId/notification-rules', () => []);

	r.get(
		'/observe/deployments/:id/capabilities',
		withDep((d) => ({
			logs: true,
			containerMetrics: true,
			httpMetrics: Boolean(d.host),
			accessLogs: Boolean(d.host),
			httpMetricsShared: false,
			customMetrics: false,
			traces: false,
			runtime: {
				language: d.framework === 'rails' ? 'ruby' : 'node',
				framework: d.framework,
				version: d.framework === 'rails' ? '3.3.5' : '22.12.0',
				confidence: 'high',
				detectedFrom: 'image'
			}
		}))
	);
	r.get(
		'/observe/deployments/:id/overview',
		withDep((d) => {
			const pods = podsOf(store, d);
			return {
				uptime: d.podStartedAt,
				podCount: pods.length,
				restarts: d.restarts,
				cpuPercent: Math.round((d.cpuUsageMilli / d.cpuRequestMilli) * 100),
				memoryPercent: Math.round((d.memoryUsageBytes / d.memoryRequestBytes) * 100),
				httpRequestRate: d.host ? 14.2 : null,
				httpErrorRate: d.host ? 0.4 : null,
				httpAvgLatency: d.host ? 38 : null
			};
		})
	);
	r.get(
		'/observe/deployments/:id/logs/structured',
		withDep((d, { query }) => {
			const pods = podsOf(store, d).map((p) => p.name);
			const n = Math.min(Number(query.get('tailLines') ?? 1000), 600);
			const level = query.get('level');
			const search = query.get('search')?.toLowerCase();
			const entries = tail(d, pods, n)
				.filter((l) => !level || l.level === level)
				.filter((l) => !search || l.message.toLowerCase().includes(search))
				.map(structured);
			return { entries };
		})
	);
	r.get(
		'/observe/deployments/:id/logs/search',
		withDep((d, { query }) => {
			const pods = podsOf(store, d).map((p) => p.name);
			const limit = Math.min(Number(query.get('limit') ?? 500), 2000);
			const start = Number(query.get('start')) || Date.now() - 3_600_000;
			let end = Number(query.get('end')) || Date.now();
			const cursor = query.get('cursor');
			if (cursor) end = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).end;
			const levels = query.get('levels')?.split(',').filter(Boolean) ?? [];
			const terms = (query.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
			const lines = since(d, pods, start, end)
				.filter((l) => !levels.length || levels.includes(l.level))
				.filter((l) => terms.every((t: string) => l.message.toLowerCase().includes(t)))
				.reverse();
			const page = lines.slice(0, limit);
			const oldest = page.at(-1);
			const more = lines.length > limit && oldest;
			return {
				source: 'store',
				entries: page.map(structured),
				cursor: more
					? Buffer.from(JSON.stringify({ end: Date.parse(oldest.ts) - 1 })).toString('base64url')
					: null,
				truncated: !!more
			};
		})
	);
	r.get(
		'/observe/deployments/:id/requests',
		withDep((d, { query }) => {
			const end = Number(query.get('end')) || Date.now();
			const start = Number(query.get('start')) || end - 3_600_000;
			const limit = Math.min(Number(query.get('limit') ?? 100), 500);
			const pods = podsOf(store, d).map((p) => p.name);
			const host = d.host ?? `${d.name}.orchard.app`;
			const requests = since(d, pods, Math.max(start, end - 3 * 3_600_000), end)
				.flatMap((l) => {
					const m = /^(GET|POST|PATCH|PUT|DELETE) (\S+) (\d{3}) (\d+)ms/.exec(l.message);
					if (!m) return [];
					const n = Date.parse(l.ts);
					return [
						{
							t: l.ts,
							method: m[1],
							host,
							path: m[2],
							route: m[2].replace(/\/\d+/g, '/:id').split('?')[0],
							status: Number(m[3]),
							durationMs: Number(m[4]),
							bytes: 512 + (n % 4096),
							clientIp: `203.0.113.${n % 200}`,
							userAgent: 'Mozilla/5.0',
							pod: l.pod
						}
					];
				})
				.reverse()
				.slice(0, limit);
			return { requests };
		})
	);
	r.get(
		'/observe/deployments/:id/requests/stream',
		withDep((_d, { res }) => {
			openStream(res);
			const heartbeat = setInterval(
				() => writeMessage(res, { type: 'heartbeat', ts: Date.now() }),
				15_000
			);
			res.on('close', () => clearInterval(heartbeat));
			return STREAMING;
		})
	);
	r.get(
		'/observe/deployments/:id/logs/context',
		withDep((d, { query }) => {
			const at = Number(query.get('at')) || Date.now();
			const pod = query.get('pod');
			const pods = podsOf(store, d).map((p) => p.name);
			const lines = since(d, pods, at - 60_000, Math.min(Date.now(), at + 60_000)).filter(
				(l) => !pod || l.pod === pod
			);
			return { source: 'store', entries: lines.map(structured) };
		})
	);
	r.get(
		'/observe/deployments/:id/logs/levels',
		withDep((d, { query }) => {
			const end = Number(query.get('end')) || Date.now();
			const start = Number(query.get('start')) || end - 3_600_000;
			const step = Math.max(15_000, Number(query.get('step')) || Math.round((end - start) / 60));
			const pods = podsOf(store, d).map((p) => p.name);
			const levels: Record<string, { x: number; y: number }[]> = { error: [], warn: [] };
			const buckets = new Map<number, { error: number; warn: number }>();
			for (const l of since(d, pods, Math.max(start, end - 6 * 3_600_000), end)) {
				const lv = l.level;
				if (lv !== 'error' && lv !== 'warn') continue;
				const x = Math.floor(Date.parse(l.ts) / step) * step;
				const b = buckets.get(x) ?? { error: 0, warn: 0 };
				b[lv]++;
				buckets.set(x, b);
			}
			for (const [x, b] of [...buckets.entries()].sort((a, c) => a[0] - c[0])) {
				levels.error.push({ x, y: b.error });
				levels.warn.push({ x, y: b.warn });
			}
			return { source: 'store', levels };
		})
	);
	r.get(
		'/observe/deployments/:id/logs/export',
		withDep((d, { query }) => {
			const end = Number(query.get('end')) || Date.now();
			const start = Number(query.get('start')) || end - 3_600_000;
			const pods = podsOf(store, d).map((p) => p.name);
			const ndjson = query.get('format') === 'ndjson';
			return since(d, pods, start, end)
				.map((l) =>
					ndjson
						? JSON.stringify({ time: l.ts, level: l.level, pod: l.pod, message: l.message })
						: `${l.ts} ${l.pod} ${l.message}`
				)
				.join('\n');
		})
	);
	r.get(
		'/observe/deployments/:id/logs/stream',
		withDep((d, { res }) => {
			openStream(res);
			let cursor = Date.now();
			const tick = setInterval(() => {
				const pods = podsOf(store, d).map((p) => p.name);
				const now = Date.now();
				const lines = since(d, pods, cursor, now).map((l) => ({
					pod: l.pod,
					ts: l.ts,
					line: l.line
				}));
				cursor = now;
				if (lines.length) writeMessage(res, { lines }, lines.at(-1)!.ts);
			}, BUCKET_MS);
			const heartbeat = setInterval(
				() => writeMessage(res, { type: 'heartbeat', ts: Date.now() }),
				15_000
			);
			res.on('close', () => {
				clearInterval(tick);
				clearInterval(heartbeat);
			});
			return STREAMING;
		})
	);
	r.get(
		'/observe/deployments/:id/build-logs/stream',
		withDep((d, { res }) => {
			openStream(res);
			let sent = 0;
			const tick = setInterval(() => {
				if (d.buildLogs.length > sent) {
					writeMessage(res, { chunk: d.buildLogs.slice(sent) });
					sent = d.buildLogs.length;
				}
				if (d.buildStatus !== 'building') writeMessage(res, { done: true, status: d.buildStatus });
			}, 1_000);
			res.on('close', () => clearInterval(tick));
			return STREAMING;
		})
	);
	r.get(
		'/observe/deployments/:id/errors',
		withDep((d) => ({
			repoUrl: d.githubRepo ? `https://github.com/${d.githubRepo}` : null,
			assignable: store.state.users
				.slice(0, 3)
				.map((u) => ({ id: u.id, username: u.username, imageUrl: u.imageUrl })),
			errors: errorGroups(d)
		}))
	);
	r.patch('/observe/deployments/:id/errors/:fp', () => ({ ok: true }));
	r.get(
		'/observe/deployments/:id/http-metrics',
		withDep((_d, { query }) => {
			const { start, end, step } = metricsWindow(query);
			const pts = (base: number, wobble: number) => {
				const out: { x: number; y: number }[] = [];
				for (let t = start - (start % step); t <= end; t += step) {
					out.push({ x: t, y: +Math.max(0, base + Math.sin(t / 420_000) * wobble).toFixed(2) });
				}
				return out;
			};
			const traefik = _d.name === 'web';
			const host = _d.host ?? `${_d.name}.orchard.app`;
			return {
				source: traefik ? 'traefik' : 'haproxy',
				requestRate: pts(14, 6),
				errorRate: pts(0.4, 0.3),
				latencyAvg: pts(38, 12),
				latencyMax: pts(220, 90),
				latency: traefik ? { p50: pts(24, 6), p95: pts(140, 40), p99: pts(320, 110) } : null,
				statusRates: {
					'2xx': pts(11.5, 5),
					'3xx': pts(1.8, 0.8),
					'4xx': pts(0.6, 0.4),
					'5xx': pts(0.06, 0.05)
				},
				routes: [
					{
						id: _d.name,
						label: host,
						service: _d.name,
						requestRate: 12.4,
						errorRate: 0.05,
						errorPercent: 0.4,
						latencyMs: 36
					},
					{
						id: `${_d.name}-api`,
						label: `${host}/api`,
						service: `${_d.name}-api`,
						requestRate: 3.1,
						errorRate: 0.21,
						errorPercent: 6.8,
						latencyMs: 182
					},
					{
						id: 'orchard-protection-proxy',
						label: `admin.${host}`,
						service: 'orchard-protection-proxy',
						requestRate: 0.4,
						errorRate: 0,
						errorPercent: 0,
						latencyMs: 61
					}
				]
			};
		})
	);
	r.get(
		'/observe/deployments/:id/pod-health',
		withDep((d, { query }) => {
			const { start, end, step } = metricsWindow(query);
			const series = (fn: (t: number, i: number) => number) => {
				const out: { x: number; y: number }[] = [];
				let i = 0;
				for (let t = start - (start % step); t <= end; t += step) out.push({ x: t, y: fn(t, i++) });
				return out;
			};
			const crashing =
				d.crash !== null || Object.values(d.podScenarios ?? {}).some((v) => v !== 'healthy');
			const burst = (t: number) => (Math.floor(t / 900_000) % 5 === 3 ? 1 : 0);
			return {
				available: true,
				restarts: [
					{ key: 'Error', points: series((t) => (crashing ? 1 : burst(t))) },
					{ key: 'OOMKilled', points: series((t, i) => (i % 17 === 9 ? 1 : 0)) }
				],
				waiting: crashing
					? [{ key: 'CrashLoopBackOff', points: series(() => 1) }]
					: [{ key: 'ContainerCreating', points: series((t) => burst(t)) }],
				notReady: series((t) => (crashing ? 1 : burst(t)))
			};
		})
	);
	r.get(
		'/observe/deployments/:id/volumes',
		withDep((d) => ({
			volumes: d.volumes
				.filter((v) => v.type === 'pvc')
				.map((v, i) => {
					const gi = parseFloat(v.storageSize ?? '1') || 1;
					const capacity = gi * 1024 ** 3;
					const used = capacity * [0.42, 0.87, 0.97][i % 3];
					return {
						name: v.name,
						claim: v.name,
						mountPath: v.mountPath,
						requested: v.storageSize,
						usedBytes: Math.round(used),
						capacityBytes: capacity,
						availableBytes: Math.round(capacity - used)
					};
				})
		}))
	);
	r.get(
		'/observe/deployments/:id/builds',
		withDep((d) => ({
			builds: store
				.buildsOf(d.id)
				.slice(0, 30)
				.map((b, i) => {
					const started = Date.parse(b.buildStartedAt);
					const finished = b.buildCompletedAt ? Date.parse(b.buildCompletedAt) : null;
					const total = finished ? finished - started : null;
					const queueMs = 2_000 + (i % 4) * 9_000;
					const split = total
						? [
								{ id: 'clone', label: 'Clone', ms: Math.round(total * 0.12) },
								{ id: 'build', label: 'Build', ms: Math.round(total * 0.58) },
								{ id: 'push', label: 'Push', ms: Math.round(total * 0.18) },
								{ id: 'rollout', label: 'Apply', ms: Math.round(total * 0.12) }
							]
						: [];
					return {
						id: b.id,
						status: b.status,
						builder: i % 3 === 0 ? 'firecracker' : 'kubernetes',
						trigger: b.triggerType,
						commitSha: b.commitSha,
						title: b.commitMessage?.split('\n')[0] ?? null,
						scheduledAt: new Date(started - queueMs).toISOString(),
						startedAt: b.buildStartedAt,
						finishedAt: b.buildCompletedAt,
						queueMs,
						durationMs: total,
						phases: [{ id: 'queue', label: 'Queue', ms: queueMs }, ...split]
					};
				})
		}))
	);
	r.get(
		'/deployments/:id/diagnosis',
		withDep((d) => {
			const now = Date.now();
			const appUrl = `http://localhost:3000/ysws/deployments/${d.id}`;
			const crashAt = now - 12 * 60_000;
			const change = store.buildsOf(d.id).find((b) => b.isActive);
			const version = change?.commitSha?.slice(0, 7) ?? 'latest';
			const link = `${appUrl}?tab=observe&from=${crashAt - 900_000}&to=${Math.min(now, crashAt + 900_000)}&at=${crashAt}&panel=panel-restarts-and-out-of-memory-kills`;
			return {
				app: { id: d.id, name: d.name, image: d.image, url: appUrl },
				health: {
					app: d.crash ? 'down' : 'healthy',
					deploy: null,
					build: null,
					serving: d.crash ? 0 : 1,
					desired: 1,
					problems: d.crash
						? [
								{
									scope: 'app',
									tone: 'error',
									title: 'Your app is down: it keeps running out of memory',
									hint: 'Raise the memory limit or fix the leak.',
									pods: [store.podName(d, 0)]
								}
							]
						: []
				},
				rollout: { state: 'stable', reason: null },
				verdict: null,
				anomalies: [],
				findings: d.crash
					? [
							{
								kind: 'restart-burst',
								sentence: `Restarted 14 times from ${new Date(crashAt).toISOString().slice(11, 16)} UTC, two minutes after ${version} went live.`,
								at: new Date(crashAt).toISOString(),
								cause: `release:${change?.id ?? 'x'}`,
								link
							}
						]
					: [],
				changes: change
					? [
							{
								at: new Date(crashAt - 120_000).toISOString(),
								kind: 'deploy',
								label: `${version} went live`,
								detail: change.commitMessage ?? null,
								actor: null
							}
						]
					: [],
				resources: {
					cpu: { usedMilli: d.cpuUsageMilli, limitMilli: d.cpuRequestMilli, throttledPercent: 0 },
					memory: {
						usedBytes: d.memoryUsageBytes,
						limitBytes: d.memoryRequestBytes,
						forecast: null
					},
					rightsizing: null
				},
				http: null,
				security: { worstCve: null, counts: null, attacks: null },
				topErrors: [],
				links: {
					app: appUrl,
					observe: `${appUrl}?tab=observe`,
					logs: `${appUrl}?tab=observe&view=logs`
				}
			};
		})
	);
	r.get(
		'/deployments/:id/rightsizing',
		withDep((d) => {
			const MiB = 1024 * 1024;
			const peak = d.memoryUsageBytes;
			const recommendedMem = Math.max(128 * MiB, Math.ceil((peak * 1.15) / (64 * MiB)) * 64 * MiB);
			const lowerMem =
				d.memoryRequestBytes - recommendedMem >= Math.max(128 * MiB, d.memoryRequestBytes * 0.25);
			const p95 = d.cpuUsageMilli;
			const recommendedCpu = Math.max(100, Math.ceil((p95 * 1.5) / 100) * 100);
			const cpuChange =
				Math.abs(recommendedCpu - d.cpuRequestMilli) >= Math.max(100, d.cpuRequestMilli * 0.25)
					? recommendedCpu > d.cpuRequestMilli
						? 'raise'
						: 'lower'
					: 'none';
			return {
				status: 'ok',
				reason: null,
				historyDays: 14,
				confidence: 'high',
				unlimited: false,
				memory: {
					current: d.memoryRequestBytes,
					recommended: lowerMem ? recommendedMem : d.memoryRequestBytes,
					peak,
					change: lowerMem ? 'lower' : 'none',
					reason: `Peak was ${Math.round(peak / MiB)} MB over 14 days.`
				},
				cpu: {
					current: d.cpuRequestMilli,
					recommended: cpuChange === 'none' ? d.cpuRequestMilli : recommendedCpu,
					p95,
					p99: p95 * 1.2,
					throttledP95: null,
					change: cpuChange,
					reason: `Usage was ${p95}m at p95 and ${Math.round(p95 * 1.2)}m at p99 over 14 days.`
				}
			};
		})
	);
	r.get(
		'/deployments/:id/releases',
		withDep((d) => {
			const verdict = mockVerdict(store, d);
			return store.buildsOf(d.id).map((b) => ({
				id: `release:${b.id}`,
				imageHistoryId: b.id,
				image: b.image,
				status: b.isActive ? 'live' : 'superseded',
				promotedAt: b.buildCompletedAt ?? b.createdAt,
				verdict: verdict && verdict.imageHistoryId === b.id ? verdict : null
			}));
		})
	);
	r.get(
		'/observe/deployments/:id/findings',
		withDep((d, { query }) => {
			const end = Number(query.get('end')) || Date.now();
			const start = Number(query.get('start')) || end - 86_400_000;
			const { changes } = mockChanges(store, d, start, end);
			const at = (ms: number) =>
				new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
			const now = Date.now();
			const lastDeploy = changes.filter((c) => c.kind === 'deploy').at(-1);
			const findings =
				d.name === 'game-server'
					? [
							{
								symptomId: `throttling:${now - 80 * 60_000}`,
								causeId: `audit:${d.id}:env`,
								sentence: `Throttled 29% of the time since ${at(now - 80 * 60_000)}; the CPU limit is the bottleneck.`,
								evidence: [`throttling:${now - 80 * 60_000}`],
								at: now - 80 * 60_000,
								kind: 'throttling'
							},
							{
								symptomId: 'memory-forecast:game-server',
								causeId: null,
								sentence: `Memory has climbed about 230 MiB an hour since ${at(now - 6 * 3_600_000)} and reaches its limit around ${at(now + 5 * 3_600_000)}.`,
								evidence: ['memory-forecast:game-server'],
								at: Math.max(start, now - 6 * 3_600_000),
								kind: 'memory-forecast'
							}
						]
					: d.name === 'api'
						? [
								{
									symptomId: `error-rate:${now - 34 * 60_000}`,
									causeId: lastDeploy?.id ?? null,
									sentence: `Errors went from 0.2% to 4.1% at ${at(now - 34 * 60_000)}, two minutes after ${lastDeploy?.label ?? '6c29231 went live'}.`,
									evidence: [`error-rate:${now - 34 * 60_000}`, lastDeploy?.id ?? 'release:x'],
									at: now - 34 * 60_000,
									kind: 'error-rate'
								}
							]
						: [];
			return { findings: findings.filter((f) => f.at >= start && f.at <= end), changes };
		})
	);
	r.get(
		'/observe/deployments/:id/changes',
		withDep((d, { query }) => {
			const end = Number(query.get('end')) || Date.now();
			const start = Number(query.get('start')) || end - 86_400_000;
			return mockChanges(store, d, start, end);
		})
	);
	r.get(
		'/observe/deployments/:id/timeline',
		withDep((d, { query }) => {
			const kinds = query.get('kinds')?.split(',');
			const limit = Number(query.get('limit') ?? 40);
			const all = timeline(store, d).filter((e) => !kinds || kinds.includes(e.kind));
			return { entries: all.slice(0, limit), nextCursor: null };
		})
	);

	r.get('/pods/:pod/logs', ({ params, query }) => {
		const n = Math.min(Number(query.get('tailLines') ?? 100), 2000);
		const d = store.state.deployments.find((x) =>
			podsOf(store, x).some((p) => p.name === params.pod)
		);
		if (!d) return { logs: pgLogs(n) };
		return {
			logs: `${tail(d, [params.pod], n)
				.map((l) => `${l.ts} ${l.line}`)
				.join('\n')}\n`
		};
	});
	r.get('/pods/:pod', ({ params }) => {
		for (const d of store.state.deployments) {
			const pod = podsOf(store, d).find((p) => p.name === params.pod);
			if (!pod) continue;
			const container = pod.containers[0];
			return {
				metadata: {
					name: pod.name,
					namespace: namespaceOf(store, d),
					creationTimestamp: pod.startTime,
					labels: { app: d.name, 'orchard.my/deployment': d.id }
				},
				spec: {
					nodeName: pod.nodeName,
					containers: [{ name: container.name, image: container.image }]
				},
				status: {
					phase: pod.status === 'ready' ? 'Running' : 'Pending',
					podIP: pod.podIp,
					hostIP: `192.168.1.${10 + d.name.length}`,
					startTime: pod.startTime,
					containerStatuses: [
						{
							name: container.name,
							image: container.image,
							ready: container.ready,
							restartCount: container.restartCount,
							state: container.ready
								? { running: { startedAt: pod.startTime } }
								: { waiting: { reason: 'CrashLoopBackOff' } },
							lastState: container.lastTermination ? { terminated: container.lastTermination } : {}
						}
					]
				}
			};
		}
		return notFound('Pod not found');
	});
	r.delete('/pods/:pod', ({ params }) => {
		const d = store.state.deployments.find((x) =>
			podsOf(store, x).some((p) => p.name === params.pod)
		);
		if (d) store.restart(d.id);
		return { ok: true };
	});

	r.post(
		'/deployments/:id/rebuild',
		withDep((d) => {
			const b = store.redeploy(d.id, { trigger: 'manual' });
			return { ok: true, buildId: b?.id };
		})
	);
	r.post(
		'/deployments/:id/redeploy',
		withDep((d) => {
			const b = store.redeploy(d.id, { trigger: 'manual', rebuild: false });
			return { ok: true, buildId: b?.id };
		})
	);
	r.post(
		'/deployments/:id/cancel',
		withDep((d) => {
			store.cancelBuild(d.id);
			return { ok: true };
		})
	);
	r.post(
		'/deployments/:id/restart',
		withDep((d) => {
			store.restart(d.id);
			return { ok: true };
		})
	);
	r.post(
		'/deployments/:id/stop',
		withDep((d) => {
			store.setStopped(d.id, true);
			return { ok: true, stopped: true };
		})
	);
	r.post(
		'/deployments/:id/start',
		withDep((d, { body }) => {
			if (body?.build) store.redeploy(d.id, { trigger: 'manual' });
			else store.setStopped(d.id, false);
			return { ok: true, stopped: false };
		})
	);
	r.post(
		'/deployments/:id/scale',
		withDep((d, { body }) => {
			store.scale(d.id, Number(body?.replicas ?? d.replicas));
			return { replicas: d.replicas, stopped: d.stopped };
		})
	);
	r.post(
		'/deployments/:id/rollback/:hid',
		withDep((d, { params, body }) => {
			const target = store.state.builds.find((b) => b.id === params.hid);
			if (!target) return notFound();
			for (const b of store.state.builds)
				if (b.deploymentId === d.id) b.isActive = b.id === target.id;
			d.image = target.image;
			store.restart(d.id);
			store.emit('build.changed', d.projectId, d.id);
			const bound = body?.restoreDatabases
				? store
						.databasesOf(d.projectId)
						.filter((db) => db.mode === 'cnpg' && db.environmentId === d.environmentId)
				: [];
			return {
				ok: true,
				...(body?.restoreDatabases
					? {
							databaseRestores: bound.map((db) => ({
								databaseId: db.id,
								name: db.name,
								status: 'pending'
							}))
						}
					: {})
			};
		})
	);
	r.post(
		'/deployments/:id/retry-apply',
		withDep((d) => {
			changed(d);
			return { ok: true };
		})
	);
	r.delete(
		'/deployments/:id',
		withDep((d) => {
			store.removeDeployment(d.id);
			return { ok: true };
		})
	);
	r.patch(
		'/deployments/:id/name',
		withDep((d, { body }) => {
			d.displayName = body?.name ? String(body.name) : null;
			changed(d);
			return { displayName: d.displayName };
		})
	);
	r.put(
		'/deployments/:id/env',
		withDep((d, { body }) => {
			const prev = new Map(d.envVars.map((v) => [v.key, v]));
			d.envVars = (body?.env ?? [])
				.filter((v: any) => v?.key)
				.map((v: any) => ({
					key: String(v.key),
					value:
						v.value === null || (v.secret && v.value === '')
							? (prev.get(v.key)?.value ?? '')
							: String(v.value ?? ''),
					secret: Boolean(v.secret)
				}));
			changed(d);
			store.restart(d.id);
			return deploymentDetail(store, d);
		})
	);
	r.put(
		'/deployments/:id/volumes',
		withDep((d, { body }) => {
			d.volumes = (body?.volumes ?? []).map((v: any) => ({
				id: freshId(),
				name: String(v.name),
				type: v.type ?? 'pvc',
				mountPath: String(v.mountPath),
				storageSize: v.storageSize ?? '1Gi',
				readOnly: Boolean(v.readOnly)
			}));
			changed(d);
			return deploymentDetail(store, d);
		})
	);
	r.patch(
		'/deployments/:id/resources',
		withDep((d, { body }) => {
			if (body?.cpuRequestMilli != null) d.cpuRequestMilli = Number(body.cpuRequestMilli);
			if (body?.memoryRequestBytes != null) d.memoryRequestBytes = Number(body.memoryRequestBytes);
			if (d.crash?.reason === 'OOMKilled' && d.memoryRequestBytes > d.memoryUsageBytes * 1.5) {
				d.crash = null;
				d.restarts = 0;
			}
			store.restart(d.id);
			return deploymentDetail(store, d);
		})
	);
	r.patch(
		'/deployments/:id/image',
		withDep((d, { body }) => {
			if (body?.image) d.image = String(body.image);
			store.redeploy(d.id, { trigger: 'manual', rebuild: false });
			return deploymentDetail(store, d);
		})
	);
	for (const path of ['build-config', 'health-check']) {
		r.put(
			`/deployments/:id/${path}`,
			withDep((d, { body }) => {
				if (body?.buildType) d.buildType = body.buildType;
				if (body?.framework !== undefined) d.framework = body.framework;
				remember(d, body ?? {});
				changed(d);
				return { ...deploymentDetail(store, d), ...(body ?? {}) };
			})
		);
	}
	r.patch(
		'/deployments/:id/devices',
		withDep((d, { body }) => {
			const devices = body?.devices ?? {};
			remember(d, {
				devices,
				...(Object.keys(devices).length > 0 ? { deployStrategy: 'recreate' } : {})
			});
			changed(d);
			return deploymentDetail(store, d);
		})
	);
	for (const path of ['strategy', 'disruption-budget', 'pull-policy']) {
		r.patch(
			`/deployments/:id/${path}`,
			withDep((d, { body }) => {
				if (body?.strategy) remember(d, { deployStrategy: body.strategy });
				if (body?.minAvailable !== undefined) remember(d, { pdbMinAvailable: body.minAvailable });
				if (body && 'imagePullPolicy' in body)
					remember(d, { imagePullPolicy: body.imagePullPolicy });
				changed(d);
				return { ok: true };
			})
		);
	}
	r.post(
		'/deployments/:id/auto-deploy/enable',
		withDep((d, { body }) => {
			d.autoDeployEnabled = true;
			if (body?.branch) d.githubBranch = String(body.branch);
			remember(d, { autoDeployPaths: body?.paths ?? [] });
			changed(d);
			return { ...deploymentDetail(store, d), autoDeployPaths: body?.paths ?? [] };
		})
	);
	r.post(
		'/deployments/:id/auto-deploy/disable',
		withDep((d) => {
			d.autoDeployEnabled = false;
			changed(d);
			return deploymentDetail(store, d);
		})
	);
	r.post(
		'/deployments/:id/services',
		withDep((d) => deploymentDetail(store, d))
	);
	r.put(
		'/deployments/:id/services/:sid',
		withDep((d) => deploymentDetail(store, d))
	);
	r.delete(
		'/deployments/:id/services/:sid',
		withDep((d) => deploymentDetail(store, d))
	);

	const checks = new Map<string, number>();
	r.post('/projects/ingresses/validate-dns', ({ body }) => {
		const host = String(body?.domain ?? '').toLowerCase();
		const labels = host.split('.');
		const records =
			labels.length > 2
				? [{ type: 'CNAME', name: labels.slice(0, -2).join('.'), value: 'ingress.orchard.my' }]
				: [
						{ type: 'A', name: '@', value: '203.0.113.10' },
						{ type: 'A', name: '@', value: '203.0.113.11' }
					];
		if (store.requireDomainProof) {
			const relative = labels.slice(0, -2).join('.');
			records.push({
				type: 'TXT',
				name: relative ? `_orchard-challenge.${relative}` : '_orchard-challenge',
				value: `orchard-domain=${sha(host).slice(0, 40)}`
			});
		}
		checks.set(host, (checks.get(host) ?? 0) + 1);
		const valid = (checks.get(host) ?? 0) > 2;
		return { valid, message: valid ? 'Connected' : 'Waiting', records };
	});
	r.post('/projects/:pid/ingresses', ({ params, body }) => {
		const proofHost = String(body?.host ?? '').toLowerCase();
		if (store.requireDomainProof && (checks.get(proofHost) ?? 0) <= 2) {
			const relative = proofHost.split('.').slice(0, -2).join('.');
			const value = `orchard-domain=${sha(proofHost).slice(0, 40)}`;
			return reply(400, {
				error: 'domain_proof_required',
				message: `Prove you own ${proofHost}: add a TXT record named _orchard-challenge.${proofHost} with the value ${value}, then try again.`,
				records: [
					{
						type: 'TXT',
						name: relative ? `_orchard-challenge.${relative}` : '_orchard-challenge',
						value
					}
				]
			});
		}
		const d =
			store.deployment(body?.deploymentId ?? '') ??
			store.deploymentsOf(params.pid).find((x) => x.name === body?.routes?.[0]?.serviceName);
		if (d && body?.host) {
			d.host = String(body.host);
			d.hostPath = String(body?.routes?.[0]?.path ?? '/');
			changed(d);
		}
		return { ok: true };
	});
	r.get('/projects/:pid/ingresses/:iid/protection', () => ({
		protectionMode: 'none',
		protectionUsername: null,
		protectionBypassSecret: null,
		openPaths: ['/docs']
	}));

	r.put('/projects/:pid/ingresses/:iid', ({ body, params }) => {
		const d = store.deploymentsOf(params.pid).find((x) => uid(`ing:${x.id}`) === params.iid);
		if (d && body?.host) {
			d.host = String(body.host);
			changed(d);
		}
		return { ok: true };
	});
	r.delete('/projects/:pid/ingresses/:iid', ({ params }) => {
		const d = store.deploymentsOf(params.pid).find((x) => uid(`ing:${x.id}`) === params.iid);
		if (d) {
			d.host = null;
			changed(d);
		}
		return { ok: true };
	});

	const create = ({ params, body }: { params: Record<string, string>; body: any }) => {
		const p = store.project(params.pid ?? body?.projectId ?? '');
		if (!p) return reply(400, { message: 'projectId is required' });
		const name = slugify(String(body?.name ?? 'app')) || 'app';
		const env =
			store.state.environments.find((e) => e.id === body?.environmentId) ??
			store.state.environments.find((e) => e.projectId === p.id && e.isDefault);
		const rawRepo = body?.repoUrl ?? body?.githubRepo;
		const repo = rawRepo
			? String(rawRepo)
					.replace(/^https:\/\/github.com\//, '')
					.replace(/\.git$/, '')
			: null;
		const now = new Date().toISOString();
		const d: MockDeployment = {
			id: store.newDeploymentId(p.id, name),
			projectId: p.id,
			environmentId: env?.id ?? '',
			name,
			displayName: null,
			status: 'pending',
			buildStatus: 'pending',
			buildStep: 'queued',
			buildStepTimestamps: {},
			buildError: null,
			buildLogs: '',
			replicas: Number(body?.replicas ?? 1),
			stopped: false,
			image: body?.image ?? `registry.orchard.my/${p.slug}/${name}:latest`,
			githubRepo: repo,
			githubBranch: repo ? (body?.branch ?? body?.githubBranch ?? 'main') : null,
			buildType: body?.buildType ?? 'railpack',
			framework: body?.framework ?? null,
			host: body?.autoUrl === false ? null : `${name}-${p.slug}.orchard.my`,
			port: Number(body?.ports?.[0]?.containerPort ?? body?.port ?? 3000),
			cpuRequestMilli: Number(body?.cpuRequestMilli ?? 500),
			memoryRequestBytes: Number(body?.memoryRequestBytes ?? 512 * MIB),
			cpuUsageMilli: 30,
			memoryUsageBytes: 140 * MIB,
			envVars: (body?.env ?? body?.envVars ?? []).map((v: any) => ({
				key: String(v.key),
				value: String(v.value ?? ''),
				secret: Boolean(v.secret)
			})),
			volumes: [],
			crash: null,
			podSeed: sha(now).slice(0, 10),
			podStartedAt: now,
			restarts: 0,
			creatorId: store.state.meId,
			autoDeployEnabled: Boolean(repo),
			createdAt: now,
			updatedAt: now
		};
		store.state.deployments.push(d);
		store.redeploy(d.id, { trigger: 'manual' });
		return deploymentDetail(store, d);
	};
	r.post('/deployments', create);
	r.post('/projects/:pid/deployments', create);
	r.post('/projects/:pid/deployments/from-github', create);
}

const PG = [
	'LOG:  checkpoint starting: time',
	'LOG:  checkpoint complete: wrote 312 buffers (1.9%); 0 WAL file(s) added, 0 removed, 1 recycled',
	'LOG:  archive command succeeded for 0000000100000004000000A7',
	'LOG:  connection received: host=10.42.3.18 port=51244',
	'LOG:  connection authorized: user=app database=app application_name=prisma',
	'LOG:  duration: 112.402 ms  statement: SELECT "public"."User".* FROM "public"."User" WHERE "id" = $1'
];

function pgLogs(n: number) {
	const now = Date.now();
	const lines: string[] = [];
	for (let i = Math.min(n, 400); i > 0; i--) {
		lines.push(
			`${new Date(now - i * 4_000).toISOString()} [${100 + (i % 7)}] ${PG[i % PG.length]}`
		);
	}
	return `${lines.join('\n')}\n`;
}
