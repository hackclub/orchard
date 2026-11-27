# Tenant admission policies

`orchard-tenant-policies.yaml` holds nine native `ValidatingAdmissionPolicy` objects (Kubernetes 1.30 or later). The chart embeds the file unchanged in `templates/admission-policies.yaml` and adds the parameter ConfigMap and the bindings. The bindings select namespaces labelled `orchard.my/managed` or `orchard.dev/managed`, so nothing outside tenant namespaces is touched.

| Policy | Operations | Refuses |
| --- | --- | --- |
| `orchard-tenant-pods` | create | host namespaces, `nodeName`, `system-*` and `orchard-*` priority classes, privileged or `procMount`, `hostPort`, capabilities beyond the Pod Security baseline, host-backed volume types |
| `orchard-tenant-pods-hardening` | create | containers that do not drop ALL, pods outside the tenant RuntimeClass unless they request a device whose class names theirs (advisory by default) |
| `orchard-tenant-services` | create, update | `externalIPs`, `ExternalName`, NodePort when off, LoadBalancer or LB-IPAM pinning by anyone but the server, selector-less Services other than protection proxies |
| `orchard-tenant-endpointslices` | create, update | the server writing anything but protection-proxy slices (pinned to `protectionProxyIPs` when set) |
| `orchard-tenant-ingresses` | create, update | annotations outside the allow-list, foreign ingress class, foreign cert-manager issuer, resource backends |
| `orchard-tenant-pvcs` | create | `volumeName`, `dataSource(Ref)`, non-RWO access modes, foreign StorageClass (claim size is capped by the server, not here: the PVC schema does not type-check in CEL) |
| `orchard-tenant-networkpolicies` | create, update | egress to 0.0.0.0/0 without the private/link-local/CGNAT excepts, peer-less egress other than DNS, ingress from 0.0.0.0/0 without ports |
| `orchard-managed-namespaces` | update | removing the managed label or loosening a Pod Security enforce label |
| `orchard-tenant-rolebindings` | create, update | the server binding anything but the tenant-secrets role and Tailscale roles, or non-ServiceAccount subjects |
| `orchard-tenant-cnpg-clusters` | create, update | `pg_hba`, `postInit*SQL`, `env`, OS-command parameters, privileged managed roles, foreign images |

## Safety properties

- `failurePolicy: Ignore` on every policy, and every binding uses `parameterNotFoundAction: Allow`. A CEL error or a missing ConfigMap skips the rule.
- Every parameter is optional. An empty or missing key skips the rule it feeds.
- No rule keys off the CNPG operator or cert-manager identity. Their objects are recognised by what they are: the `cnpg.io/cluster` label on pods and PVCs, and the `acme.cert-manager.io/http01-solver` label on solver pods, Services and Ingresses. The server identity is only used to **restrict** the server (LoadBalancer, EndpointSlice, RoleBinding rules) or to allow it to do what only it may do.
- Rules that existing objects may fail (drop ALL, RuntimeClass) are in the separate `-hardening` policy with its own `hardeningActions`. Creation only: pods that already run are never touched.
- Default `validationActions` is `[Deny]`. Every benign fixture, built by the real manifest builders, is admitted. Set `admissionPolicies.validationActions: [Warn, Audit]` to report without refusing.

## Parameter ConfigMap (`orchard-tenant-policy`)

