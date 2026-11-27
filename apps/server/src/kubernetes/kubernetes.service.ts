import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { parseMemory } from './quantity';
import * as k8s from '@kubernetes/client-node';
import { clusterPods, type SnapshotRead } from './cluster-snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { apiserverEndpointsFrom, type ApiserverEndpoints } from './security-policies';
import {
  extraDenyCidrs,
  ipv4Excepts,
  nodeAddresses,
  serverHostAddresses
} from './cluster-addresses';
import type { PodSizing } from './resource-spec';
import { assertValidClaimName, assertValidVolumeSize, isPlatformOwnedClaim } from './pvc-limits';
import { setClusterDenySource } from '../notifications/webhook-guard';

export const ALLOWED_INGRESS_ANNOTATION_KEYS = new Set<string>([
  'cert-manager.io/cluster-issuer',
  'cert-manager.io/issuer',
  'acme.cert-manager.io/http01-edit-in-place',
  'ingress.cilium.io/force-https',
  'orchard.my/basic-auth'
]);

// A resolved node pool: the label selector to match, tolerations to inject so
// the workload can land on tainted nodes, and whether membership is a hard
// requirement (`required`) or a soft preference (`preferred`).
export interface PoolPlacement {
  nodeSelector: k8s.V1NodeSelectorRequirement[];
  tolerations: k8s.V1Toleration[];
  affinityMode: 'required' | 'preferred';
}

// Superadmin-only raw escape hatch stored on a workload as `placementOverride`.
export interface PlacementOverride {
  nodeSelector?: k8s.V1NodeSelectorRequirement[];
  tolerations?: k8s.V1Toleration[];
  affinity?: k8s.V1Affinity;
}

export interface PlacementInput {
  allowedNodes?: string[] | null;
  deniedNodes?: string[];
  pool?: PoolPlacement | null;
  override?: PlacementOverride | null;
}

export interface ResolvedPlacement {
  affinity?: k8s.V1Affinity;
  tolerations?: k8s.V1Toleration[];
}

// Merge every placement lever into a single { affinity, tolerations } applied to
// a pod spec: org hostname allow/deny (hard), the assigned node pool's selector
// (hard or soft) + tolerations, and the superadmin raw override (wins last).
export function buildPlacement(input: PlacementInput): ResolvedPlacement {
  const { allowedNodes, deniedNodes, pool, override } = input;
  const requiredExprs: k8s.V1NodeSelectorRequirement[] = [];
  const preferred: k8s.V1PreferredSchedulingTerm[] = [];

  if (allowedNodes && allowedNodes.length > 0) {
    requiredExprs.push({ key: 'kubernetes.io/hostname', operator: 'In', values: allowedNodes });
  }
  if (deniedNodes && deniedNodes.length > 0) {
    requiredExprs.push({ key: 'kubernetes.io/hostname', operator: 'NotIn', values: deniedNodes });
  }

  if (pool && pool.nodeSelector.length > 0) {
    if (pool.affinityMode === 'required') {
      requiredExprs.push(...pool.nodeSelector);
    } else {
      preferred.push({ weight: 100, preference: { matchExpressions: pool.nodeSelector } });
    }
  }
  if (override?.nodeSelector && override.nodeSelector.length > 0) {
    requiredExprs.push(...override.nodeSelector);
  }

  let nodeAffinity: k8s.V1NodeAffinity | undefined;
  if (requiredExprs.length > 0 || preferred.length > 0) {
    nodeAffinity = {};
    if (requiredExprs.length > 0) {
      nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution = {
        nodeSelectorTerms: [{ matchExpressions: requiredExprs }]
      };
    }
    if (preferred.length > 0) {
      nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution = preferred;
    }
  }

  let affinity: k8s.V1Affinity | undefined = nodeAffinity ? { nodeAffinity } : undefined;
  // Raw override deep-merges over the computed affinity, per top-level key
  // (nodeAffinity / podAffinity / podAntiAffinity), so a superadmin can add
  // pod (anti-)affinity or fully replace nodeAffinity.
  if (override?.affinity) {
    affinity = { ...(affinity ?? {}), ...override.affinity };
  }

  const tolerations = [...(pool?.tolerations ?? []), ...(override?.tolerations ?? [])];
  return {
    affinity,
    tolerations: tolerations.length > 0 ? tolerations : undefined
  };
}

