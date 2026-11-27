import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException
} from '@nestjs/common';
import { parseKubeletSummary, type VolumeUsage } from './volume-stats';
import * as k8s from '@kubernetes/client-node';
import * as https from 'https';
import { isDeepStrictEqual } from 'node:util';
import { PassThrough } from 'stream';
import { ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { resolveNamespaceScope } from '../projects/namespace-scope';
import {
  KubernetesService,
  CreateDeploymentOptions,
  DeploymentPortInput,
  UpdateDeploymentEnvOptions,
  buildPlacement
} from './kubernetes.service';
import { K8sNamespaceService } from './k8s-namespace.service';
import {
  sanitizePortEntries,
  mapServicePorts,
  snapshotPublicPortState,
  publicPortKey
} from './port-utils';
import {
  applySizingTo,
  containerResources,
  appResourcesPatch,
  NO_LIMITS_ANNOTATION,
  noLimitsMetadataPatch,
  type PodSizing
} from './resource-spec';
import {
  deviceQuantities,
  deviceResourcesPatch,
  deviceRuntimeClassName,
  deviceRuntimeClassPatch,
  liveDeviceQuantities,
  withDevices,
  type DeviceRequest
} from './devices';
import {
  hardenedSecurityContext,
  tenantPodAnnotations,
  tenantRuntimeClassName
} from './trusted-images';
import { TAILSCALE_EGRESS_EXCEPT, tailscaleImage, tailscaleSecurityContext } from './tailscale-pod';
import {
  buildEnvReplacePatch,
  ENV_HASH_ANNOTATION,
  envHash,
  envHashAnnotationPatch,
  envListsEqual,
  secretDataEquals
} from './env-patch';
import {
  disruptionBudgetActive,
  disruptionBudgetManifest,
  normalizeMinAvailable
} from './disruption-budget';
import { computePodStatus, podFacts } from '../engine/pod-status';
import { isExternalDeployment } from './external-deployment';
import { isPullAuthEnvKey } from '../env/reserved-env';
import {
  ROLLOUT_GATE_POLL_MS,
  ROLLOUT_GATE_TIMEOUT_MS,
  ROLLOUT_MIN_READY_SECONDS,
  ROLLOUT_PROGRESS_DEADLINE_SECONDS,
  assessRollout,
  blueGreenBlocker,
  buildGreenDeployment,
  greenName,
  k8sStrategyFor,
  rollingUpdateStrategy,
  selectorPointsAt,
  slotSelector,
  type DeployStrategy,
  type RolloutAssessment,
  revisionOf
} from './rollout-strategy';
import { k8sErrorMessage, k8sHttpException } from './k8s-error';
import { livenessProbe, probesFor, readinessProbe, startupProbe } from './probes';
import { pinToBuildArch } from '../docker/build-platform';
import {
  MANAGED_VOLUMES_ANNOTATION,
  recordedVolumeNames,
  buildVolumeReplacePatch
} from './volume-patch';

/**
 * Workloads + pods + tailscale sidecar: Deployments and Pods CRUD, env/
 * health-check/volume updates, scale/restart, image bumps, pod logs/
 * events/metrics, deployment-pods aggregation, and the tailscale sidecar
 * patch flows.
 *
 * Shares kubeconfig + a few cross-domain helpers (createPVC, mapServicePorts,
 * getDefaultNodeIp) with the core KubernetesService via injection: `this.kc`,
 * `this.ensureKubeConfig()`, etc. are delegated below.
 */
// Only the fields Orchard sets. The API server fills in the rest (scheme,
// successThreshold, termination grace), and comparing those would report drift
// on every read.
function probePatch(probe: k8s.V1Probe) {
  return {
    ...probe,
    exec: probe.exec ?? null,
    httpGet: probe.httpGet ?? null,
    tcpSocket: probe.tcpSocket ?? null,
    grpc: probe.grpc ?? null
  };
}

function probeSignature(probe: k8s.V1Probe | null | undefined): string {
  if (!probe) return 'none';

  let target = 'empty';
  if (probe.httpGet) target = `http:${probe.httpGet.path ?? '/'}:${probe.httpGet.port}`;
  else if (probe.tcpSocket) target = `tcp:${probe.tcpSocket.port}`;
  else if (probe.exec) target = `exec:${JSON.stringify(probe.exec.command ?? [])}`;

  return [target, probe.periodSeconds, probe.timeoutSeconds, probe.failureThreshold].join('|');
}

function probesEqual(
  a: k8s.V1Probe | null | undefined,
  b: k8s.V1Probe | null | undefined
): boolean {
  return probeSignature(a) === probeSignature(b);
}

function resolvePvcClaimName(vol: { name?: string; pvcName?: string | null }): string {
  const claimName = vol.pvcName?.trim() || vol.name?.trim();
  if (!claimName) {
    throw new BadRequestException('A persistent volume needs a name to claim storage under');
  }
  return claimName;
}

import { tailscaleRoleRules } from './tailscale-rbac';
import { isTailscaleOwned, legacyTailscaleNames, tailscaleNames } from './tailscale-names';
@Injectable()
export class K8sWorkloadService {
  private readonly logger = new Logger(K8sWorkloadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly namespaces: K8sNamespaceService,
    private readonly audit: AuditService
  ) {}

  private get kc(): k8s.KubeConfig | null {
    return this.kubernetes.kc;
  }

  async syncComposeAliases(
    namespace: string,
    stackId: string,
    aliases: { name: string; target: string; ports: { port: number; protocol: string }[] }[]
  ): Promise<{ conflicts: string[] }> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const owner = 'orchard.my/compose-alias-stack';
    const body = (alias: (typeof aliases)[number]) => ({
      metadata: { name: alias.name, labels: { [owner]: stackId } },
      spec: {
        selector: { 'app.kubernetes.io/name': alias.target },
        ports: alias.ports.map((p) => ({
          name: `${p.protocol.toLowerCase()}-${p.port}`,
          port: p.port,
          targetPort: p.port,
          protocol: p.protocol
        }))
      }
    });

    const existing = new Map<string, k8s.V1Service | null>();
    const conflicts: string[] = [];
    for (const alias of aliases) {
      const live = await coreApi
        .readNamespacedService(alias.name, namespace)
        .then((res) => res.body)
        .catch((e: any) => {
          if (e?.response?.statusCode === 404) return null;
          throw e;
        });
      existing.set(alias.name, live);
      if (live && live.metadata?.labels?.[owner] !== stackId) conflicts.push(alias.name);
    }
    if (conflicts.length > 0) return { conflicts };

    for (const alias of aliases) {
      if (existing.get(alias.name)) {
        await coreApi.patchNamespacedService(
          alias.name,
          namespace,
          body(alias),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        );
      } else {
        await coreApi.createNamespacedService(namespace, body(alias));
      }
    }

    const owned = await coreApi.listNamespacedService(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `${owner}=${stackId}`
    );
    const wanted = new Set(aliases.map((alias) => alias.name));
    for (const service of owned.body.items) {
      const name = service.metadata?.name;
      if (name && !wanted.has(name)) {
        await coreApi.deleteNamespacedService(name, namespace).catch((e: any) => {
          if (e?.response?.statusCode !== 404) throw e;
        });
      }
    }
    return { conflicts: [] };
  }

  private ensureKubeConfig() {
    this.kubernetes.ensureKubeConfig();
  }

  private getDefaultNodeIp(coreApi: k8s.CoreV1Api) {
    return this.kubernetes.getDefaultNodeIp(coreApi);
  }

  private createPVC(namespace: string, name: string, storageSize = '1Gi') {
    return this.kubernetes.createPVC(namespace, name, storageSize);
  }

  async volumeUsageOnNodes(nodeNames: string[]): Promise<Map<string, VolumeUsage>> {
    this.ensureKubeConfig();
    const usage = new Map<string, VolumeUsage>();
    if (!this.kc) return usage;
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    await Promise.all(
      [...new Set(nodeNames)].map(async (name) => {
        try {
          const res: any = await coreApi.connectGetNodeProxyWithPath(name, 'stats/summary');
          const raw = res?.body;
          const summary = typeof raw === 'string' ? JSON.parse(raw) : raw;
          for (const [key, value] of parseKubeletSummary(summary)) usage.set(key, value);
        } catch (e: any) {
          this.logger.warn(`volume stats for node ${name} unavailable: ${e?.message ?? e}`);
        }
      })
    );
    return usage;
  }

  async updateDeploymentResources(namespace: string, deploymentName: string, resources: PodSizing) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const existing = await appsApi.readNamespacedDeployment(deploymentName, namespace);
    const containers = existing.body.spec?.template?.spec?.containers;
    if (!containers || containers.length === 0) {
      throw new NotFoundException(`Deployment ${deploymentName} has no containers`);
    }
    const containerName = containers[0].name;
    const patch = {
      ...noLimitsMetadataPatch(resources),
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: containerName,
                resources: appResourcesPatch(resources)
              }
            ]
          }
        }
      }
    };
    await appsApi.patchNamespacedDeployment(
      deploymentName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  }

  async removeDeploymentResources(namespace: string, deploymentName: string) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const existing = await appsApi.readNamespacedDeployment(deploymentName, namespace);
    const containers = existing.body.spec?.template?.spec?.containers;
    if (!containers || containers.length === 0) {
      throw new NotFoundException(`Deployment ${deploymentName} has no containers`);
    }
    const containerName = containers[0].name;
    const patch = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: containerName,
                resources: {
                  requests: {},
                  limits: {}
                }
              }
            ]
          }
        }
      }
    };
    await appsApi.patchNamespacedDeployment(
      deploymentName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  }

  async listPods(namespace = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();

    if (!cleanNamespace || cleanNamespace.length === 0) {
      throw new BadRequestException('Namespace parameter is required');
    }

    console.log('[API] Fetching pods from namespace:', cleanNamespace);

    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const podList = await api.listNamespacedPod(cleanNamespace);

      const pods = podList.body.items.map((pod) => ({
        name: pod.metadata.name,
        namespace: pod.metadata.namespace,
        status: pod.status.phase,
        podIP: pod.status.podIP,
        hostIP: pod.status.hostIP,
        startTime: pod.status.startTime,
        conditions: pod.status.conditions,
        containerStatuses: pod.status.containerStatuses?.map((container) => ({
          name: container.name,
          ready: container.ready,
          restartCount: container.restartCount,
          image: container.image,
          state: container.state
        })),
        labels: pod.metadata.labels,
        annotations: pod.metadata.annotations
      }));

      return {
        namespace: cleanNamespace,
        podCount: pods.length,
        pods
      };
    } catch (error) {
      console.error('Error fetching pods:', error);

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to fetch pods from Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to fetch pods',
        message: error.message
      });
    }
  }

  async getKubernetesDeployment(deploymentName: string, namespace = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanDeploymentName = String(deploymentName).trim();

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const k8sDeployment = await appsApi.readNamespacedDeployment(
        cleanDeploymentName,
        cleanNamespace
      );

      return {
        name: k8sDeployment.body.metadata.name,
        namespace: k8sDeployment.body.metadata.namespace,
        status: {
          replicas: k8sDeployment.body.spec.replicas,
          availableReplicas: k8sDeployment.body.status.availableReplicas ?? 0,
          readyReplicas: k8sDeployment.body.status.readyReplicas ?? 0,
          updatedReplicas: k8sDeployment.body.status.updatedReplicas ?? 0
        }
      };
    } catch (error) {
      if (k8sHttpException(error)?.getStatus() === 404) {
        return null;
      }

      console.error('Error fetching deployment:', error);

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to fetch deployment from Kubernetes',
          message: k8sErrorMessage(error),
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to fetch deployment',
        message: k8sErrorMessage(error)
      });
    }
  }

  async getPod(podName: string, namespace = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanPodName = String(podName).trim();

    console.log('[API] Fetching pod:', cleanPodName, 'from namespace:', cleanNamespace);

    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const pod = await api.readNamespacedPod(cleanPodName, cleanNamespace);

      return pod.body;
    } catch (error) {
      console.error('Error fetching pod:', error);

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Pod not found',
          message: `Pod ${cleanPodName} not found in namespace ${cleanNamespace}`
        });
      }

      throw new BadRequestException({
        error: 'Failed to fetch pod',
        message: error.message
      });
    }
  }

  async deletePod(podName: string, namespace = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanPodName = String(podName).trim();

    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      await api.deleteNamespacedPod(cleanPodName, cleanNamespace);
      return { success: true, message: `Pod ${cleanPodName} deleted` };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Pod not found',
          message: `Pod ${cleanPodName} not found in namespace ${cleanNamespace}`
        });
      }
      throw new BadRequestException({
        error: 'Failed to delete pod',
        message: error.message
      });
    }
  }

  async getPodLogs(
    podName: string,
    namespace = 'midnight-staging',
    containerName?: string,
    tailLines = 100,
    previous = false,
    sinceSeconds?: number,
    sinceTime?: string
  ) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanPodName = String(podName).trim();
    const cleanContainerName = containerName ? String(containerName).trim() : '';

    console.log(
      '[API] Fetching logs for pod:',
      cleanPodName,
      'container:',
      cleanContainerName || '(default)',
      'from namespace:',
      cleanNamespace
    );

    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const pod = await api.readNamespacedPod(cleanPodName, cleanNamespace);
      const containers = pod.body.spec?.containers?.map((c) => c.name) || [];

      if (containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Pod "${cleanPodName}" has no containers`
        });
      }

      if (!cleanContainerName && containers.length > 1) {
        throw new BadRequestException({
          error: 'Container name required',
          message: `Pod "${cleanPodName}" has multiple containers. Specify one.`,
          availableContainers: containers
        });
      }

      const targetContainer = cleanContainerName || containers[0];

      if (cleanContainerName && !containers.includes(cleanContainerName)) {
        throw new BadRequestException({
          error: 'Container not found',
          message: `Container "${cleanContainerName}" not found in pod "${cleanPodName}"`,
          availableContainers: containers
        });
      }

      console.log('[API] Fetching logs for container:', targetContainer);

      try {
        const logs = sinceTime
          ? await this.readPodLogSinceTime(
              cleanPodName,
              cleanNamespace,
              targetContainer,
              sinceTime,
              tailLines,
              previous
            )
          : (
              await api.readNamespacedPodLog(
                cleanPodName,
                cleanNamespace,
                targetContainer,
                false,
                false,
                undefined,
                undefined,
                previous,
                sinceSeconds,
                tailLines,
                true
              )
            ).body;

        return {
          podName: cleanPodName,
          container: targetContainer,
          namespace: cleanNamespace,
          logs,
          tailLines,
          previous,
          sinceSeconds,
          sinceTime
        };
      } catch (logError) {
        const statusCode = logError.response?.statusCode;
        const k8sMessage: string = logError.response?.body?.message || '';

        // k8s answers 400 "container ... is waiting to start: ContainerCreating"
        // (or PodInitializing / image pull states) for pods that haven't started
        // yet: routine right after a scale-up or restart while the frontend is
        // already polling logs. Not an error: report empty logs until the
        // container is up.
        if (statusCode === 400 && k8sMessage.includes('is waiting to start')) {
          return {
            podName: cleanPodName,
            container: targetContainer,
            namespace: cleanNamespace,
            logs: '',
            tailLines,
            pending: true,
            message: k8sMessage
          };
        }

        if (statusCode === 400 && previous && /previous terminated container/i.test(k8sMessage)) {
          return {
            podName: cleanPodName,
            container: targetContainer,
            namespace: cleanNamespace,
            logs: '',
            tailLines,
            previous: true,
            noPreviousLogs: true,
            message: k8sMessage
          };
        }

        if (statusCode !== 404) {
          console.error('[API] Log fetch error details:', {
            message: logError.message,
            code: logError.code,
            statusCode,
            body: logError.response?.body
          });
        }

        throw new BadRequestException({
          error: 'Failed to fetch logs',
          message:
            logError.response?.body?.message || logError.message || 'Error occurred in log request',
          availableContainers: containers,
          targetContainer,
          podStatus: pod.body.status?.phase,
          containerStatuses: pod.body.status?.containerStatuses?.map((cs) => ({
            name: cs.name,
            ready: cs.ready,
            state: Object.keys(cs.state || {})[0],
            restartCount: cs.restartCount
          })),
          hint: 'The container may not be running or may not have generated any logs yet'
        });
      }
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      const statusCode = (error as any)?.response?.statusCode;
      if (statusCode !== 404) {
        console.error('Error fetching logs:', error);
      }
      throw new BadRequestException({
        error: 'Failed to fetch logs',
        message: error.message
      });
    }
  }

  // The generated client in @kubernetes/client-node 0.21 exposes sinceSeconds
  // but not sinceTime on readNamespacedPodLog, so sinceTime reads hit the API
  // server directly with the kubeconfig's TLS/auth applied. Errors are shaped
  // like the generated client's ({ response: { statusCode, body } }) so the
  // caller's error handling works unchanged.
  private async readPodLogSinceTime(
    podName: string,
    namespace: string,
    container: string,
    sinceTime: string,
    tailLines: number,
    previous: boolean
  ): Promise<string> {
    const cluster = this.kc.getCurrentCluster();
    if (!cluster) {
      throw new BadRequestException({
        error: 'Failed to fetch logs',
        message: 'No current cluster in kubeconfig'
      });
    }

    const params = new URLSearchParams({
      container,
      sinceTime,
      timestamps: 'true',
      tailLines: String(tailLines)
    });
    if (previous) params.set('previous', 'true');
    const url = new URL(
      `${cluster.server}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/log?${params.toString()}`
    );

    const opts: https.RequestOptions = { method: 'GET' };
    await this.kc.applyToHTTPSOptions(opts);

    return new Promise<string>((resolve, reject) => {
      const req = https.request(url, opts, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            let parsed: any;
            try {
              parsed = JSON.parse(body);
            } catch {
              parsed = { message: body };
            }
            reject(
              Object.assign(
                new Error(parsed?.message || `Log request failed with status ${res.statusCode}`),
                {
                  response: { statusCode: res.statusCode, body: parsed }
                }
              )
            );
            return;
          }
          resolve(body);
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async getPodContainers(podName: string, namespace: string): Promise<string[]> {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.CoreV1Api);
    const pod = await api.readNamespacedPod(podName, namespace);
    return (pod.body.spec?.containers ?? []).map((c) => c.name);
  }

  /**
   * Live-follow a pod's logs with the raw API-server endpoint (the generated
   * client cannot stream follow=true reads). Complete lines are delivered via
   * onLine; onEnd fires exactly once when the stream closes (container
   * restart, pod gone, network) or errors. Returns an abort function. The
   * caller owns reconnect policy.
   */
  followPodLogStream(
    podName: string,
    namespace: string,
    container: string | undefined,
    opts: { sinceTime?: string; tailLines?: number },
    onLine: (line: string) => void,
    onEnd: (err?: Error) => void
  ): () => void {
    this.ensureKubeConfig();
    const cluster = this.kc.getCurrentCluster();
    if (!cluster) {
      onEnd(new Error('No current cluster in kubeconfig'));
      return () => {};
    }

    const params = new URLSearchParams({ follow: 'true', timestamps: 'true' });
    if (container) params.set('container', container);
    if (opts.sinceTime) params.set('sinceTime', opts.sinceTime);
    else if (opts.tailLines !== undefined) params.set('tailLines', String(opts.tailLines));
    const url = new URL(
      `${cluster.server}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/log?${params.toString()}`
    );

    let ended = false;
    const finish = (err?: Error) => {
      if (ended) return;
      ended = true;
      onEnd(err);
    };

    let req: import('http').ClientRequest | null = null;
    const start = async () => {
      const httpsOpts: https.RequestOptions = { method: 'GET' };
      await this.kc.applyToHTTPSOptions(httpsOpts);
      req = https.request(url, httpsOpts, (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => {
            let parsed: any;
            try {
              parsed = JSON.parse(body);
            } catch {
              parsed = { message: body };
            }
            finish(
              Object.assign(
                new Error(parsed?.message || `Log stream failed with status ${res.statusCode}`),
                {
                  response: { statusCode: res.statusCode, body: parsed }
                }
              )
            );
          });
          return;
        }
        let partial = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          partial += chunk;
          let idx: number;
          while ((idx = partial.indexOf('\n')) >= 0) {
            const line = partial.slice(0, idx);
            partial = partial.slice(idx + 1);
            if (line) onLine(line);
          }
        });
        res.on('end', () => {
          if (partial) onLine(partial);
          finish();
        });
        res.on('error', (err) => finish(err as Error));
      });
      req.on('error', (err) => finish(err as Error));
      req.end();
    };
    start().catch((err) => finish(err as Error));

    return () => {
      try {
        req?.destroy();
      } catch {
        /* already gone */
      }
      finish();
    };
  }

  async listDeployments(namespace = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();

    console.log('[API] Fetching deployments from namespace:', cleanNamespace);

    try {
      const api = this.kc.makeApiClient(k8s.AppsV1Api);
      const deploymentList = await api.listNamespacedDeployment(cleanNamespace);

      const deployments = deploymentList.body.items.map((deployment) => ({
        name: deployment.metadata.name,
        namespace: deployment.metadata.namespace,
        replicas: deployment.spec.replicas,
        availableReplicas: deployment.status.availableReplicas,
        readyReplicas: deployment.status.readyReplicas,
        image: deployment.spec.template.spec.containers[0]?.image,
        labels: deployment.metadata.labels,
        createdAt: deployment.metadata.creationTimestamp
      }));

      return {
        namespace: cleanNamespace,
        deploymentCount: deployments.length,
        deployments
      };
    } catch (error) {
      console.error('Error fetching deployments:', error);

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to fetch deployments from Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to fetch deployments',
        message: error.message
      });
    }
  }

  async createDeployment(options: CreateDeploymentOptions) {
    this.ensureKubeConfig();

    const cleanNamespace = String(options.namespace || '').trim();
    const cleanName = String(options.name || '').trim();
    const cleanImage = String(options.image || '').trim();
    const replicas = Math.max(1, options.replicas || 1);
    let sanitizedPorts = sanitizePortEntries(Array.isArray(options.ports) ? options.ports : []);

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!cleanImage) {
      throw new BadRequestException('Image is required');
    }

    // Split env into inline (normal) and k8s-Secret-backed (secret) entries.
    // Secret values never appear inline in the pod spec: they're referenced
    // via secretKeyRef into a per-deployment Secret.
    const { envList, secretData } = this.buildEnvAndSecret(cleanName, options.env, {
      HOST: '0.0.0.0',
      FORCE_COLOR: '1'
    });
    if (secretData) {
      await this.upsertEnvSecret(cleanNamespace, cleanName, secretData);
    }

    let requestedServiceType: 'LoadBalancer' | 'NodePort' | 'ClusterIP' = 'ClusterIP';
    if (options.serviceType === 'LoadBalancer') requestedServiceType = 'LoadBalancer';
    else if (options.serviceType === 'NodePort') requestedServiceType = 'NodePort';

    let externalAddress: string | null = null;

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const selectorLabels = {
        'app.kubernetes.io/name': cleanName
      };

      const labels = {
        ...selectorLabels,
        'app.kubernetes.io/managed-by': 'orchard'
      };

      const volumes = Array.isArray(options.volumes) ? options.volumes : [];

      // Create PVCs in Kubernetes before referencing them
      for (const vol of volumes) {
        if (vol.type === 'pvc') {
          await this.createPVC(cleanNamespace, resolvePvcClaimName(vol), vol.storageSize || '1Gi');
        }
      }

      const volumeMounts: k8s.V1VolumeMount[] = volumes.map((vol) => ({
        name: vol.name,
        mountPath: vol.mountPath,
        readOnly: Boolean(vol.readOnly)
      }));

      const k8sVolumes: k8s.V1Volume[] = volumes.map((vol) => {
        const volume: k8s.V1Volume = {
          name: vol.name
        };

        if (vol.type === 'hostPath') {
          // hostPath mounts trivially escape tenant isolation by exposing the
          // node filesystem (docker.sock, kubelet creds, /etc/kubernetes). Hard
          // refuse at the lowest layer, regardless of caller role.
          throw new Error("hostPath volumes aren't permitted");
        }

        if (vol.type === 'pvc') {
          volume.persistentVolumeClaim = {
            claimName: resolvePvcClaimName(vol)
          };
        } else {
          volume.emptyDir = {};
        }

        return volume;
      });

      const container: k8s.V1Container = {
        name: cleanName,
        image: cleanImage,
        imagePullPolicy: options.imagePullPolicy ?? 'IfNotPresent',
        ports: sanitizedPorts.map((port) => ({
          name: port.name,
          containerPort: port.containerPort,
          protocol: port.protocol
        })),
        ...(options.args?.length ? { args: options.args } : {}),
        env: envList,
        volumeMounts: volumeMounts.length > 0 ? volumeMounts : undefined,
        securityContext: hardenedSecurityContext()
      };

      // Burstable QoS: memory requests == limits, CPU requests a fraction of
      // them. Org quota still bills the limit: see getOrgUsage.
      if (options.resources) {
        container.resources = containerResources(options.resources);
      }
      const devices = options.devices ?? {};
      container.resources = withDevices(container.resources, deviceQuantities(devices));

      if (options.healthCheck?.enabled) {
        const probes = probesFor(options.healthCheck);
        if (probes.liveness) container.livenessProbe = probes.liveness;
        if (probes.readiness) container.readinessProbe = probes.readiness;
        if (probes.startup) container.startupProbe = probes.startup;
      }

      const placement = buildPlacement({
        allowedNodes: options.allowedNodes,
        deniedNodes: options.deniedNodes,
        pool: options.pool,
        override: options.placementOverride
      });
      const affinity = pinToBuildArch(placement.affinity, cleanImage) ?? null;

      // PVC volumes can't be held by two pods at once on most CSI drivers
      // (ReadWriteOnce), so a rolling cutover would deadlock waiting for the
      // old pod to release the volume. Force Recreate whenever a PVC is in
      // the volume list, regardless of caller's preference.
      const hasPvcVolume = (options.volumes ?? []).some((v) => v.type === 'pvc');
      const effectiveStrategy =
        hasPvcVolume || Object.keys(devices).length > 0
          ? 'recreate'
          : (options.deployStrategy ?? 'rollingUpdate');
      const strategy: k8s.V1DeploymentStrategy =
        effectiveStrategy === 'recreate' ? { type: 'Recreate' } : rollingUpdateStrategy();

      const deploymentBody: k8s.V1Deployment = {
        metadata: {
          name: cleanName,
          labels,
          annotations: {
            [ENV_HASH_ANNOTATION]: envHash(envList),
            ...(options.resources?.noLimits ? { [NO_LIMITS_ANNOTATION]: 'true' } : {})
          }
        },
        spec: {
          replicas,
          strategy,
          minReadySeconds: ROLLOUT_MIN_READY_SECONDS,
          progressDeadlineSeconds: ROLLOUT_PROGRESS_DEADLINE_SECONDS,
          selector: {
            matchLabels: selectorLabels
          },
          template: {
            metadata: {
              labels,
              annotations: {
                ...tenantPodAnnotations(),
                [MANAGED_VOLUMES_ANNOTATION]: JSON.stringify(volumes.map((vol) => vol.name).sort())
              }
            },
            spec: {
              // Tenant pods do not need to talk to the kube-apiserver. The
              // default ServiceAccount token, if mounted, lets a compromised
              // pod do `selfsubjectreviews` and (more importantly) carries
              // any unintended RBAC grants out of the namespace.
              automountServiceAccountToken: false,
              runtimeClassName: deviceRuntimeClassName(Object.keys(devices)),
              containers: [container],
              imagePullSecrets: options.imagePullSecrets?.length
                ? options.imagePullSecrets
                : undefined,
              volumes: k8sVolumes.length > 0 ? k8sVolumes : undefined,
              affinity: affinity || undefined,
              tolerations: placement.tolerations
            }
          }
        }
      };

      const serviceBody: k8s.V1Service = {
        metadata: {
          name: cleanName,
          labels
        },
        spec: {
          type: requestedServiceType,
          selector: selectorLabels,
          ports: sanitizedPorts.map((port) => {
            const entry: k8s.V1ServicePort = {
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol
            };
            return entry;
          })
        }
      };

      let deploymentCreated = false;

      try {
        await appsApi.createNamespacedDeployment(cleanNamespace, deploymentBody);
        deploymentCreated = true;
        const serviceResponse = await coreApi.createNamespacedService(cleanNamespace, serviceBody);

        const fetchedService = await coreApi.readNamespacedService(cleanName, cleanNamespace);
        if (requestedServiceType === 'LoadBalancer') {
          const ingressStatus = fetchedService.body.status?.loadBalancer?.ingress?.[0];
          if (ingressStatus) {
            externalAddress = ingressStatus.ip || ingressStatus.hostname || null;
          } else if (serviceResponse.body.status?.loadBalancer?.ingress?.[0]) {
            const fallbackIngress = serviceResponse.body.status.loadBalancer.ingress[0];
            externalAddress = fallbackIngress.ip || fallbackIngress.hostname || null;
          }
        } else if (requestedServiceType === 'NodePort') {
          const mappedPorts = mapServicePorts(fetchedService.body.spec?.ports, sanitizedPorts);
          if (mappedPorts.length > 0) {
            const nodePortMap = new Map<string, number>();
            mappedPorts.forEach((port) => {
              if (port.nodePort) {
                nodePortMap.set(port.name, port.nodePort);
                nodePortMap.set(`${port.servicePort}-${port.protocol}`, port.nodePort);
              }
            });
            sanitizedPorts = sanitizedPorts.map((port) => {
              const nodePort =
                nodePortMap.get(port.name) ||
                nodePortMap.get(`${port.servicePort}-${port.protocol}`);
              if (nodePort) {
                return {
                  ...port,
                  nodePort
                };
              }
              return port;
            });
          }
          externalAddress = await this.getDefaultNodeIp(coreApi);
        }
      } catch (error) {
        if (deploymentCreated) {
          try {
            await appsApi.deleteNamespacedDeployment(cleanName, cleanNamespace);
          } catch (cleanupError) {
            console.error('[K8s] Deployment cleanup failed after error', {
              message: cleanupError.message,
              code: cleanupError.code,
              statusCode: cleanupError.response?.statusCode
            });
          }
        }

        if (error.response) {
          throw new BadRequestException({
            error: 'Failed to create deployment',
            message: error.response.body?.message || error.message,
            details: error.response.body
          });
        }

        throw new BadRequestException({
          error: 'Failed to create deployment',
          message: error.message
        });
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create deployment',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to create deployment',
        message: error.message
      });
    }

    // Outside the try above on purpose: the app is already running at this
    // point, and a budget that fails to write is not worth rolling the
    // deployment back over.
    await this.applyPodDisruptionBudget({
      name: cleanName,
      namespace: cleanNamespace,
      minAvailable: options.pdbMinAvailable ?? 1,
      replicas
    }).catch((error) => {
      console.error(
        `[K8s] Failed to apply PodDisruptionBudget for ${cleanName}:`,
        error?.message ?? error
      );
    });

    return {
      success: true,
      deployment: cleanName,
      namespace: cleanNamespace,
      image: cleanImage,
      replicas,
      port: sanitizedPorts[0]?.servicePort ?? 80,
      ports: sanitizedPorts,
      env: envList,
      serviceType: requestedServiceType,
      externalIp: externalAddress
    };
  }

  /**
   * Reconcile the PodDisruptionBudget that keeps an app up while Kubernetes
   * drains a node under it. Written through server-side apply under the same
   * `orchard` field manager the apply queue uses, so a hand-edited budget
   * converges instead of 409-ing.
   *
   * Inactive (see disruptionBudgetActive) means the budget is deleted rather
   * than written, so this is safe to call on every apply: scaling from 2 to 1
   * removes the object, scaling back restores it.
   */
  async applyPodDisruptionBudget(options: {
    name: string;
    namespace: string;
    minAvailable: number;
    replicas: number;
  }): Promise<{ applied: boolean; minAvailable: number }> {
    this.ensureKubeConfig();

    const cleanName = String(options.name || '').trim();
    const cleanNamespace = String(options.namespace || '').trim();

    if (!cleanName) {
      throw new BadRequestException('Deployment name is required');
    }
    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    const minAvailable = normalizeMinAvailable(options.minAvailable);

    if (!disruptionBudgetActive(minAvailable, options.replicas)) {
      try {
        await this.kc
          .makeApiClient(k8s.PolicyV1Api)
          .deleteNamespacedPodDisruptionBudget(cleanName, cleanNamespace);
      } catch (error) {
        if (error.response?.statusCode !== 404) throw error;
      }
      return { applied: false, minAvailable };
    }

    const manifest = disruptionBudgetManifest({
      name: cleanName,
      namespace: cleanNamespace,
      minAvailable
    });
    await k8s.KubernetesObjectApi.makeApiClient(this.kc).patch(
      manifest,
      undefined,
      undefined,
      'orchard',
      true,
      { headers: { 'content-type': k8s.PatchUtils.PATCH_FORMAT_APPLY_YAML } }
    );

    return { applied: true, minAvailable };
  }

  /**
   * Split env vars into inline entries and secretKeyRef entries. Secret values
   * are collected into `secretData` (goes into a per-deployment k8s Secret);
   * the container references them via secretKeyRef so plaintext never lands in
   * the pod spec. `extras` are inline defaults added only when not already set.
   */
  private buildEnvAndSecret(
    deploymentName: string,
    env: { key: string; value: string; secret?: boolean }[] | undefined,
    extras: Record<string, string> = {}
  ): { envList: k8s.V1EnvVar[]; secretData: Record<string, string> | null } {
    const secretName = `${deploymentName}-env`;
    const normal = new Map<string, string>();
    const secret = new Map<string, string>();
    for (const entry of Array.isArray(env) ? env : []) {
      if (!entry || typeof entry.key !== 'string') continue;
      const key = entry.key.trim();
      if (!key) continue;
      if (isPullAuthEnvKey(key)) continue;
      const value = entry.value != null ? String(entry.value) : '';
      if (entry.secret) secret.set(key, value);
      else normal.set(key, value);
    }
    for (const [k, v] of Object.entries(extras)) {
      if (!normal.has(k) && !secret.has(k)) normal.set(k, v);
    }
    const envList: k8s.V1EnvVar[] = [
      ...Array.from(normal, ([name, value]) => ({ name, value })),
      ...Array.from(secret.keys(), (name) => ({
        name,
        valueFrom: { secretKeyRef: { name: secretName, key: name } }
      }))
    ];
    return { envList, secretData: secret.size > 0 ? Object.fromEntries(secret) : null };
  }

  /**
   * Upsert (or delete when null) the per-deployment env Secret. Returns whether
   * the stored values actually changed: secret entries reach the container
   * through secretKeyRef, so their contents are invisible to the pod spec and
   * only a changed Secret justifies forcing a rollout.
   */
  private async upsertEnvSecret(
    namespace: string,
    deploymentName: string,
    secretData: Record<string, string> | null
  ): Promise<boolean> {
    const name = `${deploymentName}-env`;
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    if (!secretData) {
      return this.deleteEnvSecret(coreApi, namespace, name);
    }
    const body: k8s.V1Secret = {
      metadata: {
        name,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'app.kubernetes.io/name': deploymentName
        }
      },
      type: 'Opaque',
      stringData: secretData
    };
    try {
      return await this.writeEnvSecret(coreApi, namespace, name, body, secretData);
    } catch (err: any) {
      const code = err?.statusCode ?? err?.response?.statusCode;
      if (code !== 403) throw err;
      this.logger.warn(
        `[K8s] Namespace ${namespace} is missing the tenant secrets Role; bootstrapping it and retrying`
      );
      await this.namespaces.bootstrapTenantSecretsRbac(namespace);
      return this.writeEnvSecret(coreApi, namespace, name, body, secretData);
    }
  }

  private async deleteEnvSecret(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    name: string
  ): Promise<boolean> {
    try {
      const existing = await coreApi.readNamespacedSecret(name, namespace);
      if (isTailscaleOwned(existing.body.metadata)) return false;
      await coreApi.deleteNamespacedSecret(name, namespace);
      return true;
    } catch {
      return false;
    }
  }

  private async writeEnvSecret(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    name: string,
    body: k8s.V1Secret,
    secretData: Record<string, string>
  ): Promise<boolean> {
    try {
      const existing = await coreApi.readNamespacedSecret(name, namespace);
      if (isTailscaleOwned(existing.body.metadata)) {
        throw new ConflictException(
          `Secret ${name} is reserved by the Tailscale integration; choose a different app name`
        );
      }
      body.metadata!.resourceVersion = existing.body.metadata?.resourceVersion;
      await coreApi.replaceNamespacedSecret(name, namespace, body);
      return !secretDataEquals(existing.body.data, secretData);
    } catch (err: any) {
      const code = err?.statusCode ?? err?.response?.statusCode;
      if (code === 404) {
        await coreApi.createNamespacedSecret(namespace, body);
        return true;
      }
      throw err;
    }
  }

  async updateDeploymentEnv(options: UpdateDeploymentEnvOptions) {
    this.ensureKubeConfig();

    const cleanNamespace = String(options.namespace || '').trim();
    const cleanName = String(options.deploymentName || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Deployment name is required');
    }

    const { envList, secretData } = this.buildEnvAndSecret(cleanName, options.env, {
      HOST: '0.0.0.0',
      FORCE_COLOR: '1'
    });
    // Upsert (or clear) the per-deployment env Secret before patching so the
    // secretKeyRef entries resolve. An empty secret set removes the Secret.
    const secretChanged = await this.upsertEnvSecret(cleanNamespace, cleanName, secretData);

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

      const existing = await appsApi.readNamespacedDeployment(cleanName, cleanNamespace);

      const containers = existing.body.spec?.template?.spec?.containers;

      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Deployment "${cleanName}" has no containers`
        });
      }

      // Target the app container the way updateDeploymentImage does, by name,
      // so env and image can never land on different containers. Falls back to
      // the first container for deployments imported from outside Orchard.
      const namedIndex = containers.findIndex((c) => c.name === cleanName);
      const containerIndex = namedIndex === -1 ? 0 : namedIndex;

      // The patch below stamps an annotation, which rewrites the pod template
      // and rolls the deployment. Callers that re-assert the stored env on
      // every rebuild would otherwise restart pods a second time for nothing,
      // so a genuinely unchanged env is a no-op.
      const hash = envHash(envList);
      if (envListsEqual(containers[containerIndex].env ?? [], envList) && !secretChanged) {
        if (existing.body.metadata?.annotations?.[ENV_HASH_ANNOTATION] !== hash) {
          await appsApi.patchNamespacedDeployment(
            cleanName,
            cleanNamespace,
            [envHashAnnotationPatch(existing.body.metadata, hash)],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { headers: { 'Content-Type': 'application/json-patch+json' } }
          );
        }
        return {
          success: true,
          deployment: cleanName,
          namespace: cleanNamespace,
          env: envList,
          unchanged: true
        };
      }

      // JSON Patch, not strategic merge: a merge patch unions env by name and
      // can never remove a key. See buildEnvReplacePatch.
      const patch = [
        envHashAnnotationPatch(existing.body.metadata, hash),
        ...buildEnvReplacePatch({
          containerIndex,
          env: envList,
          stamp: new Date().toISOString(),
          templateMetadata: existing.body.spec?.template?.metadata
        })
      ];

      await appsApi.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/json-patch+json' }
        }
      );

      return {
        success: true,
        deployment: cleanName,
        namespace: cleanNamespace,
        env: envList
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update deployment environment',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to update deployment environment',
        message: error.message
      });
    }
  }

  async updateDeploymentHealthCheck(options: {
    namespace: string;
    deploymentName: string;
    enabled: boolean;
    type: string;
    path?: string | null;
    port?: number | null;
    command?: string | null;
    execCommand?: string[] | null;
    livenessEnabled: boolean;
    readinessEnabled: boolean;
    startupEnabled: boolean;
    interval: number;
    timeout: number;
    retries: number;
    startupFailureThreshold: number;
  }) {
    const cleanName = String(options.deploymentName || '').trim();
    const cleanNamespace = String(options.namespace || '').trim();

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const existing = await appsApi.readNamespacedDeployment(cleanName, cleanNamespace);

      const containers = existing.body.spec?.template?.spec?.containers;
      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Deployment "${cleanName}" has no containers`
        });
      }

      const containerName = containers[0].name;

      const {
        liveness: livenessProbe,
        readiness: readinessProbe,
        startup: startupProbe
      } = probesFor(options);

      // The patch stamps an annotation, so every call that reaches the API
      // server restarts the pods. Callers re-apply on every rebuild to heal
      // drift, and the common case is no drift at all.
      const live = containers[0];
      const unchanged =
        probesEqual(live.livenessProbe, livenessProbe) &&
        probesEqual(live.readinessProbe, readinessProbe) &&
        probesEqual(live.startupProbe, startupProbe);

      if (unchanged) {
        return {
          success: true,
          deployment: cleanName,
          namespace: cleanNamespace
        };
      }

      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'orchard.my/health-check-updated-at': new Date().toISOString()
              }
            },
            spec: {
              containers: [
                {
                  name: containerName,
                  livenessProbe,
                  readinessProbe,
                  startupProbe
                }
              ]
            }
          }
        }
      };

      await appsApi.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' }
        }
      );

      return {
        success: true,
        deployment: cleanName,
        namespace: cleanNamespace
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }

      throw new BadRequestException({
        error: 'Failed to update deployment health check',
        message: error.response?.body?.message || error.message
      });
    }
  }

  private async managedVolumeNames(deployment: k8s.V1Deployment): Promise<Set<string>> {
    const names = recordedVolumeNames(deployment);
    if (
      deployment.spec?.template?.metadata?.annotations?.[MANAGED_VOLUMES_ANNOTATION] !== undefined
    ) {
      return names;
    }
    const spec = deployment.spec?.template?.spec;
    const mounts = new Set((spec?.containers?.[0]?.volumeMounts ?? []).map((mount) => mount.name));
    const claims = new Map<string, string>();
    for (const volume of spec?.volumes ?? []) {
      const claimName = volume.persistentVolumeClaim?.claimName;
      if (claimName && mounts.has(volume.name)) claims.set(claimName, volume.name);
    }
    if (claims.size === 0) return names;
    const mirrored = await this.prisma.k8sObject.findMany({
      where: {
        kind: 'PersistentVolumeClaim',
        namespace: deployment.metadata!.namespace!,
        name: { in: [...claims.keys()] }
      },
      select: { name: true, manifest: true }
    });
    for (const row of mirrored) {
      const labels = (row.manifest as k8s.V1PersistentVolumeClaim)?.metadata?.labels;
      if (labels?.['app.kubernetes.io/managed-by'] === 'orchard') names.add(claims.get(row.name)!);
    }
    return names;
  }

  private async mirroredDeployment(
    name: string,
    namespace: string
  ): Promise<k8s.V1Deployment | null> {
    const row = await this.prisma.k8sObject.findFirst({
      where: { kind: 'Deployment', apiVersion: 'apps/v1', namespace, name },
      select: { manifest: true }
    });
    return (row?.manifest as k8s.V1Deployment | undefined) ?? null;
  }

  /**
   * The volume set the mirrored Deployment is running with.
   *
   * Returned as a canonical signature rather than raw objects so a caller can
   * ask the only question that matters: does the cluster match what the
   * database says it should be? Null means the mirror has no Deployment yet,
   * which is a different answer from "it exists with no volumes".
   */
  async getDeploymentVolumeSignature(
    deploymentName: string,
    namespace: string,
    desiredNames: string[] = []
  ): Promise<string | null> {
    const existing = await this.mirroredDeployment(
      String(deploymentName || '').trim(),
      String(namespace || '').trim()
    );
    if (!existing) return null;
    const spec = existing.spec?.template?.spec;
    const mounts = spec?.containers?.[0]?.volumeMounts ?? [];
    const managedNames = await this.managedVolumeNames(existing);
    for (const name of desiredNames) managedNames.add(name);
    const mountByName = new Map(mounts.map((m) => [m.name, m]));

    return (spec?.volumes ?? [])
      .filter((vol) => managedNames.has(vol.name) && mountByName.has(vol.name))
      .map((vol) => {
        const mount = mountByName.get(vol.name);
        const claim = vol.persistentVolumeClaim?.claimName ?? '';
        return [
          vol.name,
          claim ? `pvc:${claim}` : 'emptyDir',
          mount?.mountPath ?? '',
          mount?.readOnly ? 'ro' : 'rw'
        ].join('|');
      })
      .sort()
      .join(',');
  }

  /** The same signature, computed from what the database says should be running. */
  static volumeSignature(
    volumes: {
      name: string;
      type: 'pvc' | 'hostPath' | 'emptyDir';
      mountPath: string;
      pvcName?: string | null;
      readOnly?: boolean;
    }[]
  ): string {
    return (volumes ?? [])
      .map((vol) =>
        [
          vol.name,
          vol.type === 'pvc' ? `pvc:${vol.pvcName?.trim() || vol.name}` : 'emptyDir',
          vol.mountPath,
          vol.readOnly ? 'ro' : 'rw'
        ].join('|')
      )
      .sort()
      .join(',');
  }

  async updateDeploymentVolumes(options: {
    namespace: string;
    deploymentName: string;
    volumes: {
      name: string;
      type: 'pvc' | 'hostPath' | 'emptyDir';
      mountPath: string;
      pvcName?: string | null;
      storageSize?: string | null;
      hostPath?: string | null;
      readOnly?: boolean;
    }[];
    deployStrategy?: 'rollingUpdate' | 'recreate';
  }) {
    this.ensureKubeConfig();

    const cleanNamespace = String(options.namespace || '').trim();
    const cleanName = String(options.deploymentName || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Deployment name is required');
    }

    const volumesList = Array.isArray(options.volumes) ? options.volumes : [];

    // Create PVCs in Kubernetes before referencing them. Surface the API's own
    // reason on failure; the client library's HttpError message is a useless
    // generic string.
    for (const vol of volumesList) {
      if (vol.type === 'pvc') {
        try {
          await this.createPVC(cleanNamespace, resolvePvcClaimName(vol), vol.storageSize || '1Gi');
        } catch (error) {
          throw new BadRequestException({
            error: 'Failed to create volume',
            message: error.response?.body?.message || error.message
          });
        }
      }
    }

    const volumeMounts: k8s.V1VolumeMount[] = volumesList.map((vol) => ({
      name: vol.name,
      mountPath: vol.mountPath,
      readOnly: Boolean(vol.readOnly)
    }));

    const k8sVolumes: k8s.V1Volume[] = volumesList.map((vol) => {
      const volume: k8s.V1Volume = {
        name: vol.name
      };

      if (vol.type === 'hostPath') {
        throw new Error("hostPath volumes aren't permitted");
      }

      if (vol.type === 'pvc') {
        volume.persistentVolumeClaim = {
          claimName: resolvePvcClaimName(vol)
        };
      } else {
        volume.emptyDir = {};
      }

      return volume;
    });

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

      const existing = await appsApi.readNamespacedDeployment(cleanName, cleanNamespace);

      const containers = existing.body.spec?.template?.spec?.containers;

      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Deployment "${cleanName}" has no containers`
        });
      }

      const managedNames = await this.managedVolumeNames(existing.body);
      const desiredNames = new Set(volumesList.map((volume) => volume.name));
      for (const volume of existing.body.spec?.template?.spec?.volumes ?? []) {
        if (!desiredNames.has(volume.name) || managedNames.has(volume.name)) continue;
        const desired = k8sVolumes.find((candidate) => candidate.name === volume.name);
        const mount = containers[0].volumeMounts?.find(
          (candidate) => candidate.name === volume.name
        );
        const desiredMount = volumeMounts.find((candidate) => candidate.name === volume.name);
        if (
          JSON.stringify(volume) === JSON.stringify(desired) &&
          mount &&
          desiredMount &&
          isDeepStrictEqual(
            { ...mount, readOnly: Boolean(mount.readOnly) },
            { ...desiredMount, readOnly: Boolean(desiredMount.readOnly) }
          )
        )
          managedNames.add(volume.name);
      }
      const requestedStrategy =
        options.deployStrategy === 'recreate'
          ? { type: 'Recreate', rollingUpdate: null as any }
          : rollingUpdateStrategy();
      const replacement = buildVolumeReplacePatch({
        deployment: existing.body,
        managedNames,
        volumes: k8sVolumes,
        mounts: volumeMounts,
        strategy: requestedStrategy,
        stamp: new Date().toISOString()
      });
      const effectiveStrategy =
        replacement.strategy.type === 'Recreate' ? 'recreate' : 'rollingUpdate';
      const patch = replacement.operations;

      await appsApi.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/json-patch+json' }
        }
      );

      return {
        success: true,
        deployment: cleanName,
        namespace: cleanNamespace,
        volumes: volumesList,
        deployStrategy: effectiveStrategy
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update deployment volumes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to update deployment volumes',
        message: error.message
      });
    }
  }

  async deleteDeployment(deploymentName: string, namespace = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanName = String(deploymentName || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Deployment name is required');
    }

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      try {
        await appsApi.deleteNamespacedDeployment(cleanName, cleanNamespace);
      } catch (deploymentError) {
        if (deploymentError.response?.statusCode !== 404) {
          throw deploymentError;
        }
      }

      try {
        await coreApi.deleteNamespacedService(cleanName, cleanNamespace);
      } catch (serviceError) {
        if (serviceError.response?.statusCode !== 404) {
          throw serviceError;
        }
      }

      // Clean up the per-deployment env Secret so it doesn't orphan.
      await this.deleteEnvSecret(coreApi, cleanNamespace, `${cleanName}-env`);

      // An orphaned PodDisruptionBudget matches nothing, but it still shows up
      // as a permanently unsatisfied budget on every drain report.
      await this.kc
        .makeApiClient(k8s.PolicyV1Api)
        .deleteNamespacedPodDisruptionBudget(cleanName, cleanNamespace)
        .catch(() => {});

      return {
        success: true,
        deployment: cleanName,
        namespace: cleanNamespace
      };
    } catch (error) {
      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete deployment',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete deployment',
        message: error.message
      });
    }
  }

  async syncNamespaceToDatabase(namespace: string) {
    this.ensureKubeConfig();

    console.log('[Sync] Syncing namespace to database:', namespace);

    const scope = await resolveNamespaceScope(this.prisma, namespace);

    if (!scope) {
      throw new NotFoundException({
        error: 'Project not found',
        message: `No project found with namespace ${namespace}`
      });
    }

    const project = { id: scope.projectId };

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const deploymentList = await appsApi.listNamespacedDeployment(namespace);

      let adoptedCount = 0;
      for (const k8sDeployment of deploymentList.body.items) {
        if (!isExternalDeployment(k8sDeployment)) continue;
        const deploymentName = k8sDeployment.metadata.name;
        const existingRecord = await this.prisma.deployment.findFirst({
          where: { projectId: project.id, namespace, name: deploymentName },
          select: { id: true }
        });
        if (existingRecord) continue;

        const image = k8sDeployment.spec.template.spec.containers[0]?.image;
        const specReplicas = k8sDeployment.spec.replicas ?? 1;
        const replicas = specReplicas > 0 ? specReplicas : 1;
        const availableReplicas = k8sDeployment.status?.availableReplicas || 0;
        const unavailableReplicas = k8sDeployment.status?.unavailableReplicas || 0;

        let status = 'pending';
        if (specReplicas === 0) {
          status = 'stopped';
        } else if (availableReplicas === replicas && replicas > 0) {
          status = 'running';
        } else if (availableReplicas > 0 && availableReplicas < replicas) {
          status = 'scaling';
        } else if (availableReplicas === 0 && unavailableReplicas > 0) {
          status = 'failed';
        } else {
          status = 'pending';
        }

        // The namespace being synced belongs to one environment. Adopting
        // its workloads into the default one would file them under the wrong
        // namespace the moment anything writes the record back.
        const defaultEnv = scope.environmentId
          ? { id: scope.environmentId }
          : await this.prisma.environment.findFirst({
              where: { projectId: project.id, isDefault: true },
              select: { id: true }
            });
        const deploymentRecord = await this.prisma.deployment.create({
          data: {
            projectId: project.id,
            environmentId: defaultEnv?.id ?? null,
            name: deploymentName,
            namespace,
            image,
            replicas,
            stopped: specReplicas === 0,
            status
          }
        });
        adoptedCount += 1;

        const containerEnv = k8sDeployment.spec.template.spec.containers?.[0]?.env || [];
        const adopted = containerEnv
          .filter((envVar) => envVar?.name && envVar.value !== undefined && envVar.value !== null)
          .map((envVar) => ({
            deploymentId: deploymentRecord.id,
            key: String(envVar.name),
            value: String(envVar.value)
          }));
        if (adopted.length > 0) {
          await this.prisma.deploymentEnvVar.createMany({ data: adopted, skipDuplicates: true });
        }
        const referenced = containerEnv.filter((envVar) => envVar?.name && envVar.valueFrom);
        if (referenced.length > 0) {
          this.logger.warn(
            `[Sync] ${deploymentName}: ${referenced.length} env var(s) resolve through valueFrom and weren't imported: ${referenced
              .map((envVar) => envVar.name)
              .join(', ')}`
          );
        }

        try {
          const serviceResponse = await coreApi.readNamespacedService(deploymentName, namespace);
          const containerPorts = k8sDeployment.spec.template.spec.containers?.[0]?.ports || [];
          const servicePorts = serviceResponse.body.spec?.ports || [];
          const serviceTypeRaw = serviceResponse.body.spec?.type || 'ClusterIP';
          const serviceTypeValue =
            serviceTypeRaw === 'ClusterIP' ? ServiceType.internal : ServiceType.external;
          const ingressStatus = serviceResponse.body.status?.loadBalancer?.ingress?.[0];
          let externalIp = ingressStatus?.ip || ingressStatus?.hostname || null;
          if (!externalIp && serviceTypeRaw === 'NodePort') {
            externalIp = await this.getDefaultNodeIp(coreApi);
          }

          const rawPorts: DeploymentPortInput[] = servicePorts.map((servicePort, index) => {
            const resolvedServicePort = Number(servicePort.port);
            if (!Number.isInteger(resolvedServicePort) || resolvedServicePort <= 0) {
              return {
                name: servicePort.name ?? `port-${index + 1}`,
                containerPort: resolvedServicePort > 0 ? resolvedServicePort : 80,
                servicePort: resolvedServicePort > 0 ? resolvedServicePort : 80,
                protocol: servicePort.protocol ?? 'TCP',
                nodePort:
                  typeof servicePort.nodePort === 'number' && Number.isInteger(servicePort.nodePort)
                    ? servicePort.nodePort
                    : undefined
              };
            }

            let resolvedContainerPort = 0;
            const targetPort = servicePort.targetPort;
            if (typeof targetPort === 'number') {
              resolvedContainerPort = targetPort;
            } else if (typeof targetPort === 'string') {
              const numericTarget = Number.parseInt(targetPort, 10);
              if (Number.isInteger(numericTarget)) {
                resolvedContainerPort = numericTarget;
              } else {
                const matchByTargetName = containerPorts.find((port) => port.name === targetPort);
                if (matchByTargetName?.containerPort) {
                  resolvedContainerPort = matchByTargetName.containerPort;
                }
              }
            }

            if (!resolvedContainerPort) {
              const matchByName = containerPorts.find((port) => port.name === servicePort.name);
              if (matchByName?.containerPort) {
                resolvedContainerPort = matchByName.containerPort;
              }
            }

            if (!resolvedContainerPort) {
              resolvedContainerPort = resolvedServicePort;
            }

            return {
              name: servicePort.name ?? `port-${index + 1}`,
              containerPort: resolvedContainerPort,
              servicePort: resolvedServicePort,
              protocol: servicePort.protocol ?? 'TCP',
              nodePort:
                typeof servicePort.nodePort === 'number' && Number.isInteger(servicePort.nodePort)
                  ? servicePort.nodePort
                  : undefined
            };
          });

          const sanitizedServicePorts = sanitizePortEntries(rawPorts);

          const serviceRecord = await this.prisma.service.upsert({
            where: {
              deploymentId_name: {
                deploymentId: deploymentRecord.id,
                name: deploymentName
              }
            },
            update: {
              port: sanitizedServicePorts[0].servicePort,
              targetPort: sanitizedServicePorts[0].containerPort,
              protocol: sanitizedServicePorts[0].protocol,
              type: serviceTypeValue,
              externalIp,
              nodePort:
                sanitizedServicePorts[0].nodePort !== undefined &&
                sanitizedServicePorts[0].nodePort !== null
                  ? sanitizedServicePorts[0].nodePort
                  : null
            },
            create: {
              deploymentId: deploymentRecord.id,
              name: deploymentName,
              type: serviceTypeValue,
              port: sanitizedServicePorts[0].servicePort,
              targetPort: sanitizedServicePorts[0].containerPort,
              protocol: sanitizedServicePorts[0].protocol,
              externalIp,
              nodePort:
                sanitizedServicePorts[0].nodePort !== undefined &&
                sanitizedServicePorts[0].nodePort !== null
                  ? sanitizedServicePorts[0].nodePort
                  : null
            }
          });

          const priorPublic = snapshotPublicPortState(
            await this.prisma.servicePort.findMany({
              where: { serviceId: serviceRecord.id },
              select: { port: true, protocol: true, publicEnabled: true, publicPort: true }
            })
          );

          await this.prisma.servicePort.deleteMany({
            where: { serviceId: serviceRecord.id }
          });

          await this.prisma.servicePort.createMany({
            data: sanitizedServicePorts.map((port) => {
              const prior = priorPublic.get(publicPortKey(port.servicePort, port.protocol));
              return {
                serviceId: serviceRecord.id,
                name: port.name,
                port: port.servicePort,
                targetPort: port.containerPort,
                protocol: port.protocol,
                nodePort:
                  port.nodePort !== undefined && port.nodePort !== null ? port.nodePort : null,
                publicEnabled: prior ? prior.publicEnabled : false,
                publicPort: prior ? prior.publicPort : null
              };
            })
          });
        } catch (serviceError) {
          if (serviceError.response?.statusCode !== 404) {
            console.error('[Sync] Service sync error:', {
              message: serviceError.message,
              code: serviceError.code,
              statusCode: serviceError.response?.statusCode
            });
          }
        }
      }

      console.log('[Sync] Successfully synced namespace:', namespace);

      return {
        success: true,
        namespace,
        projectId: project.id,
        deploymentsCount: deploymentList.body.items.length,
        adoptedCount
      };
    } catch (error) {
      console.error('[Sync] Error syncing namespace:', error);
      throw new BadRequestException({
        error: 'Failed to sync namespace',
        message: error.message
      });
    }
  }

  async restartDeployment(
    deploymentName: string,
    namespace = 'midnight-staging',
    resources?: PodSizing
  ) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanDeploymentName = String(deploymentName).trim();

    console.log(
      '[API] Restarting deployment:',
      cleanDeploymentName,
      'in namespace:',
      cleanNamespace
    );

    try {
      const api = this.kc.makeApiClient(k8s.AppsV1Api);

      const patch = {
        ...(resources ? noLimitsMetadataPatch(resources) : {}),
        spec: {
          template: {
            metadata: {
              annotations: {
                'kubectl.kubernetes.io/restartedAt': new Date().toISOString()
              }
            },
            ...(resources
              ? {
                  spec: {
                    containers: [
                      { name: cleanDeploymentName, resources: appResourcesPatch(resources) }
                    ]
                  }
                }
              : {})
          }
        }
      };

      await api.patchNamespacedDeployment(
        cleanDeploymentName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' }
        }
      );

      console.log('[API] Successfully restarted deployment:', cleanDeploymentName);

      return {
        success: true,
        deployment: cleanDeploymentName,
        namespace: cleanNamespace,
        restartedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error restarting deployment:', error);

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanDeploymentName} not found in namespace ${cleanNamespace}`
        });
      }

      throw new BadRequestException({
        error: 'Failed to restart deployment',
        message: error.message
      });
    }
  }

  async patchDeploymentReplicas(deploymentName: string, namespace: string, replicas: number) {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.AppsV1Api);
    await api.patchNamespacedDeployment(
      deploymentName,
      namespace,
      { spec: { replicas } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  }

  async scaleDeployment(deploymentName: string, namespace: string, replicas: number) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanDeploymentName = String(deploymentName).trim();

    if (replicas < 0 || !Number.isInteger(replicas)) {
      throw new BadRequestException({
        error: 'Invalid replicas',
        message: 'Replicas must be a non-negative integer'
      });
    }

    console.log(
      '[API] Scaling deployment:',
      cleanDeploymentName,
      'to',
      replicas,
      'replicas in namespace:',
      cleanNamespace
    );

    try {
      const api = this.kc.makeApiClient(k8s.AppsV1Api);

      const patch = {
        spec: {
          replicas
        }
      };

      const result = await api.patchNamespacedDeployment(
        cleanDeploymentName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' }
        }
      );

      console.log(
        '[API] Successfully scaled deployment:',
        cleanDeploymentName,
        'to',
        replicas,
        'replicas'
      );

      const project = await this.prisma.project.findFirst({
        where: { namespace: cleanNamespace }
      });

      if (project) {
        await this.prisma.deployment.updateMany({
          where: { projectId: project.id, name: cleanDeploymentName },
          data: { replicas }
        });

        console.log('[API] Updated deployment replicas in database');
      }

      return {
        success: true,
        deployment: cleanDeploymentName,
        namespace: cleanNamespace,
        replicas: result.body.spec.replicas,
        currentReplicas: result.body.status.replicas,
        readyReplicas: result.body.status.readyReplicas
      };
    } catch (error) {
      console.error('Error scaling deployment:', error);

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanDeploymentName} not found in namespace ${cleanNamespace}`
        });
      }

      throw new BadRequestException({
        error: 'Failed to scale deployment',
        message: error.message
      });
    }
  }

  // Patch only the `spec.strategy` of an existing Deployment. Used when the
  // user toggles RollingUpdate ↔ Recreate without changing image/volumes.
  async updateDeploymentStrategy(
    deploymentName: string,
    namespace: string,
    strategy: DeployStrategy
  ) {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.AppsV1Api);
    const cleanName = String(deploymentName).trim();
    const cleanNamespace = String(namespace).trim();

    // Setting `rollingUpdate: null` clears any prior rolling config when
    // switching to Recreate. K8s rejects strategy.rollingUpdate alongside
    // type=Recreate, so we have to actively wipe it. Blue/green is orchestrated
    // above Kubernetes, so the blue object simply rolls.
    const body = k8sStrategyFor(strategy);

    try {
      await api.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        { spec: { strategy: body } },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }
      throw new BadRequestException({
        error: 'Failed to update deployment strategy',
        message: error.message
      });
    }

    return { success: true, deployment: cleanName, namespace: cleanNamespace, strategy };
  }

  // imagePullPolicy lives in the pod template, so patching it changes the
  // template hash and the Deployment controller rolls a new ReplicaSet on its
  // own. No restartedAt annotation needed, and patching it to the value it
  // already has is correctly a no-op.
  async updateDeploymentPullPolicy(
    deploymentName: string,
    namespace: string,
    policy: 'Always' | 'IfNotPresent'
  ) {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.AppsV1Api);
    const cleanName = String(deploymentName).trim();
    const cleanNamespace = String(namespace).trim();

    // The tenant container is named after the deployment (see createDeployment),
    // which is the same assumption updateDeploymentImage makes. Strategic merge
    // patch keys containers by name, so a wrong name would silently append a
    // second container rather than fail.
    const patch = {
      spec: {
        template: {
          spec: {
            containers: [{ name: cleanName, imagePullPolicy: policy }]
          }
        }
      }
    };

    try {
      await api.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }
      throw new BadRequestException({
        error: 'Failed to update image pull policy',
        message: error.message
      });
    }

    return { success: true, deployment: cleanName, namespace: cleanNamespace, policy };
  }

  async updateDeploymentDevices(deploymentName: string, namespace: string, devices: DeviceRequest) {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.AppsV1Api);
    const cleanName = String(deploymentName).trim();
    const cleanNamespace = String(namespace).trim();

    try {
      const live = await api.readNamespacedDeployment(cleanName, cleanNamespace);
      const container = live.body.spec?.template?.spec?.containers?.find(
        (c) => c.name === cleanName
      );
      if (!container) {
        throw new NotFoundException(`Deployment ${cleanName} has no app container`);
      }
      const attaching = Object.keys(devices).length > 0;
      const patch = {
        spec: {
          ...(attaching && live.body.spec?.strategy?.type !== 'Recreate'
            ? { strategy: { type: 'Recreate', rollingUpdate: null } }
            : {}),
          template: {
            spec: {
              ...deviceRuntimeClassPatch(Object.keys(devices)),
              containers: [
                {
                  name: cleanName,
                  resources: deviceResourcesPatch(
                    devices,
                    liveDeviceQuantities(container.resources)
                  )
                }
              ]
            }
          }
        }
      };
      await api.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }
      throw new BadRequestException({
        error: 'Failed to update devices',
        message: error.body?.message ?? error.message
      });
    }

    return { success: true, deployment: cleanName, namespace: cleanNamespace, devices };
  }

  async updateDeploymentPullSecrets(
    deploymentName: string,
    namespace: string,
    secrets: { name: string }[]
  ) {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.AppsV1Api);
    const cleanName = String(deploymentName).trim();
    const cleanNamespace = String(namespace).trim();

    const patch = {
      spec: {
        template: {
          spec: {
            imagePullSecrets: secrets.length ? secrets : null
          }
        }
      }
    };

    try {
      await api.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }
      throw new BadRequestException({
        error: 'Failed to update image pull secrets',
        message: error.message
      });
    }

    return { success: true, deployment: cleanName, namespace: cleanNamespace };
  }

  async readDeploymentPullSecrets(deploymentName: string, namespace: string): Promise<string[]> {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.AppsV1Api);
    const live = await api.readNamespacedDeployment(
      String(deploymentName).trim(),
      String(namespace).trim()
    );
    return (live.body.spec?.template?.spec?.imagePullSecrets ?? [])
      .map((s) => s.name ?? '')
      .filter(Boolean);
  }

  async upsertDockerConfigSecret(
    namespace: string,
    name: string,
    auths: Record<string, { username: string; password: string; auth: string }> | null
  ): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    if (!auths || Object.keys(auths).length === 0) {
      await coreApi.deleteNamespacedSecret(name, namespace).catch((err: any) => {
        const code = err?.statusCode ?? err?.response?.statusCode;
        if (code !== 404) throw err;
      });
      return;
    }
    const body: k8s.V1Secret = {
      metadata: {
        name,
        labels: { 'app.kubernetes.io/managed-by': 'orchard' }
      },
      type: 'kubernetes.io/dockerconfigjson',
      data: {
        '.dockerconfigjson': Buffer.from(JSON.stringify({ auths })).toString('base64')
      }
    };
    const write = async () => {
      try {
        const existing = await coreApi.readNamespacedSecret(name, namespace);
        body.metadata!.resourceVersion = existing.body.metadata?.resourceVersion;
        await coreApi.replaceNamespacedSecret(name, namespace, body);
      } catch (err: any) {
        const code = err?.statusCode ?? err?.response?.statusCode;
        if (code !== 404) throw err;
        await coreApi.createNamespacedSecret(namespace, body);
      }
    };
    try {
      await write();
    } catch (err: any) {
      const code = err?.statusCode ?? err?.response?.statusCode;
      if (code !== 403) throw err;
      await this.namespaces.bootstrapTenantSecretsRbac(namespace);
      await write();
    }
  }

  /**
   * Apply a changed start command without a rebuild.
   *
   * The args live in the pod template, so patching them rolls a new ReplicaSet
   * the same way a pull-policy change does, and unlike every other build
   * setting, a start command on a Dockerfile or image-source deployment needs
   * no builder at all, so it takes effect in seconds instead of a build.
   *
   * `args` must be an explicit null to clear: an omitted key would merge away
   * to "leave whatever is running", which is exactly wrong when the user just
   * emptied the field to get the image's own CMD back.
   */
  async updateDeploymentStartArgs(
    deploymentName: string,
    namespace: string,
    args: string[] | null
  ) {
    this.ensureKubeConfig();
    const api = this.kc.makeApiClient(k8s.AppsV1Api);
    const cleanName = String(deploymentName).trim();
    const cleanNamespace = String(namespace).trim();

    const patch = {
      spec: {
        template: {
          spec: {
            containers: [{ name: cleanName, args: args?.length ? args : null }]
          }
        }
      }
    };

    try {
      await api.patchNamespacedDeployment(
        cleanName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanName} not found in namespace ${cleanNamespace}`
        });
      }
      throw new BadRequestException({
        error: 'Failed to update start command',
        message: error.message
      });
    }

    return { success: true, deployment: cleanName, namespace: cleanNamespace };
  }

  async updateDeploymentImage(
    deploymentName: string,
    namespace: string,
    image: string,
    healthCheck?: CreateDeploymentOptions['healthCheck'],
    // Tri-state on purpose: undefined leaves the running args alone (callers
    // that only swap an image), an array sets them, null clears them back to
    // the image's CMD.
    args?: string[] | null,
    resources?: PodSizing
  ) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanDeploymentName = String(deploymentName).trim();
    const cleanImage = String(image).trim();

    console.log(
      '[API] Updating deployment image:',
      cleanDeploymentName,
      'to',
      cleanImage,
      'in namespace:',
      cleanNamespace
    );

    try {
      const api = this.kc.makeApiClient(k8s.AppsV1Api);

      // A rolling update cannot hand a ReadWriteOnce PVC from the old pod to
      // the new one (Multi-Attach when they land on different nodes), so a
      // redeploy must roll out with Recreate whenever the pod mounts a PVC.
      // Objects created or volume-edited today already carry Recreate, but
      // this is the hot path every redeploy goes through, so self-heal any
      // live object that still has RollingUpdate + PVC from before those
      // guards existed.
      let forceRecreate = false;
      let strategy: k8s.V1DeploymentStrategy | undefined;
      let liveDevices: string[] | null = null;
      try {
        const live = await api.readNamespacedDeployment(cleanDeploymentName, cleanNamespace);
        const liveContainer = live.body.spec?.template?.spec?.containers?.find(
          (c) => c.name === cleanDeploymentName
        );
        liveDevices = Object.keys(liveDeviceQuantities(liveContainer?.resources));
        const hasPvc = (live.body.spec?.template?.spec?.volumes ?? []).some(
          (v) => v.persistentVolumeClaim?.claimName
        );
        const pinned = hasPvc || liveDevices.length > 0;
        forceRecreate = pinned && live.body.spec?.strategy?.type !== 'Recreate';
        if (forceRecreate) {
          strategy = { type: 'Recreate', rollingUpdate: null as any };
        } else if (!pinned && live.body.spec?.strategy?.type !== 'Recreate') {
          strategy = rollingUpdateStrategy();
        }
      } catch {
        // If the read fails the patch below will fail too and report properly.
      }
      const runtimeClassPatch =
        liveDevices === null
          ? {}
          : { runtimeClassName: deviceRuntimeClassName(liveDevices) ?? null };

      const containerPatch = {
        name: cleanDeploymentName,
        image: cleanImage,
        securityContext: hardenedSecurityContext(),
        ...(args === undefined ? {} : { args: args?.length ? args : null }),
        ...(resources ? { resources: appResourcesPatch(resources) } : {}),
        ...(healthCheck
          ? {
              livenessProbe:
                healthCheck.enabled && healthCheck.livenessEnabled
                  ? probePatch(livenessProbe(healthCheck))
                  : null,
              readinessProbe:
                healthCheck.enabled && healthCheck.readinessEnabled
                  ? probePatch(readinessProbe(healthCheck))
                  : null,
              startupProbe:
                healthCheck.enabled && healthCheck.startupEnabled
                  ? probePatch(startupProbe(healthCheck))
                  : null
            }
          : {})
      };

      const patch = {
        ...(resources ? noLimitsMetadataPatch(resources) : {}),
        spec: {
          ...(strategy ? { strategy } : {}),
          minReadySeconds: ROLLOUT_MIN_READY_SECONDS,
          progressDeadlineSeconds: ROLLOUT_PROGRESS_DEADLINE_SECONDS,
          template: {
            ...(tenantPodAnnotations()
              ? { metadata: { annotations: tenantPodAnnotations() } }
              : {}),
            spec: {
              ...runtimeClassPatch,
              containers: [containerPatch]
            }
          }
        }
      };

      if (forceRecreate) {
        console.log(
          '[API] PVC volume detected with RollingUpdate strategy, switching to Recreate:',
          cleanDeploymentName
        );
      }

      await api.patchNamespacedDeployment(
        cleanDeploymentName,
        cleanNamespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' }
        }
      );

      console.log(
        '[API] Successfully updated deployment image:',
        cleanDeploymentName,
        'to',
        cleanImage
      );

      const project = await this.prisma.project.findFirst({
        where: { namespace: cleanNamespace }
      });

      if (project) {
        const deployment = await this.prisma.deployment.findFirst({
          where: { projectId: project.id, name: cleanDeploymentName }
        });

        if (deployment) {
          await this.prisma.deployment.update({
            where: { id: deployment.id },
            data: {
              image: cleanImage,
              ...(forceRecreate ? { deployStrategy: 'recreate' } : {})
            }
          });
        }
      }

      return {
        success: true,
        deployment: cleanDeploymentName,
        namespace: cleanNamespace,
        image: cleanImage
      };
    } catch (error) {
      console.error('Error updating deployment image:', error);

      if (k8sHttpException(error)?.getStatus() === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${cleanDeploymentName} not found in namespace ${cleanNamespace}`
        });
      }

      throw new BadRequestException({
        error: 'Failed to update deployment image',
        message: k8sErrorMessage(error)
      });
    }
  }

  /**
   * Block until the rollout that began at `sinceMs` has landed or provably
   * cannot. Polls the live Deployment and its pods rather than the mirror, so
   * it works for the transient green object too, which no mirror row tracks.
   */
  async waitForRollout(
    deploymentName: string,
    namespace: string,
    opts: {
      sinceMs: number;
      timeoutMs?: number;
      pollMs?: number;
      onProgress?: (detail: string) => void;
    }
  ): Promise<RolloutAssessment> {
    this.ensureKubeConfig();
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const cleanName = String(deploymentName).trim();
    const cleanNamespace = String(namespace).trim();
    const timeoutMs = opts.timeoutMs ?? ROLLOUT_GATE_TIMEOUT_MS;
    const pollMs = opts.pollMs ?? ROLLOUT_GATE_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    let lastDetail = '';
    for (;;) {
      let dep: k8s.V1Deployment;
      try {
        dep = (await appsApi.readNamespacedDeployment(cleanName, cleanNamespace)).body;
      } catch (error) {
        if (error?.response?.statusCode === 404) {
          return { state: 'failed', reason: 'the Deployment disappeared during the rollout' };
        }
        throw error;
      }
      const pods = (
        await coreApi.listNamespacedPod(
          cleanNamespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `app.kubernetes.io/name=${cleanName}`
        )
      ).body.items;
      const verdict = assessRollout(dep, pods, opts.sinceMs);
      if (verdict.state !== 'progressing') return verdict;
      if (verdict.detail !== lastDetail) {
        lastDetail = verdict.detail;
        opts.onProgress?.(verdict.detail);
      }
      if (Date.now() >= deadline) {
        return {
          state: 'failed',
          reason: `pods weren't ready after ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes (${verdict.detail})`
        };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Blue/green with a transient green: clone blue with the candidate image,
   * wait for it to be ready, move the Service's selector to it, then bring blue
   * to the same image behind the scenes and move the selector back. Traffic
   * only ever points at pods that have already proved ready, and the canonical
   * object keeps its name, so nothing else in Orchard has to learn about slots.
   */
  async deployBlueGreen(opts: {
    deploymentName: string;
    namespace: string;
    image: string;
    healthCheck?: CreateDeploymentOptions['healthCheck'];
    args?: string[] | null;
    resources?: PodSizing;
    timeoutMs?: number;
    pollMs?: number;
    log?: (line: string) => void;
  }): Promise<{ ok: true; settled: boolean } | { ok: false; reason: string }> {
    this.ensureKubeConfig();
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const name = String(opts.deploymentName).trim();
    const namespace = String(opts.namespace).trim();
    const green = greenName(name);
    const log = opts.log ?? (() => {});

    const blue = (await appsApi.readNamespacedDeployment(name, namespace)).body;
    const blocker = blueGreenBlocker(blue);
    if (blocker) return { ok: false, reason: blocker };
    if ((blue.spec?.replicas ?? 1) === 0) {
      await this.updateDeploymentImage(
        name,
        namespace,
        opts.image,
        opts.healthCheck,
        opts.args,
        opts.resources
      );
      return { ok: true, settled: true };
    }

    await this.removeGreen(appsApi, green, namespace);
    const body = buildGreenDeployment(blue, { image: opts.image, args: opts.args });
    this.applyProbesTo(body, opts.healthCheck);
    if (opts.resources) applySizingTo(body, opts.resources);
    log(`Starting ${green} with ${opts.image}`);
    const sinceMs = Date.now();
    await appsApi.createNamespacedDeployment(namespace, body);
    const verdict = await this.waitForRollout(green, namespace, {
      sinceMs,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
      onProgress: (detail) => log(`green: ${detail}`)
    });
    if (verdict.state !== 'ready') {
      const reason = verdict.state === 'failed' ? verdict.reason : 'not ready';
      log(`Green never became ready: ${reason}. Removing it; blue keeps serving.`);
      await this.removeGreen(appsApi, green, namespace);
      return { ok: false, reason };
    }

    await this.pointServiceAt(name, namespace, 'green');
    log('Traffic moved to green');
    const settled = await this.settleBlueGreen({
      deploymentName: name,
      namespace,
      image: opts.image,
      healthCheck: opts.healthCheck,
      args: opts.args,
      resources: opts.resources,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
      log
    });
    return { ok: true, settled };
  }

  /**
   * Second half of a blue/green rollout, and the whole of the healing sweep:
   * bring blue to the image green is serving, wait for it, move traffic back,
   * remove green. Idempotent, so a process that died between the two selector
   * writes is finished by whichever replica notices the leftover green.
   */
  async settleBlueGreen(opts: {
    deploymentName: string;
    namespace: string;
    image: string;
    healthCheck?: CreateDeploymentOptions['healthCheck'];
    args?: string[] | null;
    resources?: PodSizing;
    timeoutMs?: number;
    pollMs?: number;
    log?: (line: string) => void;
  }): Promise<boolean> {
    this.ensureKubeConfig();
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const name = String(opts.deploymentName).trim();
    const namespace = String(opts.namespace).trim();
    const log = opts.log ?? (() => {});
    const sinceMs = Date.now();
    await this.updateDeploymentImage(
      name,
      namespace,
      opts.image,
      opts.healthCheck,
      opts.args,
      opts.resources
    );
    const verdict = await this.waitForRollout(name, namespace, {
      sinceMs,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
      onProgress: (detail) => log(`blue: ${detail}`)
    });
    if (verdict.state !== 'ready') {
      const reason = verdict.state === 'failed' ? verdict.reason : 'not ready';
      log(`Blue hasn't settled (${reason}); green keeps serving until it does.`);
      return false;
    }
    await this.pointServiceAt(name, namespace, 'blue');
    await this.removeGreen(appsApi, greenName(name), namespace);
    log('Traffic back on blue, green removed');
    return true;
  }

  /** The image a leftover green is serving, or null when there is no green. */
  async findGreen(deploymentName: string, namespace: string): Promise<{ image: string } | null> {
    this.ensureKubeConfig();
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    try {
      const green = (
        await appsApi.readNamespacedDeployment(greenName(String(deploymentName).trim()), namespace)
      ).body;
      const image = green.spec?.template?.spec?.containers?.[0]?.image;
      return image ? { image } : null;
    } catch (error) {
      if (error?.response?.statusCode === 404) return null;
      throw error;
    }
  }

  private async pointServiceAt(name: string, namespace: string, slot: 'blue' | 'green') {
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const selector = slotSelector(name, slot);
    await coreApi.patchNamespacedService(
      name,
      namespace,
      { spec: { selector } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
    const service = (await coreApi.readNamespacedService(name, namespace)).body;
    if (!selectorPointsAt(service, name, slot)) {
      throw new Error(
        `Service ${namespace}/${name} doesn't select the ${slot} pods after the write`
      );
    }
  }

  private async removeGreen(appsApi: k8s.AppsV1Api, green: string, namespace: string) {
    try {
      await appsApi.deleteNamespacedDeployment(
        green,
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'Foreground'
      );
    } catch (error) {
      if (error?.response?.statusCode === 404) return;
      throw error;
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        await appsApi.readNamespacedDeployment(green, namespace);
      } catch (error) {
        if (error?.response?.statusCode === 404) return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  private applyProbesTo(
    body: k8s.V1Deployment,
    healthCheck: CreateDeploymentOptions['healthCheck'] | undefined
  ) {
    if (!healthCheck) return;
    const container = body.spec?.template?.spec?.containers?.[0];
    if (!container) return;
    const probes = probesFor(healthCheck);
    container.livenessProbe = probes.liveness ?? undefined;
    container.readinessProbe = probes.readiness ?? undefined;
    container.startupProbe = probes.startup ?? undefined;
  }

  async getPodEvents(podName: string, namespace: string) {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      const events = await coreApi.listNamespacedEvent(
        namespace,
        undefined,
        undefined,
        undefined,
        `involvedObject.name=${podName}`
      );

      return events.body.items
        .filter(
          (event) =>
            event.type === 'Warning' || event.reason === 'BackOff' || event.reason === 'Failed'
        )
        .map((event) => ({
          type: event.type,
          reason: event.reason,
          message: event.message,
          count: event.count || 1,
          firstTimestamp: event.firstTimestamp,
          lastTimestamp: event.lastTimestamp
        }))
        .sort((a, b) => {
          const timeA = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0;
          const timeB = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0;
          return timeB - timeA;
        });
    } catch (error) {
      console.error(`[API] Error fetching events for pod ${podName}:`, error.message);
      return [];
    }
  }

  // Cluster-wide pod labels. Returns Map<"namespace/podName", labels>.
  async getAllPodLabels(): Promise<Map<string, Record<string, string>>> {
    const out = new Map<string, Record<string, string>>();
    this.ensureKubeConfig();
    if (!this.kc) return out;
    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const res = await api.listPodForAllNamespaces();
      for (const pod of res.body.items) {
        const ns = pod.metadata?.namespace;
        const name = pod.metadata?.name;
        if (!ns || !name) continue;
        out.set(`${ns}/${name}`, (pod.metadata?.labels || {}) as Record<string, string>);
      }
    } catch (err) {
      console.error('[K8s] getAllPodLabels failed:', err instanceof Error ? err.message : err);
    }
    return out;
  }

  // Cluster-wide pod metrics. Returns Map<"namespace/podName", {cpuMilli, memBytes}>.
  async getAllPodMetrics(): Promise<
    Map<string, { cpuMilli: number; memoryBytes: number; namespace: string; podName: string }>
  > {
    const out = new Map<
      string,
      { cpuMilli: number; memoryBytes: number; namespace: string; podName: string }
    >();
    this.ensureKubeConfig();
    if (!this.kc) return out;
    try {
      const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
      const response = await customApi.listClusterCustomObject('metrics.k8s.io', 'v1beta1', 'pods');
      const items = (response.body as any)?.items ?? [];
      for (const item of items) {
        const ns = item.metadata?.namespace as string | undefined;
        const pod = item.metadata?.name as string | undefined;
        if (!ns || !pod) continue;
        let cpu = 0;
        let mem = 0;
        for (const c of item.containers ?? []) {
          const cpuStr: string = c.usage?.cpu ?? '0';
          const memStr: string = c.usage?.memory ?? '0';
          if (cpuStr.endsWith('n')) cpu += parseInt(cpuStr, 10) / 1_000_000;
          else if (cpuStr.endsWith('u')) cpu += parseInt(cpuStr, 10) / 1000;
          else if (cpuStr.endsWith('m')) cpu += parseInt(cpuStr, 10);
          else cpu += parseFloat(cpuStr) * 1000;
          if (memStr.endsWith('Ki')) mem += parseInt(memStr, 10) * 1024;
          else if (memStr.endsWith('Mi')) mem += parseInt(memStr, 10) * 1024 * 1024;
          else if (memStr.endsWith('Gi')) mem += parseInt(memStr, 10) * 1024 * 1024 * 1024;
          else mem += parseInt(memStr, 10);
        }
        out.set(`${ns}/${pod}`, {
          cpuMilli: Math.round(cpu),
          memoryBytes: mem,
          namespace: ns,
          podName: pod
        });
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error('[K8s] getAllPodMetrics failed:', m);
    }
    return out;
  }

  async getPodMetrics(
    namespace: string,
    labelSelector: string
  ): Promise<Map<string, { cpuUsage: number; memoryUsage: number }>> {
    try {
      const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
      const response = await customApi.listNamespacedCustomObject(
        'metrics.k8s.io',
        'v1beta1',
        namespace,
        'pods',
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // continue
        undefined, // fieldSelector
        labelSelector
      );

      const metricsMap = new Map<string, { cpuUsage: number; memoryUsage: number }>();
      const items = (response.body as any)?.items ?? [];

      for (const item of items) {
        const podName = item.metadata?.name;
        if (!podName) continue;

        let totalCpu = 0;
        let totalMemory = 0;

        for (const container of item.containers ?? []) {
          const cpuStr: string = container.usage?.cpu ?? '0';
          const memStr: string = container.usage?.memory ?? '0';

          // Parse CPU: could be "123n" (nanocores) or "100m" (millicores)
          if (cpuStr.endsWith('n')) {
            totalCpu += parseInt(cpuStr, 10) / 1_000_000; // nanocores to millicores
          } else if (cpuStr.endsWith('m')) {
            totalCpu += parseInt(cpuStr, 10);
          } else {
            totalCpu += parseFloat(cpuStr) * 1000; // cores to millicores
          }

          // Parse memory: could be "123Ki", "456Mi", "789Gi", or plain bytes
          if (memStr.endsWith('Ki')) {
            totalMemory += parseInt(memStr, 10) * 1024;
          } else if (memStr.endsWith('Mi')) {
            totalMemory += parseInt(memStr, 10) * 1024 * 1024;
          } else if (memStr.endsWith('Gi')) {
            totalMemory += parseInt(memStr, 10) * 1024 * 1024 * 1024;
          } else {
            totalMemory += parseInt(memStr, 10);
          }
        }

        metricsMap.set(podName, { cpuUsage: Math.round(totalCpu), memoryUsage: totalMemory });
      }

      return metricsMap;
    } catch (error) {
      console.warn(
        '[API] Failed to fetch pod metrics (metrics-server may not be available):',
        error.message
      );
      return new Map();
    }
  }

  /**
   * Lightweight batch fetch: lists all pods in a namespace in one API call and
   * groups them by their `app` label. Skips per-pod event fetches and metrics,
   * intended for status-badge computation across many deployments.
   */
  async listNamespacePodsByApp(
    namespace: string
  ): Promise<Map<string, { pods: any[]; warnings: any[] }> | null> {
    this.ensureKubeConfig();
    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const result = new Map<string, { pods: any[]; warnings: any[] }>();
    try {
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      const podList = await coreApi.listNamespacedPod(cleanNamespace);
      for (const pod of podList.body.items) {
        const appLabel = pod.metadata?.labels?.app;
        if (!appLabel) continue;

        const containerStatuses = pod.status?.containerStatuses ?? [];
        const totalRestartCount = containerStatuses.reduce(
          (sum, c) => sum + (c.restartCount ?? 0),
          0
        );

        const computedStatus = computePodStatus(pod);

        const warnings: any[] = [];
        for (const cs of containerStatuses) {
          const waiting = cs.state?.waiting;
          if (waiting?.reason === 'CrashLoopBackOff' || waiting?.reason === 'ImagePullBackOff') {
            warnings.push({
              podName: pod.metadata?.name,
              message: `${cs.name}: ${waiting.message || waiting.reason}`
            });
          }
        }

        const entry = result.get(appLabel) ?? { pods: [], warnings: [] };
        entry.pods.push({
          name: pod.metadata?.name,
          status: computedStatus,
          restartCount: totalRestartCount
        });
        entry.warnings.push(...warnings);
        result.set(appLabel, entry);
      }
    } catch (error) {
      if (error?.response?.statusCode === 404) {
        return result;
      }
      console.warn('[API] listNamespacePodsByApp failed:', error?.message ?? error);
      return null;
    }
    return result;
  }

  async runningImageDigests(deploymentName: string, namespace: string): Promise<string[] | null> {
    this.ensureKubeConfig();
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    let selector: k8s.V1LabelSelector | undefined;
    try {
      selector = (await appsApi.readNamespacedDeployment(deploymentName, namespace)).body.spec
        ?.selector;
    } catch (err: any) {
      if ((err?.statusCode ?? err?.response?.statusCode) === 404) return null;
      throw err;
    }
    const labels = selector?.matchLabels ?? { app: deploymentName };
    const labelSelector = Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const pods = await coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );
    const digests = new Set<string>();
    for (const pod of pods.body.items) {
      if (pod.metadata?.deletionTimestamp) continue;
      const statuses = pod.status?.containerStatuses ?? [];
      const status = statuses.find((s) => s.name === deploymentName) ?? statuses[0];
      const digest = status?.imageID?.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
      if (digest) digests.add(digest);
    }
    return [...digests];
  }

  async getDeploymentPods(deploymentName: string, namespace = 'midnight-staging') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || 'midnight-staging').trim();
    const cleanDeploymentName = String(deploymentName).trim();

    console.log(
      '[API] Fetching pods for deployment:',
      cleanDeploymentName,
      'in namespace:',
      cleanNamespace
    );

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const k8sDeployment = await appsApi.readNamespacedDeployment(
        cleanDeploymentName,
        cleanNamespace
      );

      const selector = k8sDeployment.body.spec.selector;
      const labelSelector = selector.matchLabels
        ? Object.entries(selector.matchLabels)
            .map(([key, value]) => `${key}=${value}`)
            .join(',')
        : `app=${cleanDeploymentName}`;

      const podList = await coreApi.listNamespacedPod(
        cleanNamespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
      );

      const pods = await Promise.all(
        podList.body.items.map(async (pod) => {
          const containerStatuses = pod.status?.containerStatuses ?? [];
          const statusByName = new Map(containerStatuses.map((status) => [status.name, status]));

          const containers =
            pod.spec?.containers?.map((container) => {
              const status = statusByName.get(container.name);
              const state = status?.state;
              let containerWarning: string | undefined;

              if (state?.waiting) {
                if (
                  state.waiting.reason === 'CrashLoopBackOff' ||
                  state.waiting.reason === 'ImagePullBackOff'
                ) {
                  containerWarning = state.waiting.message || state.waiting.reason;
                }
              }

              const term = state?.terminated ?? status?.lastState?.terminated;

              return {
                name: container.name,
                image: container.image,
                ready: status?.ready ?? false,
                restartCount: status?.restartCount ?? 0,
                warning: containerWarning,
                lastTerminatedAt: term?.finishedAt,
                lastTerminationReason: term?.reason,
                lastExitCode: term?.exitCode
              };
            }) ?? [];

          const totalRestartCount = containerStatuses.reduce(
            (sum, current) => sum + (current.restartCount ?? 0),
            0
          );

          const podName = pod.metadata?.name;
          const events = podName ? await this.getPodEvents(podName, cleanNamespace) : [];

          const computedStatus = computePodStatus(pod);

          return {
            name: podName,
            namespace: pod.metadata?.namespace,
            podIp: pod.status?.podIP,
            nodeName: pod.spec?.nodeName,
            status: computedStatus,
            restartCount: totalRestartCount,
            createdAt: pod.metadata?.creationTimestamp,
            revision: revisionOf(pod),
            facts: podFacts(pod),
            containers,
            // The Events panel in ObserveTab shows the real history, and a crash loop
            // generates several distinct reasons before the interesting one.
            events: events.slice(0, 20)
          };
        })
      );

      // Warnings mirror the pod's CURRENT state, not k8s event history.
      // Kubernetes retains warning events for ~1h after the condition
      // resolves, so a pod that briefly failed scheduling or volume attach
      // would otherwise keep showing the alert long after it went ready.
      const RECENT_TERMINATION_MS = 15 * 60 * 1000;
      const warnings = pods.flatMap((pod) => {
        const podWarnings: { message: string; timestamp?: any }[] = [];

        pod.containers?.forEach((container) => {
          if (container.warning) {
            podWarnings.push({ message: `${container.name}: ${container.warning}` });
          }
          const terminatedAt = container.lastTerminatedAt
            ? new Date(container.lastTerminatedAt).getTime()
            : null;
          const recentlyTerminated =
            terminatedAt !== null && Date.now() - terminatedAt < RECENT_TERMINATION_MS;
          const restartingOrRecentlyDied =
            container.restartCount > 0 && (pod.status !== 'ready' || recentlyTerminated);

          const reason = container.lastTerminationReason;
          if (reason && reason !== 'Completed' && reason !== 'Error' && restartingOrRecentlyDied) {
            const codePart =
              container.lastExitCode != null ? ` (exit code ${container.lastExitCode})` : '';
            podWarnings.push({
              message: `${container.name}: last terminated with ${reason}${codePart}`,
              timestamp: container.lastTerminatedAt
            });
          }

          if (restartingOrRecentlyDied) {
            podWarnings.push({
              message: `${container.name} has restarted ${container.restartCount} time(s)`,
              timestamp: container.lastTerminatedAt
            });
          }
        });

        if (pod.status !== 'ready') {
          pod.events?.forEach((event) => {
            if (/failedscheduling/i.test(event.reason ?? '') && pod.nodeName) return;
            podWarnings.push({
              message: `${event.reason}: ${event.message}`,
              timestamp: event.lastTimestamp
            });
          });
        }

        return podWarnings.map((warning) => ({
          podName: pod.name,
          message: warning.message,
          timestamp: warning.timestamp || pod.createdAt
        }));
      });

      const metricsMap = await this.getPodMetrics(cleanNamespace, labelSelector);
      const podsWithMetrics = pods.map((pod) => {
        const metrics = metricsMap.get(pod.name);
        return {
          ...pod,
          cpuUsage: metrics?.cpuUsage ?? null,
          memoryUsage: metrics?.memoryUsage ?? null
        };
      });

      const totalCpuUsage = podsWithMetrics.reduce((sum, p) => sum + (p.cpuUsage ?? 0), 0);
      const totalMemoryUsage = podsWithMetrics.reduce((sum, p) => sum + (p.memoryUsage ?? 0), 0);
      const hasMetrics = metricsMap.size > 0;

      return {
        deployment: cleanDeploymentName,
        namespace: cleanNamespace,
        podCount: podsWithMetrics.length,
        pods: podsWithMetrics,
        warnings: warnings.slice(0, 10),
        totalCpuUsage: hasMetrics ? totalCpuUsage : null,
        totalMemoryUsage: hasMetrics ? totalMemoryUsage : null,
        // How many pods the totals above are summed over. Requests and limits
        // are per pod, so a caller comparing the total against a budget has to
        // multiply by this and not by the replica count: a rollout or a
        // crashloop runs more pods than the deployment asks for, and dividing
        // by the smaller number reports pressure that is not there.
        meteredPods: hasMetrics ? metricsMap.size : null
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        console.log(
          `[API] Deployment ${cleanDeploymentName} not found in Kubernetes (may still be building), returning empty pods`
        );
        return {
          deployment: cleanDeploymentName,
          namespace: cleanNamespace,
          podCount: 0,
          pods: [],
          warnings: [],
          totalCpuUsage: null,
          totalMemoryUsage: null
        };
      }

      console.error('[API] Error fetching deployment pods:', error.message);
      throw new BadRequestException({
        error: 'Failed to fetch deployment pods',
        message: error.message
      });
    }
  }

  /**
   * Lightweight batch: one listNamespacedPod call per namespace, bucketed by
   * the `app.kubernetes.io/name` label (which every orchard-managed Deployment
   * sets via selectorLabels). Returns just enough shape for
   * computeDeploymentStatus: pod phase/ready/restarts and a crash-loop flag,
   * skipping the per-pod events + metrics fetches that getDeploymentPods does.
   *
   * Use for list/overview endpoints where you have many deployments in a
   * shared namespace; collapses 2*N round-trips to a single one.
   */
  async listPodStatusesByDeploymentInNamespace(
    namespace: string
  ): Promise<
    Map<
      string,
      { pods: { status: string; restartCount: number }[]; warnings: { message: string }[] }
    >
  > {
    this.ensureKubeConfig();
    const cleanNamespace = String(namespace || '').trim();
    if (!cleanNamespace) return new Map();

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const result = new Map<
      string,
      { pods: { status: string; restartCount: number }[]; warnings: { message: string }[] }
    >();

    try {
      const podList = await coreApi.listNamespacedPod(
        cleanNamespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'app.kubernetes.io/managed-by=orchard'
      );

      for (const pod of podList.body.items) {
        const deploymentName = pod.metadata?.labels?.['app.kubernetes.io/name'];
        if (!deploymentName) continue;

        const containerStatuses = pod.status?.containerStatuses ?? [];
        const computedStatus = computePodStatus(pod);

        const totalRestarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);

        const bucket = result.get(deploymentName) ?? { pods: [], warnings: [] };
        bucket.pods.push({ status: computedStatus, restartCount: totalRestarts });

        for (const cs of containerStatuses) {
          const reason = cs.state?.waiting?.reason;
          if (reason === 'CrashLoopBackOff' || reason === 'ImagePullBackOff') {
            bucket.warnings.push({
              message: cs.state?.waiting?.message ?? reason
            });
          }
        }

        result.set(deploymentName, bucket);
      }
    } catch (err: any) {
      // 404 just means the namespace doesn't exist yet; treat as empty.
      if (err?.response?.statusCode !== 404) {
        console.error(
          `[API] listPodStatusesByDeploymentInNamespace(${cleanNamespace}):`,
          err?.message ?? err
        );
      }
    }

    return result;
  }

  async addTailscaleSidecar(
    namespace: string,
    deploymentName: string,
    authKey: string,
    hostname: string,
    servicePorts: { port: number; targetPort: number; protocol: string }[]
  ): Promise<void> {
    this.ensureKubeConfig();
    if (!this.kc) return;

    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const names = tailscaleNames(deploymentName);
    const tsDeployName = names.proxy;
    const secretName = names.stateSecret;
    const keySecretName = names.keySecret;

    const orchardLabels = {
      'app.kubernetes.io/managed-by': 'orchard',
      'orchard.my/tailscale': 'true',
      'orchard.my/target-deployment': deploymentName
    };

    const podLabels = {
      ...orchardLabels,
      'app.kubernetes.io/name': tsDeployName
    };

    // 1. The auth key lives in its own Secret that only the kubelet reads (env
    //    injection); the proxy's ServiceAccount can reach only the state Secret.
    await this.upsertTailscaleSecret(coreApi, namespace, deploymentName, keySecretName, {
      labels: orchardLabels,
      stringData: { TS_AUTHKEY: authKey }
    });
    await this.upsertTailscaleSecret(coreApi, namespace, deploymentName, secretName, {
      labels: orchardLabels,
      stringData: {}
    });

    // 2. Create ServiceAccount
    const saName = tsDeployName;
    try {
      await coreApi.createNamespacedServiceAccount(namespace, {
        metadata: { name: saName, labels: orchardLabels }
      });
    } catch (error: any) {
      if (error.response?.statusCode !== 409) throw error;
    }

    // 3. Create RBAC (the Tailscale container needs to read/write its state secret)
    const rbacApi = this.kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const roleBody: k8s.V1Role = {
      metadata: { name: tsDeployName, labels: orchardLabels },
      rules: tailscaleRoleRules(secretName)
    };
    try {
      await rbacApi.createNamespacedRole(namespace, roleBody);
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        await rbacApi.replaceNamespacedRole(tsDeployName, namespace, roleBody);
      } else {
        throw error;
      }
    }
    try {
      await rbacApi.createNamespacedRoleBinding(namespace, {
        metadata: { name: tsDeployName, labels: orchardLabels },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: tsDeployName },
        subjects: [{ kind: 'ServiceAccount', name: saName, namespace }]
      });
    } catch (error: any) {
      if (error.response?.statusCode !== 409) throw error;
    }

    // 4. Build a Tailscale Serve config to proxy each port to the target service.
    // TS_SERVE_CONFIG works in userspace mode: no NET_ADMIN needed.
    const serveConfig = JSON.stringify({
      TCP: Object.fromEntries(
        servicePorts.map((p) => [
          String(p.targetPort),
          { TCPForward: `${deploymentName}:${p.targetPort}` }
        ])
      )
    });
    const serveConfigName = names.serveConfig;

    // Store the serve config in a ConfigMap
    const configMapBody: k8s.V1ConfigMap = {
      metadata: { name: serveConfigName, namespace, labels: orchardLabels },
      data: { 'serve-config.json': serveConfig }
    };
    try {
      await coreApi.createNamespacedConfigMap(namespace, configMapBody);
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        await coreApi.replaceNamespacedConfigMap(serveConfigName, namespace, configMapBody);
      } else {
        throw error;
      }
    }

    // 5. Create the Tailscale proxy Deployment (separate pod, NOT a sidecar)
    const tsDeployBody: k8s.V1Deployment = {
      metadata: { name: tsDeployName, namespace, labels: orchardLabels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { 'app.kubernetes.io/name': tsDeployName } },
        template: {
          metadata: { labels: podLabels },
          spec: {
            serviceAccountName: saName,
            runtimeClassName: tenantRuntimeClassName(),
            containers: [
              {
                name: 'tailscale',
                image: tailscaleImage(),
                imagePullPolicy: 'IfNotPresent',
                env: [
                  {
                    name: 'TS_AUTHKEY',
                    valueFrom: { secretKeyRef: { name: keySecretName, key: 'TS_AUTHKEY' } }
                  },
                  { name: 'TS_HOSTNAME', value: hostname },
                  { name: 'TS_STATE_DIR', value: '/var/lib/tailscale' },
                  { name: 'TS_USERSPACE', value: 'true' },
                  { name: 'TS_KUBE_SECRET', value: secretName },
                  { name: 'TS_SERVE_CONFIG', value: '/config/serve-config.json' },
                  { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
                  { name: 'POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } }
                ],
                resources: {
                  requests: { cpu: '10m', memory: '64Mi' },
                  limits: { cpu: '100m', memory: '128Mi' }
                },
                securityContext: tailscaleSecurityContext(),
                volumeMounts: [
                  { name: 'tailscale-state', mountPath: '/var/lib/tailscale' },
                  { name: 'serve-config', mountPath: '/config', readOnly: true }
                ]
              }
            ],
            volumes: [
              { name: 'tailscale-state', emptyDir: {} },
              {
                name: 'serve-config',
                configMap: { name: serveConfigName }
              }
            ]
          }
        }
      }
    };

    try {
      await appsApi.createNamespacedDeployment(namespace, tsDeployBody);
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        await appsApi.replaceNamespacedDeployment(tsDeployName, namespace, tsDeployBody);
      } else {
        throw error;
      }
    }

    // 6. Create a strict NetworkPolicy: the TS proxy pod can ONLY talk to the
    //    target deployment's pods. No internet, no other namespaces, no DNS even.
    //
    // The TS container stores its state in the ts--state Secret (see RBAC above),
    // so it must also reach the kube apiserver. NetworkPolicy is enforced after
    // kube-proxy DNAT, so allow the real endpoint IPs behind kubernetes.default,
    // not the service ClusterIP.
    let apiServerPeers: k8s.V1NetworkPolicyPeer[] = [];
    let apiServerPorts: k8s.V1NetworkPolicyPort[] = [{ port: 6443 as any, protocol: 'TCP' as any }];
    try {
      const eps = await coreApi.readNamespacedEndpoints('kubernetes', 'default');
      const subsets = eps.body.subsets ?? [];
      const ips = subsets.flatMap((s) => (s.addresses ?? []).map((a) => a.ip));
      const ports = subsets.flatMap((s) => (s.ports ?? []).map((p) => p.port));
      if (ips.length && ports.length) {
        apiServerPeers = ips.map((ip) => ({ ipBlock: { cidr: `${ip}/32` } }));
        apiServerPorts = [...new Set(ports)].map((port) => ({
          port: port as any,
          protocol: 'TCP' as any
        }));
      }
    } catch {
      // Fall back to allowing 6443 to any peer.
    }

    const netpolName = names.netpol;
    const netpolBody: k8s.V1NetworkPolicy = {
      metadata: { name: netpolName, namespace, labels: orchardLabels },
      spec: {
        podSelector: {
          matchLabels: { 'app.kubernetes.io/name': tsDeployName, 'orchard.my/tailscale': 'true' }
        },
        policyTypes: ['Ingress', 'Egress'],
        // Ingress: allow nothing from inside the cluster (Tailscale uses DERP/WireGuard UDP from outside)
        ingress: [],
        egress: [
          // Allow traffic ONLY to the target deployment's pods
          {
            to: [
              {
                podSelector: {
                  matchLabels: {
                    'app.kubernetes.io/name': deploymentName,
                    'app.kubernetes.io/managed-by': 'orchard'
                  },
                  matchExpressions: [{ key: 'orchard.my/tailscale', operator: 'DoesNotExist' }]
                }
              }
            ],
            ports: servicePorts.map((p) => ({
              port: p.targetPort,
              protocol: (p.protocol || 'TCP') as any
            }))
          },
          // Allow DNS resolution (needed for K8s service name → ClusterIP)
          {
            to: [],
            ports: [
              { port: 53, protocol: 'UDP' as any },
              { port: 53, protocol: 'TCP' as any }
            ]
          },
          // Allow Tailscale DERP/coordination (external, any IP, specific ports)
          {
            to: [
              {
                ipBlock: {
                  cidr: '0.0.0.0/0',
                  except: [...TAILSCALE_EGRESS_EXCEPT]
                }
              }
            ],
            ports: [
              { port: 443, protocol: 'TCP' as any }, // DERP + coordination
              { port: 3478, protocol: 'UDP' as any }, // STUN
              { port: 41641, protocol: 'UDP' as any } // WireGuard direct
            ]
          },
          // Allow the kube apiserver (state Secret reads/writes)
          {
            to: apiServerPeers,
            ports: apiServerPorts
          }
        ]
      }
    };

    try {
      await networkingApi.createNamespacedNetworkPolicy(namespace, netpolBody);
    } catch (error: any) {
      if (error.response?.statusCode === 409) {
        await networkingApi.replaceNamespacedNetworkPolicy(netpolName, namespace, netpolBody);
      } else {
        throw error;
      }
    }

    // 7. Under Cilium, ipBlock rules can't select the apiserver (it has the
    //    reserved kube-apiserver identity), so the egress rule above is inert
    //    there: mirror it as a CiliumNetworkPolicy, same as allow-cnpg-apiserver.
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const tsApiServerPolicy = {
      apiVersion: 'cilium.io/v2',
      kind: 'CiliumNetworkPolicy',
      metadata: {
        name: names.ciliumPolicy,
        namespace,
        labels: orchardLabels
      },
      spec: {
        endpointSelector: {
          matchLabels: { 'app.kubernetes.io/name': tsDeployName, 'orchard.my/tailscale': 'true' }
        },
        egress: [{ toEntities: ['kube-apiserver'] }]
      }
    };
    try {
      await customApi.createNamespacedCustomObject(
        'cilium.io',
        'v2',
        namespace,
        'ciliumnetworkpolicies',
        tsApiServerPolicy
      );
    } catch (e: any) {
      const code = e.response?.statusCode;
      if (code === 404 || code === 403) {
        // Cilium CRD absent, or present with no cilium.io rbac granted
        // (cilium.enabled=false): the vanilla NetworkPolicy rule covers it.
      } else if (code !== 409) {
        throw e;
      }
    }
  }

  private async upsertTailscaleSecret(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    deploymentName: string,
    name: string,
    spec: { labels: Record<string, string>; stringData: Record<string, string> }
  ): Promise<void> {
    const body: k8s.V1Secret = {
      metadata: { name, namespace, labels: spec.labels },
      type: 'Opaque',
      stringData: spec.stringData
    };
    try {
      await coreApi.createNamespacedSecret(namespace, body);
    } catch (error: any) {
      if (error.response?.statusCode !== 409) throw error;
      const existing = await coreApi.readNamespacedSecret(name, namespace);
      if (!isTailscaleOwned(existing.body.metadata, deploymentName)) {
        throw new ConflictException(
          `Secret ${name} already exists and is not managed by the Tailscale integration`
        );
      }
      await coreApi.replaceNamespacedSecret(name, namespace, body);
    }
  }

  async removeTailscaleSidecar(namespace: string, deploymentName: string): Promise<void> {
    this.ensureKubeConfig();
    if (!this.kc) return;

    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const rbacApi = this.kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const current = tailscaleNames(deploymentName);
    const legacy = legacyTailscaleNames(deploymentName);

    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e: any) {
        if ((e?.response?.statusCode ?? e?.statusCode) !== 404)
          console.error(`[K8s] Failed to delete ${label}:`, e);
      }
    };
    const ownedLegacy = async (
      label: string,
      read: () => Promise<{ body: { metadata?: { labels?: Record<string, string> } } }>,
      del: () => Promise<unknown>
    ) => {
      try {
        const existing = await read();
        if (!isTailscaleOwned(existing.body.metadata, deploymentName)) return;
      } catch (e: any) {
        if ((e?.response?.statusCode ?? e?.statusCode) !== 404)
          console.error(`[K8s] Failed to read ${label}:`, e);
        return;
      }
      await attempt(label, del);
    };

    await attempt(`Deployment ${current.proxy}`, () =>
      appsApi.deleteNamespacedDeployment(current.proxy, namespace)
    );
    await attempt(`NetworkPolicy ${current.netpol}`, () =>
      networkingApi.deleteNamespacedNetworkPolicy(current.netpol, namespace)
    );
    await attempt(`CNP ${current.ciliumPolicy}`, () =>
      customApi.deleteNamespacedCustomObject(
        'cilium.io',
        'v2',
        namespace,
        'ciliumnetworkpolicies',
        current.ciliumPolicy
      )
    );
    await attempt(`ConfigMap ${current.serveConfig}`, () =>
      coreApi.deleteNamespacedConfigMap(current.serveConfig, namespace)
    );
    await attempt(`RoleBinding ${current.proxy}`, () =>
      rbacApi.deleteNamespacedRoleBinding(current.proxy, namespace)
    );
    await attempt(`Role ${current.proxy}`, () =>
      rbacApi.deleteNamespacedRole(current.proxy, namespace)
    );
    await attempt(`ServiceAccount ${current.proxy}`, () =>
      coreApi.deleteNamespacedServiceAccount(current.proxy, namespace)
    );
    await attempt(`Secret ${current.keySecret}`, () =>
      coreApi.deleteNamespacedSecret(current.keySecret, namespace)
    );
    await attempt(`Secret ${current.stateSecret}`, () =>
      coreApi.deleteNamespacedSecret(current.stateSecret, namespace)
    );

    await ownedLegacy(
      `Deployment ${legacy.proxy}`,
      () => appsApi.readNamespacedDeployment(legacy.proxy, namespace),
      () => appsApi.deleteNamespacedDeployment(legacy.proxy, namespace)
    );
    await ownedLegacy(
      `NetworkPolicy ${legacy.netpol}`,
      () => networkingApi.readNamespacedNetworkPolicy(legacy.netpol, namespace),
      () => networkingApi.deleteNamespacedNetworkPolicy(legacy.netpol, namespace)
    );
    await ownedLegacy(
      `CNP ${legacy.ciliumPolicy}`,
      () =>
        customApi.getNamespacedCustomObject(
          'cilium.io',
          'v2',
          namespace,
          'ciliumnetworkpolicies',
          legacy.ciliumPolicy
        ) as Promise<{ body: { metadata?: { labels?: Record<string, string> } } }>,
      () =>
        customApi.deleteNamespacedCustomObject(
          'cilium.io',
          'v2',
          namespace,
          'ciliumnetworkpolicies',
          legacy.ciliumPolicy
        )
    );
    await ownedLegacy(
      `ConfigMap ${legacy.serveConfig}`,
      () => coreApi.readNamespacedConfigMap(legacy.serveConfig, namespace),
      () => coreApi.deleteNamespacedConfigMap(legacy.serveConfig, namespace)
    );
    await ownedLegacy(
      `RoleBinding ${legacy.proxy}`,
      () => rbacApi.readNamespacedRoleBinding(legacy.proxy, namespace),
      () => rbacApi.deleteNamespacedRoleBinding(legacy.proxy, namespace)
    );
    await ownedLegacy(
      `Role ${legacy.proxy}`,
      () => rbacApi.readNamespacedRole(legacy.proxy, namespace),
      () => rbacApi.deleteNamespacedRole(legacy.proxy, namespace)
    );
    await ownedLegacy(
      `ServiceAccount ${legacy.proxy}`,
      () => coreApi.readNamespacedServiceAccount(legacy.proxy, namespace),
      () => coreApi.deleteNamespacedServiceAccount(legacy.proxy, namespace)
    );
    await ownedLegacy(
      `Secret ${legacy.keySecret}`,
      () => coreApi.readNamespacedSecret(legacy.keySecret, namespace),
      () => coreApi.deleteNamespacedSecret(legacy.keySecret, namespace)
    );
  }

  /**
   * Exec into the Tailscale proxy pod for a deployment and return its IP + DNS name.
   */
  async getTailscaleStatus(
    namespace: string,
    deploymentName: string
  ): Promise<{ ip: string | null; dns: string | null }> {
    this.ensureKubeConfig();
    if (!this.kc) return { ip: null, dns: null };

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body: podList } = await coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `app.kubernetes.io/managed-by=orchard,orchard.my/tailscale=true,orchard.my/target-deployment=${deploymentName}`
    );

    const runningPod = podList.items.find((p) => p.status?.phase === 'Running');

    if (!runningPod?.metadata?.name) {
      return { ip: null, dns: null };
    }

    const exec = new k8s.Exec(this.kc);
    const podName = runningPod.metadata.name;

    return new Promise<{ ip: string | null; dns: string | null }>((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const stdout = new PassThrough();
      const stderr = new PassThrough();

      stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

      exec
        .exec(
          namespace,
          podName,
          'tailscale',
          ['tailscale', '--socket=/tmp/tailscaled.sock', 'status', '--json'],
          stdout,
          stderr,
          null,
          false,
          (status) => {
            try {
              const output = Buffer.concat(chunks).toString('utf-8').trim();
              if (status.status === 'Success' && output) {
                const data = JSON.parse(output);
                const selfKey = data.Self;
                if (selfKey) {
                  const ip = selfKey.TailscaleIPs?.[0] || null;
                  const dns = selfKey.DNSName?.replace(/\.$/, '') || null;
                  resolve({ ip, dns });
                  return;
                }
              }
            } catch {
              // Parse error: proxy may not be ready yet
            }
            resolve({ ip: null, dns: null });
          }
        )
        .catch(() => {
          resolve({ ip: null, dns: null });
        });
    });
  }
}
