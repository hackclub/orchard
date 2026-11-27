import { readdirSync, readFileSync } from 'node:fs';
import type { MockContext } from '../plugin.ts';
import { STREAMING, notFound, reply, type Router } from '../router.ts';
import {
	databaseSummary,
	deploymentSummary,
	me,
	memberRow,
	orgRow,
	projectMeta
} from '../serialize.ts';

const unauthorized = () => reply(401, { statusCode: 401, message: 'Unauthorized' });

export const storageFeatures = { s3: false, backups: 'local', uploads: true, localDeploys: false };

export const mockSetup: {
	installer: boolean;
	publicIp: string | null;
	cname: string | null;
	appDomain: string | null;
	email: boolean;
	skipped: string[];
} = {
	installer: false,
	publicIp: null,
	cname: null,
	appDomain: 'apps.example.com',
	email: false,
	skipped: []
};

const pinned = () => mockSetup.installer;

export const configSections = () => [
	{
		id: 'ingress',
		configured: !!mockSetup.cname,
		values: { cname: mockSetup.cname },
		lockedFields: [],
		secretFields: [],
		boolFields: []
	},
	{
		id: 'wildcard',
		configured: !!mockSetup.appDomain,
		values: { domains: '', appDomain: mockSetup.appDomain, sourceNamespace: '' },
		lockedFields: ['appDomain'],
		secretFields: [],
		boolFields: []
	},
	{
		id: 'network',
		configured: !!mockSetup.publicIp,
		values: { publicIp: mockSetup.publicIp },
		lockedFields: pinned() ? ['publicIp'] : [],
		secretFields: [],
		boolFields: []
	}
];

const mockCertificate = {
	state: 'failed',
	host: 'orchard.example.com',
	message: 'Timeout during connect (likely firewall problem)'
};

export const storageSection: Record<string, any> = {
	id: 'storage',
	configured: false,
	values: {
		accountId: null,
		accessKeyId: null,
		secretAccessKey: null,
		bucketName: null,
		endpoint: null,
		publicUrl: null,
		buildContextBucket: null,
		backupBucket: null,
		region: null,
		pathStyle: null
	},
	lockedFields: [],
	secretFields: ['accessKeyId', 'secretAccessKey'],
	boolFields: []
};

