import 'reflect-metadata';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dump } from 'js-yaml';

const OUT = resolve(
  process.argv[2] ?? join(__dirname, '../../../infra/charts/orchard/policies/fixtures/benign')
);
const NS = 'orchard-policy-test';
const SERVER = 'system:serviceaccount:orchard:orchard-server';

process.env.TENANT_RUNTIME_CLASS = 'gvisor';
process.env.K8S_INGRESS_CLASS = 'haproxy';
process.env.CERT_CLUSTER_ISSUER = 'letsencrypt-prod';
process.env.DEVICE_CLASSES = JSON.stringify([
  { resource: 'nvidia.com/gpu', label: 'NVIDIA GPU', runtimeClassName: 'nvidia' },
  { resource: 'squat.ai/dri', label: 'Intel GPU' }
]);

type Call = { method: string; args: any[] };

function fakeKc(calls: Call[], responders: Record<string, (args: any[]) => any> = {}) {
  return {
    makeApiClient() {
      return new Proxy(
        {},
        {
          get(_t, method: string) {
            return async (...args: any[]) => {
              calls.push({ method, args });
              const r = responders[method];
              if (r) return r(args);
              if (method.startsWith('read')) {
                const e: any = new Error('nf');
                e.response = { statusCode: 404 };
                throw e;
              }
              return { body: { items: [], status: {}, spec: {}, metadata: {} } };
            };
          }
        }
      );
    },
    getCurrentCluster() {
      return { server: 'https://x' };
    }
  } as any;
}

const written: string[] = [];

function emit(name: string, object: any, directives: Record<string, string> = {}, old?: any) {
  const obj = JSON.parse(JSON.stringify(object));
  obj.metadata = { ...(obj.metadata ?? {}) };
  if (obj.kind !== 'Namespace') obj.metadata.namespace = NS;
  else obj.metadata.name = obj.metadata.name === 'x' ? NS : obj.metadata.name;
  const header = Object.entries(directives)
    .map(([k, v]) => `# ${k}: ${v}\n`)
    .join('');
  const oldDoc = old
    ? `---\n${dump(JSON.parse(JSON.stringify(old)), { lineWidth: 120, noRefs: true })}`
    : '';
  writeFileSync(
    join(OUT, `${name}.yaml`),
    `${header}${dump(obj, { lineWidth: 120, noRefs: true })}${oldDoc}`
  );
  written.push(name);
}

