export interface ContainerTermination {
	reason: string;
	exitCode?: number | null;
	finishedAt?: string | null;
}

export interface Pod {
	name: string;
	status: string;
	ip?: string;
	startTime?: string;
	restartCount?: number;
	cpuUsage?: number | null;
	memoryUsage?: number | null;
	containers?: {
		name: string;
		image: string;
		ready: boolean;
		restartCount?: number;
		lastTermination?: ContainerTermination | null;
	}[];
}

export interface ServicePortConfig {
	id?: string;
	name?: string;
	port: number;
	targetPort: number;
	protocol: string;
	nodePort?: number | null;
	publicEnabled?: boolean;
	publicPort?: number | null;
	publicAddress?: string | null;
	internalUrl?: string;
}

export interface Service {
	id: string;
	name: string;
	port: number;
	targetPort: number;
	protocol: string;
	nodePort?: number;
	type?: string;
	externalIp?: string | null;
	domain?: string | null;
	ports?: ServicePortConfig[];
	internalHost?: string;
	internalUrl?: string;
	internalUrls?: string[];
}

export interface IngressRoute {
	path: string;
	serviceName: string;
	servicePort: number;
}

export interface Ingress {
	id: string;
	name: string;
	host: string;
	path: string;
	tlsEnabled: boolean;
	address?: string;
	annotations?: Record<string, any>;
	routes?: IngressRoute[];
	service?: {
		id: string;
		name: string;
		port: number;
	};
	protectionMode?: 'none' | 'password' | 'orchard';
	protectionBypassSecret?: string;
}

export interface ImageHistory {
	id: string;
	image: string;
	branch?: string;
	commitSha?: string;
	commitMessage?: string;
	commitAuthorName?: string;
	commitAuthorUsername?: string;
	buildStartedAt?: string;
	buildCompletedAt?: string;
	createdAt: string;
	isActive: boolean;
	triggerType?: string;
	triggeredBy?: {
		id: string;
		username: string;
		firstName?: string;
		lastName?: string;
	};
}

export type VolumeResizeState = 'resizing' | 'pendingRestart' | 'failed';

export interface VolumeObservation {
	observedCapacity?: string | null;
	phase?: string | null;
	resizeState?: VolumeResizeState | null;
	resizeMessage?: string | null;
	observedAt?: string | null;
}

export interface Volume extends VolumeObservation {
	id: string;
	name: string;
	type: 'pvc' | 'hostPath' | 'emptyDir';
	mountPath: string;
	pvcName?: string | null;
	storageSize?: string | null;
	hostPath?: string | null;
	readOnly: boolean;
}

export interface DockerfileHealthCheck {
	command: string[];
	interval?: number;
	timeout?: number;
	retries?: number;
	startPeriod?: number;
}

export interface Deployment {
	id: string;
	name: string;
	displayName?: string | null;
	icon?: string | null;
	status: string;
	buildStatus?: string;
	buildStep?: string | null;
	replicas: number;
	availableReplicas: number;
	// Mirrored from the live Deployment: what Kubernetes is asked to run, as
	// opposed to `replicas`, which is what Orchard intends. Null until the
	// mirror has seen the object.
	// How many pods the usage totals are summed over, which is what the
	// per-pod requests must be multiplied by to get a budget.
	meteredPods?: number | null;
	specReplicas?: number | null;
	readyReplicas?: number | null;
	stopped?: boolean;
	image?: string;
	namespace?: string;
	env?: { key: string; value: string }[];
	volumes?: Volume[];
	pods?: Pod[];
	services?: Service[];
	ingresses?: Ingress[];
	imageHistory?: ImageHistory[];
	latestVerdict?: import('$lib/components/deployment/verdict').ReleaseVerdict | null;
	dockerfileTarget?: string | null;
	githubRepo?: string;
	githubBranch?: string;
	buildType?: 'dockerfile' | 'railpack';
	dockerfilePath?: string;
	buildFromRoot?: boolean;
	buildWithDepot?: boolean;
	rootDirectory?: string | null;
	framework?: string | null;
	installCommand?: string | null;
	buildCommand?: string | null;
	startCommand?: string | null;
	outputDirectory?: string | null;
	detectedConfig?: {
		framework?: string | null;
		providers?: string[];
		isStatic?: boolean;
		packageManager?: string | null;
		railpackVersion?: string | null;
	} | null;
	buildLogs?: string;
	buildError?: string;
	buildStepTimestamps?: Record<string, number> | null;
	autoDeployEnabled?: boolean;
	autoDeployBranch?: string;
	pendingPush?: {
		sha: string;
		branch: string;
		author?: string | null;
		message?: string | null;
		at: string;
		count: number;
	} | null;
	gitConnection?: {
		id: string;
		name: string;
		provider: string;
		baseUrl: string;
		userId: string;
	} | null;
	queuedCommitSha?: string | null;
	queuedCommitMessage?: string | null;
	queuedCommitAuthorUsername?: string | null;
	queuedAt?: string | null;
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
	pdbMinAvailable?: number;
	devices?: Record<string, number>;
	imagePullPolicy?: 'Always' | 'IfNotPresent' | null;
	effectiveImagePullPolicy?: 'Always' | 'IfNotPresent';
	warnings?: { podName: string; message: string; timestamp: string }[];
	envConflicts?:
		| {
				key: string;
				reason:
					| 'reference'
					| 'foreign-source'
					| 'orphan-secret-ref'
					| 'removed-secret'
					| 'mass-removal';
		  }[]
		| null;
	project?: {
		id: string;
		name: string;
		slug: string;
		backgroundImage?: string | null;
	};
	projectId?: string;
	tailscaleExposed?: boolean;
	tailscaleHostname?: string | null;
	envVars?: { key: string; value: string }[];
}

export interface AutoDeployStatus {
	enabled: boolean;
	branch: string;
	paths?: string[];
	/** The App can see the repo. */
	appInstalled: boolean;
	/** This deployment is bound to a live installation, so pushes actually reach it. */
	linked?: boolean;
	deliverable?: boolean;
	message?: string | null;
	/** Set when the app comes from a git provider rather than the GitHub App. */
	provider?: {
		id: string;
		name: string;
		kind: string;
		host: string;
		webhookUrl: string;
		hookPresent: boolean | null;
		canRegister: boolean;
		ownedByMe: boolean;
	} | null;
}

export interface GitHubAppInstallation {
	id: string;
	installationId: string;
	accountLogin: string;
	accountType: string;
}

export interface GitHubDeploymentRecord {
	id: string;
	githubDeploymentId: string;
	owner: string;
	repo: string;
	ref: string;
	commitSha: string;
	environment: string;
	status: string;
	logUrl?: string;
	environmentUrl?: string;
	createdAt: string;
}

export interface ServicePortForm {
	name: string;
	containerPort: number;
	servicePort: number;
	protocol: string;
	nodePort?: number | null;
}

export interface ServiceFormState {
	name: string;
	exposePublic: boolean;
	ports: ServicePortForm[];
}

export interface WebhookToken {
	id: string;
	label: string | null;
	createdAt: string;
	lastUsedAt: string | null;
	token?: string;
}

export interface TerminalTabInfo {
	id: string;
	podName: string;
	container: string;
	label: string;
	title?: string;
	bell?: boolean;
	sessionHandle?: string;
}

export type StatusTone = 'success' | 'warning' | 'error' | 'neutral' | 'info';

export type TabId =
	| 'overview'
	| 'environment'
	| 'resources'
	| 'metrics'
	| 'volumes'
	| 'network'
	| 'history'
	| 'webhooks'
	| 'audit'
	| 'advanced';
