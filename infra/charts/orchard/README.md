# Orchard Helm chart

Chart published to: `oci://ghcr.io/hackclub/orchard/charts/orchard`

The chart version is the highest service version, assigned at release.

This chart installs the Orchard app stack into a Kubernetes cluster:
frontend + server + MCP + Traefik IngressRoutes, Redis, a CloudNativePG `Cluster`,
the image-builder namespace/RBAC/secrets, and the orchard-metrics stack
(VictoriaMetrics + vmagent + kube-state-metrics + node-exporter).

It does **not** install operators or CRDs, and it does not check for them, so a
missing one fails `helm install`. With the default values the cluster must already
have:

- **CloudNativePG operator**: provides `postgresql.cnpg.io/v1` `Cluster`
- **cert-manager** and a DNS-01 `ClusterIssuer` named `letsencrypt-dns01-wildcard`,
  for the wildcard `Certificate`s. Change `certificates.issuer`, or set
  `certificates.enabled: false` and bring the TLS Secrets yourself.
- **A `network` namespace.** `certificates.namespace` defaults to it. With `createNamespace: true` the chart creates it if missing and
  keeps it on uninstall. With `false`, create it yourself.
- **An OCI registry** for builds to push to and nodes to pull from (`builders.harbor.*`,
  plus `DOCKER_REGISTRY_PUSH` and `DOCKER_REGISTRY_PULL` in `server.env`).
- A default StorageClass, or an explicit `storageClass` for each volume below.
  Every volume the chart creates uses the cluster default when its
  `storageClass` is empty, which is the default.

Traefik (the `traefik.io/v1alpha1` CRDs and a `websecure` entryPoint) is needed only
for `ingress.enabled` and `mcp.ingress`. Tenant apps use any ingress class
(`tenant.ingressClass`), but app HTTP metrics come only from HAProxy and Traefik.

---

## 1. Quick install

These steps were run end to end on one node: k3s v1.36.5 with its bundled Traefik,
Helm 4.3.1, Let's Encrypt over HTTP-01, and a registry behind an ingress on the same
node. The run reached a working sign-in, an app built from a repository and served
over HTTPS, and two healthy databases. That run set `CNPG_OPERATOR_NAMESPACE` in
`server.env`. The `tenant.cnpgOperatorNamespace` value used below sets the same
variable. Its rendered output is checked in CI, but it has not been run on a cluster.

These were not tested on this path: backups with the `objectStorage` values, MCP,
public database exposure, and other ingress controllers. Hack Club runs Orchard with
this chart on a six-node Talos Linux cluster.