// Back-compat shim: org hostname allow/deny only (no pool/override).
export function buildNodeAffinity(
  allowedNodes: string[] | null | undefined,
  deniedNodes: string[] | undefined
): k8s.V1Affinity | null {
  return buildPlacement({ allowedNodes, deniedNodes }).affinity ?? null;
}

export interface DeploymentEnvVarInput {
  key: string;
  value: string;
  secret?: boolean;
}

export interface DeploymentPortInput {
  name?: string;
  containerPort?: number;
  servicePort?: number;
  protocol?: string;
  nodePort?: number;
}

export interface SanitizedPortEntry {
  name: string;
  containerPort: number;
  servicePort: number;
  protocol: string;
  nodePort?: number;
}

export interface CreateDeploymentOptions {
  namespace: string;
  name: string;
  image: string;
  replicas: number;
  ports?: DeploymentPortInput[];
  env?: DeploymentEnvVarInput[];
  // The deployment's start command, already resolved to argv by
  // resolveStartArgs. Set as the container's `args`, so it lands after the
  // image's ENTRYPOINT rather than replacing it. Omitted or null leaves the
  // image's own CMD in place.
  args?: string[] | null;
  serviceType?: 'ClusterIP' | 'LoadBalancer' | 'NodePort';
  allowedNodes?: string[] | null;
  deniedNodes?: string[];
  // Resolved node-pool placement + superadmin raw override (merged with the
  // org allow/deny above via buildPlacement into affinity + tolerations).
  pool?: PoolPlacement | null;
  placementOverride?: PlacementOverride | null;
  resources?: PodSizing;
  volumes?: {
    name: string;
    type: 'pvc' | 'hostPath' | 'emptyDir';
    mountPath: string;
    pvcName?: string;
    storageSize?: string;
    hostPath?: string;
    readOnly?: boolean;
  }[];
  healthCheck?: {
    enabled: boolean;
    type: string;
    path?: string | null;
    port?: number | null;
    command?: string | null;
    // Already split into argv. A Dockerfile's HEALTHCHECK carries shell
    // operators that splitting `command` on spaces would destroy.
    execCommand?: string[] | null;
    livenessEnabled: boolean;
    readinessEnabled: boolean;
    startupEnabled: boolean;
    interval: number;
    timeout: number;
    retries: number;
    startupFailureThreshold: number;
  };
  // When omitted, the cluster default (RollingUpdate) is used. Caller is
  // responsible for forcing 'recreate' when a PVC volume is attached.
  // 'blueGreen' is orchestrated above Kubernetes and renders as RollingUpdate
  // on the object itself.
  deployStrategy?: 'rollingUpdate' | 'recreate' | 'blueGreen';
  // Whether the kubelet re-pulls the image on every pod start. Omitted means
  // IfNotPresent, which is right for the unique per-build tags a GitHub deploy
  // produces and wrong for an image-source app pinned to a mutable tag.
  imagePullPolicy?: 'Always' | 'IfNotPresent';
  imagePullSecrets?: { name: string }[];
  // Pods that must stay ready through a node drain. Omitted means 1, and the
  // budget is skipped entirely unless `replicas` exceeds it: see
  // K8sWorkloadService.applyPodDisruptionBudget.
  pdbMinAvailable?: number;
  devices?: Record<string, number>;
}

export interface UpdateDeploymentEnvOptions {
  namespace: string;
  deploymentName: string;
  env: DeploymentEnvVarInput[];
}

export interface UpdateServiceExposureOptions {
  namespace: string;
  serviceName: string;
  type: 'ClusterIP' | 'LoadBalancer' | 'NodePort';
}

export interface UpdateServicePortsOptions {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  ports: DeploymentPortInput[];
}

export interface CreateAdditionalServiceOptions {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  ports: DeploymentPortInput[];
  type?: 'ClusterIP' | 'LoadBalancer' | 'NodePort';
}

export interface DeleteDeploymentServiceOptions {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  remainingPorts?: DeploymentPortInput[];
}

interface IngressPathBackend {
  path: string;
  pathType?: string;
  serviceName: string;
  servicePort: number;
}