| Key | Source in the chart | Effect when empty |
| --- | --- | --- |
| `serverUser` | `system:serviceaccount:<namespace>:orchard-server` | server-restricting rules are skipped |
| `ingressClass` | `admissionPolicies.ingressClass`, else `tenant.ingressClass` | class rule skipped |
| `allowedIssuers` | `tenant.certClusterIssuer` plus `admissionPolicies.extraIssuers` | issuer rule skipped. Add your DNS-01 wildcard issuer to `extraIssuers`. |
| `storageClasses` | `admissionPolicies.storageClasses` | rule skipped |
| `allowNodePort` | `tenant.nodePortExposure` | NodePort allowed |
| `allowLoadBalancer` | always `true` | |
| `runtimeClass` | `tenantSandbox.runtimeClassName` when the sandbox is on | advisory rule skipped |
| `databaseRuntimeClass` | `databases.runtimeClassName` | database pods are not checked |
| `deviceRuntimeClasses` | `resource=runtimeClassName` pairs from `devices.classes` | a pod outside the tenant RuntimeClass is never excused by a device |
| `protectionProxyIPs` | `admissionPolicies.protectionProxyIPs`, else the `server` Service ClusterIP | address pin skipped |
| `tenantSecretsRole` | `orchard-tenant-secrets` | |
| `pgImagePrefixes` | `admissionPolicies.pgImagePrefixes` | image rule skipped |
| `pgPreloadLibraries` | `admissionPolicies.pgPreloadLibraries` | preload rule skipped |

## Tests

`celtest/` is a separate Go module that evaluates the policy expressions with the Kubernetes CEL environment (`k8s.io/apiserver/pkg/cel/environment`: strings, lists, quantity, CIDR and optional libraries) against `fixtures/`. The environment is dynamically typed, so schema type errors are only caught by a real API server (see below).

```bash
cd infra/charts/orchard/policies/celtest
go test ./...
WRITE_BUNDLE=$PWD/../fixtures/all.json go test -run TestBundleJSON ./...
```

- `fixtures/benign/` holds objects produced by the real manifest builders (`apps/server/scripts/gen-admission-fixtures.ts`): app pod, NodePort and ClusterIP Services, PVC, Tailscale proxy pod and NetworkPolicy, tenant NetworkPolicies, public LoadBalancer Services, protection-proxy Service and EndpointSlice, Ingresses, CNPG Cluster, job pod, legacy Postgres container pod, namespace, RoleBindings, plus real-shaped cert-manager solver and CNPG objects. All must be admitted. Regenerate with `cd apps/server && node node_modules/tsx/dist/cli.mjs scripts/gen-admission-fixtures.ts`.
- `fixtures/hostile/` holds objects that must be refused. The `denied-by` header names the message.
- Header directives: `user`, `groups`, `operation`, `set` (parameter overrides), `params: none`, `denied-by`, `warns`. A second YAML document is the `oldObject`.
- `fixtures/all.json` is the same set as `{name, expect, object, user, operation, ...}` for an external runner.

## Live check

1. Put the parameters in place: `kubectl apply -f fixtures/params.yaml` (edit the values for your cluster).
2. Install the policies with bindings that select only a sandbox namespace: `kubectl apply -f orchard-tenant-policies.yaml -f sandbox-bindings.yaml`, then `kubectl create ns orchard-policy-test` and label it `orchard.my/policy-sandbox=true`.
3. Run each fixture with `kubectl apply --dry-run=server -n orchard-policy-test -f <file>`, adding `--as=<user>` when the header names a user (for the server user: `--as=system:serviceaccount:orchard:orchard-server`). Benign files must succeed, hostile files must be refused with the message in `denied-by`. The `Namespace` fixtures are UPDATE cases: apply the second document first, then the first.
4. Read `kubectl get vap -o yaml` for `status.typeChecking`. A type warning on a `failurePolicy: Ignore` policy means a rule never denies; fix the expression.

## Notes from the live run

- The CNPG mutating webhook runs before validating policies and fills `spec.postgresql.parameters` with about 26 defaults (including `shared_preload_libraries`, `ssl_*`, `log_*`). The CNPG fixtures carry them, and the parameter rule only denies keys the webhook never sets. Preload libraries are checked on the top-level `postgresql.shared_preload_libraries` list instead.
- Param lookups use `'key' in params.data ? params.data['key'] : default`, not optional selection, which behaved differently on the live API server.