To install the prerequisites, including the commands and a ClusterIssuer example,
refer to [Install the prerequisites](https://docs.orchard.hackclub.com/start/install/#install-the-prerequisites).

**1. Create the namespaces and the Secret.** The Secret holds two values the
server needs at boot. `jwt` signs sessions and must be at least 32 characters.
`enc` encrypts stored secrets, so keep it safe: a new key makes everything already
encrypted unreadable.

```bash
kubectl create namespace orchard
kubectl create namespace network
kubectl -n orchard create secret generic orchard-secrets \
  --from-literal=jwt="$(openssl rand -base64 48 | tr -d '\n')" \
  --from-literal=enc="$(openssl rand -base64 32 | tr -d '\n')"
```

**2. Write `my-values.yaml`.** CI renders this exact file, from
`examples/minimal-values.yaml`, on every chart change:

```yaml
createNamespace: false
signupMode: invite_only
datadog:
  enabled: false
ingress:
  host: orchard.example.com
  tls:
    enabled: true
    issuerRef: { name: letsencrypt, kind: ClusterIssuer }
gateway:
  http:
    appDomain: apps.example.com
certificates:
  enabled: false
mcp:
  enabled: false
tenant:
  storageClass: local-path
  ingressClass: traefik
  ingressNamespaces: kube-system,orchard
  cnpgOperatorNamespace: cnpg-system
  certClusterIssuer: letsencrypt
server:
  env:
    - { name: FRONTEND_URL, value: https://orchard.example.com }
    - name: JWT_SECRET
      valueFrom: { secretKeyRef: { name: orchard-secrets, key: jwt } }
    - name: SECRETS_ENCRYPTION_KEY
      valueFrom: { secretKeyRef: { name: orchard-secrets, key: enc } }
```

Replace the hostnames, then check these against your cluster:

| Value                       | What to set                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant.storageClass`       | A class from `kubectl get storageclass`, or `''` for the cluster default                                                                                                                                                |
| `tenant.ingressClass`       | A class from `kubectl get ingressclass`                                                                                                                                                                                 |
| `tenant.ingressNamespaces`  | The namespace your ingress controller's pods run in, then `orchard`. The Traefik bundled with k3s runs in `kube-system`. To find the namespace, run `kubectl get pods -A -l app.kubernetes.io/name=traefik`. Tenant namespaces deny traffic by default, so with the wrong one apps are unreachable and HTTP-01 certificates are not issued |
| `tenant.ingressPorts` | `""` | TCP ports tenant pods may reach on the ingress namespaces, as `TENANT_INGRESS_PORTS`. Empty means `80,443,8000,8080,8443`. The controller's stats and pprof ports stay closed. |
| `tenant.egressBlockPorts` | `""` | Outbound TCP ports tenant pods may not use on the internet, as `TENANT_EGRESS_BLOCK_PORTS`, comma-separated. Empty or `none` blocks nothing. |
| `tenant.denyEntities` | `""` | Cilium entities tenant pods may not reach, as `TENANT_DENY_ENTITIES`. Empty means `host,remote-node,kube-apiserver`. `none` turns the policy off. |
| `tenant.extraDenyCidrs` | `""` | Extra IPv4 addresses or CIDRs added to the egress deny list, as `PLATFORM_EXTRA_DENY_CIDRS`. The server already adds node addresses, apiserver endpoints and pod CIDRs. |
| `tenant.cnpgOperatorNamespace` | The namespace where CloudNativePG runs, usually `cnpg-system`. With the wrong one, the tenant network policy blocks the operator, and databases show `Instance Status Extraction Error` |
| `tenant.certClusterIssuer`  | A ClusterIssuer from `kubectl get clusterissuer`, also used in `ingress.tls.issuerRef`                                                                                                                                  |
| `certificates.enabled`      | Leave `false` unless you have a DNS-01 issuer for wildcards. The default needs one named `letsencrypt-dns01-wildcard`                                                                                                   |
| `mcp.enabled`               | Leave `false` to start. On, it needs the extra settings below                                                                                                                                                           |

**3. Install and wait for the API.**

```bash
helm install orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard -f my-values.yaml
kubectl -n orchard rollout status deploy/server --timeout=10m
```

**4. Get the claim link.** The server logs one on first boot, but only once and
only on one replica, so mint one instead:

```bash
kubectl -n orchard exec deploy/server -- node dist/scripts/mint-claim-link.js
```

Keeping `createNamespace: true`, the default, makes the chart render `orchard`
and any missing `network` namespace itself, so pass `--create-namespace` and
create the Secret after the install. The server waits for it. A `network`
namespace that already exists is left alone, and one the chart made survives
`helm uninstall`.

**Upgrades.** On Helm 4, pass `--server-side=false` to `helm upgrade`. The server
updates the `buildkit-config` ConfigMap when it runs a build, so a server-side
upgrade after the first build fails with a conflict. Helm 3 does not have this flag.

**Builds** need these:

- A registry in `builders.harbor`, and `DOCKER_REGISTRY_PUSH`, `DOCKER_REGISTRY_PULL`
  and `REGISTRY_PROJECT` in `server.env`.
- An entry in `builders.registryEgress` for the registry's namespace. A registry
  behind an ingress in the same cluster also needs one for the ingress controller,
  or the push fails with `connection refused`. So does S3 storage behind an ingress
  in the same cluster, or `orchard up` builds fail at `context-fetch`.
- Registry credentials on every node. On k3s, that is
  `/etc/rancher/k3s/registries.yaml`. Orchard does not add a pull secret to app pods
  for this registry, so without them the pod fails with `no basic auth credentials`.
  `REGISTRY_PULL_SECRET_NAME` does not change this: it names the Secret that build
  jobs use to push.

**Backups** need object storage. Set `objectStorage.local.enabled: true` for a store
inside the cluster, or configure external storage. Refer to
[Object storage](#object-storage-objectstoragelocal).

**MCP** needs `mcp.enabled: true`, `mcp.ingress.host`, and `JWT_SECRET` and
`MCP_SERVICE_TOKEN` in `mcp.env`, with the same `MCP_SERVICE_TOKEN` in `server.env`.
This was not tested on this path.

For the steps in full, refer to
[Turn on image builds](https://docs.orchard.hackclub.com/start/install/#turn-on-image-builds).

Inspect what will be applied first:

```bash
helm template orchard oci://ghcr.io/hackclub/orchard/charts/orchard -f my-values.yaml | less
```

[Install on an existing cluster](https://docs.orchard.hackclub.com/start/install/#install-on-an-existing-cluster) walks through the rest.

---

## 2. Storage classes

Every volume uses the cluster's default StorageClass unless you name one. To
pin them all to a class that is not the default (k3s ships only `local-path`,
and it is the default there):

```yaml
postgres:
  storage: { storageClass: <sc-name> }
redis:
  storageClass: <sc-name>
builders:
  localCache: { storageClass: <sc-name> }
metrics:
  victoriametrics:
    storage: { storageClass: <sc-name> }
logs:
  victorialogs:
    storage: { storageClass: <sc-name> }
trivy:
  storage: { storageClass: <sc-name> }
objectStorage:
  local:
    storage: { storageClass: <sc-name> }
```

Upgrading from a chart that defaulted to `longhorn`: a StorageClass cannot
change on a live StatefulSet or PVC, so when the value is empty the chart reads
the class off the existing Postgres `Cluster`, the VictoriaMetrics StatefulSet
and the BuildKit cache PVC and keeps it. Set the value explicitly to move to a
new class on a fresh volume.

---

## 3. What lands where

| Namespace          | Resources |
|--------------------|-----------|
| `orchard`          | `frontend` / `server` / `mcp` Deployments + Services, Redis Deployment + PVC, Traefik `IngressRoute`s, CNPG `Cluster` (`orchard-db`) |
| `network`          | Wildcard `Certificate`s, and Gateways when `gateway.enabled` is on. Created by the chart only with `createNamespace: true`, and kept on uninstall. |
| `orchard-builders` | SA, RBAC, Harbor + R2 secrets, BuildKit ConfigMap, ResourceQuota, LimitRange, NetworkPolicy |
| `orchard-metrics`  | VictoriaMetrics StatefulSet, vmagent, kube-state-metrics, node-exporter DaemonSet, VictoriaLogs StatefulSet, Vector DaemonSet |
| `orchard-scans`    | Only with `trivy.enabled`: Trivy server Deployment + Service + cache PVC, the scan jobs, server Role for their Secrets, NetworkPolicies |
| `orchard-r2-proxy` | Only when `r2Proxy.enabled` and it has an upstream: the backup proxy Deployment + Service, its upstream and database Secrets, NetworkPolicy |
| `orchard-object-storage` | Only with `objectStorage.local.enabled`: versitygw Deployment + Service + data PVC, root-credentials Secret, the bucket Job, NetworkPolicy |
| `orchard-fc-builders` | Only with `fcBuilder.enabled`: the Firecracker builder StatefulSet, its Secrets, NetworkPolicy |
| `orchard-sandboxes` | Only with `sandbox.install` or `sandbox.enabled`: machine quota, LimitRange, NetworkPolicy, RBAC |
| `orchard-netpol` | Only with `networkPolicy.enforcer.enabled`: the `kube-router` policy enforcer DaemonSet and its ServiceAccount, bound to the `orchard-kube-router` ClusterRole |
| cluster-scoped     | `ClusterRole`/`ClusterRoleBinding` for builder management and metrics scraping |

The server deployment gets `DATABASE_URL` injected automatically from the
CNPG-managed secret `orchard-db-app` (key `uri`).

Routing (Traefik IngressRoute on `Host(ingress.host, ...ingress.extraHosts)`):

- `PathPrefix(/apiv1)` → `server:3001`
- everything else      → `frontend:3000`

---

## 4. Values reference

The keys most installs touch, with defaults from `values.yaml`. `values.yaml` itself
is the complete list. Each third-party image default below is a version tag pinned to
its multi-arch index digest (`repo:tag@sha256:…`) in `values.yaml`; the tables show the
tag. `orchardctl update` moves them within their policy and pins the digest it pulled.

### Top-level

| Key | Default | Description |
|---|---|---|
| `namespace` | `orchard` | Namespace the app components install into. |
| `createNamespace` | `true` | Render a `Namespace` object for `.namespace`, and for `gateway.namespace` and `certificates.namespace` when they are in use and missing. Those two are kept on uninstall. Set `false` if you manage them yourself. |
| `cilium.enabled` | `false` | Add CiliumNetworkPolicy / CiliumEnvoyConfig grants to the server ClusterRole and set `CILIUM_ENABLED=true`. Only for clusters running Cilium as the CNI. Left off, the server probes for the `cilium.io` group plus create on `ciliumenvoyconfigs`: per-tenant policy falls back to plain NetworkPolicy, and basic auth on an ingress is enforced by the protection proxy instead of an Envoy filter. |
| `protection.orchardLogin` | `false` | Offer `protectionMode: orchard` ("sign in with Orchard") on tenant ingresses, via `PROTECTION_ORCHARD_LOGIN=true`. Gates selecting the mode, not enforcing it. `basic` and `password` are always available. |
| `signupMode` | `invite_only` | Who can sign up: `open`, `invite_only` or `closed`, as `SIGNUP_MODE`. |
| `priorityClasses.enabled` | `true` | Creates the cluster-scoped `orchard-platform` PriorityClass (value 100000) and sets it on the platform pods, so tenant workloads (default priority 0) cannot out-schedule or out-evict them. Tenants cannot choose a class, and the admission policy refuses `system-*` and `orchard-*` names in tenant namespaces. Enabling it on an existing install restarts the platform pods once, including the platform Postgres. |
| `logs.vector.throttle.eventsPerSecond` | `2000` | Most log lines per second one tenant namespace may ship to the shared log store. Lines above the rate are dropped for that namespace only and counted in Vector's `component_discarded_events_total`. `0` turns the limit off. |
| `tenant.storageClass` | `""` | StorageClass for tenant apps and databases, as `K8S_STORAGE_CLASS`. Empty uses the cluster default StorageClass. |
| `tenant.ingressClass` | `""` | Ingress class of tenant apps, as `K8S_INGRESS_CLASS`. Empty falls back to `haproxy`. |
| `tenant.certClusterIssuer` | `""` | ClusterIssuer for tenant certificates, as `CERT_CLUSTER_ISSUER`. Empty falls back to `letsencrypt-prod`. |
| `tenant.ingressNamespaces` | `""` | Namespaces that may reach tenant pods, as `TENANT_INGRESS_NAMESPACES`. Tenant pods may reach the same list, except Orchard's own namespace, unless `TENANT_EGRESS_NAMESPACES` in `server.env` says otherwise. Empty means `network,orchard`. The ingress controller has to be on this list, or apps are unreachable and HTTP-01 certificates never issue. Traefik in its own namespace wants `traefik,orchard`. The Traefik bundled with k3s runs in `kube-system`, so that cluster wants `kube-system,orchard`. |
| `tenant.cnpgOperatorNamespace` | `""` | Where CloudNativePG runs, as `CNPG_OPERATOR_NAMESPACE`. Empty leaves the server's default, `postgresql`. A value in `server.env` wins. With the wrong one, the tenant policy keeps the operator out of database pods, and databases show `Instance Status Extraction Error`. |
| `tenant.wildcardDomains` | `""` | `.suffix=tlsSecret` pairs generated app URLs are built from. Empty derives one from `gateway.http.appDomain`. |
| `tenant.publicIp` | `""` | Fallback external IP publicly exposed ports and databases are published on, via `PUBLIC_EXPOSURE_IP`. An organization that sets its own overrides it. Empty means every organization must configure one before it can expose anything, and setting it here locks the admin-panel field. |
| `tenant.egressBandwidth` | `""` | Outbound bandwidth cap per tenant pod, as `TENANT_EGRESS_BANDWIDTH` (for example `50M`), set through the `kubernetes.io/egress-bandwidth` annotation. Empty sets nothing. Only enforced where the CNI shapes traffic: Cilium with `bandwidthManager.enabled=true`, or the `bandwidth` CNI plugin, which k3s chains after its default Flannel. Other CNIs ignore it. |
| `tenant.newOrgCpu` | `""` | Seed for the CPU cap of NEW organizations, as `NEW_ORG_CPU`. Empty means uncapped; a superadmin can set an instance default in the admin panel, which wins. Existing organizations are never changed. |
| `tenant.newOrgMemory` | `""` | Seed for the memory cap of NEW organizations, as `NEW_ORG_MEMORY`. Empty means uncapped. |
| `tenant.maxProjectsPerOrg` | `""` | Hard ceiling on projects for every organization, as `MAX_PROJECTS_PER_ORG`. Empty or `0` means no ceiling; per-organization limits are set in the admin panel. An organization already above the limit keeps what it has and cannot create more. |
| `tenant.maxEnvironmentsPerOrg` | `""` | Hard ceiling on extra environments (one namespace each) for every organization, as `MAX_ENVIRONMENTS_PER_ORG`. Empty or `0` means no ceiling. |
| `tenant.maxDeploymentsPerOrg` | `""` | Hard ceiling on deployments for every organization, as `MAX_DEPLOYMENTS_PER_ORG`. Empty or `0` means no ceiling. |
| `tenant.maxCustomDomainsPerOrg` | `""` | Most custom hostnames one organization may hold, as `MAX_CUSTOM_DOMAINS_PER_ORG`. Empty means 250; `0` is unlimited. |
| `tenant.maxCustomDomainCreatesPerHour` | `""` | Most custom hostnames one organization may add per hour, as `MAX_CUSTOM_DOMAIN_CREATES_PER_HOUR`. Empty means 30; `0` is unlimited. With `signupMode: open`, adding a custom domain also needs a TXT proof unless `CUSTOM_DOMAIN_VERIFICATION=false` is set in `server.env`. |

### Datadog (`datadog.*`)

APM for the server. Off by default; turn it on if you run a Datadog agent.

| Key | Default | Description |
|---|---|---|
| `datadog.enabled` | `false` | Injects the `DD_*` env into the server, adds `pg_stat_statements` parameters to Postgres, and adds a `datadog` Postgres role whose password comes from an `orchard-db-datadog` Secret you create. |
| `datadog.agentHost` | `datadog.monitoring.svc.cluster.local` | The agent Service, as `DD_AGENT_HOST`. |
| `datadog.env` | `production` | `DD_ENV`. |
| `datadog.profiling` | `true` | Continuous profiler. |
| `datadog.appsec` | `true` | App and API Protection. Detection only unless you enable blocking in Datadog. |

### Image defaults (`image.*`)

| Key | Default | Description |
|---|---|---|
| `image.registry` | `ghcr.io` | Container registry host. |
| `image.repository` | `hackclub/orchard` | Repository prefix. Final ref = `{registry}/{repository}/{component}:{tag}`. Matches where CI publishes images; override if pulling from your own registry. |
| `image.pullPolicy` | `IfNotPresent` | Applied to all app containers. |
| `image.pullSecrets` | `[]` | List of `imagePullSecrets` names. Required if images are private. |

### Frontend (`frontend.*`)

| Key | Default | Description |
|---|---|---|
| `frontend.enabled` | `true` | Deploy the SvelteKit frontend. |
| `frontend.replicas` | `2` | Replica count. Ignored when `frontend.autoscaling.enabled`. |
| `frontend.image.name` | `frontend` | Image name suffix. |
| `frontend.image.tag` | the last frontend release | Empty falls back to `Chart.AppVersion`. Use `sha-<commit>` to pin a build. |
| `frontend.service.port` | `3000` | ClusterIP Service port. |
| `frontend.sourceUrl` | `""` | Where the dashboard's Source link points, as `PUBLIC_SOURCE_URL`. Empty means the upstream repository. |
| `frontend.resources` | requests `50m/128Mi`, limits `1/1Gi` | Standard k8s resource block. |
| `frontend.autoscaling.enabled` | `false` | HPA on CPU. Needs metrics-server. When on, `replicas` is omitted from the Deployment so upgrades don't fight the HPA. |
| `frontend.autoscaling.minReplicas` / `maxReplicas` | `2` / `6` | Bounds. |
| `frontend.autoscaling.targetCPUUtilizationPercentage` | `75` | Scale-out target. |
| `frontend.env` | `[]` | Extra env vars (k8s env list). `PUBLIC_APP_DOMAIN` is injected from `gateway.http.appDomain`. |

### Server (`server.*`)

| Key | Default | Description |
|---|---|---|
| `server.enabled` | `true` | Deploy the NestJS server. |
| `server.replicas` | `2` | Replica count. Ignored when `server.autoscaling.enabled`. |
| `server.image.name` | `server` | Image name suffix. |
| `server.image.tag` | the last server release | Empty falls back to `Chart.AppVersion`. |
| `server.service.port` | `3001` | ClusterIP Service port. |
| `server.resources` | requests `100m/384Mi`, limits `2/2Gi` | Resource block. |
| `server.autoscaling.enabled` | `false` | HPA on CPU. Needs metrics-server. When on, `replicas` is omitted from the Deployment. |
| `server.autoscaling.minReplicas` / `maxReplicas` | `2` / `8` | Bounds. |
| `server.autoscaling.targetCPUUtilizationPercentage` | `70` | Scale-out target. |
| `server.workers.enabled` | `false` | Run builds, notifications and the k8s apply queue in dedicated `server-worker` pods, leaving api pods enqueue-only. Same image and env as the server. |
| `server.workers.replicas` | `2` | Replica count. Ignored when `server.workers.autoscaling.enabled`. |
| `server.workers.resources` | requests `100m/384Mi`, limits `2/2Gi` | Resource block. |
| `server.workers.autoscaling.*` | `false`, `1`–`10`, `60%` | Same for the worker Deployment. Builds are the burstiest tier. |
| `server.env` | `[]` | Extra env vars. `DATABASE_URL` is injected automatically from `orchard-db-app` when `postgres.enabled=true`. `APP_DOMAIN` and `PLATFORM_WILDCARD_DOMAINS` are derived from `gateway.http.appDomain`; list them here to override. `RESERVED_HOSTS` and `RESERVED_HOST_SUFFIXES` (comma-separated hostnames and domains that vanity addresses, status pages and custom domains cannot claim) pass through here too. |
| `server.envFrom` | `[]` | `envFrom` list (configMapRef / secretRef). |

The chart sets `TENANT_SECRETS_CLUSTER_ROLE` to `<release>-tenant-secrets`, the ClusterRole the server binds into each tenant namespace. The server's own ClusterRole may `bind` only that name and holds no `escalate`.

### Postgres / CloudNativePG (`postgres.*`)

| Key | Default | Description |
|---|---|---|
| `postgres.enabled` | `true` | Create a CNPG `Cluster`. Requires the CNPG operator. |
| `postgres.name` | `orchard-db` | Cluster name. Also drives the auto-generated secret name (`{name}-app`). |
| `postgres.instances` | `1` | Number of Postgres replicas. |
| `postgres.imageName` | `""` | Override the CNPG Postgres image. Empty = operator default. |
| `postgres.database` | `orchard` | Initial database. |
| `postgres.owner` | `orchard` | Owner role for the initial database. |
| `postgres.storage.size` | `10Gi` | PVC size per instance. |
| `postgres.storage.storageClass` | `""` | StorageClass for the data PVC. Empty keeps the live cluster's class, or uses the cluster default on a fresh install. |
| `postgres.resources` | requests `200m/512Mi`, limits `2/2Gi` | Per-instance resources. |
| `postgres.walSlotKeepSize` | `2GB` | `max_slot_wal_keep_size`. |
| `postgres.pooler.enabled` | `false` | Put a CNPG `Pooler` (PgBouncer, transaction mode) in front of the database. Orchard's own queries go through it; migrations and graft pools connect directly. |
| `postgres.pooler.instances` / `defaultPoolSize` / `maxClientConn` | `2` / `20` / `1000` | Postgres sees at most `instances` x `defaultPoolSize` connections from Orchard. |
| `postgres.pooler.image` | `ghcr.io/cloudnative-pg/pgbouncer:1.26.1` | PgBouncer image for the CNPG `Pooler`. Empty = operator default, which lags behind PgBouncer security releases. |
| `postgres.pooler.resources` | requests `50m/64Mi`, limits `256Mi` memory | Resource block. |
| `postgres.backup.enabled` | `false` | Archive `orchard-db` and render a CNPG `ScheduledBackup`. |
| `postgres.backup.method` | `barman` | `barman`, or `plugin` for the barman cloud plugin, which also renders an `ObjectStore`. The plugin must already be installed. |
| `postgres.backup.destinationPath` | `""` | `s3://` path. Required when backups are on. |
| `postgres.backup.endpointURL` | `""` | S3 endpoint, for anything that is not AWS. |
| `postgres.backup.secretName` | `orchard-db-backup` | Secret you create, with keys `ACCESS_KEY_ID` and `ACCESS_SECRET_KEY`. |
| `postgres.backup.retentionPolicy` | `30d` | Retention. |
| `postgres.backup.schedule` | `0 30 1 * * *` | Six-field cron. |
| `postgres.backup.walMaxParallel` | `4` | WAL upload parallelism. |

### Platform network policies (`networkPolicy.*`)

| Key | Default | What it does |
| --- | --- | --- |
| `networkPolicy.platform.enabled` | `true` | Ingress policies for the release namespace and the metrics namespace. Tenant namespaces (the managed label), the builders, sandbox, fc-builder and trivy namespaces cannot connect to a control-plane pod. Every other namespace keeps its access. Redis keeps its own, narrower policy. Needs a CNI that enforces NetworkPolicy. |
| `networkPolicy.platform.untrustedNamespaces` | `[]` | More namespaces to treat like tenants. |
| `networkPolicy.enforcer.enabled` | `false` | Run kube-router on every node in policy-only mode (`--run-firewall=true --run-router=false --run-service-proxy=false --enable-cni=false`), the same controller k3s embeds. For clusters whose CNI is plain Flannel, such as the Talos default, which ignores NetworkPolicy. Do not enable it next to Cilium, Calico, Antrea, Canal or k3s's built-in controller. The doctor's `cni-enforcement` check finds the `kube-router` DaemonSet; run the isolation self-test to confirm. |
| `networkPolicy.enforcer.namespace` | `orchard-netpol` | Namespace for the DaemonSet. The chart creates it with the `privileged` Pod Security labels, unless it is `kube-system`. |
| `networkPolicy.enforcer.image` | `cloudnativelabs/kube-router:v2.12.0` | kube-router image. |
| `networkPolicy.enforcer.priorityClassName` | `system-node-critical` | Priority class of the enforcer pods. |
| `networkPolicy.enforcer.resources` | requests `250m/250Mi` | Resource block. |
| `networkPolicy.enforcer.tolerations` | every `NoSchedule` and `NoExecute` taint, `CriticalAddonsOnly` | Runs on every node, control plane included. A node without the enforcer does not enforce policy for its pods. |
| `networkPolicy.enforcer.extraArgs` | `[]` | Extra kube-router flags, for example `--enable-ipv6=true` on a dual-stack cluster. |

### Redis (`redis.*`)

Backs the cross-replica SSE event bus and is available as a cache. Without it the server
degrades to local-only delivery plus polling.

| Key | Default | Description |
|---|---|---|
| `redis.enabled` | `true` | Deploy Redis and inject `REDIS_URL` into the server. |
| `redis.image` | `redis:8.10.3-alpine` | Image. |
| `redis.storage` / `storageClass` | `1Gi` / cluster default | The data PVC. |
| `redis.url` | `""` | Use this URL for `REDIS_URL` instead of the in-cluster Service. |
| `redis.auth.enabled` | `true` | Require a password. The chart mints one into the `redis-auth` Secret on first install and keeps it on upgrades. Not used with `redis.url`. |
| `redis.auth.password` | `""` | Use this password instead. Set it when a GitOps tool only runs `helm template`, which cannot read the existing Secret. |
| `redis.networkPolicy.enabled` | `true` | Restrict who can reach it. |
| `redis.maxmemory` | `""` | Pin Redis `maxmemory` (e.g. `256mb`). Empty derives it from the memory limit. |
| `redis.maxmemoryPercent` | `50` | Share of `redis.resources.limits.memory` used as `maxmemory` when `maxmemory` is empty, leaving headroom for AOF rewrites and client buffers. |
| `redis.maxmemoryPolicy` | `volatile-ttl` | Eviction policy at the cap. Everything the server stores in Redis (rate-limit windows, caches, idempotency and SSO state) carries a TTL, so a key flood evicts the soonest-expiring entries instead of OOM-killing Redis; keys without a TTL are never evicted. |
| `redis.resources` | requests `50m/64Mi`, limits `500m/512Mi` | Resource block. |

### Ingress / Traefik (`ingress.*`)

| Key | Default | Description |
|---|---|---|
| `ingress.enabled` | `true` | Create the Traefik `IngressRoute`. |
| `ingress.host` | `orchard.local` | **The domain.** Used in the `Host(...)` match, and the one links are generated with. Set this to your real FQDN. |
| `ingress.extraHosts` | `[]` | Additional names the same routes answer on, joined into the one `Host(...)` match. For a LAN box reachable by IP, machine name and Tailscale name. Matched only: they are not added to the certificate. |
| `ingress.entryPoints` | `[websecure]` | Traefik entryPoints to bind. Use `[web]` for HTTP-only. |
| `ingress.tls.enabled` | `true` | Emit a `tls:` block on the IngressRoute. |
| `ingress.tls.secretName` | `""` | Name of an existing TLS secret. Empty uses Traefik's default cert. |
| `ingress.tls.issuerRef` | `{}` | Name a ClusterIssuer and the chart issues the control-plane certificate itself, into `{release}-tls`. Without this or `secretName`, Traefik terminates with its self-signed default. |
| `ingress.middlewares` | `[]` | List of `{name, namespace}` refs applied to both routes. |

Routing is fixed: `PathPrefix(/apiv1)` → server, everything else → frontend, both bound to `Host(ingress.host, ...ingress.extraHosts)`.

### MCP (`mcp.*`)

The Model Context Protocol server, a second process out of the same image, on
its own hostname.

| Key | Default | Description |
|---|---|---|
| `mcp.enabled` | `true` | Deploy the MCP. Off, the Deployment and route go away **and** `MCP_ENABLED=false` is set on the server, which pins the runtime toggle in the admin panel off: nothing is serving MCP, so it cannot be switched back on from a browser. |
| `mcp.replicas` | `1` | Replica count. Ignored when `mcp.autoscaling.enabled`. |
| `mcp.image.name` | `mcp` | Image name suffix. Built from `apps/server/Dockerfile.mcp`. |
| `mcp.service.port` | `3100` | ClusterIP Service port. |
| `mcp.autoscaling.enabled` | `false` | HPA on CPU. Needs metrics-server. |
| `mcp.autoscaling.minReplicas` / `maxReplicas` | `1` / `4` | Bounds. |
| `mcp.autoscaling.targetCPUUtilizationPercentage` | `75` | Scale-out target. |
| `mcp.ingress.enabled` | `true` | Create the Traefik `IngressRoute`. |
| `mcp.ingress.host` | `""` | **The MCP domain**, e.g. `mcp.example.com`. Empty creates no route, and every URL derived from it stays unset. |
| `mcp.ingress.tls.issuerRef` | `{}` | As `ingress.tls.issuerRef`, into `{release}-mcp-tls`. An MCP client refuses a self-signed certificate outright, so this or `secretName` is not optional in practice. |
| `mcp.url` | `""` | The origin clients actually reach, when it differs from what the route implies. Behind a tunnel the route terminates plaintext in-cluster while the world connects over https, and an OAuth issuer that disagrees with the URL the client typed is rejected. Empty derives it from the route. |
| `mcp.env` | `[]` | Extra env vars. **`JWT_SECRET` and `MCP_SERVICE_TOKEN` have to be here and have to match the server's**: the MCP validates the sessions the server issued, and authenticates to the API as a service while passing the consenting user in headers. A mismatch starts cleanly and fails every tool call. |

Derived for you unless `mcp.env` already names them: `MCP_BASE_URL` (the OAuth
issuer and resource identifier), `FRONTEND_URL` (where a client is sent to
consent, taken from `server.env` when set), and `ORCHARD_API_URL` (the in-cluster
server Service). Left to their own defaults these point at localhost, which
fails only once a client tries to authorise.

**Setting `mcp.envFrom` disables all three.** A container `env` entry outranks
every `envFrom` source, so injecting one would silently shadow a value held in a
Secret rather than defer to it. The same rule applies to `MCP_BASE_URL` on the
server, which is set only so the DNS check in the admin panel knows the MCP's
hostname, and is skipped entirely when `server.envFrom` is present.

`mcp.ingress.host` also feeds the frontend's `PUBLIC_MCP_URL`, which is the URL
**Settings → MCP** shows people, and `SANDBOX_MCP_URL` when sandboxes are on. It
is the single place the MCP's address is configured.

### Builders (`builders.*`)

| Key | Default | Description |
|---|---|---|
| `builders.enabled` | `true` | Install the `orchard-builders` namespace + RBAC + secrets. |
| `builders.namespace` | `orchard-builders` | Namespace where BuildKit pods will run. |
| `builders.buildkitImage` | `moby/buildkit:v0.34.2` | BuildKit image for builds. `orchardctl update` moves it to the newest patch version. |
| `builders.buildkitRootlessImage` | `moby/buildkit:v0.34.2-rootless` | BuildKit image for rootless builds, the default. `orchardctl update` moves it to the newest patch version. Empty adds `-rootless` to the `buildkitImage` tag and drops its digest, so set both when you mirror BuildKit. |
| `builders.allowPrivilegedOnHost` | `false` | Without `builderSandbox`, builds run in rootless BuildKit. `true` restores a PRIVILEGED BuildKit container on the node runtime, where a Dockerfile `RUN` step is root on the node. Do not enable it for untrusted builders. |
| `builders.railpackVersion` | `v0.43.0` | Railpack version for builds without a Dockerfile. |
| `builders.harbor.username` | `""` | Registry username (written to `harbor-registry-creds` dockerconfigjson). Required when `hosts` is set. |
| `builders.harbor.password` | `""` | Registry password. Required when `hosts` is set. |
| `builders.harbor.hosts` | `[]` | Hosts the credentials apply to. |
| `builders.httpRegistries` | `[harbor-core.harbor.svc.cluster.local]` | Registries BuildKit talks plain HTTP to. Anything not listed is HTTPS. A self-host running zot lists `zot.orchard.svc.cluster.local:5000`. |
| `builders.r2.accessKeyId` | `""` | Instance-wide R2 access key for the BuildKit S3 cache. Builds use it only with `BUILDKIT_S3_SHARED_KEY=true`, because every build can read it. Single-tenant instances only; otherwise let the r2-proxy carry the cache. |
| `builders.r2.secretAccessKey` | `""` | Cloudflare R2 secret. |
| `builders.quota.requestsCpu` | `"16"` | Namespace ResourceQuota: total CPU requests. |
| `builders.quota.requestsMemory` | `"32Gi"` | Total memory requests. |
| `builders.quota.limitsCpu` | `"32"` | Total CPU limits. |
| `builders.quota.limitsMemory` | `"100Gi"` | Total memory limits. |
| `builders.quota.pods` | `"10"` | Max concurrent builder pods. |
| `builders.registryEgress` | Harbor's `core` pods on 80 and 8080, plus the `kubernetes-ingress` pods in `network` on 80, 443, 8000, 8080 and 8443 | In-cluster destinations builders may reach on top of DNS and public IPs on 80/443. A registry not listed here fails the build at the push. Not defaulted to the release namespace on purpose: a build runs untrusted repo code. |
| `builders.dedicatedNode.enabled` | `false` | Pin builds to nodes labelled `orchard-builder=true`, tolerating an `orchard-builder` NoSchedule taint. |
| `builders.platform` | `""` | `linux/amd64` or `linux/arm64`. Set, it also pins Orchard-built apps to that architecture. Empty builds `linux/amd64` and leaves app placement alone. |
| `builders.localCache.enabled` | `true` | Keep the BuildKit cache on a PVC instead of S3/R2. |
| `builders.localCache.size` / `storageClass` | `100Gi` / cluster default | The PVC. `storageClass` is immutable once created. |
| `builders.localCache.path` / `pvcName` / `accessMode` | `/cache/buildkit` / `buildkit-cache` / `ReadWriteOnce` | Where and how it mounts. |
| `builders.localCache.gcKeepBytes` / `gcEphemeralKeepBytes` | `18GB` / `1GB` | BuildKit GC ceilings **per tenant**, not per volume. |
| `builders.localCache.evict.maxAgeDays` | `14` | Evict any tenant untouched for this long. |
| `builders.localCache.evict.highPct` / `targetPct` | `80` / `60` | Above `highPct` used, evict least-recently-used tenants until under `targetPct`. |
| `builders.localCache.evict.idleMinutes` | `60` | Never evict a tenant whose cache moved this recently. |
| `builders.localCache.evict.maxGiB` | `""` | Total GiB the cache may hold before least-recently-used tenants are evicted. Empty means no byte budget. Set it on storage that does not enforce `size`, such as `local-path`. **Instance admin** > **Build cache** overrides it and `maxAgeDays`. |

The chart grants the orchard-server ServiceAccount in `.namespace` permission to manage Jobs/Pods/Secrets in `builders.namespace`.

### Fast builder (`fcBuilder.*`)

Experimental. One privileged pod per node runs a Firecracker microVM per project. Deploying
the hosts does nothing on its own: builds route here only when `serverEnabled` is true, and
then the routing mode decides which. The defaults below are sized for a large dedicated
build node. On an installer host, `orchardctl fast-builder enable` sizes everything to the
machine instead. See the [fast builder guide](https://docs.orchard.hackclub.com/operate/fast-builder/).

| Key | Default | Description |
|---|---|---|
| `fcBuilder.enabled` | `false` | Deploy the hosts in `fcBuilder.namespace` (`orchard-fc-builders`). |
| `fcBuilder.serverEnabled` | `false` | Let the server route builds to them. |
| `fcBuilder.routing` | `""` (`flag`) | Default routing mode: `all`, `per_app`, `off`, or `flag` (the PostHog flag `firecracker-builder`). Instance admin can change it; an app's own setting still wins. |
| `fcBuilder.replicas` | `2` | Number of hosts. |
| `fcBuilder.image.{name,tag,repository}` | `fc-builder`, `latest`, `""` | Image. |
| `fcBuilder.token` | generated | Secret for the server to fc-builder API, kept across upgrades. |
| `fcBuilder.nodeSelector` | `orchard-fc-builder: "true"` | Nodes that may host VMs. They need `/dev/kvm`. |
| `fcBuilder.tolerations` | `[]` | Tolerations. |
| `fcBuilder.terminationGracePeriodSeconds` | `90` | Grace period. |
| `fcBuilder.resources` | requests `12/48Gi`, limits `32/108Gi` | Resource block. |
| `fcBuilder.storage.storageClass` / `size` | `longhorn-build-scratch` / `1Ti` | Holds every project's cache disk image. |
| `fcBuilder.vm.*` | `maxVms: 6`, `vcpus: 8`, `memoryMiB: 16384`, `idleSeconds: 300`, `cacheSize: 50G`, `minNodeFreeMiB: 32768`, `memoryOverheadMiB: 1536` | Per-host VM limits. |
| `fcBuilder.jailer.{enabled,cgroups}` | `true`, `true` | Run VMs under the Firecracker jailer. |
| `fcBuilder.maxConcurrentBuilds` | `16` | Queue slots across all hosts. |
| `fcBuilder.maxBuildsPerVm` | `2` | Builds that may run at once in one environment's VM. More wait in the queue. |
| `fcBuilder.registry.{upstream,username,password}` | Harbor core, `""`, `""` | Where the push proxy forwards guest pushes. Guests never see these credentials. |
| `fcBuilder.registryEgress` | Harbor core on 8080 | In-cluster egress besides DNS and the public internet. |

### Pod sandboxing (`tenantSandbox.*`, `builderSandbox.*`)

Both off by default, and both need the runtime on every node first, or pods fail with
`no runtime for ... is configured`.

| Key | Default | Description |
|---|---|---|
| `tenantSandbox.enabled` | `false` | Run tenant apps under gVisor, as `TENANT_RUNTIME_CLASS`, and render the RuntimeClass. |
| `tenantSandbox.runtimeClassName` | `gvisor` | RuntimeClass name (handler `runsc`). |
| `builderSandbox.enabled` | `false` | Run build Jobs under a VM runtime and render the RuntimeClass. |
| `builderSandbox.runtimeClassName` / `handler` | `kata` / `kata` | RuntimeClass for build Jobs, as `BUILDER_RUNTIME_CLASS`. |
| `builderSandbox.depotRuntimeClassName` | `gvisor` | RuntimeClass for super builds (Depot), which never execute repo code. It must exist, and `tenantSandbox` renders it. `""` reuses `runtimeClassName`. |
| `builderSandbox.sidecarPush` | `true` | Move BuildKit to an init container with no registry credentials and push from a separate container. |
| `builderSandbox.pusherImage` | `quay.io/skopeo/stable:v1.24.1` | Image for that container. Must have `skopeo` on `PATH`. |
| `builderSandbox.tmpfsWorkspace` | `false` | Back workspace and output `emptyDir`s with memory. Counts against the container's memory limit. |
| `builderSandbox.scratch.mode` | `""` | `tmpfs`, `disk` or `block`. Empty follows the isolation setting. |
| `builderSandbox.scratch.size` / `storageClass` | `40Gi` / `""` | Size and class of the BuildKit scratch. The class only applies in block mode; empty uses the default StorageClass. With tmpfs, `size` is a RAM reservation. |
| `builderSandbox.memoryLimit` | `""` | `BUILDER_MEMORY_LIMIT`. |

### Devices (`devices.*`)

| Key | Default | Description |
|---|---|---|
| `devices.classes` | `[]` | Extended resources apps may attach, as `DEVICE_CLASSES`. Each entry has `resource` (for example `nvidia.com/gpu`), `label`, an optional `runtimeClassName` (for example `nvidia`) and `max` per app (default 1). A device plugin on the node must advertise the resource. |

### Backup proxy (`r2Proxy.*`)

| Key | Default | Description |
|---|---|---|
| `r2Proxy.enabled` | `true` | Deploy the proxy that brokers per-cluster backup credentials. Rendered only once it has somewhere to send backups: `r2Proxy.upstream.endpoint`, or `objectStorage.local.enabled`. Without either nothing is deployed and `BACKUP_PROXY_ENABLED` is not set, instead of a proxy that crash-loops on a missing `R2_ENDPOINT`. |
| `r2Proxy.namespace` | `orchard-r2-proxy` | Its namespace. Tenant namespaces may reach it on 9000 and nothing else. |
| `r2Proxy.upstream.*` | | Endpoint, region and the real R2 key pair. Only the proxy ever holds these. Empty with `objectStorage.local.enabled` points the proxy at the local store. |
| `r2Proxy.defaultBucket` | `""` | Bucket for organizations without their own. Also the default of the proxy's `ALLOWED_BUCKETS`. Required, unless `r2Proxy.allowedBuckets` is set, when `r2Proxy.upstream.endpoint` is set: the render fails otherwise. |
| `r2Proxy.allowedBuckets` | `[]` | The only buckets the proxy signs with the platform credentials, rendered as `ALLOWED_BUCKETS`. An empty allowlist never means "every bucket": the chart refuses to render and the proxy refuses to start. A bucket an organization names as its backup bucket does not widen this list. |
| `r2Proxy.buildCacheBucket` | `""` | The bucket the proxy binds build cache keys to, rendered as `BUILD_CACHE_BUCKET`. Empty takes `BUILDKIT_S3_BUCKET` from `server.env`. With neither, a cache key may use the backup bucket or a bucket only `allowedBuckets` lists. Database keys only reach backup buckets: `defaultBucket` and the buckets saved under Instance admin. |
| `r2Proxy.databasePassword` | `""` | Password for the read-only `orchard_r2_proxy` postgres role. Empty keeps whatever the `orchard-r2-proxy-db` secret already holds, or mints one on first install. |
| `r2Proxy.databaseUrl` | `""` | Full override for a database the chart does not run. Give it a read-only role. |

When `postgres.enabled`, the CNPG cluster manages the `orchard_r2_proxy` login role and the server grants it `SELECT` on `databases`, `projects`, `organizations` and the columns of `storage_access_keys` the proxy reads at boot. The proxy never holds the app owner's credentials.

### Object storage (`objectStorage.local.*`)

An S3 server inside the cluster (versitygw on one PVC), so database backups,
checkpoints, point-in-time restore, forks, the 30-day trash and restore tests
work on an instance with no external storage. Off in the chart; on from the
one-command installer, and from `orchardctl update` when no object storage is
configured anywhere (values file, `server.envFrom`, `r2Proxy.upstream` or
Instance admin).

**This is not disaster recovery.** The backups sit on the same machine, often
the same disk, as the databases they protect. They undo a bad migration or a
deleted table; they do not survive the disk or the box. Use real S3 or R2 for
that.

| Key | Default | Description |
|---|---|---|
| `objectStorage.local.enabled` | `false` | Deploy the store in `objectStorage.local.namespace`. |
| `objectStorage.local.namespace` | `orchard-object-storage` | Its namespace. A NetworkPolicy admits only the release namespace (the server) and `r2Proxy.namespace`; tenant pods cannot reach it at all. |
| `objectStorage.local.image` | `versity/versitygw:v1.11.0` | The S3 gateway, POSIX backend on `/data`. The filesystem needs user xattrs (ext4 and xfs have them). |
| `objectStorage.local.bucketImage` | `amazon/aws-cli:2.40.2` | Image of the Job that creates the bucket. Its name hashes bucket, image and region, so a change runs it again. |
| `objectStorage.local.bucket` | `orchard-backups` | The bucket backups go to. |
| `objectStorage.local.region` | `auto` | The region every client signs with. versitygw rejects any other; the server and r2-proxy sign with `auto`. |
| `objectStorage.local.backups` | `true` | Make this the instance backup target. Requires `r2Proxy.enabled`: the render fails otherwise, because tenant databases must only ever get per-prefix proxy credentials, never the root key. |
| `objectStorage.local.accessKey` / `secretKey` | generated | Root credentials, kept across upgrades in the `orchard-object-storage` Secret in the release namespace. |
| `objectStorage.local.storage.size` / `storageClass` | `20Gi` / cluster default | The data PVC. `local-path` does not enforce the size, so watch the disk. |
| `objectStorage.local.resources` | requests `20m/64Mi`, limits `1/512Mi` | Resource block. |

With `backups` on, the server gets `LOCAL_STORE_ENDPOINT`
(`http://object-storage.<namespace>.svc.cluster.local:9000`),
`LOCAL_STORE_BACKUP_BUCKET`, `LOCAL_STORE_UPLOADS_BUCKET`, `LOCAL_STORE_REGION`,
and `LOCAL_STORE_ACCESS_KEY_ID`/`LOCAL_STORE_SECRET_ACCESS_KEY` from that Secret.
These are a fallback: storage saved in the UI and any `R2_*` variable win.
Nothing is injected when `server.envFrom` is set, when `server.env` has
`R2_ACCOUNT_ID`, or when `r2Proxy.upstream.endpoint` is set. r2-proxy uses the
store as its upstream and defaults `ALLOWED_BUCKETS` to the bucket. Tenant
databases reach it through r2-proxy only, which the tenant NetworkPolicy already
allows on `orchard-r2-proxy:9000`.

The namespace, the data PVC and the credentials Secret carry
`helm.sh/resource-policy: keep`: turning the store off or uninstalling leaves
the backups and the key behind, and turning it back on picks both up again.

Uploads use their own bucket, `objectStorage.local.uploadsBucket`, and the server
serves them through its API at `/apiv1/uploads`, so nothing needs to be public.
Empty turns uploads off until S3 storage is added.

#### Adding S3 storage

Use the setup flow, **Instance admin**, or `sudo orchardctl backups s3 set`. No
chart value changes. See
[Add S3 storage](https://docs.orchard.hackclub.com/operate/storage/) for provider settings.

New databases back up to the new bucket. Databases that already exist keep their
bucket, so they keep archiving to the local store and restoring from it. To let
that work, the server writes every bucket it has served to the `r2-proxy-stored`
Secret in the proxy namespace, the proxy re-reads it while running, and each
database key stays limited to its own prefix in any of those buckets. To move a
database, fork it. Keep the local store on while any database still uses it.

The S3 bucket cannot be named `objectStorage.local.bucket`, because the proxy picks
its upstream by bucket name.

To set it in values instead, set `r2Proxy.upstream.*` and the `R2_*` variables on
the server, which lock the fields in the UI. That route replaces the store's
upstream, so the bucket must keep the same name and you must copy the history
across first, or point-in-time restore loses everything before the switch.

### Updates feed (`updates.*`)

| Key | Default | Description |
|---|---|---|
| `updates.url` | `""` | Folder holding `latest.json` and the release notes the "what's new" sheet reads, as `UPDATES_URL`. Empty keeps the server's default; `off` hides the sheet. A value in `server.env` wins. |

### Greenhouse (`sandbox.*`)

AI dev machines. Off by default. Full operator guide:
`apps/docs/src/content/docs/operate/greenhouse.md` (docs site: Operating Orchard → Running Greenhouse).

| Key | Default | Description |
|---|---|---|
| `sandbox.enabled` | `false` | Installs the plumbing below unless `install` is set. Greenhouse itself is the `greenhouse` graft: add it to `grafts:` to turn it on. |
| `sandbox.install` | `null` | Renders the machine namespace, ResourceQuota, LimitRange, NetworkPolicy, RBAC and the `SANDBOX_*` settings below. `null` follows `enabled`. Needed for the kubernetes runner of the `greenhouse` graft. |
| `sandbox.namespace` | `orchard-sandboxes` | Namespace for kubernetes machines. |
| `sandbox.image` | `ghcr.io/hackclub/orchard/sandbox:latest` | Ships sshd, git, tmux, Node.js and the supported agents, so a machine boots in seconds. With any other image, a bootstrap script installs what is missing on first boot, which is slow. |
| `sandbox.runtimeClassName` | `kata` | RuntimeClass for machines. Empty runs them on runc with a Filesystem home PVC, a reduced capability set, RuntimeDefault seccomp and a `baseline` Pod Security namespace. |
| `sandbox.idleTimeoutMinutes` | `60` | Stop machines with no terminal or SSH activity and no busy agent. `0` never. |
| `sandbox.maxLifetimeHours` | `168` | Stop machines this long after their last start. `0` never. |
| `sandbox.maxPerUserDefault` | `1` | Default machines per person; overridable per user in `/admin/greenhouse`. |
| `sandbox.storageClass` | `""` | Home volume StorageClass. Empty = cluster default. |
| `sandbox.diskSize` / `cpuLimit` / `memoryLimit` | `10Gi` / `"2"` / `4Gi` | Per-machine size. Keep memory at least `1Gi` under kata. |
| `sandbox.tunnelMode` | `""` | `portforward` only for a server outside the cluster. |
| `sandbox.homeMode` | `""` | `block`, `filesystem`, or empty for auto. |
| `sandbox.quota.{pods,cpu,memory}` | `"20"`, `"40"`, `"80Gi"` | Namespace ResourceQuota. |
| `sandbox.runners.default` | `""` | `kubernetes` or `vercel`. Empty lets the admin pick. |
| `sandbox.runners.kubernetes.enabled` | `null` | `true`/`false` pins the runner; `null` leaves it to the admin (default on). |
| `sandbox.runners.vercel.enabled` | `null` | Same for Vercel (default off). |
| `sandbox.runners.vercel.tokenSecret.{name,key}` | `""`, `token` | Secret holding the Vercel access token. |
| `sandbox.runners.vercel.{teamId,projectId,image,vcpus,timeoutMinutes}` | `""` | Vercel team, project and machine settings. |
| `sandbox.runners.bridgeBinaryUrl` | `""` | https URL of the linux/amd64 orchard CLI tarball used as the ssh bridge on Vercel machines. Empty = the pinned release, verified against its `checksums.txt`. |
| `sandbox.runners.bridgeBinarySha256` | `""` | SHA-256 of `bridgeBinaryUrl`. Required when that is set. |
| `sandbox.runners.previewDomain` | `""` | Bare domain for kubernetes previews. Must not share the Orchard cookie domain or hostnames. Also renders the preview IngressRoute and certificate below. |
| `sandbox.previews.route` | `true` | With a preview domain, renders a Traefik IngressRoute for `<port>-<id8>.<previewDomain>` on `ingress.entryPoints` to the `server` service. |
| `sandbox.previews.tls.secretName` | `""` | TLS Secret for previews. Empty = `<release>-sandbox-previews-tls`. |
| `sandbox.previews.tls.issuerRef` | `{}` | cert-manager issuer for the `*.<previewDomain>` Certificate (DNS-01 for wildcards). Empty = `certificates.issuer` when `certificates.enabled`, else no Certificate (bring the Secret). |

Prerequisites the chart does **not** install: the kubernetes-sigs/agent-sandbox controller and CRDs (`agents.x-k8s.io/v1beta1`), the kata RuntimeClass handler on the nodes, a VolumeSnapshotClass if you want forking, and for previews a wildcard DNS record (the route and certificate come from `sandbox.previews`). Values under `sandbox.runners` left empty render no env var, so those fields stay editable at Instance admin → Configuration → Sandbox runners. Slack and Linear integrations are configured there too (`SLACK_*`, `LINEAR_WEBHOOK_SECRET` via `server.env` if you want them pinned).

The `sandbox-isolation` NetworkPolicy is identical to the one the server applies on every leader election, ports included (`pnpm --filter server test:chart` compares them), so upgrades and the server never fight over it.

Example:

```yaml
sandbox:
  enabled: true
  runtimeClassName: kata
  runners:
    default: kubernetes
    vercel:
      enabled: true
      tokenSecret: { name: orchard-vercel, key: token }
      teamId: team_abc123
      projectId: prj_abc123
    previewDomain: orchard-preview.dev
```

### Grafts (`grafts`, `graftSettings.*`)

`grafts` lists the extensions to load, and is usually managed with `orchardctl graft`.

| Key | Default | Description |
|---|---|---|
| `graftSettings.trust` | `listed` | Which grafts may load: `official`, `listed` (official, marketplace, and signed by a key in `keys`), `taps` (listed plus the taps below) or `any` (unsigned too). |
| `graftSettings.keys` | `[]` | Raw ed25519 publisher keys, as `graft keygen` prints them. |
| `graftSettings.taps` | `[]` | Third-party catalogues, each with `name`, the https `url` of the folder holding `tap.json`, and `key`. Load only when `trust` is `taps` or `any`. |
| `graftSettings.marketplaceUrl` | `""` | Override the marketplace. |
| `graftSettings.strict` | `false` | `ORCHARD_GRAFTS_STRICT`. |
| `graftSettings.safeMode` | `false` | `ORCHARD_GRAFTS_SAFE_MODE`. |
| `graftSettings.pools` | `{}` | Database connections per pod, by graft id. Overrides `database.pool` in `graft.json` (default 3). |

### Database dumps (`databaseDumps.*`)

A CronJob per target that runs `pg_dump` and uploads the result to S3, for databases
outside Orchard.

| Key | Default | Description |
|---|---|---|
| `databaseDumps.enabled` | `false` | Render the CronJobs. |
| `databaseDumps.schedule` | `15 2 * * *` | Cron, unless a target sets its own `schedule`. |
| `databaseDumps.image` / `uploaderImage` | `postgres:17.12-alpine` / `amazon/aws-cli:2.40.2` | Dump and upload images. Keep the Postgres major at or above your server's. |
| `databaseDumps.destination.bucket` | `""` | Required when there are targets. |
| `databaseDumps.destination.prefix` | `platform-dumps` | Key prefix. |
| `databaseDumps.destination.endpointURL` | `""` | S3 endpoint, for anything that is not AWS. |
| `databaseDumps.destination.secretName` | `database-dumps-r2` | Secret you create, with keys `ACCESS_KEY_ID` and `ACCESS_SECRET_KEY`. |
| `databaseDumps.destination.keep` | `0` | Dumps to keep per target. `0` keeps them all. |
| `databaseDumps.targets` | `[]` | Each needs `name`, `host`, `database`, `user` and `passwordSecret.name`; optional `port`, `namespace`, `schedule`, `passwordSecret.key` (default `password`). |

### Metrics (`metrics.*`)

| Key | Default | Description |
|---|---|---|
| `metrics.enabled` | `true` | Install the orchard-metrics stack. |
| `metrics.namespace` | `orchard-metrics` | Namespace for the metrics stack. Referenced inside the vmagent scrape config and remote-write URL. |
| `metrics.clusterLabel` | `orchard` | `cluster` label vmagent stamps on every series. |
| `metrics.ingress.traefik.namespaces` | `[traefik]` | Namespaces vmagent scrapes the Traefik pods from. Matches the installer. Set to where your own Traefik runs (k3s's bundled one is in `kube-system`). Also sent to the server as `INGRESS_METRICS_TRAEFIK_NAMESPACE`. |
| `metrics.ingress.traefik.labels` | `{app.kubernetes.io/name: traefik}` | Pod labels that identify the Traefik pods. Combined with the namespace, so a tenant pod with the same label elsewhere is ignored. |
| `metrics.ingress.traefik.portName` | `metrics` | Container port name of Traefik's Prometheus entrypoint. |
| `metrics.ingress.haproxy.namespaces` | `[network]` | Namespaces vmagent scrapes the HAProxy ingress pods from. Also sent as `INGRESS_METRICS_HAPROXY_NAMESPACE`. |
| `metrics.ingress.haproxy.labels` | `{app.kubernetes.io/name: kubernetes-ingress}` | Pod labels that identify the HAProxy ingress pods. |
| `metrics.ingress.haproxy.portName` | `stat` | Container port name of the HAProxy stats exporter. |
| `metrics.victoriametrics.image` | `victoriametrics/victoria-metrics:v1.156.0` | VM image. Keep it on the same version as `metrics.vmagent.image`. |
| `metrics.victoriametrics.retention` | `30d` | `-retentionPeriod` flag. |
| `metrics.victoriametrics.storage.size` | `5Gi` | StatefulSet PVC size. |
| `metrics.victoriametrics.storage.storageClass` | `""` | StorageClass for the VM data PVC. Empty keeps the live StatefulSet's class, or uses the cluster default. |
| `metrics.victoriametrics.memoryAllowedPercent` | `60` | `-memory.allowedPercent`. VM sizes its cache off the memory *limit*, so it grows to fill whatever it is given; lower this and the limit together to shrink idle RSS. |
| `metrics.victoriametrics.resources` | requests `100m/256Mi`, limits `1/1Gi` | Resource block. |
| `metrics.vmagent.image` | `victoriametrics/vmagent:v1.156.0` | vmagent image. |
| `metrics.vmagent.resources` | requests `50m/128Mi`, limits `500m/512Mi` | Resource block. |
| `metrics.kubeStateMetrics.image` | `registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.20.0` | kube-state-metrics image. Each release tracks one Kubernetes client-go minor (v2.20 is v1.36), so bump it with the cluster. |
| `metrics.kubeStateMetrics.resources` | requests `20m/64Mi`, limits `200m/256Mi` | Resource block. |
| `metrics.nodeExporter.image` | `prom/node-exporter:v1.12.1` | node-exporter image. |
| `metrics.nodeExporter.resources` | requests `20m/32Mi`, limits `200m/128Mi` | Resource block. |

This stack is the largest idle cost in the chart. On a small cluster, trim it instead of turning it off: the installer gives a box under 8G of RAM VictoriaMetrics requests `50m/96Mi` limits `1/384Mi`, vmagent `20m/64Mi`/`500m/256Mi`, kube-state-metrics `10m/32Mi`/`200m/128Mi` and node-exporter `10m/16Mi`/`200m/64Mi`, with 7 days of retention. `metrics.enabled: false` empties the deployment metrics graphs and usage pages and leaves everything else working.

The server gets `VICTORIAMETRICS_URL` built from `metrics.namespace` (port 8428) whenever the stack is on, so moving the namespace no longer leaves it pointing at `orchard-metrics`. Set it in `server.env` to point somewhere else; a value only in `server.envFrom` is shadowed by the chart's.

### Logs (`logs.*`)

VictoriaLogs plus a Vector DaemonSet, in `metrics.namespace` but toggled independently (the namespace is created here when `metrics.enabled` is false). Vector tails pods in namespaces labelled `orchard.my/managed=true` (and the legacy `orchard.dev/managed=true`) and the ingress controller's pods (`app.kubernetes.io/name in (kubernetes-ingress,traefik)`), and ships them to `/insert/jsonline` with `namespace,app,kind,ingress_service` as stream fields (`ingress_service` is only set on Traefik access lines, which carry no namespace of their own).

| Key | Default | Description |
|---|---|---|
| `logs.enabled` | `true` | Install VictoriaLogs + Vector and inject `VICTORIALOGS_URL` (`http://victorialogs.<metrics.namespace>.svc.cluster.local:9428`) into the server. |
| `logs.retention` | `14d` | `-retentionPeriod`. |
| `logs.maxDiskSpaceUsage` | `16GiB` | `-retention.maxDiskSpaceUsageBytes`. Oldest days are dropped past this whatever the retention says. Keep it below the PVC size. |
| `logs.victorialogs.image` | `victoriametrics/victoria-logs:v1.54.0` | VictoriaLogs image. |
| `logs.victorialogs.storage.size` / `storageClass` | `20Gi` / cluster default | StatefulSet PVC. A StatefulSet cannot change class in place: `orchardctl update` recreates one whose volume never bound, and pins the values to the live class of one that did. |
| `logs.victorialogs.resources` | requests `100m/256Mi`, limits `1/1Gi` | Resource block. |
| `logs.vector.image` | `timberio/vector:0.61.0-distroless-libc` | Vector image. |
| `logs.vector.dataDir` | `/var/lib/vector-orchard` | Host directory for file checkpoints, so a restarted pod resumes instead of re-shipping. |
| `logs.vector.bufferEvents` | `20000` | In-memory sink buffer. When VictoriaLogs is down this fills and the newest events are dropped rather than back-pressuring the tail. |
| `logs.vector.resources` | requests `50m/128Mi`, limits `500m/512Mi` | Resource block. |

Each record carries `namespace`, `app` (pod label `orchard.my/app`, then `app.kubernetes.io/name`, then `app`), `kind` and `level` (`error`/`warn`/`info`/`debug`, read from JSON `level`/`severity` including pino numbers, then `level=` logfmt, then keywords). App logs (`kind=app`) also carry `pod`, `container`, `node`, `stream` and `slot` (`orchard.my/slot`, blue/green). Access logs (`kind=access`) carry `host`, `method`, `path` (query stripped), `route` (ids collapsed to `:id`, same rules as `normalizeRoute` in `apps/server/src/logs/logsql.ts`), `status`, `duration_ms`, `bytes`, `client_ip`, `user_agent`, `backend`, `service`, `server` and `ingress_pod`.

Access logs need the controller to log JSON:

- **HAProxy** (haproxytech kubernetes-ingress): set `controller.config.log-format` to a `%{+json}o` format with the field names above (`ts_ms`, `host`, `method`, `path`, `status`, `duration_ms`, `bytes`, `client_ip`, `user_agent`, `backend`, `server`) and capture host and UA into `txn.host`/`txn.ua` from `frontend-config-snippet`. The backend `<ns>_svc_<service>_<port>` gives namespace and service. Lines are capped at the log target's length (1024 bytes by default), so a very long path or UA truncates the JSON and that request is dropped.
- **Traefik**: on Traefik chart 41 and later, `accessLog.enabled=true`, `accessLog.format=json` and `accessLog.fields.headers.names.User-Agent=keep`; before 41 the same keys live under `logs.access.*`. The installer sets them, and `orchardctl update` turns them on for an install that predates that, with `--reuse-values` on the chart version already deployed. `ServiceName` (`<ns>-<service>-<port>@kubernetes`) does not mark where the namespace ends, so Vector stores it as the `ingress_service` stream field (provider suffix removed, `@internal` lines dropped) and the server matches it against each app's `<ns>-<app>-<port>` when it queries. Nothing depends on node-local state, so access lines are kept whichever node the app runs on.

### Image scanning (`trivy.*`)

The Orchard scanner, one of the two backends behind the app Security tab (the
other is Harbor's own scanner). With nothing picked in Admin, Instance, Image
scanning (or pinned with `IMAGE_SCANNER` in `server.env`), a deployed Orchard
scanner is the one used. The chart default is off; the one-command installer
and `orchardctl update` turn it on. It pulls images straight from the registry
the server pushes to (`DOCKER_REGISTRY_PUSH`, plain http when listed in
`REGISTRY_HTTP_HOSTS`) with `HARBOR_USERNAME`/`HARBOR_PASSWORD`, which is how
it reaches the installer's zot.

| Key | Default | Description |
|-----|---------|-------------|
| `trivy.enabled` | `false` | Install the Trivy server in `trivy.namespace` and inject `TRIVY_SERVER_URL`, `TRIVY_SCAN_NAMESPACE`, `TRIVY_IMAGE`, `TRIVY_SERVER_TOKEN`, `TRIVY_MAX_CONCURRENT_SCANS`, `TRIVY_SCAN_TIMEOUT_SECONDS` and `ORCHARD_INTERNAL_URL` (`http://server.<namespace>.svc.cluster.local:<server.service.port>`, unless `server.env` sets it) into the server. |
| `trivy.namespace` | `orchard-scans` | Namespace for the server and the scan jobs. Created by the chart, Pod Security `restricted`. |
| `trivy.image` | `ghcr.io/aquasecurity/trivy:0.76.2` | Used for both the server and the jobs. Keep it the Alpine-based upstream image: jobs run `sh` and `wget`. |
| `trivy.token` | generated | Shared secret between the jobs and the server, kept across upgrades in `trivy-server-token`. |
| `trivy.maxConcurrentScans` | `3` | Scans running at once; a scan request past this is refused with a "try again" message. |
| `trivy.scanTimeoutSeconds` | `900` | `activeDeadlineSeconds` of each scan job. Trivy's own timeout is a minute less. |
| `trivy.dbRepository` / `javaDbRepository` | Trivy defaults | Point at a mirror for air-gapped instances. |
| `trivy.resources` | requests `100m/512Mi`, limits `2/2Gi` | Trivy server resources. Scan jobs use requests `100m/256Mi`, limits `1/1536Mi`. |
| `trivy.storage.size` / `storageClass` | `5Gi` / cluster default | Vulnerability database cache. |

How a scan runs: the API server creates a Job labelled `orchard.my/image-scan`
plus a Secret it owns (registry credentials and a one-time result token). The
Job pulls the image with Trivy in client mode, asks the server for matches and
POSTs the JSON report to `ORCHARD_INTERNAL_URL/apiv1/internal/image-scans/<id>/result`.
The engine's `scans` shard watches those Jobs and marks a scan failed when its
Job fails, times out or is removed. Jobs are cleaned up 10 minutes after they
finish. Images in Orchard's own registry are pulled through `DOCKER_REGISTRY_PUSH`
(the in-cluster address), so the pull-only names kubelets use, such as the
installer's `registry.orchard.local`, still work.

Network: scan jobs accept no traffic and may reach any in-cluster pod and the
public internet except `169.254.0.0/16`. If your registry or the server
namespace has an ingress policy of its own, allow `orchard-scans`. The Trivy
server needs egress to download its database (`mirror.gcr.io`, `ghcr.io`).

### Gateway (`gateway.*`)

Renders Gateway API `Gateway` objects and `ReferenceGrant`s. Orchard does not support
Gateway API yet: tenant apps use `Ingress`, and the server creates no `HTTPRoute`, so
these objects carry no traffic. Leave `gateway.enabled` off. `gateway.http.appDomain` is
read either way, because it is the app domain.

| Key | Default | Description |
|---|---|---|
| `gateway.enabled` | `false` | Master switch. Turning it on needs the Gateway API CRDs and a matching `GatewayClass`. |
| `gateway.namespace` | `network` | Namespace the Gateways + ReferenceGrants live in. Cert Secrets must be readable from here. |
| `gateway.gatewayClassName` | `traefik` | `GatewayClass` both Gateways attach to. |
| `gateway.http.enabled` | `true` | Render the L7 HTTP/HTTPS Gateway. |
| `gateway.http.name` | `http-gateway` | Gateway object name. |
| `gateway.http.appDomain` | `""` | Hostname pattern for autogen user app domains. Must match server `APP_DOMAIN` and frontend `PUBLIC_APP_DOMAIN`. Empty renders no wildcard listener and no wildcard Certificate. |
| `gateway.http.appWildcardSecretName` | `""` | Secret holding the wildcard TLS cert for `*.{appDomain}`. Empty derives `wildcard-<appDomain with dots as dashes>-tls`, which the chart-managed `Certificate`, the Gateway listener and `PLATFORM_WILDCARD_DOMAINS` all agree on. |
| `gateway.db.enabled` | `true` | Render a TCP Gateway with a placeholder listener. Public databases use `LoadBalancer` Services, not this Gateway. |
| `gateway.db.name` | `db-gateway` | Gateway object name. |
| `gateway.referenceGrants.enabled` | `false` | Render `ReferenceGrant`s. Only needed if Routes reference cross-namespace *backend Services*, not for parentRefs (covered by `allowedRoutes.namespaces.from: All`). |
| `gateway.referenceGrants.fromNamespaces` | `[]` | Explicit list of source namespaces. One ReferenceGrant rendered per (namespace × Gateway). Empty = no grants rendered. Gateway API admission rejects empty / wildcard `from.namespace`, so this must be a concrete list. |

### Certificates (`certificates.*`)

Renders `cert-manager.io/v1 Certificate` resources for the configured wildcards.

| Key | Default | Description |
|---|---|---|
| `certificates.enabled` | `true` | Render `Certificate` resources. Set `false` if you pre-provision the TLS Secrets out-of-band. |
| `certificates.namespace` | `network` | Where Certificates + their Secrets live. Same as `gateway.namespace` in the default layout. |
| `certificates.issuer.name` | `letsencrypt-dns01-wildcard` | Name of the `ClusterIssuer` (or `Issuer`). **Must support DNS-01.** See [Wildcard certificates](https://docs.orchard.hackclub.com/operate/wildcard-certificates/). |
| `certificates.issuer.kind` | `ClusterIssuer` | `ClusterIssuer` or `Issuer`. |
| `certificates.duration` | `2160h` | Cert lifetime. |
| `certificates.renewBefore` | `360h` | Renewal lead time. |
| `certificates.privateKey` | `{algorithm: ECDSA, size: 256, rotationPolicy: Always}` | Passed verbatim to `spec.privateKey`. |
| `certificates.wildcards.app.enabled` | `true` | Issue the wildcard for autogen app domains. |
| `certificates.wildcards.app.domain` | `""` (→ `gateway.http.appDomain`) | Hostname pattern. Cert covers `*.{domain}` + `{domain}`. |
| `certificates.wildcards.app.secretName` | `""` (→ `gateway.http.appWildcardSecretName`) | Secret name. Tenant ingresses reference it, and so does the Gateway listener when `gateway.enabled` is on. |
| `certificates.wildcards.db.enabled` | `true` | Issue the wildcard for public CNPG TLS. |
| `certificates.wildcards.db.domain` | `""` | Hostname pattern. Matches server `PUBLIC_DB_DOMAIN`. Empty issues no Certificate. |
| `certificates.wildcards.db.secretName` | `wildcard-db-orchard-my-tls` | Secret consumed by the server's `syncPublicTlsSecret` reflection. |

### Public TLS reflection (`publicTls.*`)

Exposes the secret-name knobs that the server reads at runtime (`PUBLIC_DB_TLS_*` env vars).

| Key | Default | Description |
|---|---|---|
| `publicTls.db.sourceNamespace` | `""` (→ `certificates.namespace`) | Where the server reads the wildcard DB cert FROM. Maps to `PUBLIC_DB_TLS_SOURCE_NAMESPACE`. |
| `publicTls.db.sourceSecret` | `""` (→ `certificates.wildcards.db.secretName`) | Source Secret name. Maps to `PUBLIC_DB_TLS_SOURCE_SECRET`. |
| `publicTls.db.localSecret` | `wildcard-db-tls` | Secret name written into each project namespace for CNPG to mount. Maps to `PUBLIC_DB_TLS_LOCAL_SECRET`. |
| `publicTls.db.mode` | `wildcard` | `wildcard` copies the shared wildcard private key into tenant namespaces. `perDatabase` has cert-manager issue one certificate per public database for its own hostname, and the wildcard key stays in `sourceNamespace`. Maps to `PUBLIC_DB_TLS_MODE=per-database`. Grants the server create/update/delete on `certificates.cert-manager.io`. |
| `publicTls.db.issuer` | `{}` (→ `certificates.issuer`) | `name` and `kind` of the issuer used in `perDatabase` mode. Must be able to solve DNS-01 for the database domain. Maps to `PUBLIC_DB_TLS_ISSUER_NAME` / `_KIND`. |
| `publicTls.db.legacyHostnames` | `false` | Also put the pre-namespace-qualified hostname `<cluster>.<db domain>` in each per-database certificate. Off by default because two tenants with the same cluster name could otherwise both obtain a certificate for it. Maps to `PUBLIC_DB_TLS_LEGACY_HOSTNAMES`. |

---

### Example: production override

```yaml
namespace: orchard

image:
  repository: hackclub/orchard
  pullSecrets: [ghcr-pull]

frontend:
  replicas: 2
  image: { tag: "sha-abc1234" }

server:
  replicas: 2
  image: { tag: "sha-abc1234" }
  env:
    - { name: LOG_LEVEL, value: info }

postgres:
  instances: 2
  storage: { size: 50Gi, storageClass: ceph-rbd }

ingress:
  host: orchard.example.com
  entryPoints: [websecure]
  tls:
    enabled: true
    secretName: orchard-tls
  middlewares:
    - { name: redirect-https, namespace: traefik }

builders:
  harbor:
    username: orchard-ci
    password: "${HARBOR_PASSWORD}"
    hosts: [harbor.example.com]
  r2:
    accessKeyId: "${R2_KEY}"
    secretAccessKey: "${R2_SECRET}"
  quota:
    requestsCpu: "32"
    requestsMemory: "64Gi"
    pods: "20"

metrics:
  victoriametrics:
    retention: 90d
    storage: { size: 50Gi, storageClass: ceph-rbd }
```

---

## 5. Toggles

Disable any component you don't want:

```yaml
postgres:  { enabled: false }   # if you bring your own DB; then set server.env.DATABASE_URL
builders:  { enabled: false }
metrics:   { enabled: false }
logs:      { enabled: false }
ingress:   { enabled: false }
mcp:       { enabled: false }   # also pins the admin panel's MCP toggle off
trivy:     { enabled: true }    # off by default; enables the Orchard image scanner
```

If `postgres.enabled: false`, supply `DATABASE_URL` via `server.env` or
`server.envFrom`:

```yaml
server:
  env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef: { name: my-db, key: uri }
```

---

## 6. Image pulls

Images live under `ghcr.io/hackclub/orchard/{frontend,server,mcp}` and are
public by default. If made private, create a pull secret and reference it:

```yaml
image:
  pullSecrets: [ghcr-pull]
```

---

## 7. Upgrades

```bash
helm upgrade orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --version <new-version> -n orchard -f my-values.yaml
```

CNPG handles rolling Postgres upgrades on its own. Bumping `postgres.instances`
adds replicas. Set `postgres.backup.enabled` to render a CNPG `ScheduledBackup`.

Upgrading to the release with opt-in Postgres updates:

- Orchard no longer moves tenant databases to new Postgres minor releases on
  its own. Each organization's admins turn it on under Settings → Databases
  (or `orchard org update <org> --postgres-auto-update`). Until then, members
  apply a minor update from the database's Security tab or with
  `orchard db update <id>`. `POSTGRES_AUTO_UPDATE=false` still switches it off
  for the whole instance.

Upgrading across the 2026-09 security release:

- the server's ClusterRole loses `escalate`; a new `<release>-tenant-secrets`
  ClusterRole appears and tenant namespaces created from now on bind to it.
  Existing namespaces keep their per-namespace Role, which stays valid.
- the backup proxy switches to the `orchard_r2_proxy` role. Backup lookups can
  fail for a few seconds after the rollout until the server's boot-time grant
  lands, then recover.
- `builders.httpRegistries` replaces the registries that were hardcoded in the
  BuildKit config. If you pushed to a plaintext registry other than the
  internal Harbor, list it.
- identity-provider-initiated SAML sign-in stops working, and org owners only
  sign in through providers they created; see https://docs.orchard.hackclub.com/teams/sso/.

Upgrading to the release with cluster-neutral storage defaults:

- `postgres`, `metrics`, `logs` and `builders.localCache` no longer default to
  `longhorn`. The Postgres cluster, the VictoriaMetrics and VictoriaLogs
  StatefulSets and the BuildKit cache keep their live class on their own, so
  `helm upgrade` does not trip over an immutable field.
- Vector no longer guesses a Traefik access line's namespace from the pods on
  its own node. It stores Traefik's service name as the `ingress_service`
  stream field and the server matches `<namespace>-<app>(--green)-<port>`, so
  access lines from apps on other nodes are kept. HAProxy lines are unchanged.
- `r2Proxy` renders only with an upstream. A release that had it enabled with
  an empty `r2Proxy.upstream.endpoint` (a crash-looping proxy) loses the
  Deployment and `BACKUP_PROXY_ENABLED`; nothing that worked changes.

---

## 8. Troubleshooting checklist

- `helm install` fails with `no matches for kind` → a CRD the chart renders isn't installed. Check the prerequisites at the top. `Certificate` goes away with `certificates.enabled: false`, and `IngressRoute` with `ingress.enabled: false` and `mcp.ingress.enabled: false` (then route to the Services yourself).
- `kubectl -n orchard get cluster orchard-db` → confirm CNPG `Cluster.status.phase` is `Cluster in healthy state`. If it has no phase, the CNPG operator isn't running or isn't watching this namespace.
- `kubectl -n orchard describe pod -l app.kubernetes.io/name=server` → look for `ImagePullBackOff` (pull secret) or `CreateContainerConfigError` (missing `orchard-db-app` secret: CNPG hasn't finished bootstrapping yet, retry).
- `kubectl -n orchard-metrics logs deploy/vmagent` → scrape errors mean the RBAC ClusterRoleBinding didn't apply (cluster-admin needed for install).

---

## 9. Uninstall

```bash
helm uninstall orchard -n orchard
kubectl delete ns --ignore-not-found orchard orchard-builders orchard-metrics \
  orchard-scans orchard-r2-proxy orchard-object-storage
```

`helm uninstall` deletes the CNPG `Cluster`, and its PVCs go with it, so back up the Orchard
database first. The metrics and logs volumes and the local object store
(`helm.sh/resource-policy: keep`) survive the uninstall. Deleting the namespaces removes the PVCs
in them too, including the local backups, so stop before that step if you want to keep them.

Add `orchard-fc-builders` and `orchard-sandboxes` if you turned those on. Tenant
namespaces (label `orchard.my/managed=true`) are not part of the release and stay
either way.