export interface CreateIngressOptions {
  namespace: string;
  name: string;
  host: string;
  path?: string;
  pathType?: string;
  serviceName?: string;
  servicePort?: number;
  serviceTargetPort?: number;
  paths?: IngressPathBackend[];
  tlsSecretName?: string;
  tlsHosts?: string[];
  ingressClassName?: string;
  entrypoints?: string[];
  annotations?: Record<string, string>;
  basicAuth?: {
    enabled: boolean;
    username: string;
    password: string;
    secretName?: string;
  };
}

@Injectable()
export class KubernetesService {
  kc: k8s.KubeConfig | null;

  constructor(private readonly prisma: PrismaService) {
    try {
      this.kc = new k8s.KubeConfig();
      if (process.env.KUBECONFIG_BASE64) {
        console.log('[K8s] Loading kubeconfig from base64 encoded string');
        let base64Value = process.env.KUBECONFIG_BASE64.trim();

        while (
          (base64Value.startsWith('"') && base64Value.endsWith('"')) ||
          (base64Value.startsWith("'") && base64Value.endsWith("'"))
        ) {
          base64Value = base64Value.slice(1, -1).trim();
        }

        if (!base64Value) {
          throw new Error('KUBECONFIG_BASE64 is empty after removing quotes');
        }

        console.log('[K8s] Base64 kubeconfig length:', base64Value.length, 'characters');

        try {
          const decoded = Buffer.from(base64Value, 'base64').toString('utf-8');
          if (!decoded || decoded.trim().length === 0) {
            throw new Error('Decoded kubeconfig is empty');
          }
          console.log(
            '[K8s] Successfully decoded kubeconfig, decoded length:',
            decoded.length,
            'characters'
          );
          this.kc.loadFromString(decoded);
        } catch (decodeError) {
          throw new Error(`Failed to decode base64 kubeconfig: ${decodeError.message}`);
        }
      } else if (process.env.KUBECONFIG_PATH) {
        let configPath = process.env.KUBECONFIG_PATH.trim();

        while (
          (configPath.startsWith('"') && configPath.endsWith('"')) ||
          (configPath.startsWith("'") && configPath.endsWith("'"))
        ) {
          configPath = configPath.slice(1, -1).trim();
        }

        if (!configPath.includes('/') && !configPath.includes('\\') && configPath.length > 100) {
          console.log('[K8s] Detected base64 string in KUBECONFIG_PATH, decoding...');
          console.log('[K8s] Base64 kubeconfig length:', configPath.length, 'characters');
          try {
            const decoded = Buffer.from(configPath, 'base64').toString('utf-8');
            if (!decoded || decoded.trim().length === 0) {
              throw new Error('Decoded kubeconfig is empty');
            }
            if (decoded.includes('apiVersion:') || decoded.includes('kind: Config')) {
              console.log(
                '[K8s] Successfully decoded kubeconfig from KUBECONFIG_PATH, decoded length:',
                decoded.length,
                'characters'
              );
              this.kc.loadFromString(decoded);
            } else {
              throw new Error("Decoded string doesn't appear to be a valid kubeconfig");
            }
          } catch (decodeError) {
            console.warn(
              '[K8s] Failed to decode as base64, trying as file path:',
              decodeError.message
            );
            console.log('[K8s] Loading kubeconfig from file:', configPath);
            this.kc.loadFromFile(configPath);
          }
        } else {
          console.log('[K8s] Loading kubeconfig from file:', configPath);
          this.kc.loadFromFile(configPath);
        }
      } else {
        console.log('[K8s] Loading default kubeconfig');
        this.kc.loadFromDefault();
      }
      console.log('[K8s] Successfully loaded kubeconfig');
      console.log('[K8s] Current context:', this.kc.getCurrentContext());
    } catch (error) {
      console.error('[K8s] Error loading kubeconfig:', error.message);
      console.warn(
        '[K8s] Make sure KUBECONFIG_BASE64, KUBECONFIG_PATH is set or ~/.kube/config exists'
      );
      this.kc = null;
    }
  }

  onModuleInit() {
    setClusterDenySource(() => this.clusterExceptCidrs());
  }

