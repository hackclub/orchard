# Developing Orchard

This file explains how Orchard works, for people changing it. Every name here is in the code, so grep for it.

- Setup, commits and pull requests are in [CONTRIBUTING.md](CONTRIBUTING.md).
- The repo map, generated files and project rules are in [AGENTS.md](AGENTS.md).
- How the server could split into services is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Running an instance is covered at <https://docs.orchard.hackclub.com>.

## Kubernetes is the source of truth

Orchard does not own the state of the things it runs. The cluster does. Postgres holds what Orchard needs to know about those objects, plus the things Kubernetes has no concept of, such as organizations, roles and audit records.

Three rules follow from that, and most engine code exists to keep them:

1. If Postgres and the cluster disagree, the cluster is right.
2. A failed read never means a resource is gone. Only a live 404 does. `readLive` in `apps/server/src/engine/consumers/live-object.ts` returns `present`, `absent` or `unknown`, and `unknown` must never be treated as `absent`.
3. A change made with `kubectl` is adopted into Orchard's rows, not reverted. Security objects are the one exception (see [The guard shard](#the-guard-shard)).

## How a request flows

**Reads** mostly come from Postgres, so a page load does not call the Kubernetes API. The engine keeps that copy current.

**Writes** mostly go through the apply queue (`apps/server/src/apply`). A request records the desired manifest with `ApplyQueueService.enqueue`, which upserts on a `dedupeKey` and bumps a `generation`, then returns. Workers drain the queue and retry with backoff through `ApplyExecutorService`. A newer write for the same key replaces an older one rather than queueing behind it.

**Events** reach the dashboard as server-sent events over Redis Streams, and a client replays from the last event it saw after reconnecting. Without Redis, each replica delivers only its own events.

## The engine

`apps/server/src/engine` lists and watches every object Orchard manages, stores a copy in Postgres, and hands each change to a consumer.

```
Kubernetes API
   | list, then watch (one informer per resource)
   v
engine/core/informer.ts    stores the object through EngineStore (engine/prisma-store.ts)
   | onEvent / onListComplete
   v
engine/consumers/*         update Orchard's own rows
```

- **`engine/core`** is the standalone part: the list-then-watch informer, deletes, lease election and health. It imports nothing from the server except through the `EngineStore` interface, and oxlint enforces that.
- **`engine/shards.ts`** groups resources into shards: `pods`, `cnpg`, `workloads`, `batch`, `net`, `tenancy`, `events`, `scans`, `storage` and `guard`. Each shard has its own lease (`orchard-mirror-<name>`), so one replica runs each shard, and replicas balance shards between them. Grafts add shards with `registerEngineShard`.
- **`engine/consumers`** are Orchard-specific, one per kind.

The engine stays off when `ENGINE_DISABLED=true`, when there is no kubeconfig, and when `LeaseService.canCoordinate` is false.

### Writing an informer or consumer

The contracts on `EngineResource` in `engine/core/informer.ts` matter:

- `mapRefs` returning `{}` means the object belongs to nothing, and that gets stored. Throwing means Orchard could not tell, so the informer leaves the row alone and retries.
- `onEvent` must throw on failure. A handler that swallows its errors tells the informer the version was applied, and nothing will ever come back for it.
- `onListComplete` receives `refs: null` for anything it could not resolve. A pruner that sees a null has an incomplete picture and must not delete on the strength of it.

Events for the same object are serialized. A full resync runs every 10 minutes (`RESYNC_INTERVAL_MS`) to repair anything a watch missed.

Consumers follow a few more rules:

- Removals that destroy Orchard state are confirmed after a delay. Ingresses and namespaces use `CONFIRM_AFTER_MS`, 90 seconds.
- A row created in the last two minutes may not have its cluster object yet. Check `rowMayBePending` before treating that as drift.
- Adoption must not echo Orchard's own writes. Consumers defer while a build or queued apply is in flight, and fields Orchard derives carry an annotation recording what it last wrote.

### The guard shard

`GuardConsumer` (`engine/consumers/guard.consumer.ts`) is the exception to adoption. It compares isolation objects against what `PrismaGuardDesired` (`engine/guard/desired.ts`) expects, and restores a missing or edited object after a settle window (`SETTLE_MS`), rate limited by `RestoreLimiter` and audited as `security.policy.restored`. A periodic sweep backs up the watch.

## Leases and `canCoordinate`

`apps/server/src/coordination/lease.service.ts` wraps Kubernetes Leases.

`LeaseService.canCoordinate` is true when the process has a cluster to talk to and a namespace whose leases it can contend for, either `ORCHARD_CONTROL_NAMESPACE` or the ServiceAccount's own namespace. A laptop with a kubeconfig but no control namespace fails this check, which is the point: it cannot see the leases, so anything cluster-wide it ran would be a second, uncoordinated actor on someone else's infrastructure.

Use these patterns for background work:

| Work                                | Gate                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Runs on exactly one replica         | `canCoordinate` and `lease.isHolder(GLOBAL_LEADER_LEASE)`, or `LeaderElectionService.isLeader()` |
| Runs on every member of the cluster | `canCoordinate`. The apply queue and build queue work this way.                                  |
| One pass at startup on the leader   | `LeaderElectionService.onAcquired`. `isLeader()` is false until the first round trip completes.  |

Never gate cluster-wide work on having a kubeconfig. `APPLY_WORKER_DISABLED=true` makes a replica enqueue only.

## Tenancy and namespace boundaries

Each project environment gets its own namespace, named `{org-slug}-{project-slug}-{6 hex}` and labeled `orchard.my/managed=true`. Retired names are recorded and never reused. Platform namespaces such as `orchard`, `orchard-builders` and `orchard-sandboxes` are reserved in `ProjectsService.RESERVED_NAMESPACES`.

When you add a route or a tenant-reaching feature:

- Authorize in the service with `AuthorizationService`. A caller with no access gets `NotFoundException`, not 403. There is no row-level security, so a missing scope check is a real hole.
- A new route fails `auth-coverage.test.ts` until the snapshot is reviewed. `apps/server/test/isolation/` replays routes as another tenant. [docs/isolation-testing.md](docs/isolation-testing.md) explains how to classify a route.
- `K8sNamespaceService.createNamespace` fails closed: if the default-deny policy cannot be applied, the namespace is deleted.

