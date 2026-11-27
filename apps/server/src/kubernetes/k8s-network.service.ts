import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
  Optional
} from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PublicIpPolicyService } from './public-ip-policy.service';
import { sharedIpAnnotations, servicesToAlign, type ShareWith } from './public-ip-policy';
import {
  publicEndpointStatus,
  SERVICELB_NAME_LABEL,
  SERVICELB_NAMESPACE_LABEL,
  UNKNOWN_PUBLIC_ENDPOINT,
  type PublicEndpointStatus
} from './public-endpoint';
import { PrismaService } from '../prisma/prisma.service';
import {
  KubernetesService,
  CreateIngressOptions,
  CreateAdditionalServiceOptions,
  DeleteDeploymentServiceOptions,
  UpdateServiceExposureOptions,
  UpdateServicePortsOptions,
  ALLOWED_INGRESS_ANNOTATION_KEYS
} from './kubernetes.service';
import { mapServicePorts, ensureUniqueServicePorts, sanitizePortEntries } from './port-utils';
import {
  truncateK8sName,
  platformWildcardDomains,
  CERT_CLUSTER_ISSUER
} from '../projects/projects.utils';
import { isSanctionedIssuerValue } from './ingress-annotations';
import { k8sErrorMessage } from './k8s-error';
import { syncTlsSecret } from './tls-secret-sync';
import { LeaderElectionService } from '../events/leader-election.service';
import { optionalDomain } from '../env/platform-domains';
import {
  basicAuthEnvoyConfig,
  basicAuthEnvoyConfigName,
  basicAuthHtpasswd,
  publicDatabasePolicy,
  publicDatabasePolicyName,
  publicDeploymentPolicy,
  publicDeploymentPolicyName
} from './security-policies';

const PUBLIC_ENDPOINT_READ_MS = 4000;

export type ProtectionProxyResult = 'applied' | 'ingress-missing' | 'failed';

export interface CertificateStatus {
  state: 'ready' | 'issuing' | 'failed' | 'rateLimited' | 'unknown';
  reason?: string | null;
  message?: string | null;
  notAfter?: string | null;
}

// Let's Encrypt reports the per-registered-domain cap in the order's error
// text, and it is worth separating from other failures: the fix is a wildcard
// certificate rather than anything about this particular host.
function isAcmeRateLimit(text: string | null | undefined): boolean {
  if (!text) return false;
  return /too many certificates( already)? issued|rate ?limit/i.test(text);
}

export function certificateStatusFrom(cert: any | null | undefined): CertificateStatus {
  if (!cert) return { state: 'unknown' };
  const conditions: any[] = cert.status?.conditions || [];
  const ready = conditions.find((c) => c.type === 'Ready');
  const issuing = conditions.find((c) => c.type === 'Issuing');

  if (ready?.status === 'True') {
    return { state: 'ready', notAfter: cert.status?.notAfter ?? null };
  }

  const reason = ready?.reason || issuing?.reason || null;
  const message = ready?.message || issuing?.message || null;

  if (isAcmeRateLimit(message) || isAcmeRateLimit(reason)) {
    return { state: 'rateLimited', reason, message };
  }
  if (ready?.status === 'False' && reason === 'Failed') {
    return { state: 'failed', reason, message };
  }
  return { state: 'issuing', reason, message };
}

export function certificateForSecret(
  certificates: { manifest: unknown }[],
  secretName: string | null | undefined
): any | null {
  const clean = String(secretName || '').trim();
  if (!clean) return null;
  return (
    certificates.map((c) => c.manifest as any).find((cert) => cert?.spec?.secretName === clean) ??
    null
  );
}

/**
 * All Kubernetes network/edge resources: Services, Ingress (Cilium),
 * basic-auth (CiliumEnvoyConfig), public exposure (Cilium LB IPAM
 * LoadBalancer + NetworkPolicies) for both CNPG clusters and raw
 * deployment ports, and endpoint listing.
 */
@Injectable()
export class K8sNetworkService implements OnModuleInit {
  private readonly logger = new Logger(K8sNetworkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly leaderElection: LeaderElectionService,
    @Optional() private readonly ipPolicy?: PublicIpPolicyService
  ) {}

  onModuleInit() {
    this.leaderElection.onAcquired(() => {
      void this.reconcileProtectionProxies();
      void this.reconcileWildcardSecrets();
    });
    setInterval(
      () => {
        void this.reconcileProtectionProxies();
      },
      10 * 60 * 1000
    ).unref();
    // Certificates renew on cert-manager's schedule, not ours, so this is a
    // convergence loop rather than an event handler: whenever the source Secret
    // changes, every tenant copy is stale until it runs again. Five minutes
    // bounds how long a renewed wildcard can be missing from a namespace.
    setInterval(
      () => {
        void this.reconcileWildcardSecrets();
      },
      5 * 60 * 1000
    ).unref();
  }

  /**
   * Copy the app wildcard TLS Secret into every namespace that has an ingress
   * referencing it.
   *
   * A wildcard is issued once into one namespace, but tenant Ingresses name it
   * locally, so without a copy the host has no certificate. Production solves
   * this with emberstack/reflector; doing it here means a self-hosted install
   * needs no extra component. No-op unless a wildcard is actually configured,
   * which is the default, so nothing runs on a per-host install.
   */
  async reconcileWildcardSecrets(): Promise<void> {
    if (!this.kc) return;
    if (!this.leaderElection.isLeader()) return;

    const sourceNamespace = (process.env.WILDCARD_TLS_SOURCE_NAMESPACE || '').trim();
    const wildcards = platformWildcardDomains().filter((w) => !!w.secret);
    if (!sourceNamespace || wildcards.length === 0) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    for (const wildcard of wildcards) {
      const secretName = wildcard.secret as string;
      let namespaces: string[];
      try {
        const rows = await this.prisma.ingress.findMany({
          where: { tlsSecretName: secretName },
          select: { namespace: true },
          distinct: ['namespace']
        });
        namespaces = rows.map((r) => r.namespace).filter(Boolean);
      } catch (error: any) {
        this.logger.warn(`Failed to list namespaces for ${secretName}: ${error.message}`);
        continue;
      }

      let copied = 0;
      for (const namespace of namespaces) {
        if (namespace === sourceNamespace) continue;
        try {
          const wrote = await syncTlsSecret(
            coreApi,
            { namespace: sourceNamespace, name: secretName },
            { namespace, name: secretName }
          );
          if (wrote) copied += 1;
        } catch (error: any) {
          this.logger.warn(
            `Failed to copy ${secretName} into ${namespace}: ${k8sErrorMessage(error)}`
          );
        }
      }

      if (copied > 0) {
        this.logger.log(`Copied wildcard ${secretName} into ${copied} namespace(s)`);
      }
    }
  }

  async reconcileProtectionProxies(): Promise<void> {
    if (!this.kc) return;
    if (!this.leaderElection.isLeader()) return;

    let protectedIngresses: { namespace: string; name: string }[];
    try {
      protectedIngresses = await this.prisma.ingress.findMany({
        where: {
          OR: [{ protectionMode: { not: 'none' } }, { redirectTarget: { not: null } }]
        },
        select: { namespace: true, name: true },
        distinct: ['namespace', 'name']
      });
    } catch (error) {
      this.logger.warn(`Failed to list protected ingresses for reconcile: ${error.message}`);
      return;
    }

    let applied = 0;
    const orphaned: string[] = [];
    const failed: string[] = [];

    for (const ingress of protectedIngresses) {
      const key = `${ingress.namespace}/${ingress.name}`;
      let result: ProtectionProxyResult;
      try {
        result = await this.enableProtectionProxy(ingress.namespace, ingress.name);
      } catch (error) {
        this.logger.error(
          `Failed to reconcile protection proxy for ${key}: ${k8sErrorMessage(error)}`
        );
        result = 'failed';
      }
      if (result === 'applied') applied += 1;
      else if (result === 'ingress-missing') orphaned.push(key);
      else failed.push(key);
    }

    // A row whose Ingress is gone has nothing to protect, so it is a cleanup
    // problem rather than an auth problem: summarise it once instead of once
    // per row per pass. A real failure means a reachable app is not behind the
    // wall, so that one stays loud.
    if (failed.length > 0) {
      this.logger.error(
        `Protection proxy NOT applied to ${failed.length} ingress(es): ${failed.join(', ')}`
      );
    }
    if (orphaned.length > 0) {
      const shown = orphaned.slice(0, 10).join(', ');
      const more = orphaned.length > 10 ? ` (+${orphaned.length - 10} more)` : '';
      this.logger.warn(
        `${orphaned.length} protected ingress row(s) have no Ingress in the cluster and were skipped: ${shown}${more}`
      );
    }
    if (protectedIngresses.length > 0) {
      this.logger.log(
        `Reconciled protection proxies: ${applied} applied, ${orphaned.length} orphaned rows, ${failed.length} failed`
      );
    }

    try {
      await this.restoreOrphanedProtectionBackends(
        new Set(protectedIngresses.map((i) => `${i.namespace}/${i.name}`))
      );
    } catch (error) {
      this.logger.warn(`Failed to restore orphaned protection backends: ${error.message}`);
    }

    try {
      await this.syncUnprotectedBackends();
    } catch (error) {
      this.logger.warn(`Failed to reconcile ingress backends: ${error.message}`);
    }
  }