  ensureKubeConfig() {
    if (!this.kc) {
      throw new ServiceUnavailableException({
        error: 'Kubernetes API not available',
        message: "Kubeconfig couldn't be loaded. Check server logs for details."
      });
    }
  }

  private ciliumProbe: { at: number; result: boolean } | null = null;

  private static readonly CILIUM_PROBE_TTL_MS = 5 * 60 * 1000;

  private apiserverProbe: { at: number; result: ApiserverEndpoints } | null = null;

  async apiserverEndpoints(): Promise<ApiserverEndpoints | null> {
    if (!this.kc) return null;
    const cached = this.apiserverProbe;
    if (cached && Date.now() - cached.at < KubernetesService.CILIUM_PROBE_TTL_MS) {
      return cached.result;
    }
    try {
      const core = this.kc.makeApiClient(k8s.CoreV1Api);
      const [{ body: service }, { body: endpoints }] = await Promise.all([
        core.readNamespacedService('kubernetes', 'default'),
        core.readNamespacedEndpoints('kubernetes', 'default')
      ]);
      const result = apiserverEndpointsFrom(service, endpoints);
      if (!result) throw new Error('the kubernetes Service lists no endpoints');
      this.apiserverProbe = { at: Date.now(), result };
      return result;
    } catch (err) {
      if (!cached) throw err;
      console.warn(`[K8s] could not read the API server endpoints: ${(err as Error).message}`);
      return cached.result;
    }
  }

  private clusterExceptProbe: { at: number; result: string[] } | null = null;

  private static readonly CLUSTER_EXCEPT_FAILURE_TTL_MS = 30 * 1000;

  async clusterExceptCidrs(opts: { refresh?: boolean } = {}): Promise<string[]> {
    const cached = this.clusterExceptProbe;
    if (!opts.refresh && cached && Date.now() < cached.at) return cached.result;
    const found: string[] = [...extraDenyCidrs()];
    let complete = true;
    if (this.kc) {
      try {
        const nodes = await this.kc.makeApiClient(k8s.CoreV1Api).listNode();
        found.push(...nodeAddresses(nodes.body.items));
      } catch (err) {
        complete = false;
        console.warn(
          `[K8s] could not list nodes for the egress deny list: ${(err as Error).message}`
        );
      }
      try {
        const apiserver = await this.apiserverEndpoints();
        found.push(...(apiserver?.ips ?? []));
      } catch (err) {
        complete = false;
        console.warn(`[K8s] could not read the API server endpoints: ${(err as Error).message}`);
      }
      found.push(...(await serverHostAddresses(this.kc.getCurrentCluster()?.server)));
    }
    const result = ipv4Excepts(complete || !cached ? found : [...cached.result, ...found]);
    this.clusterExceptProbe = {
      at:
        Date.now() +
        (complete
          ? KubernetesService.CILIUM_PROBE_TTL_MS
          : KubernetesService.CLUSTER_EXCEPT_FAILURE_TTL_MS),
      result
    };
    return result;
  }

  /**
   * Whether Cilium-backed edge features (basic auth via CiliumEnvoyConfig,
   * per-tenant CiliumNetworkPolicy) can actually be used. CILIUM_ENABLED is a
   * hard override for operators; otherwise this probes the cluster, so an
   * install that already runs Cilium keeps working without any new config.
   *
   * Both the CRD and the create permission have to be there: on a chart
   * install with `cilium.enabled: false` the CRDs may exist while the control
   * plane has no rbac for them, and creating an ingress that silently skipped
   * its auth filter is worse than refusing to create it.
   */
  async isCiliumAvailable(): Promise<boolean> {
    const override = process.env.CILIUM_ENABLED;
    if (override === 'true') return true;
    if (override === 'false') return false;
    if (!this.kc) return false;

    const cached = this.ciliumProbe;
    if (cached && Date.now() - cached.at < KubernetesService.CILIUM_PROBE_TTL_MS) {
      return cached.result;
    }

    const result = await this.probeCilium();
    this.ciliumProbe = { at: Date.now(), result };
    return result;
  }