The full set of boundaries is in [Tenancy model](#tenancy-model).

## URLs are computed by the server

An instance can serve on ports other than 80 and 443, so a client must never assemble a URL. `ingressPublicUrl` in `apps/server/src/projects/projects.utils.ts` builds one from the host, TLS state and the configured public ports. `scrubIngress` returns it as `url` and removes the protection secrets. A new ingress payload selects `host`, `path`, `tlsSecretName` and `entrypoints`, and maps through `scrubIngress`.

## Conventions

[AGENTS.md](AGENTS.md) has the rules and the generated-files table. The ones that catch people out:

- Run the generators in the same change as the route, command, variable or dependency they describe.
- Migrations go through Prisma. Never hand-write the SQL or edit an applied migration.
- Cluster-specific values such as storage class, ingress class and registry are environment variables, not literals.
- A typecheck error about a missing column means a stale Prisma client. Check `schema.prisma`, then regenerate.
- Suites that write real rows refuse `localhost:5432`. See [apps/server/test/README.md](apps/server/test/README.md).

## Tenancy model

Internal spec. For each isolation boundary it states the invariant, the mechanism that enforces it now, the configuration it requires, what is not guaranteed, the residual risk, and the test that proves it. Its behaviour was last verified against `main` at commit `b9cc0373`. Every file, function and setting named here was checked to exist again in November 2026. Items marked `UNVERIFIED` were not confirmed against code or a live cluster.

Threat model: an evil organization, an evil project editor, an evil tenant workload, an evil build, an evil IdP, a leaked org-scoped token, a prompt-injected MCP client. Trusted: the instance operator, first-party grafts, and a project editor for their own project only.

Principals: instance superadmin; org owner / admin / member / guest; project admin / member / viewer; API token (optionally project-scoped, optionally org-scoped); org-scoped IdP session (`sessionOrgId`); MCP gateway request; tenant workload (a pod in a tenant namespace); build pod; anonymous internet client.

Grafts are trusted by design. Graft code authority is out of scope; only signature, revocation and labeling signals matter.

Related files: `docs/isolation-testing.md` (how the cross-tenant control-plane harness works and how to classify a new route), `docs/isolation-invariants.json` (machine-readable index), operator page `apps/docs/src/content/docs/operate/security.mdx`.

Rule for this document: where something is still unfixed it is described as hardening guidance, not as a procedure.

### Conventions

- Tenant namespace: `{org-slug}-{project-slug}-{6 hex}` (`ProjectsService.freshNamespace`, `apps/server/src/projects/projects.service.ts`), one per project environment (`EnvironmentsService.deconflictNamespace`). Labeled `orchard.my/managed=true`. Retired names are recorded in the `RetiredNamespace` table and never reused.
- Control-plane namespace: `orchard` (`Values.namespace`). Other platform namespaces: `orchard-builders`, `orchard-r2-proxy`, `orchard-metrics`, `orchard-scans`, `orchard-object-storage`, `orchard-sandboxes`, `orchard-fc-builders` (reserved in `ProjectsService.RESERVED_NAMESPACES`).
- Chart paths are under `infra/charts/orchard/`.

### I1. Organization to organization, control plane (API and database)

**Invariant.** A principal with no membership in org B cannot read, list, mutate or learn the existence of any resource of org B through any route, token, session or MCP request.

**Mechanism now.**

- Global guard `SuperAdminGuard.canActivate` (`apps/server/src/auth/superadmin.guard.ts`) authenticates every route that is not `@Public()` and publishes the request auth context (`requestAuthStorage`, `apps/server/src/auth/request-context.ts`) with `tokenProjectIds` and `sessionOrgId`.
- `AuthorizationService.getOrgAccess`, `requireOrgMember`, `requireOrgAdmin`, `requireOrgOwner` (`apps/server/src/auth/authorization.service.ts`): non-members get `NotFoundException`, not 403. `getOrgAccess` returns `null` when `sessionOrgId` differs from the requested org.
- `AuthorizationService.resolveProjectAccess`, `requireProjectView`, `requireProjectEdit`: access is derived from the project's own `organizationId`. A `ProjectMember` row without an `OrganizationMember` row grants nothing.
- `AuthorizationService.listVisibleProjectIds` and `ProjectAccessService.buildProjectAccessFilter` (`apps/server/src/projects/project-access.service.ts`) scope list endpoints.
- Namespace-keyed Kubernetes routes answer 404 for both hidden and missing namespaces (`kubernetes.controller.ts`, `resolveNamespaceScope` in `apps/server/src/projects/namespace-scope.ts`).
- Pre-auth answers that could reveal accounts are uniform: auth methods independent of the email, ownership transfer recipient lookup.
- Route classification is snapshotted in `apps/server/test/auth-coverage.snapshot.json`: 689 routes (519 authenticated, 101 superadmin, 69 public). A new or reclassified route fails `auth-coverage.test.ts` until the snapshot is reviewed.
- Superadmin bypass is explicit (`source: 'superadmin'`). `requirePhysicalOrgMembership` exists for actions a superadmin must not satisfy.

**Required config.** None beyond a correctly operated database. Restrict superadmin accounts.

**Not guaranteed.**

- Authorization is enforced in services by convention, not by the data layer. There is no row-level security and no automated check that every Prisma query on a tenant table is scoped.
- Superadmins can read every org, but only as an unrestricted principal: a session not scoped to an org, or an API token with `exec` and no project or org restriction. Restricted tokens, org-scoped sessions and MCP grants of a superadmin act on their real memberships only (`holdsSuperAdminPower`, `AuthorizationService.isUnrestrictedSuperAdmin`).

**Residual risk.** A missing scope check in one route. Response-shape parity between "not found" and "forbidden" is by convention outside the routes listed above (`UNVERIFIED` for routes that do their own lookups). Timing was not measured.

**Test.** Partial. `apps/server/test/org-isolation.test.ts`, `auth-coverage.test.ts`, `kubernetes-namespace-oracle.test.ts`, `auth-methods-uniform.test.ts`, `transfer-recipient-oracle.test.ts`, `rbac-coverage.test.ts` (needs `helm`). The cross-tenant sweep (every authenticated route replayed with another org's ids): `apps/server/test/isolation/`, see `docs/isolation-testing.md`.

### I2. Project to project inside an org (roles, guests, tokens, MCP grants, exec)

**Invariant.** A principal holds exactly the rights of their project role. A plain org member or guest sees only projects they belong to; a viewer cannot mutate; a project-scoped token or MCP grant cannot reach another project or act with org-level power; a minted credential never outlives or outranks its parent.

**Mechanism now.**

- Role resolution: `AuthorizationService.resolveProjectAccess` (org owner/admin see all projects; project admin / member / viewer; unknown role names degrade to read-only).
- Project-scoped tokens: `tokenProjectIds` makes any other project resolve to `null`; `getOrgAccess` strips `isAdmin` for them; `requireOrgCanCreateProjects` and `requireOrgOwner` refuse them.
- Route denylists in `superadmin.guard.ts`: `deniedToApiToken`, `deniedToProjectToken`, `deniedToOrgScopedSession`, `deniedToOrgSsoSession`, `MCP_GATEWAY_DENY`.
- Token lineage: minted tokens record their parent in `ApiToken.parentTokenId` (cascade delete), so revoking a parent revokes its children; depth is capped (`apps/server/src/auth/api-tokens.service.ts`). Exec session tokens and MCP OAuth tokens are bound to the grant that created them (`apps/server/src/kubernetes/exec-session-engine.ts`, `mcp-oauth.service.ts`).
- Org-scoped credentials cannot use personal git: `personalCredentialsRefused` and `personalSourceSelectionRefused` (`apps/server/src/auth/request-context.ts`) are enforced in `git-connections.service.ts`, `github.service.ts`, `deployments.service.ts`, `compose-stacks.service.ts`.
- Notifications, events and deploys stop after access is lost (`MembershipCacheService`, org event stream re-authorisation).
- CSRF: `crossSiteMutation` in `superadmin.guard.ts` (Origin against platform origins, else `Sec-Fetch-Site`). A request with neither header is allowed; non-browser clients cannot ride a cookie.
- Pod exec requires `requireProjectEdit`, resolves the namespace to its project via `resolveNamespaceScope`, and is limited to tenant app pods: `isExecableAppPod` / `checkPodExecable` / `assertPodExecable` (`apps/server/src/kubernetes/pod-exec-policy.ts`, used by `terminal.gateway.ts` and `kubernetes.controller.ts`). Database, pooler, Tailscale proxy, job and build pods are refused with 403.

**Required config.** None.

**Not guaranteed.** Project editors (`member`, `admin`) are trusted with their own project's resources: exec into every app pod of the project and read the environment bound to it. Org owners and admins see every project in the org.

**Residual risk.** A role x token scope x MCP grant x route matrix is not tested. Greenhouse sandbox terminals are a separate surface (see `docs/ai-sandbox.md`).

**Test.** `api-token-lineage.test.ts`, `exec-token-expiry.test.ts`, `mcp-gateway-scope.test.ts`, `mcp-token-type.test.ts`, `project-member-role.test.ts`, `namespace-scope.test.ts`, `security-hardening.test.ts`, `pod-exec-policy.test.ts`, `org-scoped-personal-credentials.test.ts`. Role x token scope x MCP grant replay: `apps/server/test/isolation/` (`docs/isolation-testing.md`).

### I3. Tenant network (workload to workload, workload to platform, workload to node and metadata)

**Invariant.** A pod in tenant namespace A can reach only: pods in A; DNS; the ingress controller namespaces on their serving ports; the public internet outside private, link-local and cluster-node ranges; other tenants' explicitly published (`-allow-public`) pods; and the backup proxy on TCP 9000. It cannot reach the kube-apiserver, node services, cloud metadata, or any unpublished service of another tenant or of the platform. No platform pod accepts a connection from a tenant namespace.

**Mechanism now.**

- `tenantDenyPolicy` (`apps/server/src/kubernetes/security-policies.ts`) builds `default-deny-all` (Ingress and Egress). Ingress: own namespace plus `tenantIngressNamespaces()` (default `network`, `orchard`; env `TENANT_INGRESS_NAMESPACES`). Egress: own namespace; the ingress namespaces except the platform namespace, on `tenantIngressPorts()` only (default 80, 443, 8000, 8080, 8443; env `TENANT_INGRESS_PORTS`); kube-dns on 53; `0.0.0.0/0` except `TENANT_PRIVATE_EGRESS_EXCEPT` (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10) plus the cluster's node, pod CIDR and apiserver addresses (`clusterExcepts`), minus any outbound TCP ports listed in `TENANT_EGRESS_BLOCK_PORTS` (none by default); other tenant namespaces (`TENANT_NAMESPACE_EGRESS_PEERS`); the r2-proxy namespace on 9000.
- Node and apiserver addresses: `KubernetesService.clusterExceptCidrs` (`apps/server/src/kubernetes/kubernetes.service.ts`) combines `nodeAddresses`, the apiserver endpoints, the kubeconfig server host and `PLATFORM_EXTRA_DENY_CIDRS` through `ipv4Excepts` (`apps/server/src/kubernetes/cluster-addresses.ts`). The guard rolls every tenant policy forward when the set changes. The chart computes the same list for its own policies (`orchard.clusterExcepts` in `templates/_helpers.tpl`, from `lookup`, refreshed on every `helm upgrade`).
- Cilium (detected by `KubernetesService.isCiliumAvailable`, or `cilium.enabled`): `ciliumDenyPolicy` writes `deny-platform-egress` (egressDeny to entities `host`, `remote-node`, `kube-apiserver`, plus any ports in `TENANT_EGRESS_BLOCK_PORTS`) into every tenant namespace except pods labeled `cnpg.io/cluster`; `ciliumIngressPolicy` (`allow-cilium-ingress`); `cnpgApiserverPolicy` and `cnpgOperatorPolicy` for database pods. Entities come from `tenantDenyEntities()` (env `TENANT_DENY_ENTITIES`, chart `tenant.denyEntities`).
- Fail closed at creation: `K8sNamespaceService.createNamespace` calls `applyDefaultDenyOrAbandon`. It retries `createNetworkPolicy` (which also writes the Cilium policies) three times with back-off, and on final failure deletes the namespace and throws `ServiceUnavailableException`. No workload is ever created in a namespace without the policy.
- Re-applied on every boot of a lease-holding server 5 s after start (`onModuleInit` -> `reconcileTenantNetworkPolicies`).
- Continuously enforced by the engine guard: `GuardConsumer` (`apps/server/src/engine/consumers/guard.consumer.ts`) with `PrismaGuardDesired.expected` / `desired` (`apps/server/src/engine/guard/desired.ts`). A missing or edited `default-deny-all`, `allow-project-databases`, `allow-database-platform` or Cilium policy is restored after a 10 s settle window (`SETTLE_MS`), rate limited by `RestoreLimiter`, audited as `security.policy.restored`. A periodic sweep runs every 5 minutes (`TENANT_POLICY_CHECK_INTERVAL_MS` in `apps/server/src/engine/engine.service.ts`).
- Control-plane ingress: with `networkPolicy.platform.enabled` (default true) `templates/network-policies.yaml` renders `platform-ingress` in the release namespace and the metrics namespace, admitting only the namespace itself and namespaces that are not tenants, builders, sandbox, fc-builder or scan namespaces. `platform-allow-cilium-entities` admits the Cilium host, remote-node and ingress identities. `platform-allow-image-scan-results` lets scan jobs reach the server on 3001. Redis has its own `redis-ingress` (server, mcp, worker only) and requires a password (`redis.auth`, secret `redis-auth`, injected as `REDIS_PASSWORD`/`REDIS_URL`). The r2-proxy namespace accepts tenant namespaces, the release namespace and the CNPG operator only (`r2-proxy-ingress`, when `r2Proxy.networkPolicy.enabled`).
- Platform pods that run tenant code: `builder-network-policy`, `buildkit-daemon-network-policy`, `buildkit-daemon-legacy-deny` (`templates/builders.yaml`, egress from `orchard.builderEgressRules` with node and apiserver excepts), per-tenant daemon ingress `daemonTenantIngressPolicy` (`apps/server/src/docker/buildkit-daemon-policy.ts`), `sandbox-isolation`, `fc-builder`, `image-scan-jobs`. With Cilium, `templates/egress-deny.yaml` adds `deny-platform-egress` for the builders, sandbox, fc-builder and scan namespaces (`networkPolicy.egressDeny.enabled`).
- Publishing: `publicDeploymentPolicy` / `publicDatabasePolicy` open ingress from anywhere for the named pods and ports only. Public ports per org are capped (`MAX_PUBLIC_PORTS_PER_ORG`, default 20, `apps/server/src/projects/public-exposure-quota.ts`); the server picks the port, the tenant cannot.
- Tenant pods set `automountServiceAccountToken: false`. Pod Security Admission on every tenant namespace: enforce `baseline`, audit and warn `restricted` (`createNamespace`).
- Admission policies (`templates/admission-policies.yaml`, policies in `policies/orchard-tenant-policies.yaml`) refuse open NetworkPolicy egress, loosening PSA labels and non-server edits to Services and EndpointSlices (see I4).

**Required config.**

- A CNI that enforces `NetworkPolicy`. Orchard does not check this.
- `TENANT_INGRESS_NAMESPACES` (chart `tenant.ingressNamespaces`) if the ingress controller is not in `network` or `orchard`.
- Public load balancer IPs and the service CIDR that nodes do not report: `PLATFORM_EXTRA_DENY_CIDRS` (chart `tenant.extraDenyCidrs`).
- A cloud or host firewall for node ports (see Operator decisions and requirements).
- `networkPolicy.platform.enabled` left on.

**Not guaranteed.**

- With no enforcing CNI, every policy here is inert.
- Without Cilium, host-network services reachable on node addresses depend on the address excepts, which are computed from the node list at policy time.
- IPv6 is not addressed by the egress ipBlock; IPv6 egress is denied by default-deny rather than filtered.
- Tenants share the published surface: a tenant can reach another tenant's `-allow-public` pods over the pod network, like the internet can.
- `allow-cilium-ingress` admits the `host` and `remote-node` entities to every tenant pod.
- Cluster DNS answers forward lookups for any service name (see the information section).

**Residual risk.** No live check that policies are enforced (`KubernetesService.probeCilium` only detects Cilium CRDs). A public apiserver or LB address that is not in the node list, the kubeconfig host or `PLATFORM_EXTRA_DENY_CIDRS`. The manual file `infra/k8s/orchard-metrics/30-network-policies.yaml` (not part of the chart) lets VictoriaMetrics accept queries from every namespace; do not apply it on a multi-tenant cluster.

**Test.** `apps/server/test/tenant-policy.test.ts`, `network-isolation.test.ts` (serving ports, mail ports, cluster excepts, Cilium deny, guard rebuild and roll-forward), `namespace-fail-closed.test.ts`, `engine-guard.test.ts`, `database-platform-policy.test.ts`, `buildkit-daemon-policy.test.ts`, `compose-network.test.ts`, `chart-platform-policies.test.ts` and `chart-egress-policies.test.ts` (need `helm`), `public-exposure-quota.test.ts`. Live enforcement (pod A cannot reach pod B, apiserver, node): none.

### I4. Tenant compute (kernel, pod shape)

**Invariant.** Every object a tenant can cause to exist is of a shape Orchard builds; a tenant process cannot affect the host kernel or another tenant's process, and when the instance is configured for untrusted code the pod runs under a sandbox runtime.

**Mechanism now.**

- `tenantRuntimeClassName()` (`apps/server/src/kubernetes/trusted-images.ts`) reads `TENANT_RUNTIME_CLASS` and applies it to app Deployments (`K8sWorkloadService`), rollouts (`rollout-strategy.ts`), job runs and every image and job step (`JobsOrchestratorService`).
- Containers use `hardenedSecurityContext()`: no privilege escalation, drop `ALL` then add `SETUID, SETGID, CHOWN, FOWNER, DAC_OVERRIDE, SYS_CHROOT`, `seccompProfile: RuntimeDefault`. PSA `baseline` is enforced on the namespace.
- Admission guard (`templates/admission-policies.yaml`, `policies/orchard-tenant-policies.yaml`, ten ValidatingAdmissionPolicies, Kubernetes 1.30 or later): `orchard-tenant-pods`, `-pods-hardening`, `-services`, `-endpointslices`, `-ingresses`, `-pvcs`, `-networkpolicies`, `orchard-managed-namespaces`, `-rolebindings`, `-cnpg-clusters`. They refuse host-backed volumes, privileged pods, `externalIPs`, `ExternalName`, LoadBalancer pinning by anyone but the server, foreign Ingress annotations and cert-manager issuers, PVC volume hijacking, open NetworkPolicy egress, and unsafe CNPG settings. Every policy has `failurePolicy: Ignore`. The default `validationActions` is `[Deny]`; every object the server builds is admitted (`policies/fixtures/benign`). The hardening policy (drop ALL, tenant RuntimeClass) has its own `hardeningActions`, advisory by default.
- Server-side shape controls that do not depend on the policies: ClusterIssuer is chosen by the server (`tenantIngressAnnotations`, `apps/server/src/kubernetes/ingress-annotations.ts`; tenant-supplied cert-manager annotations are ignored); PVC size and claim are validated on create; node ports are never tenant-chosen; load balancers, node ports and ephemeral storage are capped in every tenant namespace (`orchard-abuse-quota`, `apps/server/src/kubernetes/tenant-abuse-quota.ts`).
- Managed databases: CNPG clusters are created with `enableSuperuserAccess: false` (`k8s-cnpg.service.ts`, `cnpg-recovery.ts`). Existing clusters keep it until `apps/server/scripts/cnpg-disable-superuser.sh` is run. Database, pooler and Tailscale proxy pods can be sandboxed by a MutatingAdmissionPolicy when `databases.runtimeClassName` is set (`templates/database-sandbox.yaml`).
- Builds: with `builderSandbox` the build pod runs under `BUILDER_RUNTIME_CLASS` (Kata). Without it, builds run in rootless BuildKit by default (`resolveBuildPosture`, `apps/server/src/docker/build-posture.ts`: `vm-sandbox`, `rootless`, `privileged-host`). Rootless means uid 1000, not privileged, user namespaces, seccomp and AppArmor `Unconfined`. `builders.allowPrivilegedOnHost=true` restores the privileged posture and is logged at startup. Super builds (Depot) use `depotRuntimeClass` (`image-builder.service.ts`).

**Required config.**

- For kernel isolation: `tenantSandbox.enabled=true` with a runtime that exists on every node; `builderSandbox.enabled=true` with Kata and KVM.
- Nodes that allow unprivileged user namespaces when running rootless builds (Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns=0`).
- Admission policies at `validationActions: [Deny]` (the default); `admissionPolicies.extraIssuers` and `admissionPolicies.storageClasses` set, or those rules skip.

**Not guaranteed.**

- Default: `tenantSandbox` is off, tenant pods share the host kernel, and a kernel or runtime escape compromises the node. The setup checklist warns when two or more users exist (`setup.service.ts`, id `tenant-isolation`).
- Rootless builds still share the node kernel and run with Unconfined seccomp and AppArmor.
- gVisor is not a hardware boundary; Kata is closer to a microVM.
- Database pods are not sandboxed unless `databases.runtimeClassName` is set.
- `restricted` PSA is not enforced; `readOnlyRootFilesystem` is not set.
- The admission policies fail open by design (`failurePolicy: Ignore`), and the hardening policy only warns by default.

**Residual risk.** Kernel and runtime escapes. A pod that needs a rule the admission policies skip because its parameter is empty. If `TENANT_RUNTIME_CLASS` is unset the pod silently runs on the node runtime (the hardening policy only warns).

**Test.** `tenant-sandbox-uniform.test.ts`, `build-sandbox.test.ts`, `build-config.test.ts`, `build-posture.test.ts`, `pod-exec-policy.test.ts`, `tenant-abuse-quota.test.ts`, `ingress-issuer.test.ts`, `chart-render.test.ts` (needs `helm`), the CEL fixtures in `infra/charts/orchard/policies/celtest/policy_test.go` (Go). Admission policies against a live API server: documented manual procedure only (`policies/README.md`).

### I5. Builds (source, secrets, caches, registry credentials)

**Invariant.** A build for project A cannot read project B's source, build secrets, cache or registry images, cannot push to another project's repository, and cannot reach the cluster.

**Mechanism now.**

- One BuildKit daemon per tenant key (the project namespace, `cacheTenantKey`): `BuildkitPoolService.getOrCreateDaemon`; daemon ingress only from build pods with the same `orchard.my/tenant-key` label (`daemonTenantIngressPolicy`). Each local docker build gets its own `DOCKER_CONFIG`. Daemons no longer mount the registry login.
- Local cache is a per-tenant subPath of the cache PVC (`cacheSubPath`).
- Registry login: the build pod pushes from a separate `pusher` container; BuildKit holds no login. In rootless posture this is always so (`effectiveSidecarPush`).
- Image ownership: ValidatingAdmissionPolicy `orchard-tenant-images` (`registryImagePolicy`, `apps/server/src/kubernetes/registry-image-policy.ts`, installed by `RegistryImagePolicyService`) rejects a pod that names another project's repository on the platform registry. Image references are parsed and registry hosts canonicalised before ownership checks (`image-ref.test.ts`). `REGISTRY_IMAGE_POLICY`: unset or `auto` enforces unless an existing image would break (then warns and logs the blockers), `enforce`, `warn`, `off`; any other value enforces. The installer sets `enforce`. The rule is reconciled every five minutes.
- S3 build cache: when the r2-proxy is enabled and serves the cache bucket (`s3CacheRoute`, `apps/server/src/docker/build-cache-s3.ts`), each build gets its own key valid for two hours that can only read and write `_build-cache/<project>/` in that bucket (`mintBuildCacheKey`, `tenantWritePrefix`). The key reaches only `buildkitd`'s environment, through `buildkitdEnvPreamble`, which also drops the app's `AWS_*` variables; it is never in a command line or in cache attributes, which BuildKit forwards to `# syntax=` frontends. Without the proxy the S3 cache is off (`s3CacheRouteNotice` logs an error) unless `BUILDKIT_S3_SHARED_KEY=true` opts a single-tenant instance into the instance-wide key.
- Build egress is allow-listed (`builder-network-policy`, `orchard.builderEgressRules`) with no apiserver, no node addresses and no metadata; Cilium entity denies are added where Cilium is present. fc-builder rejects dot and empty path segments in its push proxy.
- Secrets: build secret names come from 128 random bits and are never overwritten; the image-builder role no longer has Secret access; `build-args.ts`, `build-log-redaction.ts`, `buildSafeEnv`.

**Required config.**

- `REGISTRY_IMAGE_POLICY=enforce` (installer default) or `auto`; make sure `DOCKER_REGISTRY_PULL` / `DOCKER_REGISTRY_PUSH` are set or the policy is removed.
- `builders.registryEgress` correct.
- r2-proxy enabled and serving the cache bucket (`BUILDKIT_S3_VIA_PROXY=true` plus `r2Proxy.allowedBuckets` for a bucket other than the platform bucket).
- `builderSandbox` for VM-level separation.

**Not guaranteed.**

- The registry login is one credential for the platform project (`harbor-registry-creds` in `templates/builders.yaml`; `harborAuths` defaults the username to `admin`). Harbor robot accounts cannot narrow this because their permissions apply per Harbor project and all tenants share one. A leaked pusher login reaches every tenant's repository.
- With `BUILDER_SIDECAR_PUSH=false` in sandbox or privileged posture, and for Super builds with it set to `false`, the shared login is placed in the build or Depot session.
- Without Kata, builds share the node kernel (I4).
- In rootless posture `RUN` steps share the build container's PID namespace and uid (`--oci-worker-no-process-sandbox`), so they can read `buildkitd`'s environment and everything else in the build container, including the build's own cache key. With `BUILDKIT_S3_SHARED_KEY=true` that key is instance-wide and reaches every tenant's cache.

**Residual risk.** The shared registry login. A compromise of the pusher container. Kernel exploits from a Dockerfile `RUN` step on the node kernel.

**Test.** `buildkit-daemon-policy.test.ts`, `registry-image-policy.test.ts`, `image-ref.test.ts`, `build-secrets.test.ts`, `build-arg-injection.test.ts`, `build-cache-s3.test.ts`, `image-builder-cache.test.ts`, `builder-override-access.test.ts`, `build-sandbox.test.ts`, `build-posture.test.ts`, `chart-egress-policies.test.ts`. A cross-tenant cache or registry attack against a live cluster: none.

### I6. Secrets (env, DB credentials, registry credentials, tokens)

**Invariant.** A secret value is readable only by principals with edit rights on its project and by the workload it is bound to, is never returned by read APIs once written, and is not readable by other tenants at rest or in transit.

**Mechanism now.**

- At-rest encryption of secret env vars, shared vars, job step secrets and database passwords: `SecretCryptoService` (`apps/server/src/crypto/secret-crypto.service.ts`), AES-256-GCM, `enc:v1:` prefix, key from `SECRETS_ENCRYPTION_KEY` (falls back to `SSO_ENCRYPTION_KEY`). Per-user sealing exists (`encryptForUser`). A boot backfill (`SecretBackfillService`) encrypts old rows. Compose env is decrypted on build and image flip, with env keys validated on create.
- Write-only secrets: `redactDatabaseForViewer`, `stripR2ProxyCreds`, `sealDatabaseCredentials` (`apps/server/src/projects/projects.utils.ts`), log redaction.
- In-cluster: values reach pods as Kubernetes Secrets. The server holds Secret access per tenant namespace only through a namespaced RoleBinding to ClusterRole `<release>-tenant-secrets` (`bootstrapTenantSecretsRbac`, `tenant-rbac.ts`); `orchard-tenant-rolebindings` refuses other bindings.
- Tenant pods have no service account token. Editors can no longer exec into database pods, so database credentials and the database TLS key are not readable through exec.
- Greenhouse: collaborator GitHub tokens are kept out of shared sandbox terminals.

**Required config.** `SECRETS_ENCRYPTION_KEY` set (the installer generates one; Helm installs must set it in `server.env`). Kubernetes etcd encryption at rest for Secrets (cluster feature).

**Not guaranteed.**

- With no key configured the service logs an error and `encryptIfSecret` stores the value in plaintext (`encrypt` itself throws). The chart does not generate or require the key.
- One instance-wide key for all orgs; no per-org keys or KMS.
- The wildcard database TLS private key is copied into each tenant namespace that has a public database when `publicTls.db.mode: wildcard` (default; `K8sCnpgService.syncPublicTlsSecret`). Since exec into database pods is refused, a tenant cannot read it through exec, but it exists in tenant namespaces as a Secret. `perDatabase` mode removes it and counts against ACME rate limits.
- The domain-proof token uses `JWT_SECRET` as HMAC key (`domainProofToken`), so rotating `JWT_SECRET` invalidates every DNS proof.

**Residual risk.** Plaintext storage on a misconfigured Helm install; a shared key for all orgs; database superuser access on clusters not yet migrated.

**Test.** `secret-crypto-seal.test.ts`, `env-secret-write-only.test.ts`, `secret-redaction.test.ts`, `log-redaction.test.ts`, `tenant-rbac.test.ts`, `public-db-tls.test.ts`, `database-public-connection.test.ts`, `job-step-secrets.test.ts`. Fail-closed when the key is missing: none (behavior is fail-open for env vars).

### I7. Storage and backups (uploads, S3/R2, CNPG, restore drills)

**Invariant.** A tenant's backup credentials, build cache keys, uploads and restore operations touch only that tenant's bucket prefix, and the platform's real object-store credentials never reach a tenant namespace.

**Mechanism now.**

- `apps/r2-proxy/main.go`: S3 SigV4 re-signing gateway. Fake keys are looked up in Postgres (`bindingStore.lookup`, `lookupScoped`, `lookupRestore`); `authorizeOperation` allows only the operations barman and the build cache need, within the key's `bucket + prefix` (`validPrefix`, `withSlash`), refuses copy sources, dot segments, ambiguous targets (`validateTarget`, `strictQuery`, `checkHeaders`) and checks multi-delete per key (`deleteRequestKeys`). The proxy forwards exactly what it authorized. `ALLOWED_BUCKETS` / `DEFAULT_BACKUP_BUCKET` bound which buckets the platform credentials serve; with neither set and an endpoint set it refuses to start. Each key is also bound to buckets by kind (`upstreamTable.permits`, `scopeForPurpose`): database keys reach only backup buckets (`DEFAULT_BACKUP_BUCKET`, the stored default and stored targets), build cache keys only `BUILD_CACHE_BUCKET` (the chart's `r2Proxy.buildCacheBucket`, else the server's `BUILDKIT_S3_BUCKET`), and a scoped key with any other `purpose` is refused. It connects to Postgres as read-only `orchard_r2_proxy` with column-level grants.
- Real credentials live only in `r2-proxy-upstream` in the `orchard-r2-proxy` namespace (`templates/r2-proxy.yaml`). The proxy namespace accepts only tenant namespaces, the release namespace and the CNPG operator (I3).
- Uploads: `assertUploadUrlOwned` (`apps/server/src/organizations/upload-namespace.ts`); public `GET /uploads/*path` serves only image types with `nosniff` and `CSP sandbox`. Replaced legacy uploads are deleted when no other record references them.
- Restore drills run in a separate namespace (`database-operations.service.ts`).

**Required config.** `r2Proxy.allowedBuckets` (or `defaultBucket`) listing exactly the buckets; a separate bucket or key for uploads; `r2Proxy.networkPolicy.enabled`.

**Not guaranteed.** If a database uses an org-supplied bucket (`backupR2*` org fields) that credential belongs to the org. Anything in the platform bucket outside the proxy's prefixes is protected by the platform credentials, not by per-tenant keys, when `BUILDKIT_S3_SHARED_KEY=true` hands builds the instance-wide cache key.

**Residual risk.** A flaw in the SigV4 prefix check. Storage-backend scrubbing after namespace deletion depends on the StorageClass (`UNVERIFIED`).

**Test.** `apps/r2-proxy/main_test.go` (49 tests, for example `TestObjectsOutsidePrefixAreRefused`, `TestDatabaseKeysAreRefusedOnEveryOtherBucket`, `TestMultiDeleteIsCheckedPerKey`, `TestEmptyAllowlistServesNoBucketWithPlatformCredentials`, `TestEveryAcceptedRequestIsForwardedAsAuthorizedAndSignedAsSent`), `r2-proxy-grants.test.ts`, `upload-namespace.test.ts`, `object-storage.test.ts`, `database-recovery.test.ts`, `chart-platform-policies.test.ts`. Backup and restore across tenants end to end: none.

### I8. Observability (logs, metrics, events, traces, status pages)

**Invariant.** A user sees logs, metrics, events and status of only the projects they can view; a tenant workload cannot query the platform's metrics or log stores.

**Mechanism now.** Log queries are scoped by namespace through `scope()` in `apps/server/src/logs/logsql.ts` after the controller's project authorization. Metrics go through `apps/server/src/metrics/victoria-metrics.service.ts` and `pod-selector.ts`. Status pages render only `isPublic` pages and return the same absence for missing and private (`StatusPagesService.render`). Error assignees and engine health are scoped to the caller. VictoriaMetrics and VictoriaLogs have no authentication of their own, but the release and metrics namespaces now accept connections only from non-tenant namespaces (`platform-ingress`, I3); a tenant namespace cannot connect to them. kube-state-metrics and vmagent RBAC were trimmed and node-exporter binds to the node address.

**Required config.** `networkPolicy.platform.enabled` and a CNI that enforces it. Do not expose VictoriaMetrics or VictoriaLogs outside the cluster.

**Not guaranteed.** Any workload in a namespace that is not classed as a tenant or untrusted namespace (a custom tools namespace, for example) can query the stores unless you list it in `networkPolicy.platform.untrustedNamespaces`.

**Residual risk.** Per-query namespace scoping was read at `logsql.ts`; every metrics query path was not audited (`UNVERIFIED`).

**Test.** `logsql.test.ts`, `logs-store.test.ts`, `status-page.test.ts`, `pod-selector.test.ts`, `ingress-metrics.test.ts`, `chart-platform-policies.test.ts`. Cross-tenant query attempt: none.

### I9. Identity (SSO, SCIM, OAuth, group rules, passkeys cannot reach outside their org)

**Invariant.** An IdP, SCIM token or SSO session belonging to org A can create, sign in or modify only identities and memberships within org A, and cannot take over an account or org of another tenant.

**Mechanism now.**

- Org-scoped sessions carry `sessionOrgId`; the org and project trees refuse other orgs; account-widening routes are denied (`deniedToOrgScopedSession`).
- Email-domain routing uses only domains the org verified (`OrgDomainsService.ownerOf`, `isVerifiedFor`, `apps/server/src/sso/org-domains.service.ts`).
- SSO enforcement: `AuthorizationService.assertSsoNotEnforced`, `blockedByOrgSso`.
- IdPs and invite links cannot take over unverified accounts; unverified credentials are discarded on adoption (`discardUnverifiedCredentials`, `apps/server/src/auth/unverified-adoption.ts`).
- SAML: logins are bound to their request (`saml-request.store.ts`), responses are validated strictly (`saml-response.ts`, `saml-guard.ts`), missing IdP entity IDs are backfilled from pinned metadata. OIDC state store. SCIM base URL is built from config, not request headers; SCIM bearer auth is `scim-auth.guard.ts`.
- Group rules (`apps/server/src/sso/group-rules.ts`, `identity-mapping.service.ts`): per-org rules map IdP groups to roles on every SSO login. Only `admin`, `member` and `guest` are mappable (`MAPPABLE_ROLES`); an IdP cannot grant `owner`. Claims are bounded (500 groups, 16 KiB). An unmapped sign-in is refused with `sso_not_mapped` when rules exist.

**Required config.** Verify the org's domains before enabling enforcement; keep instance-level SSO bypass off; keep `registrySignature` and graft trust as described in the chart for graft signals.

**Not guaranteed.** The IdP is trusted for the identity of its own users and for group membership within the org that configured it.

**Residual risk.** Property tests for SAML, SCIM and OAuth lineage are not written.

**Test.** `sso-enforcement.test.ts`, `saml-hardening.test.ts`, `saml-trust-config.test.ts`, `saml-idp-entity-backfill.test.ts`, `scim.test.ts`, `scim-base-url.test.ts`, `group-rules.test.ts`, `identity-mapping.test.ts`, `unverified-adoption.test.ts`, `org-isolation.test.ts`, `passkey.test.ts`, `mcp-oauth-hardening.test.ts`.

### I10. Ingress and browser origin (host claims, certs, cookie scope, tenant apps vs dashboard)

**Invariant.** Only the project that legitimately holds a hostname receives its traffic; a tenant app cannot read or set the dashboard's credentials, and cannot obtain a certificate for a host it does not control.

**Mechanism now.**

- Host claims: `ProjectAccessService.assertHostnameUnclaimed` / `assertHostnameAvailable` with a global advisory lock (`beginHostClaim`, `apps/server/src/projects/host-claim.ts`; `lockHostnameClaims`, `apps/server/src/instance-network/reserved-hosts.ts`). Vanity, status-page and custom-domain claims share one platform host reservation, and generated app, database and preview zones are reserved (`isReservedHost`, `isReservedSubdomainLabel`; env `RESERVED_HOSTS`, `RESERVED_HOST_SUFFIXES`).
- Generated hostnames are opaque by default (`generatedHostLabel`, `opaqueDatabaseLabel`, `apps/server/src/projects/generated-host.ts`): an HMAC of the deployment id keyed by `JWT_SECRET`. `HOSTNAME_STYLE=readable` brings back readable labels that reveal the deployment and project names.
- Custom-domain proof of ownership: TXT `_orchard-challenge.<host>` (`domainProofStatus`, `domain-proof.ts`), or a verified org domain. Enabled by `CUSTOM_DOMAIN_VERIFICATION` or the admin switch; with nothing set it is on when `SIGNUP_MODE=open` and off otherwise. A host the project already serves is never re-verified. `DomainBudget` (`apps/server/src/projects/domain-budget.ts`) caps custom hostnames per org (`MAX_CUSTOM_DOMAINS_PER_ORG`, 250), new custom hostnames per hour (`MAX_CUSTOM_DOMAIN_CREATES_PER_HOUR`, 30) and backs off exponentially after repeated failed proofs.
- The ClusterIssuer is chosen by the server; tenant-supplied cert-manager annotations are ignored.
- Protected apps: `ProtectionService` (`apps/server/src/auth/protection.service.ts`). The protection cookie is a JWT bound to the ingress id and to a generation HMAC of the ingress protection mode and password hash (`protectionGeneration`), and the subject must still be able to view the project (`protectionCookieGrants`, `subjectCanViewIngress`); changing the mode or password invalidates every cookie. Cookie name per ingress (`protectionCookieName`), `HttpOnly`, `SameSite=Lax`, path `/`, no `Domain` (host-only). Ambiguous paths never count as public. `apps/docs/src/content/docs/deploy/protection.mdx` has the curl checks for the operator's ingress controller.
- Dashboard session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production (`SESSION_COOKIE_SECURE` overrides), `Domain` only when `COOKIE_DOMAIN` is set (`apps/server/src/auth/cookies.ts`). A secure instance without `COOKIE_DOMAIN` names it `__Host-session_token`, so a sibling subdomain can't plant one; otherwise it's `session_token`. Read it with `readSessionCookie`, never by name. CORS: platform origins with credentials; tenant-facing GET routes open with credentials off (`apps/server/src/main.ts`).
- Client IP: `getClientIp` and `parseTrustProxy` (`apps/server/src/auth/client-ip.ts`). Unset or `0` `TRUST_PROXY` trusts nothing; a number is a hop count; a CIDR list names the proxies. `TRUSTED_PROXY_RANGES`, `TRUST_CLOUDFLARE` and the `CLIENT_IP_HEADER`/`CLIENT_IP_HEADER_FROM` pair (chart `clientIp.*`, `trustProxy` default `"1"`) cover CDN topologies. A private address is never trusted merely for being private. Pre-auth work is bounded (rate limits, body limits).
- Favicon cache is keyed by HMAC; vector ingress is denied.

**Required config.**

- Serve tenant apps from a registrable domain different from the dashboard and list it on the Public Suffix List. Never set `COOKIE_DOMAIN` to a parent of the app domain.
- `CUSTOM_DOMAIN_VERIFICATION=true`.
- `TRUST_PROXY` / `clientIp.*` matching the real topology, and an origin that only the CDN or tunnel can reach.

**Not guaranteed.**

- Custom-domain verification defaults to off unless `SIGNUP_MODE=open`: otherwise the first claim wins, with no proof of DNS control.
- The session cookie has no `__Host-` prefix. A `COOKIE_DOMAIN` that is a parent of app hosts sends the dashboard session to every tenant app.
- Neither the chart nor the code checks the Public Suffix List. An unlisted app domain gives sibling apps shared cookie scope (cookie tossing).
- The chart does not lock the origin to the CDN; direct-to-origin traffic bypasses the CDN and its WAF.
- Every public hostname with its own certificate appears in Certificate Transparency logs.

**Residual risk.** Squatting on a host before verification is turned on. Operator misconfiguration of the app domain or origin.

**Test.** `host-claim.test.ts`, `hostname-reservation.test.ts`, `reserved-hosts.test.ts`, `reserved-generated-zones.test.ts`, `generated-host.test.ts`, `ingress-issuer.test.ts`, `client-ip.test.ts`, `protection-auth.test.ts`, `protection-bypass-paths.test.ts`, `protection-path-ambiguity.test.ts`, `protection-session-binding.test.ts`, `protection-proxy-headers.test.ts`, `protection-redirect.test.ts`, `ingress-limits.test.ts`, `xss-and-assets.test.ts`. Cookie scope against the actual app domain: none.

### I11. Resource fairness (quotas, noisy neighbour, pre-auth DoS)

**Invariant.** One tenant cannot exhaust CPU, memory, pods, volumes, load balancers or request budget in a way that degrades another tenant beyond its configured share.

**Mechanism now.**

- `K8sNamespaceService.applyNamespaceQuota` writes `ResourceQuota orchard-org-quota` and `LimitRange orchard-defaults` from `tenantQuotaHard` / `tenantQuotaFloor` (`tenant-quota.ts`): always `pods` (200), `services` (100), `persistentvolumeclaims` (50), `requests.storage` (500 GiB); CPU and memory only when the org has caps. Pushed by `QuotasService` (`apps/server/src/quotas/quotas.service.ts`), not at namespace creation.
- At namespace creation `applyAbuseGuards` applies `orchard-abuse-quota` (`tenant-abuse-quota.ts`): `services.loadbalancers` 20, `services.nodeports` 10, ephemeral storage limits (default 20 GiB per container), and a LimitRange for ephemeral storage. Failure to apply it logs a warning and does not abort creation.
- Public ports per org capped at 20 (`MAX_PUBLIC_PORTS_PER_ORG`).
- Per-IP and per-account throttles: `ApiThrottlerGuard`, `RateLimitService`, `RedisThrottleService`, pre-auth limits, body limits, SSE limiter, ingress limits.

**Required config.** Set org CPU and memory caps (without them no CPU or memory quota exists in the namespace). New organizations are uncapped by default; a superadmin sets the instance default for new organizations (CPU, memory, projects, environments, deployments; `admin/instance-settings/new-org-defaults`, setting `new_org_defaults`, snapshotted into the org at creation, never retroactive) and can override any one organization (`PATCH admin/organizations/:id/quota`). On an open-signup instance set these defaults; an uncapped new org can take all the node CPU and memory and create unbounded projects. Both writes are audited (`admin.new_org_defaults_updated`, `admin.org.quota_updated`). Count limits are enforced by `assertOrgCanCreate` (`apps/server/src/quotas/org-limits.ts`), with the optional `MAX_*_PER_ORG` environment ceilings on top; Redis for cross-replica throttling (the chart enables it); node pools for noisy tenants.

**Not guaranteed.** No CPU or memory quota by default. Quotas are per namespace; per-org totals are API-layer aggregation. No node-level isolation by default.

**Residual risk.** A tenant with no org caps can consume node CPU and memory. Window between namespace creation and the first quota sync (`UNVERIFIED` for length).

**Test.** `tenant-quota.test.ts`, `tenant-abuse-quota.test.ts`, `public-exposure-quota.test.ts`, `quota-zero.test.ts`, `owner-allowance.test.ts`, `org-limits.test.ts`, `resource-limits.test.ts`, `api-throttler.test.ts`, `preauth-rate-limit.test.ts`, `body-limits.test.ts`, `sse-stream-limiter.test.ts`, `redis-throttle.test.ts`.

### I12. Lifecycle (delete, transfer, restore, revoke)

**Invariant.** After a project, environment, member, token or domain is deleted, transferred or revoked, nothing of it remains reachable by the previous owner or by a successor tenant.

**Mechanism now.** `NamespaceTeardownService.teardown` (`apps/server/src/projects/namespace-teardown.service.ts`: deployments, databases, jobs, builds, registry repositories, build contexts, backup prefixes); the `RetiredNamespace` model prevents namespace reuse (`freshNamespace`, `deconflictNamespace`); org transfer in `project-org-transfer.service.ts` plus `tagNamespaceMoved`; credentials discarded on adoption; membership cache invalidation (`MembershipCacheService`); session revocation (`SessionsService`); API token revocation cascades to minted children (I2); org event stream re-authorisation.

**Required config.** None.

**Not guaranteed.** The namespace name keeps the former org and project slug after a transfer. PV reclaim policy and storage scrubbing depend on the StorageClass (`UNVERIFIED`).

**Residual risk.** Slug disclosure to cluster operators; data remanence on the storage backend.

**Test.** `namespace-teardown-keep.test.ts`, `delete-deployment-builds.test.ts`, `org-event-stream-reauth.test.ts`, `session-jwt.test.ts`, `backup-orphans.test.ts`, `api-token-lineage.test.ts`. Transfer-then-access: none.

### Operator decisions and requirements

#### Operator-optional (a decision with a cost)

| Setting                                                                                     | What it does                                                                          | Cost or trade-off                                                                        |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `tenantSandbox.enabled` + `runtimeClassName` (gVisor, `TENANT_RUNTIME_CLASS`)               | Tenant pods run under a user-space kernel                                             | Install the runtime on every node first; some syscalls and IO are slower                 |
| `builderSandbox.enabled` + `runtimeClassName` (Kata, `BUILDER_RUNTIME_CLASS`)               | Builds run in a lightweight VM                                                        | Needs Kata and KVM on the build nodes                                                    |
| Firecracker (`fcBuilder`) / Greenhouse Kata                                                 | VM-level isolation for specific features                                              | Per-feature; see `docs/ai-sandbox.md`                                                    |
| `publicTls.db.mode: perDatabase`                                                            | One certificate per public database; the wildcard key stays out of tenant namespaces  | Needs a DNS-01 issuer; counts against ACME rate limits                                   |
| `databases.runtimeClassName` (+ `runtimeClassFailurePolicy: Fail`)                          | Sandboxes database, pooler and Tailscale proxy pods through a MutatingAdmissionPolicy | Needs the MutatingAdmissionPolicy API; IO and latency cost; only pods created afterwards |
| `tenant.nodePortExposure: false`                                                            | Stops NodePorts on a shared multi-node cluster                                        | Only a load-balancer IP remains for raw ports                                            |
| `admissionPolicies.hardeningActions: [Deny]`                                                | The API server refuses pods that keep capabilities or skip the tenant RuntimeClass    | Review warnings first; legacy and Tailscale proxy pods can fail the hardening rules      |
| `admissionPolicies.extraIssuers`, `storageClasses`, `pgImagePrefixes`, `pgPreloadLibraries` | Fill the parameters; an empty list skips the rule                                     | Wrong values refuse legitimate objects once on `Deny`                                    |
| PSA labels                                                                                  | Orchard sets `baseline` enforce, `restricted` warn and audit on tenant namespaces     | `restricted` enforcement breaks root and low-port images; do not remove the labels       |
| `HOSTNAME_STYLE=readable`                                                                   | Readable generated hostnames                                                          | Reveals project and deployment names in DNS and CT logs                                  |
| `TENANT_DENY_ENTITIES=none`                                                                 | Turns off the Cilium entity denies                                                    | Only if the ingress controller uses hostNetwork and apps call their own hostname         |

#### Operator-required (isolation does not hold without it)

| Requirement                                                       | Exact setting                                                                                                                                                                                                                            | Why                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| CNI that enforces `NetworkPolicy`                                 | Cilium, Calico, Antrea or kube-router; not plain flannel                                                                                                                                                                                 | Every network control is a NetworkPolicy; Orchard cannot tell whether it is enforced                           |
| Cilium entity denies                                              | Automatic when Cilium is detected (`cilium.enabled` or the CRD present); do not set `TENANT_DENY_ENTITIES=none` or `networkPolicy.egressDeny.enabled: false`                                                                             | Denies `host`, `remote-node`, `kube-apiserver` to tenants and to builders, sandboxes, fc-builder and scan pods |
| Ingress controller namespace                                      | `tenant.ingressNamespaces` / `TENANT_INGRESS_NAMESPACES`                                                                                                                                                                                 | Tenant ingress is default-deny; a wrong value breaks serving and ACME HTTP-01                                  |
| Cloud or host firewall for node ports                             | Block `10250` (kubelet), `6443` (apiserver), `2379/2380` (etcd), `22` (ssh), `9100` (node-exporter) from the internet and from tenant networks                                                                                           | Orchard excludes node addresses from tenant egress; the firewall closes the same ports for outside callers     |
| CDN or tunnel origin lock                                         | Firewall the origin to the CDN ranges or use a tunnel; set `TRUST_PROXY` (`clientIp.trustProxy`), `TRUSTED_PROXY_RANGES`, `TRUST_CLOUDFLARE` and for Cloudflare Tunnel `CLIENT_IP_HEADER` + `CLIENT_IP_HEADER_FROM` to the real topology | Per-IP limits and audit IPs key on this; direct-to-origin traffic bypasses the CDN and WAF                     |
| CoreDNS PTR block                                                 | The installer does it on k3s. Elsewhere add `acl in-addr.arpa ip6.arpa { block type PTR }` to the Corefile server block                                                                                                                  | Stops a pod from reading every Service name by reverse lookup                                                  |
| Public load balancer IPs and service CIDR                         | `tenant.extraDenyCidrs` / `PLATFORM_EXTRA_DENY_CIDRS`                                                                                                                                                                                    | Orchard finds node, pod and apiserver addresses itself; it cannot find LB or service addresses outside them    |
| User namespaces for rootless builds                               | `kernel.apparmor_restrict_unprivileged_userns=0` on Ubuntu 24.04 build nodes                                                                                                                                                             | Default builds need unprivileged user namespaces; the build fails with a clear message otherwise               |
| App domain on the Public Suffix List                              | Submit the generated app domain to the PSL; keep it a different registrable domain from the dashboard; leave `COOKIE_DOMAIN` unset or scoped to the dashboard host                                                                       | Prevents cookie tossing between sibling tenant apps                                                            |
| `SECRETS_ENCRYPTION_KEY`                                          | Set in `server.env` on Helm installs                                                                                                                                                                                                     | Without it secrets are stored in plaintext                                                                     |
| `CUSTOM_DOMAIN_VERIFICATION`                                      | `true`                                                                                                                                                                                                                                   | Default off: first claim wins                                                                                  |
| `REGISTRY_IMAGE_POLICY`                                           | `enforce` or `auto`; set the registry hosts                                                                                                                                                                                              | Stops a pod from running another project's image                                                               |
| Org CPU and memory caps                                           | Set per organization                                                                                                                                                                                                                     | No CPU or memory quota otherwise                                                                               |
| Etcd encryption, database backups bucket                          | Cluster setting; `r2Proxy.allowedBuckets`                                                                                                                                                                                                | Secrets at rest; the proxy serves only listed buckets                                                          |
| Dedicated registry account                                        | A low-privilege registry account, not `admin`, in `HARBOR_USERNAME`, with pull, push and delete (old builds are pruned with it)                                                                                                          | The login is shared by all tenants                                                                             |
| Do not apply `infra/k8s/orchard-metrics/30-network-policies.yaml` | Use the chart's `platform-ingress`                                                                                                                                                                                                       | The manual file lets any namespace query VictoriaMetrics                                                       |

### Cluster control plane: the server service account

`templates/server-rbac.yaml` grants `orchard-server` a ClusterRole (`<release>-server`) bound cluster-wide. It excludes cluster-wide Secrets and ConfigMaps but is effectively cluster-admin: it can create and exec into pods in any namespace, create roles and role bindings (including binding `<release>-tenant-secrets` anywhere), delete namespaces, network policies and admission policies, and patch nodes. The admission policies `orchard-tenant-rolebindings` and `orchard-managed-namespaces` narrow what it can do inside tenant namespaces, and they fail open.

Consequence: a remote code execution or SSRF in the server is a cluster takeover, so the tenant boundary rests on the server being correct. Hardening guidance: keep the server patched, restrict who can reach it, keep the control-plane ingress policies on, and treat a least-privilege redesign (per-namespace Roles, impersonation) as open work.

Test: `rbac-coverage.test.ts` pins the builder, tailscale and tenant roles against the rendered chart; no test pins the server ClusterRole.

### What a tenant can learn about other tenants

| Channel                                                                           | What leaks                                                                                                                                                                                                                                                             | To whom                                            | Reduce                                                                             | Acceptable?                                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Cluster DNS service names                                                         | Forward lookups answer for any service name; names end in a random suffix so they are not guessable. Reverse (PTR) sweeps are blocked by the CoreDNS rule (installer on k3s; otherwise operator). SRV wildcard enumeration of `svc.cluster.local` is `UNVERIFIED` live | Any tenant pod                                     | CoreDNS PTR block; a CNI-level DNS name filter if available                        | Acceptable on a single-trust instance; hardening recommended otherwise |
| Namespace names                                                                   | `{org-slug}-{project-slug}-{hex}` reveals org and project slugs to anything that can list namespaces. Tenant pods have no token and no apiserver route. After a transfer the old slug persists                                                                         | Cluster admins, operators, platform pods with RBAC | Keep tenants away from the apiserver; opaque namespace names are a design question | Acceptable for the operator; not reachable by tenants when I3 holds    |
| Kubernetes API reachability                                                       | Apiserver ClusterIP, backends, node and kubeconfig-host addresses are excluded from egress; a public LB address not in that set is not                                                                                                                                 | Tenant pod                                         | `PLATFORM_EXTRA_DENY_CIDRS`; Cilium entity deny (automatic)                        | Acceptable when the excepts cover your addresses                       |
| Metrics and logs                                                                  | VictoriaMetrics and VictoriaLogs are unauthenticated, but tenant namespaces cannot connect (platform ingress policy)                                                                                                                                                   | Any pod that can route to the metrics namespace    | Keep `networkPolicy.platform.enabled`; list custom untrusted namespaces            | Acceptable while I3 holds                                              |
| Status pages                                                                      | Org name, component names and status for `isPublic` pages; private and missing are indistinguishable                                                                                                                                                                   | Anyone                                             | Publish deliberately                                                               | Yes, opt-in                                                            |
| Public hostnames in Certificate Transparency                                      | Every host with a publicly trusted certificate is logged. Generated hostnames are opaque by default; a wildcard certificate hides individual labels                                                                                                                    | Anyone                                             | Wildcard certificate for generated hosts; keep `HOSTNAME_STYLE` at `opaque`        | Yes for public sites                                                   |
| `GET /sso/org/:slug`                                                              | For an org with SSO live: org uuid, name, slug, avatar, branding, provider names. A slug without live SSO is the same 404 as a missing slug                                                                                                                            | Anyone                                             | Pre-auth limiter                                                                   | Acceptable; it is the login page payload                               |
| `GET /sso/subdomain/:subdomain`, `POST /sso/discover`                             | Legacy vanity subdomain to `{slug, name}`; discover returns an org only for a verified domain with live SSO                                                                                                                                                            | Anyone                                             | As above                                                                           | Acceptable                                                             |
| `GET /sso/providers`, `/auth/methods`, `/auth/config`, `/setup/status`, `/health` | Instance-level login methods and setup state; `/auth/methods` is independent of the email                                                                                                                                                                              | Anyone                                             |                                                                                    | Acceptable                                                             |
| `GET /invitations/:token`                                                         | Org name, slug, avatar, role, expiry for a valid unexpired token; same 404 for unknown and expired                                                                                                                                                                     | Holder of the link                                 | Token entropy and expiry                                                           | Acceptable                                                             |
| `GET /uploads/*path`                                                              | Image types only; the path needs the random key                                                                                                                                                                                                                        | Anyone with the URL                                |                                                                                    | Acceptable                                                             |
| `GET /auth/protect/info`, `/check`                                                | Protection mode of a tenant host                                                                                                                                                                                                                                       | Anyone                                             |                                                                                    | Acceptable                                                             |
| SCIM routes                                                                       | Router-public, authenticated by the SCIM bearer token; 401 otherwise                                                                                                                                                                                                   | Token holder                                       |                                                                                    | Acceptable                                                             |
| Ownership transfer recipient lookup                                               | Does not reveal whether an account exists                                                                                                                                                                                                                              | Authenticated users                                |                                                                                    | Acceptable                                                             |
| IDOR error differences                                                            | Services return `NotFoundException` for no-access; routes that do their own lookup may differ; timing not measured                                                                                                                                                     | Authenticated users                                | Cross-tenant differential harness                                                  | `UNVERIFIED`                                                           |
| Pod-network reachability of published services                                    | Another tenant's `-allow-public` pods answer on their ports                                                                                                                                                                                                            | Tenant pods                                        | By design; same surface as the internet                                            | Acceptable                                                             |
| Shared node effects                                                               | Under the node runtime, kernel and resource contention side channels                                                                                                                                                                                                   | Co-located tenants                                 | gVisor or Kata, dedicated node pools                                               | Not guaranteed                                                         |

### Summary table

| Invariant              | Mechanism now                                                                                              | Required config                                                    | Test                                                                    | Status                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| I1 org to org          | `AuthorizationService`, `SuperAdminGuard`, route snapshot                                                  | none                                                               | `org-isolation`, `auth-coverage`; route sweep none                      | Enforced by convention; no data-layer guard                            |
| I2 project to project  | role resolution, `tokenProjectIds`, token lineage column, exec limited to app pods                         | none                                                               | `api-token-lineage`, `pod-exec-policy`, `mcp-gateway-scope`             | Enforced; matrix test none                                             |
| I3 tenant network      | `tenantDenyPolicy`, fail-closed namespace creation, Cilium entity denies, platform ingress policies, guard | enforcing CNI; ingress namespaces; extra deny CIDRs; node firewall | `network-isolation`, `namespace-fail-closed`, `chart-platform-policies` | Enforced given a CNI; live test none                                   |
| I4 tenant compute      | `TENANT_RUNTIME_CLASS`, rootless builds, admission policies, no CNPG superuser                             | sandbox runtime (optional); `Deny` mode (optional)                 | `tenant-sandbox-uniform`, `build-posture`, CEL fixtures                 | Kernel shared by default; policies advisory by default                 |
| I5 builds              | per-tenant daemon, pusher push, image ownership policy, scoped S3 cache keys                               | r2-proxy for cache; `REGISTRY_IMAGE_POLICY`                        | `buildkit-daemon-policy`, `registry-image-policy`, `build-cache-s3`     | Partial: shared registry login                                         |
| I6 secrets             | AES-256-GCM, write-only, namespaced secret RBAC, no database exec                                          | `SECRETS_ENCRYPTION_KEY`; `perDatabase` TLS (optional)             | `secret-crypto-seal`, `env-secret-write-only`                           | Partial: plaintext if key unset                                        |
| I7 storage and backups | r2-proxy prefix policy, read-only DB role, proxy namespace policy                                          | `r2Proxy.allowedBuckets`                                           | `apps/r2-proxy/main_test.go`, `r2-proxy-grants`                         | Enforced; e2e none                                                     |
| I8 observability       | namespace-scoped queries, platform ingress policy                                                          | I3                                                                 | `logsql`, `chart-platform-policies`                                     | Enforced given I3                                                      |
| I9 identity            | `sessionOrgId`, verified domains, SAML binding, group rules without owner                                  | verify domains                                                     | `sso-enforcement`, `saml-hardening`, `identity-mapping`                 | Enforced; property tests none                                          |
| I10 ingress and origin | host claims, opaque hosts, bound protection cookie, trusted-proxy parsing                                  | PSL; verification; proxy settings; origin lock                     | `host-claim`, `protection-session-binding`, `client-ip`                 | Partial: verification off, no `__Host-`, origin and PSL operator-owned |
| I11 resource fairness  | ResourceQuota, abuse quota, throttlers                                                                     | org caps                                                           | `tenant-quota`, `tenant-abuse-quota`                                    | Partial: no CPU or memory quota by default                             |
| I12 lifecycle          | teardown, retired namespaces, token cascade                                                                | none                                                               | `namespace-teardown-keep`, `api-token-lineage`                          | Partial: old slug in namespace; transfer test none                     |
| Server SA              | ClusterRole `<release>-server`                                                                             | none                                                               | `rbac-coverage` (not the server role)                                   | Effectively cluster-admin                                              |