export function shellRoutes(r: Router, { store, hub, log }: MockContext) {
	const signIn = () => {
		if (!store.state.signedIn) log('signed in');
		store.state.signedIn = true;
		return me(store, store.me()!);
	};

	const loginRedirect = () => {
		signIn();
		return reply(302, '', { location: '/' });
	};

	r.get('/auth/me', () => {
		const u = store.me();
		return u ? me(store, u) : unauthorized();
	});
	r.patch('/auth/me', ({ body }) => {
		const u = store.me();
		if (!u) return unauthorized();
		for (const key of ['firstName', 'lastName', 'username', 'setupCompleted'] as const) {
			if (body?.[key] !== undefined) (u as any)[key] = body[key];
		}
		return me(store, u);
	});
	r.post('/auth/me/seen-updates', ({ body }) => {
		const u = store.me();
		if (!u) return unauthorized();
		if (body?.id && !u.seenUpdates.includes(body.id)) u.seenUpdates.push(body.id);
		return { seenUpdates: u.seenUpdates };
	});
	r.get('/updates/latest', () => {
		const dir = new URL('../../../../releases/ui/notes/', import.meta.url);
		const versions = readdirSync(dir)
			.map((f) => /^(\d+)\.(\d+)\.(\d+)\.md$/.exec(f))
			.filter((m): m is RegExpExecArray => !!m)
			.sort(
				(a, b) =>
					Number(b[1]) - Number(a[1]) || Number(b[2]) - Number(a[2]) || Number(b[3]) - Number(a[3])
			);
		const newest = versions[0];
		if (!newest) return null;
		const version = `${newest[1]}.${newest[2]}.${newest[3]}`;
		return {
			version,
			url: null,
			publishedAt: null,
			markdown: readFileSync(new URL(`${version}.md`, dir), 'utf8')
		};
	});
	r.get('/auth/login', loginRedirect);
	r.get('/auth/mock-login', loginRedirect);
	r.get('/sso/start/:slug', loginRedirect);
	r.post('/auth/logout', () => {
		store.state.signedIn = false;
		log('signed out, /auth/me answers 401 until you sign back in');
		return { ok: true };
	});
	r.get('/auth/config', () => ({ turnstileSiteKey: null, ssoEnforced: false, emailCodes: true }));
	r.get('/auth/methods', () => ({ passkey: true, password: false }));
	r.post('/auth/otp/request', () => ({
		message: 'Mock mode: any 6-digit code works except 000000.'
	}));
	r.post('/auth/otp/verify', ({ body }) =>
		body?.code === '000000'
			? reply(400, { statusCode: 400, message: 'That code is wrong or expired.' })
			: { user: signIn() }
	);
	r.post('/auth/password', () => ({ user: signIn() }));
	r.get('/sso/providers', () => [
		{
			id: 'mock',
			slug: 'mock',
			name: 'Mock sign-in',
			preset: 'generic',
			protocol: 'oauth2',
			label: 'Continue as alfd (mock)',
			iconUrl:
				store.state.ssoProviders.find((p) => p.organizationId === store.state.orgs[0]?.id)
					?.iconUrl ?? null,
			startUrl: '/apiv1/auth/mock-login',
			source: 'env'
		}
	]);
	r.post('/sso/discover', () => ({ organization: null }));
	r.get('/sso/org/:slug', () => notFound('No single sign-on for this organization'));
	r.get('/sso/subdomain/:subdomain', () => notFound('No single sign-on for this organization'));

	r.get('/organizations/user', () =>
		store.state.signedIn ? store.myOrgs().map((o) => orgRow(store, o)) : unauthorized()
	);
	r.get('/organizations', () => store.myOrgs().map((o) => orgRow(store, o)));
	r.get('/invitations/pending', () => []);
	r.get('/grafts', () => []);
	r.get('/instance/features', () => ({
		mcp: true,
		sandboxes: false,
		fastBuilder: true,
		email: true,
		superBuilds: true,
		resourceLimits: store.state.resourceLimits ?? 'on',
		fastBuilderRouting: store.state.fastBuilderRouting ?? 'flag',
		devices: [
			{ resource: 'nvidia.com/gpu', label: 'NVIDIA GPU', max: 1 },
			{ resource: 'squat.ai/dri', label: 'Intel GPU (/dev/dri)', max: 2 }
		],
		grafts: [],
		storage: storageFeatures
	}));
	r.get('/admin/instance-config', () => [storageSection, ...configSections()]);
	r.post('/__mock/setup', ({ body }) => {
		for (const key of ['installer', 'publicIp', 'cname'] as const) {
			if (key in (body ?? {})) (mockSetup as any)[key] = body[key];
		}
		return { installer: mockSetup.installer };
	});
	r.get('/admin/instance-config/storage', () => storageSection);
	r.post('/admin/instance-config/storage/test', ({ body }) =>
		body?.backupBucket === 'missing'
			? { ok: false, message: `The bucket missing does not exist at ${body?.endpoint}.` }
			: { ok: true }
	);
	r.put('/admin/instance-config/storage', ({ body }) => {
		storageSection.values = { ...storageSection.values, ...body, secretAccessKey: '' };
		storageSection.configured = true;
		storageFeatures.s3 = true;
		storageFeatures.backups = 'external';
		storageFeatures.localDeploys = true;
		return storageSection;
	});
	r.get('/engine/health', () => ({
		shards: ['workloads', 'pods', 'network', 'storage'].map((shard) => ({
			shard,
			holder: 'mock-0',
			stale: false,
			lastListAt: new Date(Date.now() - 40_000).toISOString(),
			lastEventAt: new Date(Date.now() - 2_000).toISOString(),
			lastResyncAt: new Date(Date.now() - 600_000).toISOString(),
			resyncRepairs: 0
		})),
		replicas: ['mock-0'],
		undelivered: 0
	}));
	r.get('/setup/state', () => ({ steps: [], complete: false }));
	r.get('/admin/networking/dns', () => ({
		checkedAt: new Date().toISOString(),
		reference: ['203.0.113.10'],
		rows: [
			{
				role: 'platform',
				record: 'orchard.example.com',
				probe: 'orchard.example.com',
				label: 'Dashboard',
				detail: 'Where people sign in.',
				verdict: 'ok',
				addresses: ['203.0.113.10'],
				expected: ['203.0.113.10'],
				message: 'Points at this instance.'
			}
		]
	}));
	r.get('/setup/github-app/status', () => ({ configured: false, lockedFields: [] }));
	r.get('/setup/certificate', () => mockCertificate);
	r.get('/setup/overview', () => {
		const skipped = mockSetup.skipped;
		const skippedOr = (id: string) => (skipped.includes(id) ? 'skipped' : 'pending');
		return {
			installer: mockSetup.installer,
			mode: mockSetup.installer ? 'public' : null,
			dashboardUrl: 'https://orchard.example.com',
			appDomain: mockSetup.appDomain,
			publicIp: mockSetup.publicIp,
			cname: mockSetup.cname,
			certIssuer: 'letsencrypt',
			locked: {
				publicIp: pinned() && !!mockSetup.publicIp,
				cname: false,
				appDomain: true,
				email: false,
				limits: false
			},
			mcp: { deployed: true, enabled: true, url: 'https://mcp.example.com', locked: false },
			emailConfigured: mockSetup.email,
			certificate: mockCertificate,
			skipped,
			items: [
				{
					id: 'github',
					title: 'GitHub App',
					value: 'Not connected',
					state: skippedOr('github'),
					detail:
						'Private repositories and rebuilds on push need it. Public repositories still deploy.',
					href: '/setup/github'
				},
				{
					id: 'storage',
					title: 'Storage',
					value: 'On this server',
					state: skippedOr('storage'),
					detail: 'If you lose the server, you lose the backups.',
					href: '/admin/instance'
				},
				{
					id: 'limits',
					title: 'Resource limits',
					value: 'On',
					state: 'configured',
					detail: null,
					href: '/admin/instance'
				},
				{
					id: 'dashboard',
					title: 'Dashboard domain',
					value: 'orchard.example.com',
					state: 'configured',
					detail: null,
					href: '/admin/networking'
				},
				{
					id: 'apps',
					title: 'Apps domain',
					value: mockSetup.appDomain ?? 'Not set',
					state: mockSetup.appDomain ? 'configured' : 'pending',
					detail: mockSetup.appDomain ? null : 'No apps domain, so apps get no URL.',
					href: '/admin/instance#wildcard'
				},
				{
					id: 'public-ip',
					title: 'Public IP',
					value: mockSetup.publicIp ?? 'Not set',
					state: mockSetup.publicIp ? 'configured' : skippedOr('network'),
					detail: mockSetup.publicIp
						? null
						: 'Public ports and databases are unavailable until this is set.',
					href: '/admin/instance'
				},
				{
					id: 'custom-domains',
					title: 'Custom domains target',
					value: mockSetup.cname ?? 'Not set',
					state: mockSetup.cname ? 'configured' : skippedOr('network'),
					detail: null,
					href: '/admin/instance'
				},
				{
					id: 'mcp',
					title: 'MCP endpoint',
					value: 'mcp.example.com',
					state: 'configured',
					detail: null,
					href: '/admin/instance'
				},
				{
					id: 'email',
					title: 'Email',
					value: mockSetup.email ? 'Configured' : 'Not set',
					state: mockSetup.email ? 'configured' : skippedOr('email'),
					detail: mockSetup.email
						? null
						: 'No sign-in codes by email. Invitations still work as links.',
					href: '/admin/instance'
				},
				{
					id: 'certificate',
					title: 'Certificate',
					value: 'Failed',
					state: 'pending',
					detail: mockCertificate.message,
					href: '/admin/networking'
				}
			]
		};
	});
	r.post('/setup/skip', ({ body }) => {
		if (body?.step && !mockSetup.skipped.includes(body.step)) mockSetup.skipped.push(body.step);
		return { steps: [], complete: true };
	});
	r.put('/admin/instance-config/network', ({ body }) => {
		mockSetup.publicIp = body?.publicIp || null;
		return { id: 'network', configured: !!body?.publicIp, values: body ?? {}, lockedFields: [] };
	});
	r.put('/admin/instance-config/ingress', ({ body }) => {
		mockSetup.cname = body?.cname || null;
		return { id: 'ingress', configured: !!body?.cname, values: body ?? {}, lockedFields: [] };
	});
	r.put('/admin/instance-config/wildcard', ({ body }) => {
		mockSetup.appDomain = body?.appDomain || null;
		return { id: 'wildcard', configured: false, values: body ?? {}, lockedFields: [] };
	});
	r.post('/admin/instance-config/email/test', ({ body }) =>
		body?.host === 'bad.example.com'
			? { ok: false, message: 'connect ECONNREFUSED bad.example.com:587' }
			: { ok: true }
	);
	r.put('/admin/instance-config/email', ({ body }) => {
		mockSetup.email = !!body?.host;
		return { id: 'email', configured: !!body?.host, values: {}, lockedFields: [] };
	});
	r.patch('/admin/instance-settings/mcp', ({ body }) => ({
		enabled: !!body?.enabled,
		dbValue: !!body?.enabled,
		envOverride: null
	}));
	r.get('/setup/checklist', () => [
		{
			id: 'mock',
			title: 'You are running the mock API',
			detail: 'Nothing here talks to a cluster. State resets when Vite restarts.',
			done: true,
			severity: 'normal'
		}
	]);
	r.get('/setup/status', () => ({ setupCompleted: true, hasUsers: true, needsClaim: false }));
	r.get('/setup/github-app/status', () => ({ configured: false, lockedFields: [] }));
	r.get('/setup/state', () => ({
		steps: [
			{ id: 'passkey', done: true, skipped: false, required: false },
			{ id: 'organization', done: true, skipped: false, required: false }
		]
	}));
	r.get('/admin/telemetry', () => ({
		enabled: false,
		consent: 'denied',
		envOverride: null,
		needsAnswer: false,
		destination: 'https://telemetry.orchard.my'
	}));
	r.put('/admin/telemetry', ({ body }) => ({
		enabled: Boolean(body?.enabled),
		consent: body?.enabled ? 'granted' : 'denied',
		envOverride: null,
		needsAnswer: false,
		destination: 'https://telemetry.orchard.my'
	}));
	r.get('/admin/stats', () => ({
		userCount: store.state.users.length,
		orgCount: store.state.orgs.length,
		projectCount: store.state.projects.length,
		deploymentCount: store.state.deployments.length
	}));

	r.get('/overview', () => {
		const orgs = store.myOrgs();
		const ids = new Set(orgs.map((o) => o.id));
		const projects = store.state.projects.filter((p) => ids.has(p.organizationId));
		const pids = new Set(projects.map((p) => p.id));
		return {
			organizations: orgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name })),
			projects: projects.map((p) => projectMeta(store, p)),
			deployments: store.state.deployments
				.filter((d) => pids.has(d.projectId))
				.map((d) => deploymentSummary(store, d)),
			databases: store.state.databases
				.filter((d) => pids.has(d.projectId))
				.map((d) => databaseSummary(store, d))
		};
	});

	r.get('/overview/orgs/:slug', ({ params }) => {
		const o = store.org(params.slug);
		if (!o) return notFound('Organization not found');
		const projects = store.projectsOf(o.id);
		const pids = new Set(projects.map((p) => p.id));
		const role = store.myRole(o.id);
		const byUpdated = <T extends { updatedAt: string }>(a: T, b: T) =>
			b.updatedAt.localeCompare(a.updatedAt);
		return {
			organization: { id: o.id, slug: o.slug, name: o.name },
			currentMember: role ? { role, synthetic: false } : null,
			projects: projects
				.slice()
				.sort(byUpdated)
				.map((p) => projectMeta(store, p)),
			deployments: store.state.deployments
				.filter((d) => pids.has(d.projectId))
				.sort(byUpdated)
				.map((d) => deploymentSummary(store, d)),
			databases: store.state.databases
				.filter((d) => pids.has(d.projectId))
				.sort(byUpdated)
				.map((d) => databaseSummary(store, d))
		};
	});

	r.get('/overview/orgs/:slug/builds', ({ params }) => {
		const o = store.org(params.slug);
		if (!o) return notFound('Organization not found');
		const pids = new Set(store.projectsOf(o.id).map((p) => p.id));
		const deps = store.state.deployments.filter((d) => pids.has(d.projectId));
		const lite = (d: (typeof deps)[number]) => {
			const s = deploymentSummary(store, d);
			return {
				id: s.id,
				name: s.name,
				displayName: s.displayName,
				image: s.image,
				buildStatus: s.buildStatus,
				ingresses: s.ingresses,
				project: { name: s.project.name },
				faviconUrl: null
			};
		};
		const active = deps
			.filter((d) => d.buildStatus === 'building' || d.buildStatus === 'pending')
			.map((d) => ({
				...lite(d),
				status: d.status,
				buildStep: d.buildStep,
				buildStartedAt: d.buildStepTimestamps?.queued
					? new Date(d.buildStepTimestamps.queued).toISOString()
					: null,
				buildStepTimestamps: d.buildStepTimestamps
					? { __start: d.buildStepTimestamps.queued, ...d.buildStepTimestamps }
					: null,
				updatedAt: d.updatedAt,
				githubRepo: d.githubRepo,
				githubBranch: d.githubBranch
			}));
		const byId = new Map(deps.map((d) => [d.id, d]));
		const recent = store.state.builds
			.filter((b) => byId.has(b.deploymentId) && b.status !== 'building')
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, 8)
			.map((b) => ({
				id: b.id,
				commitSha: b.commitSha,
				branch: b.branch,
				triggerType: b.triggerType,
				isActive: b.isActive,
				createdAt: b.createdAt,
				commitMessage: b.commitMessage,
				buildStartedAt: b.buildStartedAt,
				buildCompletedAt: b.buildCompletedAt,
				status: b.status,
				deployment: { ...lite(byId.get(b.deploymentId)!), buildStatus: b.status }
			}));
		return { active, recent };
	});

	r.get('/events/orgs/:orgId', ({ params, query, req, res }) => {
		const o = store.org(params.orgId);
		if (!o) return notFound('Organization not found');
		const header = req.headers['last-event-id'];
		hub.subscribe(
			o.id,
			res,
			(typeof header === 'string' ? header : null) ?? query.get('lastEventId')
		);
		return STREAMING;
	});

	r.get('/organizations/:orgId/members', ({ params }) => {
		const o = store.org(params.orgId);
		if (!o) return notFound();
		return store.membersOf(o.id).map((m) => memberRow(store, m));
	});
	r.post('/organizations/:orgId/leave', () => ({ success: true }));
	r.get('/organizations/:orgId/members/me', ({ params }) => {
		const o = store.org(params.orgId);
		const role = o ? store.myRole(o.id) : null;
		return role ? { role, synthetic: false } : notFound();
	});
}
