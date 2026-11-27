import { Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { K8sNamespaceService } from '../kubernetes/k8s-namespace.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import {
  platformMetricsNamespace,
  r2ProxyNamespace,
  tenantEgressNamespaces,
  tenantIngressNamespaces,
  tenantIngressPorts
} from '../kubernetes/security-policies';
import { hardenedSecurityContext } from '../kubernetes/trusted-images';
import { podLogText } from '../kubernetes/pod-log-text';
import { ABUSE_QUOTA_NAME, DENY_POLICY_NAME, ORG_QUOTA_NAME } from './doctor.checks';
import { SELFTEST_LABEL } from './cluster-reader';
import { errorMessage, isNotFound } from './doctor.types';
import {
  probeScript,
  type PodTopology,
  type ServiceTopology,
  type Topology
} from './selftest.plan';
import {
  LISTENER_PORT,
  type NamespaceShape,
  type PodState,
  type SelfTestCluster,
  type SelfTestPodInput
} from './selftest.types';

const DEFAULT_PROBE_IMAGE =
  'docker.io/library/debian:12.15-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc';
const DEFAULT_LISTENER_IMAGE =
  'docker.io/library/busybox:1.38.0@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4';
const MAX_PLATFORM_PORTS_PER_SERVICE = 6;
const MAX_INGRESS_PODS = 10;
const GiB = 1024 ** 3;

function csv(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function externalTarget(raw = process.env.DOCTOR_EXTERNAL_TARGET): {
  host: string;
  port: number;
} {
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec((raw || '').trim());
  if (match && Number(match[2]) > 0 && Number(match[2]) < 65536) {
    return { host: match[1], port: Number(match[2]) };
  }
  return { host: '1.1.1.1', port: 443 };
}

export function selfTestPod(input: SelfTestPodInput, env = process.env): k8s.V1Pod {
  const listener = input.role === 'listener';
  const image = listener
    ? env.DOCTOR_LISTENER_IMAGE || DEFAULT_LISTENER_IMAGE
    : env.DOCTOR_PROBE_IMAGE || DEFAULT_PROBE_IMAGE;
  const runtimeClassName = env.TENANT_RUNTIME_CLASS || undefined;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: input.name,
      labels: { [SELFTEST_LABEL]: 'true', 'app.kubernetes.io/managed-by': 'orchard' }
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 0,
      activeDeadlineSeconds: 240,
      ...(runtimeClassName ? { runtimeClassName } : {}),
      containers: [
        {
          name: input.role,
          image,
          imagePullPolicy: 'IfNotPresent',
          command: listener
            ? ['httpd', '-f', '-p', String(LISTENER_PORT), '-h', '/tmp']
            : ['bash', '-c', probeScript()],
          env: Object.entries(input.env ?? {}).map(([name, value]) => ({ name, value })),
          securityContext: hardenedSecurityContext(),
          resources: {
            requests: { cpu: '10m', memory: '32Mi' },
            limits: { cpu: '250m', memory: '128Mi' }
          }
        }
      ]
    }
  };
}

function podDetail(pod: k8s.V1Pod): string {
  const waiting = (pod.status?.containerStatuses ?? [])
    .map((c) => c.state?.waiting)
    .find((w) => w?.reason);
  if (waiting)
    return `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ''}`.slice(0, 300);
  const unschedulable = (pod.status?.conditions ?? []).find(
    (c) => c.type === 'PodScheduled' && c.status === 'False'
  );
  if (unschedulable) return `${unschedulable.reason}: ${unschedulable.message ?? ''}`.slice(0, 300);
  return pod.status?.reason ? String(pod.status.reason).slice(0, 300) : '';
}