  private async probeCilium(): Promise<boolean> {
    try {
      const groups = await this.kc!.makeApiClient(k8s.ApisApi).getAPIVersions();
      const present = (groups.body.groups || []).some((group) => group.name === 'cilium.io');
      if (!present) return false;

      const review = await this.kc!.makeApiClient(
        k8s.AuthorizationV1Api
      ).createSelfSubjectAccessReview({
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SelfSubjectAccessReview',
        spec: {
          resourceAttributes: {
            group: 'cilium.io',
            resource: 'ciliumenvoyconfigs',
            verb: 'create'
          }
        }
      });
      return review.body.status?.allowed === true;
    } catch (error) {
      console.warn('[K8s] Cilium capability probe failed:', error.message);
      return false;
    }
  }

  // Exposed for sibling services (e.g. R2ProxyService) that need raw kube
  // client access without duplicating the kubeconfig-loading logic above.
  public getCoreV1Api(): k8s.CoreV1Api {
    this.ensureKubeConfig();
    return this.kc!.makeApiClient(k8s.CoreV1Api);
  }

  async getDefaultNodeIp(coreApi: k8s.CoreV1Api): Promise<string | null> {
    const configured = process.env.PUBLIC_EXPOSURE_IP?.trim();
    if (configured) return configured;
    try {
      const nodes = await coreApi.listNode();
      for (const node of nodes.body.items) {
        const addresses = node.status?.addresses || [];
        const external = addresses.find((entry) => entry.type === 'ExternalIP' && entry.address);
        if (external?.address) {
          return external.address;
        }
        const internal = addresses.find((entry) => entry.type === 'InternalIP' && entry.address);
        if (internal?.address) {
          return internal.address;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[K8s] Failed to fetch node IP:', message);
    }
    return null;
  }

  // Apply (or remove) a ResourceQuota + LimitRange in a namespace.
  // Pass nulls to remove the resource.

  async listClusterNodes(): Promise<k8s.V1Node[]> {
    this.ensureKubeConfig();
    if (!this.kc) return [];
    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      const res = await api.listNode();
      return res.body.items;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[K8s] listClusterNodes failed:', message);
      return [];
    }
  }

  // Merge-patch a node's metadata/spec (labels, taints). The node informer
  // reflects the result back into the DB, so callers should not dual-write.
  async patchNode(name: string, patch: object): Promise<k8s.V1Node> {
    this.ensureKubeConfig();
    const api = this.kc!.makeApiClient(k8s.CoreV1Api);
    const res = await api.patchNode(
      name,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    return res.body;
  }

  // Returns per-node aggregated requests for all pods in the cluster.
  async getClusterPodUsage(opts: SnapshotRead = {}): Promise<
    {
      nodeName: string | null;
      namespace: string;
      podName: string;
      cpuRequestMilli: number;
      memoryRequestBytes: number;
      cpuLimitMilli: number;
      memoryLimitBytes: number;
      labels: Record<string, string>;
    }[]
  > {
    this.ensureKubeConfig();
    return clusterPods(this.kc, opts);
  }

  async deletePVC(namespace: string, name: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim(cleanName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete PVC ${cleanName} in ${cleanNamespace}:`, error);
      }
    }
  }

  async createPVC(namespace: string, name: string, storageSize = '1Gi') {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;
    assertValidClaimName(cleanName);

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      const { body: existing } = await coreApi.readNamespacedPersistentVolumeClaim(
        cleanName,
        cleanNamespace
      );
      if (isPlatformOwnedClaim(existing.metadata?.labels)) {
        throw new BadRequestException(`Volume "${cleanName}" belongs to a database`);
      }
      const current = parseMemory(String(existing.spec?.resources?.requests?.storage ?? ''));
      if (parseMemory(storageSize) > current) {
        assertValidVolumeSize(storageSize);
        await coreApi.patchNamespacedPersistentVolumeClaim(
          cleanName,
          cleanNamespace,
          { spec: { resources: { requests: { storage: storageSize } } } },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        );
      }
      return;
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        throw error;
      }
    }

    assertValidVolumeSize(storageSize);

    const pvc: k8s.V1PersistentVolumeClaim = {
      metadata: {
        name: cleanName,
        namespace: cleanNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard'
        }
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: process.env.K8S_STORAGE_CLASS || undefined,
        resources: {
          requests: {
            storage: storageSize
          }
        }
      }
    };

    await coreApi.createNamespacedPersistentVolumeClaim(cleanNamespace, pvc);
  }
}
