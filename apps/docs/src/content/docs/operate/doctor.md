---
title: Check isolation with orchard doctor
description: Run the built-in doctor to verify that tenant isolation holds on your cluster, see what each check means, and fix what it reports.
sidebar:
  order: 8
---

Orchard keeps tenants apart only when your cluster is configured correctly, and many of the settings that matter live outside Orchard, in your CNI, runtime classes, and Helm values. The doctor reads your instance's own configuration and cluster state, and reports every setting that weakens isolation, so you can find a gap before a tenant does. An optional self-test then proves enforcement by sending real traffic from a temporary tenant. Only superadmins can run it.

Each result has an `id`, a `status`, the `evidence` Orchard found, a `fix`, and a link to the matching section on this page.

| Status    | Meaning                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pass`    | The check found what it expects.                                                                                                                       |
| `warn`    | Isolation holds, but a setting weakens it or leaves a decision to you.                                                                                 |
| `fail`    | Isolation does not hold, or a configured resource is missing.                                                                                          |
| `unknown` | Orchard could not tell. Usually a missing permission, a managed cluster feature it cannot see, or a failed positive control. Treat it as not verified. |

## Run it

From the command line:

```sh
orchard doctor
orchard doctor --selftest
```

`orchard doctor` prints a table and exits with code 11 when any check fails. `--selftest` also runs the [isolation self-test](#the-isolation-self-test) after asking for confirmation (pass `--yes` in scripts). With `-o json` it prints the full report.

Over the API, `GET /admin/doctor` returns the report, `POST /admin/doctor/selftest` starts a self-test and returns its `id`, and `GET /admin/doctor/selftest/{id}` returns its progress and result.

The doctor accepts a superadmin's browser session, or a superadmin's API token with the `exec` access level that is not limited to projects or an organization. The token that `orchard auth login` stores qualifies, unless you limited it to one organization when you signed in. These are the only admin routes that accept an API token.

The server needs read access to a few cluster objects. The chart grants it. If you manage the server's RBAC yourself, allow `get` and `list` on `daemonsets`, `runtimeclasses`, `priorityclasses` and `clusterissuers`.

## Checks

Each section names the setting and the exact fix. For why the setting matters, refer to [What you must do](/operate/security/#what-you-must-do).

### `cni-enforcement`

A NetworkPolicy only works when the CNI enforces it. The doctor has two sources for this check: the name of the CNI and the result of the last [isolation self-test](#the-isolation-self-test). The self-test result wins, because it shows what the cluster does, and the name match is only a hint.

The name match looks for Cilium, Calico, Antrea, kube-router, Weave Net, Canal and Azure Network Policy Manager by their custom resources and daemonsets, and checks that the agent runs on every node. A CNI that is not on that list, or a managed CNI that does not run as a daemonset the server can see, such as GKE Dataplane V2, can enforce policy without matching. For the CNIs that Orchard supports, refer to [Compatibility](/operate/compatibility/#supported-cnis).

When the server has a self-test result, it reads the `selftest-cross-tenant` check from that run, provided the temporary namespaces were created correctly (`selftest-namespace-shape` passed):

- `pass`: a pod in one temporary tenant namespace could not connect to a pod in the other, and the positive controls connected. The check passes whatever the CNI is called, unless the name match found a problem with a detected agent (the `warn` cases below about unready agents or two enforcers). The self-test probe runs on one node, so it cannot clear those.
- `fail`: a pod in one tenant namespace connected to a pod in the other. NetworkPolicy is not enforced, even if a known CNI is installed.
- An inconclusive run falls back to the name match.

Without a usable self-test result:

- `pass`: a known CNI was found. This shows the CNI is installed, not that it enforces policy.
- `warn`: the agent is not ready on every node, only Flannel was found, or kube-router runs next to another enforcer (another CNI from the list, or a k3s or RKE2 node).
- `unknown`: no known CNI was found by name. k3s and RKE2 embed a policy controller that is not visible as a daemonset, and managed clusters hide theirs.

Fix: run `orchard doctor --selftest`, and then run `orchard doctor` again. The report that `--selftest` prints is read before the self-test starts, so its `cni-enforcement` row reflects the previous run. If a tenant reached another tenant, install Cilium or Calico, or enable your provider's network policy add-on. On Flannel, set `networkPolicy.enforcer.enabled=true`. For more information, refer to [Enforce network policies on Flannel](/operate/security/#enforce-network-policies-on-flannel). With two enforcers, turn one off.

Self-test results are kept in memory on the server that ran the test. After a restart, or when the request reaches another server replica, the check falls back to the name match.

### `default-deny-coverage`

Every namespace labelled `orchard.my/managed` must carry the `default-deny-all` NetworkPolicy. The doctor counts namespaces that do not. A namespace without it accepts and sends any traffic.

Fix: restart the server. It re-applies the policy to every managed namespace on boot. If a namespace keeps failing, read the server log for the error.

### `tenant-runtime-class`

`TENANT_RUNTIME_CLASS` puts tenant pods in a sandbox such as gVisor. Unset, tenants share the node kernel (`warn`). Set to a name that does not exist as a RuntimeClass, pods never schedule (`fail`).

Fix: set `tenantSandbox.enabled=true` on nodes that provide the runtime, or create the RuntimeClass.

### `builder-posture`

Shows how builds are isolated: `vm-sandbox` (pass), `rootless` (`warn`, shares the node kernel), or `privileged-host` (`fail`, a Dockerfile `RUN` step is root on the node). With a builder RuntimeClass configured, it must exist.

Fix: enable `builderSandbox` with Kata and KVM, and remove `builders.allowPrivilegedOnHost`.

### `pod-security-labels`

Managed namespaces must enforce Pod Security `baseline` or `restricted`. Orchard sets `baseline` on creation, so a failure means someone removed it.

Fix: `kubectl label ns <name> pod-security.kubernetes.io/enforce=baseline --overwrite`.

### `admission-policies`

The ten Orchard ValidatingAdmissionPolicies refuse object shapes Orchard never creates. None installed is a `warn`, a partial install is a `fail`, and policies that only `Warn` or `Audit` are a `warn`.

Fix: install the chart with `admissionPolicies.enabled=true` on Kubernetes 1.30 or later. Set `admissionPolicies.validationActions` to `[Deny]` (the default). Set `hardeningActions` to `[Deny]` once no pod reports a hardening warning.

### `redis-auth`

Redis holds sessions, throttle state and cached data. Without a password in `REDIS_URL` (or `REDIS_PASSWORD`), network policy is the only protection (`warn`). Without `REDIS_URL`, limits are per pod.

Fix: set a Redis password and include it in `REDIS_URL`.

### `secrets-encryption-key`

Without `SECRETS_ENCRYPTION_KEY`, secret environment variables, job secrets and database passwords are stored in plaintext (`fail`). Falling back to `SSO_ENCRYPTION_KEY` or a key under 32 characters is a `warn`.

Fix: set `SECRETS_ENCRYPTION_KEY` to `openssl rand -hex 32` and restart. A boot backfill encrypts existing rows.

### `jwt-secret-strength`

`JWT_SECRET` signs every session and DNS proof. The doctor fails a missing, short (under 32 characters), example-like or low-variety value, and warns when it equals an encryption key. It never prints the value.

Fix: set `JWT_SECRET` to `openssl rand -hex 32` or longer. Rotating it signs everyone out.

### `client-ip-trust`

Rate limits and abuse controls use the client address. Behind a proxy, the server sees only the proxy unless `TRUST_PROXY` says how many proxies to trust. The doctor judges the request you made: a private peer address carrying `X-Forwarded-For` that resolved to a private client means every user shares one address (`warn`).

Fix: set `TRUST_PROXY` to the number of proxies in front of the server, or a comma-separated list of their CIDRs. `TRUST_PROXY=true` is not valid and trusts nothing. Run the check from the dashboard host, not a port-forward, so it sees the real path.

### `signup-and-domain-verification`

Open signup means anyone can create an organization. With it, custom-domain verification must be on, or a tenant can claim hostnames they do not own (`fail`).

Fix: turn on **Require proof of domain ownership** in **Instance admin** > **Networking**, or set `CUSTOM_DOMAIN_VERIFICATION=true`. Or set `SIGNUP_MODE=invite_only`.

### `registry-image-policy`

The `orchard-tenant-images` policy stops a pod using another project's repository on the platform registry. `off` is a `fail`. A policy that only warns, or is not installed yet, is a `warn`. In `auto` mode the server falls back to warn when an existing image would break.

Fix: leave `REGISTRY_IMAGE_POLICY` unset or set it to `enforce`, and make sure `DOCKER_REGISTRY_PULL` and `DOCKER_REGISTRY_PUSH` are set.

### `nodeport-exposure`

While `TENANT_NODEPORT_EXPOSURE` is not `false`, tenants can publish TCP ports on node addresses (`warn`). Nothing inside the cluster stops them being reachable on every node.

Fix: set `tenant.nodePortExposure=false`, and firewall node ports at your cloud or host.

### `hostname-style`

`HOSTNAME_STYLE=readable` puts organization and project names in public hostnames, which certificate transparency logs expose (`warn`).

Fix: unset `HOSTNAME_STYLE`. The default is opaque.

### `namespace-quotas`

Each managed namespace needs `orchard-org-quota` (CPU, memory, pods) and `orchard-abuse-quota` (load balancers, node ports, ephemeral storage). No quota at all is a `fail`, a missing one is a `warn`.

Fix: restart the server to re-apply the abuse quota, and set organization CPU and memory caps so the organization quota is created.

### `priority-class`

The `orchard-platform` PriorityClass schedules platform pods before tenants and evicts them last. Missing is a `warn`.

Fix: set `priorityClasses.enabled=true`.

### `cert-issuer`

The ClusterIssuer named by `CERT_CLUSTER_ISSUER` (default `letsencrypt-prod`) must exist and be Ready, or tenant ingresses never get certificates.

Fix: create the ClusterIssuer in cert-manager, or point `CERT_CLUSTER_ISSUER` at one that exists.

### `backup-proxy-buckets`

With the backup proxy off (`warn`), backups and the build cache use instance-wide object-store credentials. With it on, the allowed bucket list lives in the `r2-proxy-upstream` Secret, which the server does not read, so the result is `unknown`.

Fix: enable `r2Proxy` and list only the buckets you intend in `r2Proxy.allowedBuckets`. Confirm `ALLOWED_BUCKETS` in the Secret yourself.

### `metrics-stack`

The server calls the `/health` endpoint of VictoriaMetrics (`VICTORIAMETRICS_URL`). No answer is a `warn`.

Fix: check the VictoriaMetrics deployment in the `orchard-metrics` namespace and the URL.

### `logging-stack`

The server calls the `/health` endpoint of VictoriaLogs (`VICTORIALOGS_URL`). No answer is a `warn`.

Fix: check the VictoriaLogs deployment in the `orchard-metrics` namespace and the URL.

## The isolation self-test

Configuration checks show intent. The self-test shows what the cluster does. It runs only when a superadmin asks for it.

What it does:

1. Creates two temporary namespaces named `orchard-selftest-<id>-a` and `-b` through the server's normal namespace creation path, so they get the real `default-deny-all` policy, quotas and Pod Security labels. It checks they did.
2. Starts a listener pod in each, then a probe pod in each, under your tenant RuntimeClass with the same hardened security context as tenant pods.
3. From the probe in namespace A, tries a TCP connection to the kube-apiserver (the Service address and every endpoint), every node InternalIP and ExternalIP on ports 10250, 22, 6443 and 50000, the cloud metadata address, every Service in the Orchard, r2-proxy and metrics namespaces, the ingress controller pods' non-serving ports (1024, 1042, 6060, any in `DOCTOR_INGRESS_DEBUG_PORTS`, and any other port the pod declares), and the listener in namespace B.
4. Deletes both namespaces, waits for them to disappear and reports any that remain.

A dropped connection times out. A refused connection means the packet arrived, so it counts as reached. A target is `pass` only if every attempt was dropped.

Positive controls run in the same probe: cluster DNS, the public internet on 443 (`DOCTOR_EXTERNAL_TARGET`), a listener in the same namespace, an ingress controller serving port, and the listener in namespace B from inside namespace B. If any control fails, the probe cannot be trusted, so every result becomes `unknown` and the controls check says why. A failed control never produces a `pass`.

The result checks are `selftest-namespace-shape`, `selftest-controls`, `selftest-apiserver`, `selftest-nodes`, `selftest-metadata`, `selftest-platform`, `selftest-ingress-ports` and `selftest-cross-tenant`.

### `selftest-namespace-shape`

The temporary namespace must carry the managed label, `default-deny-all`, both quotas and a Pod Security enforce label. Fix: refer to [`default-deny-coverage`](#default-deny-coverage) and [`namespace-quotas`](#namespace-quotas), and read the server log for namespace creation errors.

### `selftest-controls`

The probe reached everything it must reach. Fix: make sure the probe image (`DOCTOR_PROBE_IMAGE`, default `debian:12.15-slim`) and listener image (`DOCTOR_LISTENER_IMAGE`, default `busybox:1.38.0`) can be pulled, the tenant RuntimeClass can start the pods, and tenant egress allows DNS and the internet. On an air-gapped cluster, point both images and `DOCTOR_EXTERNAL_TARGET` at internal mirrors.

### `selftest-apiserver`

A tenant pod must not reach the kube-apiserver. Fix: enforce NetworkPolicy, add the apiserver or its load balancer address to `tenant.extraDenyCidrs`, and on Cilium keep the `kube-apiserver` entity deny.

### `selftest-nodes`

A tenant pod must not reach node management ports. Fix: firewall 10250, 22, 6443 and 50000 from the pod network at the node, add node addresses to `tenant.extraDenyCidrs`, and on Cilium keep the `host` and `remote-node` entity denies.

### `selftest-metadata`

A tenant pod must not reach `169.254.169.254`. Fix: keep `169.254.0.0/16` in the tenant egress except list, and require IMDSv2 with a hop limit of 1 at the cloud.

### `selftest-platform`

A tenant pod must not reach the server, Postgres or Redis. Fix: enforce NetworkPolicy and keep `networkPolicy.platform.enabled=true`.

### `selftest-ingress-ports`

A tenant pod may reach ingress controllers on serving ports only. Controller stats and pprof ports list every tenant's backend. Fix: keep `TENANT_INGRESS_PORTS` to the serving ports, and bind controller stats and pprof to localhost where the controller allows.

### `selftest-cross-tenant`

A tenant pod must not reach an unpublished pod in another tenant namespace. Fix: enforce NetworkPolicy and check the destination namespace's `default-deny-all`.

### Cost and safety

A run takes one to three minutes, mostly pulling images. It starts four small pods and deletes them. Only one run can be active. If the server stops mid-run, a reaper deletes any namespace with the `orchard.my/selftest` label that is older than ten minutes, at the start of the next run and every ten minutes. Results are kept in memory on the server that ran the test and are lost on restart.

Run it on a staging cluster the first time you enable it on a new CNI or sandbox runtime.

## Related resources

- [Cluster settings to review](/operate/cluster-settings/) - Turn on the protections that the doctor reports, with what to check first and how to undo each one.
- [Security and isolation](/operate/security/) - Learn how Orchard isolates tenants, builds, and databases.
- [Go to production](/operate/production/) - Prepare an instance for real users.