export class KubeSelfTestCluster implements SelfTestCluster {
  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly namespaces: K8sNamespaceService
  ) {}

  private get core(): k8s.CoreV1Api {
    return this.kubernetes.getCoreV1Api();
  }

  async createTenantNamespace(name: string, labels: Record<string, string>): Promise<void> {
    const created = await this.namespaces.createNamespace(name, undefined, labels);
    if (!created.created) throw new Error(`namespace ${name} already exists`);
    await this.namespaces.applyNamespaceQuota({
      namespace: name,
      cpuLimitMilli: 2000,
      memoryLimitBytes: 2 * GiB,
      maxPods: 10,
      maxServices: 5
    });
  }

  async namespaceShape(name: string): Promise<NamespaceShape> {
    this.kubernetes.ensureKubeConfig();
    const kc = this.kubernetes.kc!;
    const [ns, policies, quotas] = await Promise.all([
      this.core.readNamespace(name),
      kc.makeApiClient(k8s.NetworkingV1Api).listNamespacedNetworkPolicy(name),
      this.core.listNamespacedResourceQuota(name)
    ]);
    const labels = ns.body.metadata?.labels ?? {};
    const quotaNames = quotas.body.items.map((q) => q.metadata?.name);
    return {
      managed: labels['orchard.my/managed'] === 'true',
      denyPolicy: policies.body.items.some((p) => p.metadata?.name === DENY_POLICY_NAME),
      quota: quotaNames.includes(ORG_QUOTA_NAME) && quotaNames.includes(ABUSE_QUOTA_NAME),
      podSecurity: labels['pod-security.kubernetes.io/enforce'] ?? null
    };
  }

  async createPod(namespace: string, pod: SelfTestPodInput): Promise<void> {
    await this.core.createNamespacedPod(namespace, selfTestPod(pod));
  }

  async podState(namespace: string, name: string): Promise<PodState> {
    const { body } = await this.core.readNamespacedPod(name, namespace);
    return {
      phase: body.status?.phase ?? 'Unknown',
      ip: body.status?.podIP ?? null,
      detail: podDetail(body)
    };
  }

  async podLog(namespace: string, name: string): Promise<string> {
    const { body } = await this.core.readNamespacedPodLog(name, namespace);
    return podLogText(body);
  }

  async deleteNamespace(name: string): Promise<void> {
    try {
      await this.core.deleteNamespace(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async namespaceExists(name: string): Promise<boolean> {
    try {
      await this.core.readNamespace(name);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async listSelfTestNamespaces(): Promise<{ name: string; createdAt: number }[]> {
    const { body } = await this.core.listNamespace(
      undefined,
      undefined,
      undefined,
      undefined,
      SELFTEST_LABEL
    );
    return body.items
      .filter((ns) => ns.metadata?.name)
      .map((ns) => ({
        name: ns.metadata!.name!,
        createdAt: ns.metadata?.creationTimestamp
          ? new Date(ns.metadata.creationTimestamp).getTime()
          : 0
      }));
  }

  async discover(sameIp: string, otherIp: string): Promise<Topology> {
    const ingressNamespaces = tenantEgressNamespaces(tenantIngressNamespaces());
    const servingPorts = tenantIngressPorts();
    const [apiserver, nodes, platformServices, ingressPods] = await Promise.all([
      this.kubernetes.apiserverEndpoints().catch(() => null),
      this.nodes(),
      this.platformServices(ingressNamespaces),
      this.ingressPods(ingressNamespaces)
    ]);
    return {
      apiserver,
      nodes,
      platformServices,
      ingressPods,
      ingressServingPorts: servingPorts,
      ingressExtraPorts: csv(process.env.DOCTOR_INGRESS_DEBUG_PORTS)
        .map(Number)
        .filter((p) => Number.isInteger(p) && p > 0 && p < 65536),
      metadataAddress: '169.254.169.254',
      external: externalTarget(),
      sameNamespaceListener: { ip: sameIp, port: LISTENER_PORT },
      otherTenantListener: { ip: otherIp, port: LISTENER_PORT }
    };
  }

  private async nodes() {
    const { body } = await this.core.listNode();
    return body.items.map((node) => ({
      name: node.metadata?.name ?? 'node',
      addresses: (node.status?.addresses ?? [])
        .filter((a) => a.type === 'InternalIP' || a.type === 'ExternalIP')
        .map((a) => a.address)
    }));
  }

  private async platformServices(skip: string[]): Promise<ServiceTopology[]> {
    const configured = csv(process.env.DOCTOR_PLATFORM_NAMESPACES);
    const namespaces = (
      configured.length
        ? configured
        : [
            process.env.ORCHARD_SERVER_NAMESPACE || 'orchard',
            r2ProxyNamespace(),
            platformMetricsNamespace()
          ]
    ).filter((ns) => !skip.includes(ns));
    const out: ServiceTopology[] = [];
    for (const namespace of [...new Set(namespaces)]) {
      try {
        const { body } = await this.core.listNamespacedService(namespace);
        for (const svc of body.items) {
          const ip = svc.spec?.clusterIP;
          if (!ip || ip === 'None') continue;
          const ports = (svc.spec?.ports ?? [])
            .filter((p) => (p.protocol ?? 'TCP') === 'TCP')
            .map((p) => p.port)
            .slice(0, MAX_PLATFORM_PORTS_PER_SERVICE);
          if (ports.length === 0) continue;
          out.push({ namespace, name: svc.metadata?.name ?? 'service', ip, ports });
        }
      } catch (error) {
        if (!isNotFound(error)) {
          throw new Error(`could not list services in ${namespace}: ${errorMessage(error)}`);
        }
      }
    }
    return out;
  }

  private async ingressPods(namespaces: string[]): Promise<PodTopology[]> {
    const out: PodTopology[] = [];
    for (const namespace of namespaces) {
      try {
        const { body } = await this.core.listNamespacedPod(namespace);
        for (const pod of body.items) {
          const ip = pod.status?.podIP;
          if (!ip || pod.status?.phase !== 'Running' || pod.spec?.hostNetwork) continue;
          const ports = (pod.spec?.containers ?? [])
            .flatMap((c) => c.ports ?? [])
            .filter((p) => (p.protocol ?? 'TCP') === 'TCP')
            .map((p) => p.containerPort);
          out.push({ namespace, name: pod.metadata?.name ?? 'pod', ip, ports });
          if (out.length >= MAX_INGRESS_PODS) return out;
        }
      } catch (error) {
        if (!isNotFound(error)) {
          throw new Error(`could not list pods in ${namespace}: ${errorMessage(error)}`);
        }
      }
    }
    return out;
  }
}

@Injectable()
export class SelfTestClusterFactory {
  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly namespaces: K8sNamespaceService
  ) {}

  create(): SelfTestCluster {
    return new KubeSelfTestCluster(this.kubernetes, this.namespaces);
  }
}