function podFrom(deployment: any, suffix = '') {
  const t = deployment.spec.template;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${deployment.metadata.name}-7d9f8c5b6-x2k4p${suffix}`,
      labels: { ...t.metadata.labels, 'pod-template-hash': '7d9f8c5b6' }
    },
    spec: JSON.parse(JSON.stringify(t.spec))
  };
}

async function section(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e: any) {
    console.error(`[gen] ${label} failed: ${e?.stack ?? e}`);
    process.exitCode = 1;
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const { K8sWorkloadService } = await import('../src/kubernetes/k8s-workload.service');
  const { K8sNetworkService } = await import('../src/kubernetes/k8s-network.service');
  const { K8sCnpgService } = await import('../src/kubernetes/k8s-cnpg.service');
  const { K8sNamespaceService } = await import('../src/kubernetes/k8s-namespace.service');
  const { KubernetesService } = await import('../src/kubernetes/kubernetes.service');
  const sp = await import('../src/kubernetes/security-policies');
  const { recoveryClusterSpec } = await import('../src/kubernetes/cnpg-recovery');

  const mkKube = (calls: Call[], responders = {}) => {
    const kube: any = new (KubernetesService as any)({});
    kube.kc = fakeKc(calls, responders);
    return kube;
  };

  await section('workload', async () => {
    for (const [tag, serviceType] of [
      ['clusterip', 'ClusterIP'],
      ['nodeport', 'NodePort']
    ] as const) {
      const calls: Call[] = [];
      const kube = mkKube(calls, {
        readNamespacedService: () => ({ body: { spec: { ports: [] }, status: {} } })
      });
      const svc = new (K8sWorkloadService as any)({}, kube, {}, {});
      await svc.createDeployment({
        namespace: NS,
        name: `app-${tag}`,
        image: 'registry.example.com/org/app:1',
        replicas: 2,
        ports: [{ name: 'http', containerPort: 8080, servicePort: 80, protocol: 'TCP' }],
        env: [{ key: 'A', value: 'b' }],
        serviceType,
        volumes: [
          {
            name: 'data',
            type: 'pvc',
            mountPath: '/data',
            pvcName: `app-${tag}-data`,
            storageSize: '5Gi'
          },
          { name: 'scratch', type: 'emptyDir', mountPath: '/tmp' }
        ]
      });
      const deployment = calls.find((c) => c.method === 'createNamespacedDeployment')!.args[1];
      emit(`pod-app-${tag}`, podFrom(deployment));
      const service = calls.find((c) => c.method === 'createNamespacedService')!.args[1];
      emit(
        `service-app-${tag}`,
        { apiVersion: 'v1', kind: 'Service', ...service },
        { user: SERVER }
      );
      const pvc = calls.find((c) => c.method === 'createNamespacedPersistentVolumeClaim');
      if (pvc)
        emit(
          `pvc-app-${tag}`,
          { apiVersion: 'v1', kind: 'PersistentVolumeClaim', ...pvc.args[1] },
          { user: SERVER }
        );
    }
  });

  await section('devices', async () => {
    for (const [tag, devices] of [
      ['gpu', { 'nvidia.com/gpu': 1 }],
      ['dri', { 'squat.ai/dri': 1 }]
    ] as const) {
      const calls: Call[] = [];
      const kube = mkKube(calls, {
        readNamespacedService: () => ({ body: { spec: { ports: [] }, status: {} } })
      });
      const svc = new (K8sWorkloadService as any)({}, kube, {}, {});
      await svc.createDeployment({
        namespace: NS,
        name: `app-${tag}`,
        image: 'registry.example.com/org/app:1',
        replicas: 1,
        ports: [{ name: 'http', containerPort: 8096, servicePort: 80, protocol: 'TCP' }],
        serviceType: 'ClusterIP',
        resources: { cpuMilli: 2000, memoryBytes: 2048 * 1024 * 1024 },
        devices
      });
      const deployment = calls.find((c) => c.method === 'createNamespacedDeployment')!.args[1];
      emit(`pod-app-${tag}`, podFrom(deployment));
    }
  });

  await section('tailscale', async () => {
    const calls: Call[] = [];
    const kube = mkKube(calls, {
      readNamespacedEndpoints: () => ({
        body: { subsets: [{ addresses: [{ ip: '10.0.0.1' }], ports: [{ port: 6443 }] }] }
      })
    });
    const svc = new (K8sWorkloadService as any)({}, kube, {}, {});
    await svc.addTailscaleSidecar(NS, 'app', 'tskey-auth-X', 'host', [
      { port: 80, targetPort: 8080, protocol: 'TCP' }
    ]);
    const deployment = calls.find((c) => c.method === 'createNamespacedDeployment')!.args[1];
    emit('pod-tailscale-proxy', podFrom(deployment));
    const np = calls.find((c) => c.method === 'createNamespacedNetworkPolicy')!.args[1];
    emit(
      'networkpolicy-tailscale',
      { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', ...np },
      { user: SERVER }
    );
    const rb = calls.find((c) => c.method === 'createNamespacedRoleBinding')!.args[1];
    emit(
      'rolebinding-tailscale',
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', ...rb },
      { user: SERVER }
    );
  });

  await section('network', async () => {
    const calls: Call[] = [];
    const kube = mkKube(calls, {
      readNamespacedService: (args: any[]) =>
        args[0] === 'server'
          ? { body: { spec: { clusterIP: '10.43.1.2' } } }
          : (() => {
              const e: any = new Error('nf');
              e.response = { statusCode: 404 };
              throw e;
            })()
    });
    const net = new (K8sNetworkService as any)({}, kube, { onAcquired() {} });
    await net.createIngress({
      namespace: NS,
      name: 'app-ing',
      host: 'app.apps.example.com',
      path: '/',
      pathType: 'Prefix',
      serviceName: 'app',
      servicePort: 80,
      tlsSecretName: 'leaf-cert-1234',
      tlsHosts: ['app.apps.example.com'],
      ingressClassName: 'haproxy',
      annotations: {
        'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
        'acme.cert-manager.io/http01-edit-in-place': 'true'
      }
    });
    const ing = calls.find((c) => c.method === 'createNamespacedIngress')!.args[1];
    emit(
      'ingress-custom-domain',
      { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', ...ing },
      { user: SERVER }
    );
    const wild = JSON.parse(JSON.stringify(ing));
    wild.metadata.name = 'app-wild';
    delete wild.metadata.annotations['cert-manager.io/cluster-issuer'];
    wild.spec.tls = [
      { hosts: ['app.apps.example.com'], secretName: 'wildcard-apps-example-com-tls' }
    ];
    emit(
      'ingress-wildcard-host',
      { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', ...wild },
      { user: SERVER }
    );

    calls.length = 0;
    await net.exposeDeploymentPortPublic({
      namespace: NS,
      deploymentName: 'app',
      loadBalancerIp: '203.0.113.7',
      publicPort: 31234,
      targetPort: 8080,
      protocol: 'TCP'
    });
    const lb = calls
      .find((c) => c.method.endsWith('Service') && /create|replace/.test(c.method))!
      .args.slice(-1)[0];
    emit('service-public-port-lb', { apiVersion: 'v1', kind: 'Service', ...lb }, { user: SERVER });

    calls.length = 0;
    await net.exposeCnpgClusterPublic({
      namespace: NS,
      clusterName: 'db',
      loadBalancerIp: '203.0.113.7',
      port: 31235
    });
    const dblb = calls
      .find((c) => c.method.endsWith('Service') && /create|replace/.test(c.method))!
      .args.slice(-1)[0];
    emit('service-public-db-lb', { apiVersion: 'v1', kind: 'Service', ...dblb }, { user: SERVER });
    emit(
      'service-public-db-lb-cluster-admin',
      { apiVersion: 'v1', kind: 'Service', ...dblb },
      { user: 'admin', groups: 'system:masters,system:authenticated' }
    );

    calls.length = 0;
    await net.enableProtectionProxy(NS, 'app-ing', []);
    const proxySvc = calls.find((c) => c.method === 'createNamespacedService')?.args[1];
    if (proxySvc)
      emit(
        'service-protection-proxy',
        { apiVersion: 'v1', kind: 'Service', ...proxySvc },
        { user: SERVER }
      );
    const slice = calls.find(
      (c) => c.method === 'createNamespacedCustomObject' && c.args[3] === 'endpointslices'
    )?.args[4];
    if (slice) emit('endpointslice-protection-proxy', slice, { user: SERVER });
  });

  await section('network policies', async () => {
    const wrap = (np: any) => ({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      ...np
    });
    emit(
      'networkpolicy-default-deny',
      wrap(sp.tenantDenyPolicy(NS, { ingressNamespaces: ['network', 'orchard'] })),
      { user: SERVER }
    );
    emit(
      'networkpolicy-default-deny-protection',
      wrap(sp.tenantDenyPolicy(NS, { ingressNamespaces: ['network'], allowProtectionProxy: true })),
      { user: SERVER }
    );
    emit('networkpolicy-project-databases', wrap(sp.projectDatabasePolicy(NS, [NS])), {
      user: SERVER
    });
    emit(
      'networkpolicy-database-platform',
      wrap(
        sp.databasePlatformPolicy(NS, {
          metricsNamespace: 'monitoring',
          storage: { namespace: 'orchard', port: 9000 } as any,
          apiserver: { ips: ['10.0.0.1'], ports: [6443] } as any,
          operatorNamespace: 'postgresql'
        })
      ),
      { user: SERVER }
    );
    emit('networkpolicy-public-database', wrap(sp.publicDatabasePolicy(NS, 'db')), {
      user: SERVER
    });
    emit(
      'networkpolicy-public-deployment',
      wrap(sp.publicDeploymentPolicy(NS, 'app', [{ port: 8080, protocol: 'TCP' }])),
      { user: SERVER }
    );
  });

  await section('namespace', async () => {
    const calls: Call[] = [];
    const kube = mkKube(calls);
    const ns = new (K8sNamespaceService as any)({}, kube, {});
    await ns.createNamespace('x');
    const body = calls.find((c) => c.method === 'createNamespace')!.args[0];
    const before = {
      apiVersion: 'v1',
      kind: 'Namespace',
      ...body,
      metadata: { ...body.metadata, name: NS }
    };
    emit(
      'namespace-update-labels',
      {
        ...before,
        metadata: {
          ...before.metadata,
          labels: { ...body.metadata.labels, 'orchard.my/current-org': 'org-1' }
        }
      },
      { operation: 'UPDATE', user: SERVER },
      before
    );
    const rb = calls.find((c) => c.method === 'createNamespacedRoleBinding')?.args[1];
    if (rb)
      emit(
        'rolebinding-tenant-secrets',
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', ...rb },
        { user: SERVER }
      );
  });

  await section('cnpg', async () => {
    const calls: Call[] = [];
    const kube = mkKube(calls);
    const svc: any = Object.create((K8sCnpgService as any).prototype);
    Object.defineProperty(svc, 'kc', { get: () => kube.kc });
    svc.logger = { warn() {}, log() {}, error() {} };
    svc.ensureKubeConfig = () => {};
    svc.ensureCnpgOperatorIngress = async () => {};
    svc.ensureDatabasePlatformPolicy = async () => {};
    svc.CNPG_GROUP = 'postgresql.cnpg.io';
    svc.CNPG_VERSION = 'v1';
    svc.CNPG_PLURAL = 'clusters';
    svc.buildAppSecretName = (n: string) => `${n}-app`;
    await svc.createCnpgCluster({
      namespace: NS,
      clusterName: 'db',
      dbName: 'app',
      dbUser: 'u_app',
      dbPassword: 'x',
      storageSize: '10Gi',
      parameters: { max_connections: '200', work_mem: '8MB' },
      sharedPreloadLibraries: ['pg_stat_statements'],
      imageName: 'ghcr.io/cloudnative-pg/postgresql:17.5',
      importFrom: {
        host: 'src.example.com',
        user: 'u',
        password: 'p',
        database: 'x',
        sslMode: 'require'
      }
    });
    const cluster = calls
      .find(
        (c) => /CustomObject/.test(c.method) && c.args.some((a: any) => a && a.kind === 'Cluster')
      )!
      .args.find((a: any) => a && a.kind === 'Cluster');
    emit('cnpg-cluster', cluster, { user: SERVER });
    const defaulted = JSON.parse(JSON.stringify(cluster));
    defaulted.spec.postgresql = {
      ...defaulted.spec.postgresql,
      syncReplicaElectionConstraint: { enabled: false },
      parameters: {
        ...defaulted.spec.postgresql.parameters,
        archive_mode: 'on',
        archive_timeout: '5min',
        dynamic_shared_memory_type: 'posix',
        full_page_writes: 'on',
        log_destination: 'csvlog',
        log_directory: '/controller/log',
        log_filename: 'postgres',
        log_rotation_age: '0',
        log_rotation_size: '0',
        log_truncate_on_rotation: 'false',
        logging_collector: 'on',
        max_parallel_workers: '32',
        max_replication_slots: '32',
        max_worker_processes: '32',
        shared_memory_type: 'mmap',
        shared_preload_libraries: 'pg_stat_statements',
        ssl_max_protocol_version: 'TLSv1.3',
        ssl_min_protocol_version: 'TLSv1.3',
        wal_keep_size: '512MB',
        wal_level: 'logical',
        wal_log_hints: 'on',
        wal_receiver_timeout: '5s',
        wal_sender_timeout: '5s'
      }
    };
    emit('cnpg-cluster-webhook-defaults', defaulted, { user: SERVER });
    emit('cnpg-cluster-webhook-defaults-update', defaulted, {
      user: 'system:serviceaccount:postgresql:cloudnative-pg',
      operation: 'UPDATE'
    });
    emit(
      'cnpg-cluster-recovery',
      {
        apiVersion: 'postgresql.cnpg.io/v1',
        kind: 'Cluster',
        metadata: { name: 'db-restore', labels: { 'app.kubernetes.io/managed-by': 'orchard' } },
        spec: recoveryClusterSpec({
          instances: 1,
          imageName: 'ghcr.io/cloudnative-pg/postgresql:17.5',
          storageSize: '10Gi',
          parameters: { shared_buffers: '64MB' },
          bootstrap: { recovery: { source: 'origin' } },
          externalClusters: [{ name: 'origin' }],
          archive: null
        })
      },
      { user: SERVER }
    );
    const pvc = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'db-1', labels: { 'cnpg.io/cluster': 'db', 'cnpg.io/pvcRole': 'PG_DATA' } },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '500Gi' } },
        storageClassName: 'longhorn'
      }
    };
    emit('pvc-cnpg-data', pvc, {
      user: 'system:serviceaccount:postgresql:cloudnative-pg',
      groups: 'system:serviceaccounts,system:serviceaccounts:postgresql,system:authenticated'
    });
    emit(
      'pod-cnpg-instance',
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: 'db-1',
          labels: {
            'cnpg.io/cluster': 'db',
            'cnpg.io/podRole': 'instance',
            'cnpg.io/instanceRole': 'primary',
            'app.kubernetes.io/managed-by': 'orchard'
          }
        },
        spec: {
          containers: [
            {
              name: 'postgres',
              image: 'ghcr.io/cloudnative-pg/postgresql:17.5',
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                runAsNonRoot: true
              }
            }
          ],
          initContainers: [
            {
              name: 'bootstrap-controller',
              image: 'ghcr.io/cloudnative-pg/cloudnative-pg:1.26',
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }
            }
          ],
          volumes: [
            { name: 'pgdata', persistentVolumeClaim: { claimName: 'db-1' } },
            { name: 'scratch-data', emptyDir: {} },
            { name: 'shm', emptyDir: { medium: 'Memory' } },
            { name: 'projected', projected: { sources: [] } }
          ]
        }
      },
      {
        user: 'system:serviceaccount:postgresql:cloudnative-pg',
        groups: 'system:serviceaccounts,system:serviceaccounts:postgresql,system:authenticated'
      }
    );
  });

  await section('legacy postgres container', async () => {
    const calls: Call[] = [];
    const kube = mkKube(calls);
    const svc: any = Object.create((K8sCnpgService as any).prototype);
    Object.defineProperty(svc, 'kc', { get: () => kube.kc });
    svc.logger = { warn() {}, log() {}, error() {} };
    svc.ensureKubeConfig = () => {};
    svc.kubernetes = kube;
    svc.createPVC = (ns: string, n: string, s: string) => kube.createPVC(ns, n, s);
    svc.pgBackRestStanza = (n: string) => n;
    await svc.createPostgresContainer({
      namespace: NS,
      name: 'legacy-pg',
      dbName: 'app',
      dbUser: 'u',
      dbPassword: 'p',
      storageSize: '5Gi',
      r2: { endpoint: 'https://r2.example.com', bucket: 'b', accessKey: 'a', secretKey: 's' }
    });
    const deployment = calls.find((c) => c.method === 'createNamespacedDeployment')!.args[1];
    emit('pod-legacy-postgres', podFrom(deployment), { warns: 'orchard-tenant-pods-hardening' });
  });

  await section('job', async () => {
    const { JobsOrchestratorService } = await import('../src/jobs/jobs-orchestrator.service');
    const orch: any = Object.create((JobsOrchestratorService as any).prototype);
    const job = orch.buildStepJobManifest(
      {
        jobId: '11111111-1111-1111-1111-111111111111',
        projectId: '22222222-2222-2222-2222-222222222222',
        organizationId: 'org',
        namespace: NS
      },
      {
        stepOrder: 1,
        name: 'migrate',
        type: 'image',
        image: 'registry.example.com/org/app:1',
        shell: 'echo hi',
        envVars: [{ key: 'A', value: 'b' }],
        cpuMilli: 100,
        memoryBytes: 128 * 1024 ** 2,
        timeoutSeconds: 300,
        retries: 0
      },
      { envSecret: 'job-env', name: 'job-1' }
    );
    emit('pod-job-step', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'job-1-abcde', labels: job.spec.template.metadata.labels },
      spec: job.spec.template.spec
    });
  });

  emit(
    'pod-acme-solver',
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'cm-acme-http-solver-abcde',
        labels: { 'acme.cert-manager.io/http01-solver': 'true' }
      },
      spec: {
        containers: [
          {
            name: 'acmesolver',
            image: 'quay.io/jetstack/cert-manager-acmesolver:v1.17.0',
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
              readOnlyRootFilesystem: true,
              runAsNonRoot: true,
              seccompProfile: { type: 'RuntimeDefault' }
            }
          }
        ]
      }
    },
    { user: 'system:serviceaccount:cert-manager:cert-manager' }
  );
  emit(
    'service-acme-solver',
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'cm-acme-http-solver-abcde',
        labels: { 'acme.cert-manager.io/http01-solver': 'true' }
      },
      spec: {
        type: 'NodePort',
        selector: { 'acme.cert-manager.io/http01-solver': 'true' },
        ports: [{ port: 8089, targetPort: 8089 }]
      }
    },
    { user: 'system:serviceaccount:cert-manager:cert-manager' }
  );
  emit(
    'ingress-acme-solver',
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: 'cm-acme-http-solver-abcde',
        labels: { 'acme.cert-manager.io/http01-solver': 'true' },
        annotations: {
          'nginx.ingress.kubernetes.io/whitelist-source-range': '0.0.0.0/0,::/0',
          'kubernetes.io/ingress.class': 'haproxy'
        }
      },
      spec: {
        ingressClassName: 'haproxy',
        rules: [
          {
            host: 'app.example.com',
            http: {
              paths: [
                {
                  path: '/.well-known/acme-challenge/tok',
                  pathType: 'ImplementationSpecific',
                  backend: {
                    service: { name: 'cm-acme-http-solver-abcde', port: { number: 8089 } }
                  }
                }
              ]
            }
          }
        ]
      }
    },
    { user: 'system:serviceaccount:cert-manager:cert-manager' }
  );
  emit(
    'service-protection-proxy-app',
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'myapp-protection-proxy',
        labels: { 'orchard.my/managed': 'true', 'orchard.my/type': 'protection-proxy' }
      },
      spec: { clusterIP: 'None', ports: [{ port: 3001, targetPort: 3001, protocol: 'TCP' }] }
    },
    { user: SERVER }
  );
  emit(
    'pvc-restore-400gi',
    {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'restored-data', labels: { 'app.kubernetes.io/managed-by': 'orchard' } },
      spec: {
        accessModes: ['ReadWriteOnce'],
        volumeMode: 'Filesystem',
        storageClassName: 'longhorn',
        resources: { requests: { storage: '400Gi' } }
      }
    },
    { user: SERVER }
  );
  emit(
    'service-cnpg-rw',
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'db-rw', labels: { 'cnpg.io/cluster': 'db' } },
      spec: {
        type: 'ClusterIP',
        selector: { 'cnpg.io/cluster': 'db', 'cnpg.io/instanceRole': 'primary' },
        ports: [{ name: 'postgres', port: 5432, targetPort: 5432 }]
      }
    },
    {
      user: 'system:serviceaccount:postgresql:cloudnative-pg',
      groups: 'system:serviceaccounts,system:serviceaccounts:postgresql,system:authenticated'
    }
  );
  emit(
    'endpointslice-controller',
    {
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      metadata: { name: 'app-abcde', labels: { 'kubernetes.io/service-name': 'app' } },
      addressType: 'IPv4',
      endpoints: [{ addresses: ['10.42.0.5'] }],
      ports: [{ port: 8080, protocol: 'TCP' }]
    },
    { user: 'system:serviceaccount:kube-system:endpointslice-controller' }
  );

  console.log(`[gen] wrote ${written.length} fixtures to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
