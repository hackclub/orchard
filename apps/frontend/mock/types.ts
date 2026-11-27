export type Role = 'owner' | 'admin' | 'member' | 'guest';

export interface MockUser {
	id: string;
	email: string;
	username: string;
	firstName: string;
	lastName: string;
	imageUrl: string | null;
	isSuperAdmin: boolean;
	setupCompleted: boolean;
	seenUpdates: string[];
	createdAt: string;
}

export interface MockOrg {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	avatarUrl: string | null;
	plan: string | null;
	createdAt: string;
}

export interface MockMember {
	id: string;
	organizationId: string;
	userId: string;
	role: Role;
	createdAt: string;
}

export interface MockProject {
	id: string;
	organizationId: string;
	name: string;
	slug: string;
	description: string | null;
	icon: string | null;
	backgroundImage: string | null;
	ownerId: string;
	memberIds: string[];
	createdAt: string;
	updatedAt: string;
}

export interface MockEnvironment {
	id: string;
	projectId: string;
	name: string;
	slug: string;
	namespace: string;
	isDefault: boolean;
	isProduction: boolean;
	cpuLimitMilli: number | null;
	memoryLimitBytes: string | null;
	maxPods: number | null;
	maxServices: number | null;
	sharedVars: MockEnvVar[];
	createdAt: string;
	updatedAt: string;
}

export interface MockEnvVar {
	key: string;
	value: string;
	secret: boolean;
}

export interface MockCrash {
	reason: string;
	exitCode: number;
	message: string;
}

export interface MockVolume {
	id: string;
	name: string;
	type: 'pvc' | 'hostPath' | 'emptyDir';
	mountPath: string;
	storageSize: string | null;
	readOnly: boolean;
}

export type BuildStep = 'queued' | 'cloning' | 'building' | 'pushing' | 'deploying' | 'complete';