  async readIngressBackends(
    namespace: string,
    name: string
  ): Promise<Map<string, { name: string; port: number }> | null> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    try {
      const { body } = await networkingApi.readNamespacedIngress(name, namespace);
      const out = new Map<string, { name: string; port: number }>();
      for (const rule of body.spec?.rules || []) {
        for (const p of rule.http?.paths || []) {
          const svc = p.backend?.service;
          if (!svc?.name) continue;
          out.set(p.path || '/', { name: svc.name, port: Number(svc.port?.number ?? 0) });
        }
      }
      return out;
    } catch (error) {
      if (error.response?.statusCode === 404) return null;
      throw error;
    }
  }

  async setIngressBackends(
    namespace: string,
    name: string,
    backends: { path: string; serviceName: string; servicePort: number }[]
  ): Promise<'applied' | 'unchanged' | 'ingress-missing'> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    let ingress: k8s.V1Ingress;
    try {
      ingress = (await networkingApi.readNamespacedIngress(name, namespace)).body;
    } catch (error) {
      if (error.response?.statusCode === 404) return 'ingress-missing';
      throw error;
    }
    const wanted = new Map(backends.map((b) => [b.path || '/', b]));
    let changed = false;
    for (const rule of ingress.spec?.rules || []) {
      for (const p of rule.http?.paths || []) {
        const b = wanted.get(p.path || '/');
        if (!b) continue;
        const current = p.backend?.service;
        if (current?.name === b.serviceName && current?.port?.number === b.servicePort) continue;
        p.backend = { service: { name: b.serviceName, port: { number: b.servicePort } } };
        changed = true;
      }
    }
    if (!changed) return 'unchanged';
    await networkingApi.replaceNamespacedIngress(name, namespace, ingress);
    return 'applied';
  }

  async syncIngressBackends(
    namespace: string,
    name: string
  ): Promise<'proxy' | 'applied' | 'unchanged' | 'ingress-missing' | 'no-rows' | 'failed'> {
    const rows = await this.prisma.ingress.findMany({
      where: { namespace, name },
      include: { service: { include: { ports: true } } }
    });
    if (rows.length === 0) return 'no-rows';
    if (rows.some((r) => r.protectionMode !== 'none' || r.redirectTarget !== null)) {
      const result = await this.enableProtectionProxy(namespace, name);
      if (result === 'applied') return 'proxy';
      return result === 'ingress-missing' ? 'ingress-missing' : 'failed';
    }
    const live = await this.readIngressBackends(namespace, name);
    if (live === null) return 'ingress-missing';
    const backends: { path: string; serviceName: string; servicePort: number }[] = [];
    for (const row of rows) {
      const backend = await this.directBackend(row, live.get(row.path || '/'));
      if (backend) backends.push(backend);
    }
    if (backends.length === 0) return 'unchanged';
    return this.setIngressBackends(namespace, name, backends);
  }

  private async directBackend(
    row: {
      id: string;
      path: string | null;
      servicePort: number | null;
      service: { name: string; port: number | null; ports: { port: number }[] } | null;
    },
    onCluster?: { name: string; port: number }
  ): Promise<{ path: string; serviceName: string; servicePort: number } | null> {
    if (!row.service) return null;
    const persisted = row.servicePort;
    const seen = onCluster && onCluster.name === row.service.name ? onCluster.port : null;
    const known = new Set<number>([
      ...row.service.ports.map((p) => p.port),
      ...(row.service.port ? [row.service.port] : [])
    ]);
    let port: number | null = persisted && known.has(persisted) ? persisted : null;
    if (port === null && seen && known.has(seen)) port = seen;
    if (port === null) port = row.service.ports[0]?.port ?? row.service.port ?? null;
    if (!port) return null;
    if (row.servicePort !== port) {
      await this.prisma.ingress.update({ where: { id: row.id }, data: { servicePort: port } });
    }
    return { path: row.path || '/', serviceName: row.service.name, servicePort: port };
  }

  private async syncUnprotectedBackends(): Promise<void> {
    const groups = await this.prisma.ingress.findMany({
      where: { protectionMode: 'none', redirectTarget: null },
      select: { namespace: true, name: true },
      distinct: ['namespace', 'name']
    });
    let applied = 0;
    let failed = 0;
    for (const g of groups) {
      try {
        const r = await this.syncIngressBackends(g.namespace, g.name);
        if (r === 'applied') applied += 1;
        else if (r === 'failed') failed += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `Failed to sync backends for ${g.namespace}/${g.name}: ${k8sErrorMessage(error)}`
        );
      }
    }
    if (applied > 0 || failed > 0) {
      this.logger.log(`Ingress backends reconciled: ${applied} repointed, ${failed} failed`);
    }
  }

  private async restoreOrphanedProtectionBackends(protectedKeys: Set<string>): Promise<void> {
    const proxyServiceName = 'orchard-protection-proxy';
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const allIngresses = await networkingApi.listIngressForAllNamespaces(
      undefined,
      undefined,
      undefined,
      'leaf.dev/managed=true'
    );

    for (const ingress of allIngresses.body.items) {
      const namespace = ingress.metadata?.namespace;
      const name = ingress.metadata?.name;
      if (!namespace || !name || protectedKeys.has(`${namespace}/${name}`)) continue;

      const rules = ingress.spec?.rules || [];
      const proxied = rules.some((rule) =>
        (rule.http?.paths || []).some((p) => p.backend?.service?.name === proxyServiceName)
      );
      if (!proxied) continue;

      try {
        await coreApi.readNamespacedService(proxyServiceName, namespace);
        continue;
      } catch (error) {
        if (error.response?.statusCode !== 404) continue;
      }

      const rows = await this.prisma.ingress.findMany({
        where: { namespace, name },
        include: { service: { include: { ports: true } } }
      });
      if (
        rows.length === 0 ||
        rows.some((r) => r.protectionMode !== 'none' || r.redirectTarget !== null)
      )
        continue;

      const backendByPath = new Map(
        rows
          .filter((r) => r.service)
          .map((r) => [
            r.path || '/',
            {
              name: r.service!.name,
              port: Number(r.service!.ports?.[0]?.port ?? r.service!.port)
            }
          ])
      );

      let restored = false;
      for (const rule of rules) {
        for (const p of rule.http?.paths || []) {
          if (p.backend?.service?.name !== proxyServiceName) continue;
          const original = backendByPath.get(p.path || '/') ?? backendByPath.values().next().value;
          if (!original || !Number.isInteger(original.port) || original.port <= 0) continue;
          p.backend = { service: { name: original.name, port: { number: original.port } } };
          restored = true;
        }
      }

      if (!restored) continue;

      try {
        await networkingApi.replaceNamespacedIngress(name, namespace, ingress);
        this.logger.log(`Restored orphaned protection backend on ${namespace}/${name}`);
      } catch (error) {
        this.logger.warn(`Failed to restore ${namespace}/${name}: ${error.message}`);
      }
    }
  }

  private get kc(): k8s.KubeConfig | null {
    return this.kubernetes.kc;
  }

  private ensureKubeConfig() {
    this.kubernetes.ensureKubeConfig();
  }

  private getDefaultNodeIp(coreApi: k8s.CoreV1Api) {
    return this.kubernetes.getDefaultNodeIp(coreApi);
  }

  async listEndpoints(namespace?: string) {
    this.ensureKubeConfig();

    const cleanNamespace = namespace ? String(namespace).trim() : undefined;

    console.log(
      '[API] Fetching endpoints',
      cleanNamespace ? `from namespace: ${cleanNamespace}` : 'from all namespaces'
    );

    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);

      let endpointList;
      if (cleanNamespace) {
        endpointList = await api.listNamespacedEndpoints(cleanNamespace);
      } else {
        endpointList = await api.listEndpointsForAllNamespaces();
      }

      const endpoints = endpointList.body.items.map((endpoint) => ({
        name: endpoint.metadata.name,
        namespace: endpoint.metadata.namespace,
        subsets: endpoint.subsets?.map((subset) => ({
          addresses: subset.addresses?.map((addr) => ({
            ip: addr.ip,
            hostname: addr.hostname,
            nodeName: addr.nodeName,
            targetRef: addr.targetRef
              ? {
                  kind: addr.targetRef.kind,
                  name: addr.targetRef.name,
                  namespace: addr.targetRef.namespace
                }
              : undefined
          })),
          notReadyAddresses: subset.notReadyAddresses?.map((addr) => ({
            ip: addr.ip,
            hostname: addr.hostname,
            nodeName: addr.nodeName,
            targetRef: addr.targetRef
              ? {
                  kind: addr.targetRef.kind,
                  name: addr.targetRef.name,
                  namespace: addr.targetRef.namespace
                }
              : undefined
          })),
          ports: subset.ports?.map((port) => ({
            name: port.name,
            port: port.port,
            protocol: port.protocol
          }))
        })),
        labels: endpoint.metadata.labels,
        annotations: endpoint.metadata.annotations
      }));

      return {
        namespace: cleanNamespace || 'all',
        endpointCount: endpoints.length,
        endpoints
      };
    } catch (error) {
      console.error('Error fetching endpoints:', error);

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to fetch endpoints from Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to fetch endpoints',
        message: error.message
      });
    }
  }

  async createBasicAuthSecret(
    namespace: string,
    name: string,
    username: string,
    password: string
  ): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Secret name is required');
    }

    if (!username || !password) {
      throw new BadRequestException('Username and password are required');
    }

    const authString = basicAuthHtpasswd(username, password);

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const secretBody: k8s.V1Secret = {
      metadata: {
        name: cleanName,
        namespace: cleanNamespace,
        labels: {
          'leaf.dev/managed': 'true',
          'leaf.dev/type': 'basic-auth'
        }
      },
      type: 'Opaque',
      stringData: {
        users: authString
      }
    };

    try {
      await coreApi.createNamespacedSecret(cleanNamespace, secretBody);
    } catch (error) {
      if (error.response?.statusCode === 409) {
        await coreApi.replaceNamespacedSecret(cleanName, cleanNamespace, secretBody);
      } else {
        throw new BadRequestException({
          error: 'Failed to create basic auth secret',
          message: error.response?.body?.message || error.message,
          details: error.response?.body
        });
      }
    }
  }

  /**
   * What cert-manager thinks of the certificate behind an ingress's TLS Secret.
   *
   * Without this the annotation asking for a certificate is written and never
   * checked, so a host whose issuance failed looks exactly like one that worked:
   * the Ingress exists, the UI says fine, and the browser shows a certificate
   * error with no explanation anywhere.
   *
   * Never throws. A cluster with no cert-manager, or one where the Secret was
   * provisioned some other way, reports `unknown` rather than turning a missing
   * CRD into a failed page load.
   */
  async getCertificateStatus(
    namespace: string,
    secretName: string | null | undefined
  ): Promise<CertificateStatus> {
    const cleanNamespace = String(namespace || '').trim();
    const cleanSecret = String(secretName || '').trim();
    if (!cleanNamespace || !cleanSecret || !this.kc) return { state: 'unknown' };

    try {
      const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
      const list: any = await customApi.listNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        cleanNamespace,
        'certificates'
      );
      // Matched on spec.secretName rather than name: the Certificate is named
      // independently of the Secret it produces, and the Ingress only knows the
      // Secret.
      const cert = (list.body?.items || []).find(
        (item: any) => item?.spec?.secretName === cleanSecret
      );
      return certificateStatusFrom(cert);
    } catch (error: any) {
      const code = error?.response?.statusCode;
      // 404 = no cert-manager CRDs, 403 = no rbac for them. Both mean "we
      // cannot know", not "broken".
      if (code === 404 || code === 403) return { state: 'unknown' };
      this.logger.warn(
        `Failed to read certificate status for ${cleanNamespace}/${cleanSecret}: ${k8sErrorMessage(error)}`
      );
      return { state: 'unknown' };
    }
  }

  async deleteBasicAuthSecret(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      await coreApi.deleteNamespacedSecret(cleanName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(
          `Failed to delete basic auth secret ${cleanName} in ${cleanNamespace}:`,
          error
        );
      }
    }
  }

  async createBasicAuthMiddleware(
    namespace: string,
    name: string,
    username: string,
    password: string,
    serviceName: string,
    servicePort: number
  ): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const envoyConfigBody = basicAuthEnvoyConfig(
      cleanNamespace,
      cleanName,
      basicAuthHtpasswd(username, password),
      serviceName,
      servicePort
    );

    try {
      await customObjectsApi.createNamespacedCustomObject(
        'cilium.io',
        'v2',
        cleanNamespace,
        'ciliumenvoyconfigs',
        envoyConfigBody
      );
    } catch (error) {
      // Never swallowed: the caller treats a returned promise as "the host is
      // now password protected" and creates the Ingress on the strength of it.
      if (error.response?.statusCode === 409) {
        await customObjectsApi.replaceNamespacedCustomObject(
          'cilium.io',
          'v2',
          cleanNamespace,
          'ciliumenvoyconfigs',
          basicAuthEnvoyConfigName(cleanName),
          envoyConfigBody
        );
      } else {
        throw new BadRequestException({
          error: 'Failed to enable basic auth',
          message: k8sErrorMessage(error)
        });
      }
    }
  }

  /**
   * Basic auth is enforced by an Envoy filter that only Cilium can install, so
   * on a cluster without it the request has to fail rather than fall through:
   * a caller that asked for a password-protected host must never end up with a
   * public one. See https://docs.orchard.hackclub.com/deploy/protection/.
   */
  private async applyBasicAuth(
    namespace: string,
    name: string,
    secretName: string,
    username: string,
    password: string,
    serviceName: string,
    servicePort: number
  ): Promise<void> {
    if (!(await this.kubernetes.isCiliumAvailable())) {
      throw new BadRequestException({
        error: "Basic auth isn't available on this instance",
        message:
          'Basic auth needs Cilium as the CNI and cilium.enabled=true in the chart. Otherwise, put the host behind your own reverse proxy.'
      });
    }

    await this.createBasicAuthSecret(namespace, secretName, username, password);
    await this.createBasicAuthMiddleware(
      namespace,
      name,
      username,
      password,
      serviceName,
      servicePort
    );
  }

  async deleteBasicAuthMiddleware(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    await this.deleteEnvoyConfig(cleanNamespace, basicAuthEnvoyConfigName(cleanName));
  }

  private async deleteEnvoyConfig(namespace: string, name: string): Promise<void> {
    const customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customObjectsApi.deleteNamespacedCustomObject(
        'cilium.io',
        'v2',
        namespace,
        'ciliumenvoyconfigs',
        name
      );
    } catch (error) {
      const status = error.response?.statusCode;
      if (status === 404) return;
      if (status === 403 && !(await this.kubernetes.isCiliumAvailable())) return;
      console.error(
        `Failed to delete CiliumEnvoyConfig ${name} in ${namespace}: ${k8sErrorMessage(error)}`
      );
    }
  }

  async deleteHttpsRedirectMiddleware(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    await this.deleteEnvoyConfig(cleanNamespace, `${cleanName}-https-redirect`);
  }

  // Reports what actually happened rather than swallowing it. 'ingress-missing'
  // means the row outlived its Ingress and there is nothing to protect;
  // 'failed' means an Ingress exists and is NOT behind the auth wall, which is
  // the case that has to be loud.
  async enableProtectionProxy(
    namespace: string,
    ingressName: string,
    protectingPaths: string[] = []
  ): Promise<ProtectionProxyResult> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(ingressName || '').trim();
    if (!cleanNamespace || !cleanName) return 'failed';

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const authServerNamespace = process.env.ORCHARD_NAMESPACE || 'orchard';
    const authServerPort = parseInt(process.env.ORCHARD_SERVER_PORT || '3001', 10);
    const proxyServiceName = 'orchard-protection-proxy';

    const serverService = await coreApi.readNamespacedService('server', authServerNamespace);
    const clusterIP = serverService.body.spec?.clusterIP;
    if (!clusterIP || clusterIP === 'None') {
      this.logger.error('No stable ClusterIP on server service for protection proxy');
      return 'failed';
    }
    const addresses = [clusterIP];

    const svcBody: k8s.V1Service = {
      metadata: {
        name: proxyServiceName,
        namespace: cleanNamespace,
        labels: { 'orchard.my/managed': 'true', 'orchard.my/type': 'protection-proxy' }
      },
      spec: {
        clusterIP: 'None',
        ports: [
          { port: authServerPort, targetPort: authServerPort, protocol: 'TCP' } as k8s.V1ServicePort
        ]
      }
    };

    try {
      await coreApi.createNamespacedService(cleanNamespace, svcBody);
    } catch (error) {
      if (error.response?.statusCode === 409) {
        await coreApi.replaceNamespacedService(proxyServiceName, cleanNamespace, svcBody);
      } else {
        console.error(`Failed to create protection proxy service: ${k8sErrorMessage(error)}`);
        return 'failed';
      }
    }

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const endpointSlice = {
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      metadata: {
        name: `${proxyServiceName}-1`,
        namespace: cleanNamespace,
        labels: { 'kubernetes.io/service-name': proxyServiceName, 'orchard.my/managed': 'true' }
      },
      addressType: 'IPv4',
      ports: [{ port: authServerPort, protocol: 'TCP' }],
      endpoints: [{ addresses, conditions: { ready: true, serving: true } }]
    };

    try {
      await customApi.createNamespacedCustomObject(
        'discovery.k8s.io',
        'v1',
        cleanNamespace,
        'endpointslices',
        endpointSlice
      );
    } catch (error) {
      if (error.response?.statusCode === 409) {
        await customApi.replaceNamespacedCustomObject(
          'discovery.k8s.io',
          'v1',
          cleanNamespace,
          'endpointslices',
          `${proxyServiceName}-1`,
          endpointSlice
        );
      } else {
        console.error(
          `Failed to create protection proxy endpoint slice: ${k8sErrorMessage(error)}`
        );
      }
    }

    await this.ensureOrchardIngressAllowed(cleanNamespace);

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    try {
      const ingress = await networkingApi.readNamespacedIngress(cleanName, cleanNamespace);
      const rows = await this.prisma.ingress.findMany({
        where: { namespace: cleanNamespace, name: cleanName },
        include: { service: { include: { ports: true } } }
      });
      const openRows = new Map(
        rows
          .filter(
            (row) =>
              row.protectionMode === 'none' &&
              row.redirectTarget === null &&
              !protectingPaths.includes(row.path || '/')
          )
          .map((row) => [row.path || '/', row])
      );
      const rules = ingress.body.spec?.rules || [];
      for (const rule of rules) {
        for (const path of rule.http?.paths || []) {
          const openRow = openRows.get(path.path || '/');
          if (!openRow) {
            path.backend = {
              service: { name: proxyServiceName, port: { number: authServerPort } }
            };
            continue;
          }
          if (path.backend?.service?.name !== proxyServiceName) continue;
          const direct = await this.directBackend(openRow);
          if (direct) {
            path.backend = {
              service: { name: direct.serviceName, port: { number: direct.servicePort } }
            };
          }
        }
      }
      const updated = await networkingApi.replaceNamespacedIngress(
        cleanName,
        cleanNamespace,
        ingress.body
      );
      // The API returns the persisted object, so this confirms the auth wall is
      // really in front of every path instead of assuming the write took.
      const paths = (updated.body.spec?.rules || []).flatMap((rule) => rule.http?.paths || []);
      // Nothing to repoint is not the same as protected. An Ingress shaped
      // some other way (a bare defaultBackend, say) would sail through an
      // emptiness check while still serving the app.
      if (paths.length === 0) {
        this.logger.error(
          `Protection proxy NOT applied to ${cleanNamespace}/${cleanName}: no rule paths to repoint`
        );
        return 'failed';
      }
      const stillDirect = paths.filter(
        (path) =>
          !openRows.has(path.path || '/') && path.backend?.service?.name !== proxyServiceName
      );
      if (stillDirect.length > 0) {
        this.logger.error(
          `Protection proxy NOT applied to ${cleanNamespace}/${cleanName}: ` +
            `${stillDirect.length} path(s) still serve the app directly`
        );
        return 'failed';
      }
      return 'applied';
    } catch (error) {
      if (error.response?.statusCode === 404) return 'ingress-missing';
      this.logger.error(
        `Failed to put ${cleanNamespace}/${cleanName} behind the protection proxy: ${k8sErrorMessage(error)}`
      );
      return 'failed';
    }
  }

  async disableProtectionProxy(namespace: string, ingressName: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(ingressName || '').trim();
    if (!cleanNamespace || !cleanName) return;

    try {
      const result = await this.syncIngressBackends(cleanNamespace, cleanName);
      if (result === 'failed') {
        this.logger.error(
          `Backends not restored on ${cleanNamespace}/${cleanName}; Orchard retries within 10 minutes`
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to restore backends on ${cleanNamespace}/${cleanName}: ${k8sErrorMessage(error)}`
      );
    }

    try {
      await this.cleanupProtectionProxy(cleanNamespace);
    } catch (error) {
      console.error(`Failed to clean up protection proxy: ${error.message}`);
    }
  }

  async cleanupProtectionProxy(namespace: string, excludedIngressName?: string): Promise<void> {
    this.ensureKubeConfig();
    const cleanNamespace = String(namespace || '').trim();
    if (!cleanNamespace) return;

    const remaining = await this.prisma.ingress.count({
      where: {
        namespace: cleanNamespace,
        name: excludedIngressName ? { not: excludedIngressName } : undefined,
        OR: [{ protectionMode: { not: 'none' } }, { redirectTarget: { not: null } }]
      }
    });
    if (remaining > 0) return;

    const proxyServiceName = 'orchard-protection-proxy';
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      await coreApi.deleteNamespacedService(proxyServiceName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete protection proxy service: ${error.message}`);
      }
    }

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.deleteNamespacedCustomObject(
        'discovery.k8s.io',
        'v1',
        cleanNamespace,
        'endpointslices',
        `${proxyServiceName}-1`
      );
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete protection proxy endpoint slice: ${error.message}`);
      }
    }
  }

  private async ensureOrchardIngressAllowed(namespace: string): Promise<void> {
    const orchardSelector = {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'orchard' } }
    };

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    try {
      const np = await networkingApi.readNamespacedNetworkPolicy('default-deny-all', namespace);
      const from = np.body.spec?.ingress?.[0]?.from || [];
      const hasOrchard = from.some(
        (f: any) => f.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'orchard'
      );
      if (!hasOrchard) {
        from.push(orchardSelector);
        await networkingApi.replaceNamespacedNetworkPolicy('default-deny-all', namespace, np.body);
      }
    } catch (e: any) {
      if (e.response?.statusCode !== 404)
        this.logger.warn(`Failed to patch NetworkPolicy: ${e.message}`);
    }

    if (!(await this.kubernetes.isCiliumAvailable())) return;

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      const cnp: any = await customApi.getNamespacedCustomObject(
        'cilium.io',
        'v2',
        namespace,
        'ciliumnetworkpolicies',
        'allow-cilium-ingress'
      );
      const ingress = cnp.body?.spec?.ingress || [];
      const hasOrchard = ingress.some((rule: any) =>
        rule.fromEndpoints?.some(
          (ep: any) => ep.matchLabels?.['kubernetes.io/metadata.name'] === 'orchard'
        )
      );
      const hasHaproxy = ingress.some((rule: any) =>
        rule.fromEndpoints?.some(
          (ep: any) =>
            ep.matchLabels?.['kubernetes.io/metadata.name'] === 'network' &&
            ep.matchLabels?.['app.kubernetes.io/name'] === 'kubernetes-ingress'
        )
      );
      if (!hasOrchard || !hasHaproxy) {
        if (!hasOrchard) {
          ingress.push({
            fromEndpoints: [{ matchLabels: { 'kubernetes.io/metadata.name': 'orchard' } }]
          });
        }
        if (!hasHaproxy) {
          ingress.push({
            fromEndpoints: [
              {
                matchLabels: {
                  'kubernetes.io/metadata.name': 'network',
                  'app.kubernetes.io/name': 'kubernetes-ingress'
                }
              }
            ]
          });
        }
        cnp.body.spec.ingress = ingress;
        await customApi.replaceNamespacedCustomObject(
          'cilium.io',
          'v2',
          namespace,
          'ciliumnetworkpolicies',
          'allow-cilium-ingress',
          cnp.body
        );
      }
    } catch (e: any) {
      if (e.response?.statusCode !== 404)
        this.logger.warn(`Failed to patch CiliumNetworkPolicy: ${e.message}`);
    }
  }

  async createIngress(options: CreateIngressOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const name = String(options.name || '').trim();
    const host = String(options.host || '')
      .trim()
      .toLowerCase();
    const ingressClassName = String(options.ingressClassName || '').trim() || undefined;

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!name) {
      throw new BadRequestException('Ingress name is required');
    }

    if (!host) {
      throw new BadRequestException('Host is required');
    }

    const pathBackends =
      Array.isArray(options.paths) && options.paths.length > 0
        ? options.paths
        : [
            {
              path: String(options.path || '/').trim() || '/',
              pathType: String(options.pathType || 'Prefix').trim() || 'Prefix',
              serviceName: String(options.serviceName || '').trim(),
              servicePort: Number(options.servicePort)
            }
          ];

    if (
      !pathBackends[0].serviceName ||
      !Number.isInteger(pathBackends[0].servicePort) ||
      pathBackends[0].servicePort <= 0
    ) {
      throw new BadRequestException('Service name and port are required');
    }

    for (const pb of pathBackends) {
      const svcName = String(pb.serviceName || '').trim();
      const svcPort = Number(pb.servicePort);
      if (!svcName || !Number.isInteger(svcPort) || svcPort <= 0) {
        throw new BadRequestException('Each path must have a valid service name and port');
      }
    }

    const annotations: Record<string, string> = {};

    if (options.annotations) {
      for (const [key, value] of Object.entries(options.annotations)) {
        if (value === undefined || value === null) {
          continue;
        }
        const k = String(key);
        if (!ALLOWED_INGRESS_ANNOTATION_KEYS.has(k)) continue;
        if (!isSanctionedIssuerValue(k, String(value), CERT_CLUSTER_ISSUER)) continue;
        annotations[k] = String(value);
      }
    }

    const hasTls = options.tlsSecretName && options.tlsSecretName.trim().length > 0;

    if (options.basicAuth?.enabled && options.basicAuth.username && options.basicAuth.password) {
      const basicAuthSecretName = options.basicAuth.secretName || `${name}-basic-auth`;
      const targetService = pathBackends[0];
      await this.applyBasicAuth(
        namespace,
        name,
        basicAuthSecretName,
        options.basicAuth.username,
        options.basicAuth.password,
        String(targetService.serviceName).trim(),
        Number(targetService.servicePort)
      );
      annotations['orchard.my/basic-auth'] = 'true';
    }

    try {
      await this.deleteHttpsRedirectMiddleware(namespace, name);
    } catch (error) {
      console.error('[K8s] Failed to remove stale HTTPS redirect middleware:', error);
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const requestedTlsHosts =
      options.tlsHosts && options.tlsHosts.length > 0 ? options.tlsHosts : [host];
    const tlsHosts = hasTls ? requestedTlsHosts : [];

    const httpPaths = pathBackends
      .map((pb) => {
        const path = String(pb.path || '/').trim() || '/';
        const pathType = String(pb.pathType || 'Prefix').trim() || 'Prefix';
        return {
          path,
          pathType,
          backend: {
            service: {
              name: String(pb.serviceName).trim(),
              port: { number: Number(pb.servicePort) }
            }
          }
        };
      })
      .sort((a, b) => b.path.length - a.path.length);

    const ingressBody: k8s.V1Ingress = {
      metadata: {
        name,
        labels: {
          'leaf.dev/managed': 'true'
        },
        annotations: Object.keys(annotations).length > 0 ? annotations : undefined
      },
      spec: {
        ingressClassName,
        rules: [
          {
            host,
            http: {
              paths: httpPaths
            }
          }
        ]
      }
    };

    if (hasTls) {
      ingressBody.spec.tls = [
        {
          hosts: tlsHosts,
          secretName: options.tlsSecretName.trim()
        }
      ];
    }

    try {
      const response = await networkingApi.createNamespacedIngress(namespace, ingressBody);
      return response.body;
    } catch (error) {
      if (error.response?.statusCode === 409) {
        throw new BadRequestException({
          error: 'Ingress already exists',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create ingress',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to create ingress',
        message: error.message
      });
    }
  }

  async updateIngress(options: CreateIngressOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const name = String(options.name || '').trim();
    const host = String(options.host || '')
      .trim()
      .toLowerCase();
    const ingressClassName = String(options.ingressClassName || '').trim() || undefined;

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!name) {
      throw new BadRequestException('Ingress name is required');
    }

    if (!host) {
      throw new BadRequestException('Host is required');
    }

    const pathBackends =
      Array.isArray(options.paths) && options.paths.length > 0
        ? options.paths
        : [
            {
              path: String(options.path || '/').trim() || '/',
              pathType: String(options.pathType || 'Prefix').trim() || 'Prefix',
              serviceName: String(options.serviceName || '').trim(),
              servicePort: Number(options.servicePort)
            }
          ];

    if (
      !pathBackends[0].serviceName ||
      !Number.isInteger(pathBackends[0].servicePort) ||
      pathBackends[0].servicePort <= 0
    ) {
      throw new BadRequestException('Service name and port are required');
    }

    for (const pb of pathBackends) {
      const svcName = String(pb.serviceName || '').trim();
      const svcPort = Number(pb.servicePort);
      if (!svcName || !Number.isInteger(svcPort) || svcPort <= 0) {
        throw new BadRequestException('Each path must have a valid service name and port');
      }
    }

    const annotations: Record<string, string> = {};

    if (options.annotations) {
      for (const [key, value] of Object.entries(options.annotations)) {
        if (value === undefined || value === null) {
          continue;
        }
        const k = String(key);
        if (!ALLOWED_INGRESS_ANNOTATION_KEYS.has(k)) continue;
        if (!isSanctionedIssuerValue(k, String(value), CERT_CLUSTER_ISSUER)) continue;
        annotations[k] = String(value);
      }
    }

    const hasTls = options.tlsSecretName && options.tlsSecretName.trim().length > 0;

    if (options.basicAuth?.enabled && options.basicAuth.username && options.basicAuth.password) {
      const basicAuthSecretName = options.basicAuth.secretName || `${name}-basic-auth`;
      const targetService = pathBackends[0];
      await this.applyBasicAuth(
        namespace,
        name,
        basicAuthSecretName,
        options.basicAuth.username,
        options.basicAuth.password,
        String(targetService.serviceName).trim(),
        Number(targetService.servicePort)
      );
      annotations['orchard.my/basic-auth'] = 'true';
    } else if (options.basicAuth?.enabled === false) {
      try {
        const basicAuthSecretName = options.basicAuth.secretName || `${name}-basic-auth`;
        await this.deleteBasicAuthSecret(namespace, basicAuthSecretName);
        await this.deleteBasicAuthMiddleware(namespace, name);
      } catch (error) {
        console.error('[K8s] Failed to remove basic auth:', error);
      }
    }

    try {
      await this.deleteHttpsRedirectMiddleware(namespace, name);
    } catch (error) {
      console.error('[K8s] Failed to remove HTTPS redirect middleware:', error);
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const requestedTlsHosts =
      options.tlsHosts && options.tlsHosts.length > 0 ? options.tlsHosts : [host];
    const tlsHosts = hasTls ? requestedTlsHosts : [];

    const httpPaths = pathBackends
      .map((pb) => {
        const path = String(pb.path || '/').trim() || '/';
        const pathType = String(pb.pathType || 'Prefix').trim() || 'Prefix';
        return {
          path,
          pathType,
          backend: {
            service: {
              name: String(pb.serviceName).trim(),
              port: { number: Number(pb.servicePort) }
            }
          }
        };
      })
      .sort((a, b) => b.path.length - a.path.length);

    const ingressBody: k8s.V1Ingress = {
      metadata: {
        name,
        labels: {
          'leaf.dev/managed': 'true'
        },
        annotations: Object.keys(annotations).length > 0 ? annotations : undefined
      },
      spec: {
        ingressClassName,
        rules: [
          {
            host,
            http: {
              paths: httpPaths
            }
          }
        ]
      }
    };

    if (hasTls) {
      ingressBody.spec.tls = [
        {
          hosts: tlsHosts,
          secretName: options.tlsSecretName.trim()
        }
      ];
    } else {
      ingressBody.spec.tls = [];
    }

    try {
      const response = await networkingApi.replaceNamespacedIngress(name, namespace, ingressBody);
      return response.body;
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Ingress not found',
          message: `Ingress ${name} not found in namespace ${namespace}`,
          details: error.response.body
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update ingress',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to update ingress',
        message: error.message
      });
    }
  }

  /**
   * Repoint an existing Ingress at a different TLS secret.
   *
   * A merge patch of only the TLS block and the issuer annotation, rather than
   * a full re-apply, so a reconcile cannot disturb paths, backends or the
   * protection-proxy wiring that live on the same object.
   */
  async patchIngressTls(
    namespace: string,
    ingressName: string,
    tls: { secretName: string; hosts: string[] } | null,
    clusterIssuer: string | null
  ): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const body = {
      metadata: {
        annotations: { 'cert-manager.io/cluster-issuer': clusterIssuer ?? null }
      },
      spec: {
        tls: tls ? [{ secretName: tls.secretName, hosts: tls.hosts }] : []
      }
    };

    await networkingApi.patchNamespacedIngress(
      ingressName,
      namespace,
      body,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  async readIngress(namespace: string, name: string) {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    try {
      const response = await networkingApi.readNamespacedIngress(name, namespace);
      return response.body;
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async deleteIngress(namespace: string, name: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Ingress name is required');
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    try {
      await networkingApi.deleteNamespacedIngress(cleanName, cleanNamespace);

      await this.deleteBasicAuthSecret(cleanNamespace, `${cleanName}-basic-auth`);
      await this.deleteBasicAuthMiddleware(cleanNamespace, cleanName);
      await this.cleanupProtectionProxy(cleanNamespace, cleanName);

      return {
        success: true,
        namespace: cleanNamespace,
        name: cleanName,
        deleted: true
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return {
          success: true,
          namespace: cleanNamespace,
          name: cleanName,
          deleted: false
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete ingress',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete ingress',
        message: error.message
      });
    }
  }

  async deleteService(namespace: string, name: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      await coreApi.deleteNamespacedService(cleanName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete service ${cleanName} in ${cleanNamespace}:`, error);
      }
    }
  }

  async updateServicePorts(options: UpdateServicePortsOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const deploymentName = String(options.deploymentName || '').trim();
    const serviceName = String(options.serviceName || '').trim();
    const sanitizedPorts = sanitizePortEntries(Array.isArray(options.ports) ? options.ports : []);
    const normalizedPorts = ensureUniqueServicePorts(sanitizedPorts);

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!deploymentName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const existingDeployment = await appsApi.readNamespacedDeployment(deploymentName, namespace);
      const containers = existingDeployment.body.spec?.template?.spec?.containers;

      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Deployment "${deploymentName}" has no containers`
        });
      }

      const containerName = containers[0].name;
      const existingContainer = containers[0];

      const updatedContainer = {
        ...existingContainer,
        ports: normalizedPorts.map((port) => ({
          name: port.name,
          containerPort: port.containerPort,
          protocol: port.protocol
        }))
      };

      const deploymentPatch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'orchard.my/service-updated-at': new Date().toISOString()
              }
            },
            spec: {
              containers: existingDeployment.body.spec.template.spec.containers.map((c: any) =>
                c.name === containerName ? updatedContainer : c
              )
            }
          }
        }
      };

      await appsApi.patchNamespacedDeployment(
        deploymentName,
        namespace,
        deploymentPatch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/merge-patch+json' }
        }
      );

      const existingService = await coreApi.readNamespacedService(serviceName, namespace);
      const serviceType = existingService.body.spec?.type || 'ClusterIP';
      const existingPorts = existingService.body.spec?.ports || [];
      const existingNodePortByName = new Map<string, number>();
      const existingNodePortBySignature = new Map<string, number>();

      existingPorts.forEach((entry) => {
        if (
          typeof entry.nodePort === 'number' &&
          Number.isInteger(entry.nodePort) &&
          entry.nodePort > 0
        ) {
          if (entry.name && entry.name.length > 0) {
            existingNodePortByName.set(entry.name, entry.nodePort);
          }
          const signature = `${entry.port}-${entry.protocol ?? 'TCP'}`.toLowerCase();
          existingNodePortBySignature.set(signature, entry.nodePort);
        }
      });

      const portsForService = normalizedPorts.map((port) => {
        let nodePortValue: number | undefined;

        if (serviceType === 'NodePort' || serviceType === 'LoadBalancer') {
          const signature = `${port.servicePort}-${port.protocol}`.toLowerCase();
          const fallbackNodePort =
            nodePortValue ??
            existingNodePortByName.get(port.name) ??
            existingNodePortBySignature.get(signature);
          if (fallbackNodePort) {
            nodePortValue = fallbackNodePort;
          }
        } else {
          nodePortValue = undefined;
        }

        return {
          ...port,
          nodePort: nodePortValue
        };
      });

      try {
        await coreApi.deleteNamespacedService(serviceName, namespace);
      } catch (deleteError) {
        if (deleteError.response?.statusCode !== 404) {
          throw deleteError;
        }
      }

      const serviceBody: k8s.V1Service = {
        metadata: {
          name: serviceName,
          labels: existingService.body.metadata?.labels,
          annotations: existingService.body.metadata?.annotations
        },
        spec: {
          type: serviceType,
          selector: existingService.body.spec?.selector || {
            'app.kubernetes.io/name': deploymentName
          },
          ports: portsForService.map((port) => {
            const entry: k8s.V1ServicePort = {
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol
            };
            if ((serviceType === 'NodePort' || serviceType === 'LoadBalancer') && port.nodePort) {
              entry.nodePort = port.nodePort;
            }
            return entry;
          })
        }
      };

      if (existingService.body.spec?.clusterIP) {
        serviceBody.spec.clusterIP = existingService.body.spec.clusterIP;
      }
      if (existingService.body.spec?.clusterIPs) {
        serviceBody.spec.clusterIPs = existingService.body.spec.clusterIPs;
      }
      if (existingService.body.spec?.ipFamilyPolicy) {
        serviceBody.spec.ipFamilyPolicy = existingService.body.spec.ipFamilyPolicy;
      }
      if (existingService.body.spec?.ipFamilies) {
        serviceBody.spec.ipFamilies = existingService.body.spec.ipFamilies;
      }

      try {
        await coreApi.createNamespacedService(namespace, serviceBody);
      } catch (createError) {
        const original: k8s.V1Service = {
          metadata: {
            name: serviceName,
            labels: existingService.body.metadata?.labels,
            annotations: existingService.body.metadata?.annotations
          },
          spec: existingService.body.spec
        };
        await coreApi.createNamespacedService(namespace, original).catch((restoreError) => {
          this.logger.error(
            `Service ${namespace}/${serviceName} couldn't be recreated with the new ports or restored as it was: ${restoreError?.message ?? restoreError}`
          );
        });
        throw new BadRequestException({
          error: 'Failed to recreate service',
          message: createError.response?.body?.message || createError.message,
          details: createError.response?.body
        });
      }

      const updatedService = await coreApi.readNamespacedService(serviceName, namespace);
      const updatedType = updatedService.body.spec?.type || serviceType;
      const mappedPorts = mapServicePorts(updatedService.body.spec?.ports, portsForService);

      let externalIp: string | null = null;
      if (updatedType === 'LoadBalancer') {
        const statusRecord = updatedService.body.status?.loadBalancer?.ingress?.[0];
        externalIp = statusRecord?.ip || statusRecord?.hostname || null;
      } else if (updatedType === 'NodePort') {
        externalIp = await this.getDefaultNodeIp(coreApi);
      }

      return {
        success: true,
        namespace,
        deploymentName,
        serviceName,
        type: updatedType,
        ports: mappedPorts,
        externalIp
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Resource not found',
          message: `Deployment or service not found in namespace ${namespace}`
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update service',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to update service',
        message: error.message
      });
    }
  }

  async createDeploymentService(options: CreateAdditionalServiceOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const deploymentName = String(options.deploymentName || '').trim();
    const serviceName = String(options.serviceName || '').trim();
    const sanitizedPorts = ensureUniqueServicePorts(
      sanitizePortEntries(Array.isArray(options.ports) ? options.ports : [])
    );

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!deploymentName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    if (sanitizedPorts.length === 0) {
      throw new BadRequestException('At least one service port is required');
    }

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const deployment = await appsApi.readNamespacedDeployment(deploymentName, namespace);
      const containers = deployment.body.spec?.template?.spec?.containers;

      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'Deployment has no containers',
          message: `Deployment "${deploymentName}" has no containers`
        });
      }

      const targetContainer = containers[0];
      const existingPorts = Array.isArray(targetContainer.ports) ? targetContainer.ports : [];
      const mergedPorts: k8s.V1ContainerPort[] = [];
      const usedSignatures = new Set<string>();
      const usedNames = new Set<string>();

      const allocateName = (desired: string, fallbackIndex: number): string => {
        let base = (desired || `port-${fallbackIndex}`).trim().toLowerCase();
        base = base.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
        if (!base) base = `port-${fallbackIndex}`;
        if (base.length > 63) base = truncateK8sName(base, 63) || `port-${fallbackIndex}`;
        if (!usedNames.has(base)) {
          usedNames.add(base);
          return base;
        }
        let suffix = 1;
        while (true) {
          const tag = `-${suffix++}`;
          const trimmed = base.substring(0, Math.max(1, 63 - tag.length));
          const candidate = `${trimmed}${tag}`;
          if (!usedNames.has(candidate)) {
            usedNames.add(candidate);
            return candidate;
          }
        }
      };

      existingPorts.forEach((port, index) => {
        if (
          typeof port.containerPort === 'number' &&
          Number.isInteger(port.containerPort) &&
          port.containerPort > 0
        ) {
          const protocol = (port.protocol || 'TCP').toUpperCase();
          const signature = `${port.containerPort}-${protocol}`;
          usedSignatures.add(signature);
          mergedPorts.push({
            name: allocateName(port.name || '', index + 1),
            containerPort: port.containerPort,
            protocol
          });
        }
      });

      sanitizedPorts.forEach((port, index) => {
        const signature = `${port.containerPort}-${port.protocol}`;
        if (!usedSignatures.has(signature)) {
          mergedPorts.push({
            name: allocateName(port.name || '', existingPorts.length + index + 1),
            containerPort: port.containerPort,
            protocol: port.protocol
          });
          usedSignatures.add(signature);
        }
      });

      await appsApi.patchNamespacedDeployment(
        deploymentName,
        namespace,
        {
          spec: {
            template: {
              metadata: {
                annotations: {
                  'orchard.my/service-updated-at': new Date().toISOString()
                }
              },
              spec: {
                containers: containers.map((container) =>
                  container.name === targetContainer.name
                    ? {
                        ...container,
                        ports: mergedPorts
                      }
                    : container
                )
              }
            }
          }
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/merge-patch+json' }
        }
      );

      const selectorLabels = deployment.body.spec?.selector?.matchLabels ||
        deployment.body.spec?.template?.metadata?.labels || {
          'app.kubernetes.io/name': deploymentName
        };

      const requestedType = options.type || 'ClusterIP';

      const serviceBody: k8s.V1Service = {
        metadata: {
          name: serviceName,
          labels: {
            ...(deployment.body.spec?.template?.metadata?.labels || {}),
            'orchard.my/managed': 'true'
          }
        },
        spec: {
          type: requestedType,
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

      try {
        await coreApi.createNamespacedService(namespace, serviceBody);
      } catch (createError) {
        throw new BadRequestException({
          error: 'Failed to create service',
          message: createError.response?.body?.message || createError.message,
          details: createError.response?.body
        });
      }

      const createdService = await coreApi.readNamespacedService(serviceName, namespace);
      const mappedPorts = mapServicePorts(createdService.body.spec?.ports, sanitizedPorts);
      const serviceType = createdService.body.spec?.type || requestedType;

      let externalIp: string | null = null;
      if (serviceType === 'LoadBalancer') {
        const statusRecord = createdService.body.status?.loadBalancer?.ingress?.[0];
        externalIp = statusRecord?.ip || statusRecord?.hostname || null;
      } else if (serviceType === 'NodePort') {
        externalIp = await this.getDefaultNodeIp(coreApi);
      }

      return {
        type: serviceType,
        ports: mappedPorts,
        externalIp
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${deploymentName} not found in namespace ${namespace}`
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create service',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to create service',
        message: error.message
      });
    }
  }

  async deleteDeploymentService(options: DeleteDeploymentServiceOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const deploymentName = String(options.deploymentName || '').trim();
    const serviceName = String(options.serviceName || '').trim();

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!deploymentName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    try {
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

      try {
        await coreApi.deleteNamespacedService(serviceName, namespace);
      } catch (deleteError) {
        if (deleteError.response?.statusCode !== 404) {
          throw new BadRequestException({
            error: 'Failed to delete service',
            message: deleteError.response?.body?.message || deleteError.message,
            details: deleteError.response?.body
          });
        }
      }

      if (options.remainingPorts) {
        const sanitizedRemaining = ensureUniqueServicePorts(
          sanitizePortEntries(options.remainingPorts)
        );

        try {
          const deployment = await appsApi.readNamespacedDeployment(deploymentName, namespace);
          const containers = deployment.body.spec?.template?.spec?.containers;

          if (containers && containers.length > 0) {
            const targetContainer = containers[0];
            const updatedContainer = {
              ...targetContainer,
              ports: sanitizedRemaining.map((port) => ({
                name: port.name,
                containerPort: port.containerPort,
                protocol: port.protocol
              }))
            };

            await appsApi.patchNamespacedDeployment(
              deploymentName,
              namespace,
              {
                spec: {
                  template: {
                    metadata: {
                      annotations: {
                        'orchard.my/service-updated-at': new Date().toISOString()
                      }
                    },
                    spec: {
                      containers: containers.map((container) =>
                        container.name === targetContainer.name ? updatedContainer : container
                      )
                    }
                  }
                }
              },
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                headers: { 'Content-Type': 'application/merge-patch+json' }
              }
            );
          }
        } catch (deploymentError) {
          if (deploymentError.response?.statusCode !== 404) {
            throw new BadRequestException({
              error: 'Failed to update deployment ports',
              message: deploymentError.response?.body?.message || deploymentError.message,
              details: deploymentError.response?.body
            });
          }
        }
      }

      return {
        success: true
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete service',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete service',
        message: error.message
      });
    }
  }

  async updateServiceExposure(options: UpdateServiceExposureOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const serviceName = String(options.serviceName || '').trim();
    let type: 'LoadBalancer' | 'NodePort' | 'ClusterIP' = 'ClusterIP';
    if (options.type === 'LoadBalancer') type = 'LoadBalancer';
    else if (options.type === 'NodePort') type = 'NodePort';

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    try {
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const patch = {
        spec: {
          type
        }
      };

      await coreApi.patchNamespacedService(
        serviceName,
        namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: {
            'Content-Type': 'application/strategic-merge-patch+json'
          }
        }
      );

      const updated = await coreApi.readNamespacedService(serviceName, namespace);
      let externalIp: string | null = null;
      if (type === 'LoadBalancer') {
        const ingressStatus = updated.body.status?.loadBalancer?.ingress?.[0];
        externalIp = ingressStatus?.ip || ingressStatus?.hostname || null;
      } else if (type === 'NodePort') {
        externalIp = await this.getDefaultNodeIp(coreApi);
      }
      const ports = mapServicePorts(updated.body.spec?.ports);

      return {
        success: true,
        namespace,
        serviceName,
        type,
        externalIp,
        ports
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update service exposure',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to update service exposure',
        message: error.message
      });
    }
  }

  publicServiceName(clusterName: string): string {
    return truncateK8sName(`${clusterName}-public`, 63);
  }

  private async shareWith(namespace: string, ip: string): Promise<ShareWith> {
    return this.ipPolicy ? this.ipPolicy.shareWith(namespace, ip) : '*';
  }

  private async alignSharedIp(
    coreApi: k8s.CoreV1Api,
    ip: string,
    shareWith: ShareWith
  ): Promise<void> {
    let services: k8s.V1Service[];
    try {
      const { body } = await coreApi.listServiceForAllNamespaces(
        undefined,
        undefined,
        undefined,
        'app.kubernetes.io/managed-by=orchard'
      );
      services = body.items;
    } catch (e: any) {
      this.logger.warn(`Couldn't list services sharing ${ip}: ${e?.message ?? e}`);
      return;
    }
    const annotations = sharedIpAnnotations(ip, shareWith);
    for (const svc of servicesToAlign(services, ip, shareWith)) {
      const name = svc.metadata?.name;
      const namespace = svc.metadata?.namespace;
      if (!name || !namespace) continue;
      try {
        await coreApi.patchNamespacedService(
          name,
          namespace,
          { metadata: { annotations } },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
        );
      } catch (e: any) {
        this.logger.warn(`Couldn't align IP sharing on ${namespace}/${name}: ${e?.message ?? e}`);
      }
    }
  }

  async publicEndpointStatuses(
    namespace: string,
    names: string[]
  ): Promise<Map<string, PublicEndpointStatus>> {
    const unique = [...new Set(names.filter(Boolean))];
    const out = new Map<string, PublicEndpointStatus>();
    if (unique.length === 0) return out;
    try {
      this.ensureKubeConfig();
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      const readService = async (name: string): Promise<k8s.V1Service | null> => {
        try {
          return (await coreApi.readNamespacedService(name, namespace)).body;
        } catch (e: any) {
          if ((e?.statusCode ?? e?.response?.statusCode) === 404) return null;
          throw e;
        }
      };
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), PUBLIC_ENDPOINT_READ_MS);
        timer.unref?.();
      });
      const [services, events, pods] = await Promise.race([
        Promise.all([
          Promise.all(unique.map(readService)),
          coreApi
            .listNamespacedEvent(
              namespace,
              undefined,
              undefined,
              undefined,
              'involvedObject.kind=Service'
            )
            .then((r) => r.body.items),
          coreApi
            .listPodForAllNamespaces(
              undefined,
              undefined,
              undefined,
              `${SERVICELB_NAMESPACE_LABEL}=${namespace}`
            )
            .then((r) => r.body.items)
        ]),
        timeout
      ]).finally(() => clearTimeout(timer));
      const now = Date.now();
      unique.forEach((name, i) => {
        out.set(
          name,
          publicEndpointStatus({
            service: services[i],
            events,
            balancerPods: pods.filter((p) => p.metadata?.labels?.[SERVICELB_NAME_LABEL] === name),
            now
          })
        );
      });
      return out;
    } catch (e: any) {
      this.logger.warn(`Couldn't read public endpoints in ${namespace}: ${k8sErrorMessage(e)}`);
      for (const name of unique) out.set(name, UNKNOWN_PUBLIC_ENDPOINT);
      return out;
    }
  }

  async listInUsePortsOnIp(loadBalancerIp: string): Promise<number[]> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.listServiceForAllNamespaces();
    const ports = new Set<number>();
    for (const svc of body.items) {
      if (svc.spec?.type !== 'LoadBalancer') continue;
      const svcIp = svc.spec?.loadBalancerIP || svc.status?.loadBalancer?.ingress?.[0]?.ip;
      if (svcIp !== loadBalancerIp) continue;
      for (const p of svc.spec?.ports || []) {
        if (typeof p.port === 'number') ports.add(p.port);
      }
    }
    return Array.from(ports);
  }

  async exposeCnpgClusterPublic(options: {
    namespace: string;
    clusterName: string;
    loadBalancerIp: string;
    port: number;
  }): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const svcName = this.publicServiceName(options.clusterName);
    const shareWith = await this.shareWith(options.namespace, options.loadBalancerIp);

    const body: k8s.V1Service = {
      metadata: {
        name: svcName,
        namespace: options.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'cnpg.io/cluster': options.clusterName
        },
        annotations: sharedIpAnnotations(options.loadBalancerIp, shareWith)
      },
      spec: {
        type: 'LoadBalancer',
        loadBalancerIP: options.loadBalancerIp,
        externalTrafficPolicy: 'Cluster',
        selector: {
          'cnpg.io/cluster': options.clusterName,
          'cnpg.io/instanceRole': 'primary'
        },
        ports: [{ name: 'postgres', port: options.port, targetPort: 5432, protocol: 'TCP' }]
      }
    };

    await this.alignSharedIp(coreApi, options.loadBalancerIp, shareWith);

    try {
      await coreApi.readNamespacedService(svcName, options.namespace);
      await coreApi.replaceNamespacedService(svcName, options.namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedService(options.namespace, body);
      } else {
        throw e;
      }
    }
  }

  async unexposeCnpgCluster(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const svcName = this.publicServiceName(clusterName);
    try {
      await coreApi.deleteNamespacedService(svcName, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
    try {
      await this.deletePublicDatabaseNetworkPolicy(namespace, clusterName);
    } catch (e: any) {
      console.error(`[K8s/netpol] Failed to delete public NetworkPolicy: ${e?.message}`);
    }
  }

  async upsertPublicDatabaseNetworkPolicy(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = publicDatabasePolicyName(clusterName);
    const body = publicDatabasePolicy(namespace, clusterName);

    try {
      await networkingApi.readNamespacedNetworkPolicy(name, namespace);
      await networkingApi.replaceNamespacedNetworkPolicy(name, namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await networkingApi.createNamespacedNetworkPolicy(namespace, body);
      } else {
        throw e;
      }
    }
  }

  async deletePublicDatabaseNetworkPolicy(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = publicDatabasePolicyName(clusterName);
    try {
      await networkingApi.deleteNamespacedNetworkPolicy(name, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  private readonly PUBLIC_DEPLOYMENT_BASE_DOMAIN = optionalDomain(
    process.env.PUBLIC_DEPLOYMENT_DOMAIN
  );

  publicDeploymentBaseDomain(): string {
    return this.PUBLIC_DEPLOYMENT_BASE_DOMAIN;
  }

  publicDeploymentServiceName(deploymentName: string, port: number, protocol: string): string {
    const proto = protocol.toLowerCase() === 'udp' ? 'u' : 't';
    return truncateK8sName(`${deploymentName}-pub-${proto}${port}`, 63);
  }

  async exposeDeploymentPortPublic(options: {
    namespace: string;
    deploymentName: string;
    loadBalancerIp: string;
    publicPort: number;
    targetPort: number;
    protocol: string;
    preserveClientIp?: boolean;
  }): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const protocol = options.protocol.toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    const svcName = this.publicDeploymentServiceName(
      options.deploymentName,
      options.publicPort,
      protocol
    );
    const shareWith = await this.shareWith(options.namespace, options.loadBalancerIp);

    const body: k8s.V1Service = {
      metadata: {
        name: svcName,
        namespace: options.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'app.kubernetes.io/name': options.deploymentName,
          'orchard.my/public-deployment': options.deploymentName
        },
        annotations: sharedIpAnnotations(options.loadBalancerIp, shareWith)
      },
      spec: {
        type: 'LoadBalancer',
        loadBalancerIP: options.loadBalancerIp,
        externalTrafficPolicy: options.preserveClientIp ? 'Local' : 'Cluster',
        selector: {
          'app.kubernetes.io/name': options.deploymentName
        },
        ports: [
          {
            name: `pub-${protocol.toLowerCase()}-${options.publicPort}`,
            port: options.publicPort,
            targetPort: options.targetPort,
            protocol
          }
        ]
      }
    };

    await this.alignSharedIp(coreApi, options.loadBalancerIp, shareWith);

    try {
      await coreApi.readNamespacedService(svcName, options.namespace);
      await coreApi.replaceNamespacedService(svcName, options.namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedService(options.namespace, body);
      } else {
        throw e;
      }
    }
  }

  async unexposeDeploymentPortPublic(options: {
    namespace: string;
    deploymentName: string;
    publicPort: number;
    protocol: string;
  }): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const protocol = options.protocol.toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    const svcName = this.publicDeploymentServiceName(
      options.deploymentName,
      options.publicPort,
      protocol
    );
    try {
      await coreApi.deleteNamespacedService(svcName, options.namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  async unexposeAllDeploymentPortsPublic(namespace: string, deploymentName: string): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      const [current, legacy] = await Promise.all([
        coreApi.listNamespacedService(
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `orchard.my/public-deployment=${deploymentName}`
        ),
        coreApi.listNamespacedService(
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `orchard.dev/public-deployment=${deploymentName}`
        )
      ]);
      const seen = new Set<string>();
      for (const svc of [...current.body.items, ...legacy.body.items]) {
        const n = svc.metadata?.name;
        if (!n || seen.has(n)) continue;
        seen.add(n);
        try {
          await coreApi.deleteNamespacedService(n, namespace);
        } catch (e: any) {
          if (e.response?.statusCode !== 404) throw e;
        }
      }
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  async upsertPublicDeploymentNetworkPolicy(
    namespace: string,
    deploymentName: string,
    ports: { port: number; protocol: string }[]
  ): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = publicDeploymentPolicyName(deploymentName);

    if (ports.length === 0) {
      await this.deletePublicDeploymentNetworkPolicy(namespace, deploymentName);
      return;
    }

    const body = publicDeploymentPolicy(namespace, deploymentName, ports);

    try {
      await networkingApi.readNamespacedNetworkPolicy(name, namespace);
      await networkingApi.replaceNamespacedNetworkPolicy(name, namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await networkingApi.createNamespacedNetworkPolicy(namespace, body);
      } else {
        throw e;
      }
    }
  }

  async deletePublicDeploymentNetworkPolicy(
    namespace: string,
    deploymentName: string
  ): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = publicDeploymentPolicyName(deploymentName);
    try {
      await networkingApi.deleteNamespacedNetworkPolicy(name, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }
}