export interface MockDeployment {
	id: string;
	projectId: string;
	environmentId: string;
	name: string;
	displayName: string | null;
	icon?: string | null;
	status: string;
	buildStatus: 'none' | 'pending' | 'building' | 'succeeded' | 'failed' | 'canceled';
	buildStep: BuildStep | null;
	buildStepTimestamps: Record<string, number> | null;
	buildError: string | null;
	buildLogs: string;
	replicas: number;
	stopped: boolean;
	image: string;
	githubRepo: string | null;
	githubBranch: string | null;
	buildType: 'dockerfile' | 'railpack';
	framework: string | null;
	host: string | null;
	hostPath?: string;
	port: number;
	cpuRequestMilli: number;
	memoryRequestBytes: number;
	cpuUsageMilli: number;
	memoryUsageBytes: number;
	envVars: MockEnvVar[];
	volumes: MockVolume[];
	crash: MockCrash | null;
	podScenarios?: Record<number, import('./scenarios.ts').PodScenario>;
	podScenarioAt?: Record<number, number>;
	revisions?: { seed: string; number: number; image: string; createdAt: string }[];
	rollout?: {
		prev: string;
		next: string;
		middle?: string;
		outcome: import('./scenarios.ts').PodScenario;
		startedAt: number;
		failed?: boolean;
	} | null;
	podSeed: string;
	podStartedAt: string;
	restarts: number;
	creatorId: string;
	autoDeployEnabled: boolean;
	templateInstanceId?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MockTemplateInstance {
	id: string;
	projectId: string;
	name: string;
	templateName: string;
	status: string;
	parameters: Record<string, unknown>;
	createdAt: string;
}

export interface MockBuild {
	id: string;
	deploymentId: string;
	image: string;
	branch: string | null;
	commitSha: string | null;
	commitMessage: string | null;
	commitAuthorName: string | null;
	commitAuthorUsername: string | null;
	triggerType: 'push' | 'manual' | 'redeploy' | 'rollback' | 'api';
	triggeredById: string | null;
	status: 'building' | 'succeeded' | 'failed' | 'canceled';
	isActive: boolean;
	buildStartedAt: string;
	buildCompletedAt: string | null;
	createdAt: string;
	logs: string;
}

export interface MockBackup {
	id: string;
	name: string;
	status: 'completed' | 'running' | 'failed';
	method: 'scheduled' | 'manual';
	sizeBytes: number;
	startedAt: string;
	completedAt: string | null;
}

export interface MockDatabase {
	id: string;
	projectId: string;
	environmentId: string;
	name: string;
	dbName: string;
	engine: 'postgres' | 'redis';
	version: string;
	status: string;
	mode: string;
	instances: number;
	storageSize: string;
	storageUsedBytes: number;
	cpuRequestMilli: number;
	memoryRequestBytes: number;
	username: string;
	password: string;
	extensions: string[];
	backups: MockBackup[];
	backupSchedule: { enabled: boolean; schedule: string; retentionDays: number };
	creatorId: string;
	templateInstanceId?: string | null;
	createdAt: string;
	updatedAt: string;
}

export type RunStatus =
	| 'pending'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'canceled'
	| 'skipped'
	| 'timed_out';

export interface MockJobStep {
	id: string;
	stepOrder: number;
	name: string;
	type: 'app' | 'image' | 'script';
	deploymentId: string | null;
	image: string | null;
	command: string | null;
	script: string | null;
	scriptRuntime: 'bash' | 'python' | 'node' | null;
	envVars: { key: string; value: string }[];
	cpuRequestMilli: number | null;
	memoryRequestBytes: string | null;
	timeoutSeconds: number;
	retries: number;
}

export interface MockJob {
	id: string;
	projectId: string;
	name: string;
	description: string | null;
	scheduleCron: string | null;
	timeZone: string | null;
	enabled: boolean;
	concurrencyPolicy: 'allow' | 'forbid';
	runTimeoutSeconds: number;
	steps: MockJobStep[];
	createdAt: string;
	updatedAt: string;
}

export interface MockJobRunStep {
	id: string;
	stepOrder: number;
	name: string;
	type: 'app' | 'image' | 'script';
	resolvedImage: string | null;
	command: string | null;
	status: RunStatus;
	exitCode: number | null;
	reason: string | null;
	logsTruncated: boolean;
	startedAt: string | null;
	finishedAt: string | null;
	logs: string;
}

export interface MockJobRun {
	id: string;
	jobId: string;
	number: number;
	status: RunStatus;
	trigger: 'cron' | 'manual' | 'api';
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: string;
	currentStepOrder: number | null;
	errorMessage: string | null;
	scheduledFor: string | null;
	triggeredById: string | null;
	steps: MockJobRunStep[];
}

export interface MockSsoProvider {
	id: string;
	organizationId: string | null;
	slug: string;
	name: string;
	preset: string;
	protocol: 'oidc' | 'saml' | 'oauth2';
	enabled: boolean;
	buttonLabel: string | null;
	iconUrl: string | null;
	sortOrder: number;
	issuerUrl: string | null;
	clientId: string | null;
	clientSecret: string | null;
	scopes: string | null;
	authorizationUrl: string | null;
	tokenUrl: string | null;
	userinfoUrl: string | null;
	samlEntryPoint: string | null;
	samlIssuer: string | null;
	samlIdpEntityId: string | null;
	samlCertificate: string | null;
	samlMetadataUrl: string | null;
	jitProvisioning: boolean;
	defaultRole: 'admin' | 'member' | 'guest';
	allowedDomains: string[];
	requireVerifiedEmail: boolean;
	trustEmail?: boolean;
	lastUsedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MockState {
	resourceLimits?: 'on' | 'off';
	fastBuilderRouting?: 'all' | 'per_app' | 'off' | 'flag';
	signedIn: boolean;
	meId: string;
	users: MockUser[];
	orgs: MockOrg[];
	members: MockMember[];
	projects: MockProject[];
	environments: MockEnvironment[];
	deployments: MockDeployment[];
	builds: MockBuild[];
	databases: MockDatabase[];
	jobs: MockJob[];
	jobRuns: MockJobRun[];
	templateInstances: MockTemplateInstance[];
	ssoProviders: MockSsoProvider[];
	pinned: { type: string; id: string }[];
}
