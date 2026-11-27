{{/* Resolve a component image reference. */}}
{{- define "orchard.image" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $tag  := index . 2 -}}
{{- $repo := "" -}}
{{- if gt (len .) 3 -}}{{- $repo = index . 3 -}}{{- end -}}
{{- $resolvedTag := $tag | default $root.Chart.AppVersion -}}
{{- $resolvedRepo := $repo | default $root.Values.image.repository -}}
{{ printf "%s/%s/%s:%s" $root.Values.image.registry $resolvedRepo $name $resolvedTag }}
{{- end -}}

{{/*
Wildcard suffix=tlsSecret pairs the server builds generated app URLs from.
Explicit tenant.wildcardDomains wins; otherwise derive a single entry from the
app domain the gateway already terminates TLS for, so operators configure the
domain once instead of keeping four values in sync.
*/}}
{{- define "orchard.appWildcardSecret" -}}
{{- if .Values.gateway.http.appWildcardSecretName -}}
{{- .Values.gateway.http.appWildcardSecretName -}}
{{- else if .Values.gateway.http.appDomain -}}
{{- printf "wildcard-%s-tls" (regexReplaceAll "[^a-zA-Z0-9]+" .Values.gateway.http.appDomain "-") -}}
{{- end -}}
{{- end -}}

{{- define "orchard.wildcardDomains" -}}
{{- if .Values.tenant.wildcardDomains -}}
{{ .Values.tenant.wildcardDomains }}
{{- else if .Values.gateway.http.appDomain -}}
{{- /*
  Suffix only, with no `=secret`, unless a wildcard Secret was actually named.
  Naming a derived one made every generated URL reference a Secret that nothing
  on a stock install creates, so the host served no certificate. Without it the
  server issues per-host against tenant.certClusterIssuer, which works with no
  extra setup.
*/ -}}
{{- if .Values.gateway.http.appWildcardSecretName -}}
{{ printf ".%s=%s" .Values.gateway.http.appDomain .Values.gateway.http.appWildcardSecretName }}
{{- else -}}
{{ printf ".%s" .Values.gateway.http.appDomain }}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The app domain the server generates hostnames under. */}}
{{- define "orchard.appDomain" -}}
{{- .Values.gateway.http.appDomain | default "" -}}
{{- end -}}

{{/* True when server.env already defines `key`, so the chart shouldn't. */}}
{{- define "orchard.serverEnvHas" -}}
{{- $key := .key -}}
{{- range .root.Values.server.env -}}
{{- if eq .name $key }}found{{ end -}}
{{- end -}}
{{- end -}}

{{/* The same question for any env list: pass `env` and `key`. */}}
{{- define "orchard.envHas" -}}
{{- $key := .key -}}
{{- range .env -}}
{{- if eq .name $key }}found{{ end -}}
{{- end -}}
{{- end -}}

{{- define "orchard.buildCacheBucket" -}}
{{- $set := .Values.r2Proxy.buildCacheBucket | default "" -}}
{{- if not $set -}}
{{- range .Values.server.env -}}
{{- if eq .name "BUILDKIT_S3_BUCKET" }}{{ $set = .value | default "" }}{{ end -}}
{{- end -}}
{{- end -}}
{{- $set -}}
{{- end -}}

{{/*
The public origin of the Orchard UI. An explicit server.env FRONTEND_URL wins,
because it is the one the server itself signs callbacks against, and it is not
always derivable: behind a tunnel the route terminates plaintext in-cluster
while the world reaches it over https.
*/}}
{{- define "orchard.frontendUrl" -}}
{{- $set := "" -}}
{{- range .Values.server.env -}}
{{- if eq .name "FRONTEND_URL" }}{{ $set = .value }}{{ end -}}
{{- end -}}
{{- if $set -}}
{{- $set -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- end -}}
{{- end -}}

{{/*
Where the MCP answers. Empty unless it is enabled and its route has a host,
so nothing derives a URL like "https://" from an unset hostname.
*/}}
{{- define "orchard.mcpUrl" -}}
{{- if .Values.mcp.enabled -}}
{{- if .Values.mcp.url -}}
{{- .Values.mcp.url -}}
{{- else if and .Values.mcp.ingress.enabled .Values.mcp.ingress.host -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.mcp.ingress.tls.enabled) .Values.mcp.ingress.host -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The Secret the MCP IngressRoute terminates with, mirroring the UI's. */}}
{{- define "orchard.mcpTlsSecret" -}}
{{- $tls := .Values.mcp.ingress.tls -}}
{{- if $tls.secretName -}}
{{- $tls.secretName -}}
{{- else if (($tls.issuerRef | default dict).name) -}}
{{- printf "%s-mcp-tls" .Release.Name -}}
{{- end -}}
{{- end -}}

{{- define "orchard.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/part-of: orchard
app.kubernetes.io/managed-by: helm
{{- end -}}

{{- define "orchard.pullSecrets" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
The Secret the control-plane IngressRoute terminates TLS with. Explicit
secretName wins; otherwise it is only defaulted when the chart is the one
issuing the certificate, so an install that fills the Secret in out of band
still has to name it.
*/}}
{{- define "orchard.sandboxInstalled" -}}
{{- $s := .Values.sandbox -}}
{{- if kindIs "invalid" $s.install -}}
{{- if $s.enabled }}true{{ end -}}
{{- else if $s.install -}}
true
{{- end -}}
{{- end }}

{{- define "orchard.sandboxIngressPorts" -}}
{{- list 22 4096 4097 3000 3001 4173 5173 8000 8080 8787 | toJson -}}
{{- end }}

{{- define "orchard.ingressTlsSecret" -}}
{{- $tls := .Values.ingress.tls -}}
{{- if $tls.secretName -}}
{{- $tls.secretName -}}
{{- else if (($tls.issuerRef | default dict).name) -}}
{{- printf "%s-tls" .Release.Name -}}
{{- end -}}
{{- end }}

{{- define "orchard.serverEnv" }}
            - { name: NODE_ENV, value: production }
            {{- if not (include "orchard.serverEnvHas" (dict "root" . "key" "TRUST_PROXY")) }}
            - { name: TRUST_PROXY, value: {{ .Values.clientIp.trustProxy | toString | quote }} }
            {{- end }}
            {{- if and .Values.clientIp.trustedProxyRanges (not (include "orchard.serverEnvHas" (dict "root" . "key" "TRUSTED_PROXY_RANGES"))) }}
            - { name: TRUSTED_PROXY_RANGES, value: {{ .Values.clientIp.trustedProxyRanges | quote }} }
            {{- end }}
            {{- if and (not .Values.clientIp.trustCloudflare) (not (include "orchard.serverEnvHas" (dict "root" . "key" "TRUST_CLOUDFLARE"))) }}
            - { name: TRUST_CLOUDFLARE, value: "false" }
            {{- end }}
            {{- if and .Values.clientIp.header .Values.clientIp.headerFrom (not (include "orchard.serverEnvHas" (dict "root" . "key" "CLIENT_IP_HEADER"))) }}
            - { name: CLIENT_IP_HEADER, value: {{ .Values.clientIp.header | quote }} }
            - { name: CLIENT_IP_HEADER_FROM, value: {{ .Values.clientIp.headerFrom | quote }} }
            {{- end }}
            - { name: TENANT_SECRETS_CLUSTER_ROLE, value: {{ printf "%s-tenant-secrets" .Release.Name | quote }} }
            {{- if .Values.datadog.enabled }}
            # Datadog agent service with internalTrafficPolicy: Local: each
            # pod reaches the agent on its own node. (hostPort 8126 is dead
            # here: Cilium runs without hostPort support; hostPath sockets
            # are blocked by PodSecurity baseline in this namespace.)
            # Covers traces (8126) and DogStatsD runtime metrics (8125).
            - { name: DD_AGENT_HOST, value: {{ .Values.datadog.agentHost | quote }} }
            - { name: DD_ENV, value: {{ .Values.datadog.env | quote }} }
            - { name: DD_SERVICE, value: orchard-server }
            # Unified service tagging: version tracks the deployed image tag.
            - { name: DD_VERSION, value: {{ .Values.server.image.tag | default .Chart.AppVersion | quote }} }
            {{- if not .Values.datadog.profiling }}
            - { name: DD_PROFILING_ENABLED, value: "false" }
            {{- end }}
            {{- if .Values.datadog.appsec }}
            - { name: DD_APPSEC_ENABLED, value: "true" }
            - { name: DD_API_SECURITY_ENABLED, value: "true" }
            {{- end }}
            {{- end }}
            {{- if .Values.postgres.enabled }}
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.postgres.name }}-app
                  key: uri
            {{- include "orchard.poolerEnv" . }}
            {{- end }}
            {{- if .Values.redis.enabled }}
            {{- if and .Values.redis.auth.enabled (not .Values.redis.url) }}
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: redis-auth
                  key: password
            - name: REDIS_URL
              value: {{ printf "redis://:$(REDIS_PASSWORD)@redis.%s.svc.cluster.local:6379" .Values.namespace | quote }}
            {{- else }}
            - name: REDIS_URL
              value: {{ default (printf "redis://redis.%s.svc.cluster.local:6379" .Values.namespace) .Values.redis.url | quote }}
            {{- end }}
            {{- end }}
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            {{- if and .Values.builders.enabled .Values.builders.dedicatedNode.enabled }}
            - { name: BUILDER_DEDICATED_NODE, value: "true" }
            {{- end }}
            {{- with .Values.builders.platform }}
            - { name: BUILD_PLATFORM, value: {{ . | quote }} }
            {{- end }}
            {{- if .Values.protection.orchardLogin }}
            - { name: PROTECTION_ORCHARD_LOGIN, value: "true" }
            {{- end }}
            {{- if .Values.certificates.copyToTenants }}
            # Where the wildcard TLS Secret is issued. The server copies it into
            # every namespace whose ingresses name it, because a wildcard is
            # issued once but referenced locally by each tenant Ingress.
            #
            # Opt-in, and it must stay off wherever something else already does
            # this: two controllers replacing the same Secret would each undo
            # the other's metadata and rewrite forever.
            - { name: WILDCARD_TLS_SOURCE_NAMESPACE, value: {{ .Values.certificates.namespace | quote }} }
            {{- end }}
            {{- if .Values.cilium.enabled }}
            # Only set when the operator opts in. Left unset the server probes
            # the cluster for the cilium.io group plus create permission on
            # ciliumenvoyconfigs, so an install that already runs Cilium keeps
            # its basic-auth and per-tenant policy without touching values.
            - { name: CILIUM_ENABLED, value: "true" }
            {{- end }}
            {{- if and .Values.builders.enabled .Values.builders.localCache.enabled }}
            - { name: BUILDKIT_LOCAL_CACHE_ENABLED, value: "true" }
            - { name: BUILDKIT_LOCAL_CACHE_PATH, value: {{ .Values.builders.localCache.path | quote }} }
            - { name: BUILDKIT_LOCAL_CACHE_PVC,  value: {{ .Values.builders.localCache.pvcName | quote }} }
            {{- with .Values.builders.localCache.gcKeepBytes }}
            - { name: BUILDKIT_GC_KEEP_BYTES, value: {{ . | quote }} }
            {{- end }}
            {{- with .Values.builders.localCache.gcEphemeralKeepBytes }}
            - { name: BUILDKIT_GC_EPHEMERAL_KEEP_BYTES, value: {{ . | quote }} }
            {{- end }}
            {{- with .Values.builders.localCache.evict }}
            {{- with .highPct }}
            - { name: BUILDKIT_CACHE_HIGH_PCT, value: {{ . | quote }} }
            {{- end }}
            {{- with .targetPct }}
            - { name: BUILDKIT_CACHE_TARGET_PCT, value: {{ . | quote }} }
            {{- end }}
            {{- with .maxAgeDays }}
            - { name: BUILDKIT_CACHE_MAX_AGE_DAYS, value: {{ . | quote }} }
            {{- end }}
            {{- with .idleMinutes }}
            - { name: BUILDKIT_CACHE_IDLE_MINUTES, value: {{ . | quote }} }
            {{- end }}
            {{- with .maxGiB }}
            - { name: BUILDKIT_CACHE_MAX_GIB, value: {{ . | quote }} }
            {{- end }}
            {{- end }}
            {{- end }}
            {{- if .Values.tenant.ingressNamespaces }}
            - { name: TENANT_INGRESS_NAMESPACES, value: {{ .Values.tenant.ingressNamespaces | quote }} }
            {{- end }}
            {{- if .Values.tenant.ingressPorts }}
            - { name: TENANT_INGRESS_PORTS, value: {{ .Values.tenant.ingressPorts | quote }} }
            {{- end }}
            {{- if .Values.tenant.egressBlockPorts }}
            - { name: TENANT_EGRESS_BLOCK_PORTS, value: {{ .Values.tenant.egressBlockPorts | quote }} }
            {{- end }}
            {{- if .Values.tenant.denyEntities }}
            - { name: TENANT_DENY_ENTITIES, value: {{ .Values.tenant.denyEntities | quote }} }
            {{- end }}
            {{- if .Values.tenant.extraDenyCidrs }}
            - { name: PLATFORM_EXTRA_DENY_CIDRS, value: {{ .Values.tenant.extraDenyCidrs | quote }} }
            {{- end }}
            {{- if and .Values.tenant.cnpgOperatorNamespace (not (include "orchard.serverEnvHas" (dict "root" . "key" "CNPG_OPERATOR_NAMESPACE"))) }}
            - { name: CNPG_OPERATOR_NAMESPACE, value: {{ .Values.tenant.cnpgOperatorNamespace | quote }} }
            {{- end }}
            {{- if .Values.tenantSandbox.enabled }}
            - { name: TENANT_RUNTIME_CLASS, value: {{ .Values.tenantSandbox.runtimeClassName | quote }} }
            {{- end }}
            {{- if .Values.devices.classes }}
            - { name: DEVICE_CLASSES, value: {{ .Values.devices.classes | toJson | quote }} }
            {{- end }}
            - { name: BUILDER_SIDECAR_PUSH, value: {{ .Values.builderSandbox.sidecarPush | quote }} }
            - { name: BUILDER_PUSHER_IMAGE, value: {{ .Values.builderSandbox.pusherImage | quote }} }
            {{- if .Values.builderSandbox.enabled }}
            {{- if .Values.builderSandbox.runtimeClassName }}
            - { name: BUILDER_RUNTIME_CLASS, value: {{ .Values.builderSandbox.runtimeClassName | quote }} }
            {{- end }}
            {{- if .Values.builderSandbox.depotRuntimeClassName }}
            - { name: BUILDER_DEPOT_RUNTIME_CLASS, value: {{ .Values.builderSandbox.depotRuntimeClassName | quote }} }
            {{- end }}
            {{- if .Values.builderSandbox.tmpfsWorkspace }}
            - { name: BUILDER_WORKSPACE_TMPFS, value: "true" }
            {{- end }}
            {{- if .Values.builderSandbox.scratch }}
            - { name: BUILDER_SCRATCH_MODE, value: {{ .Values.builderSandbox.scratch.mode | quote }} }
            - { name: BUILDER_SCRATCH_SIZE, value: {{ .Values.builderSandbox.scratch.size | quote }} }
            - { name: BUILDER_SCRATCH_STORAGE_CLASS, value: {{ .Values.builderSandbox.scratch.storageClass | quote }} }
            {{- end }}
            {{- if .Values.builderSandbox.memoryLimit }}
            - { name: BUILDER_MEMORY_LIMIT, value: {{ .Values.builderSandbox.memoryLimit | quote }} }
            {{- end }}
            {{- end }}
            {{- with .Values.sandbox }}
            {{- if include "orchard.sandboxInstalled" $ }}
            - { name: ORCHARD_SERVER_NAMESPACE, value: {{ $.Values.namespace | quote }} }
            {{- with (include "orchard.mcpUrl" $) }}
            - { name: SANDBOX_MCP_URL, value: {{ . | quote }} }
            {{- end }}
            - { name: SANDBOX_NAMESPACE, value: {{ .namespace | quote }} }
            - { name: SANDBOX_IMAGE, value: {{ .image | quote }} }
            {{- if .runtimeClassName }}
            - { name: SANDBOX_RUNTIME_CLASS, value: {{ .runtimeClassName | quote }} }
            {{- end }}
            - { name: SANDBOX_IDLE_TIMEOUT_MINUTES, value: {{ .idleTimeoutMinutes | quote }} }
            - { name: SANDBOX_MAX_LIFETIME_HOURS, value: {{ .maxLifetimeHours | quote }} }
            - { name: SANDBOX_MAX_PER_USER, value: {{ .maxPerUserDefault | quote }} }
            - { name: SANDBOX_STORAGE_CLASS, value: {{ .storageClass | quote }} }
            - { name: SANDBOX_DISK_SIZE, value: {{ .diskSize | quote }} }
            - { name: SANDBOX_CPU_LIMIT, value: {{ .cpuLimit | quote }} }
            - { name: SANDBOX_MEMORY_LIMIT, value: {{ .memoryLimit | quote }} }
            {{- if .tunnelMode }}
            - { name: SANDBOX_TUNNEL_MODE, value: {{ .tunnelMode | quote }} }
            {{- end }}
            {{- if .homeMode }}
            - { name: SANDBOX_HOME_MODE, value: {{ .homeMode | quote }} }
            {{- end }}
            {{- end }}
            {{- with .runners }}
            {{- if not (kindIs "invalid" .kubernetes.enabled) }}
            - { name: SANDBOX_RUNNER_KUBERNETES_ENABLED, value: {{ .kubernetes.enabled | toString | quote }} }
            {{- end }}
            {{- if not (kindIs "invalid" .vercel.enabled) }}
            - { name: SANDBOX_RUNNER_VERCEL_ENABLED, value: {{ .vercel.enabled | toString | quote }} }
            {{- end }}
            {{- if .default }}
            - { name: SANDBOX_DEFAULT_RUNNER, value: {{ .default | quote }} }
            {{- end }}
            {{- with .vercel }}
            {{- if .tokenSecret.name }}
            - name: SANDBOX_VERCEL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ .tokenSecret.name | quote }}
                  key: {{ .tokenSecret.key | default "token" | quote }}
            {{- end }}
            {{- if .teamId }}
            - { name: SANDBOX_VERCEL_TEAM_ID, value: {{ .teamId | quote }} }
            {{- end }}
            {{- if .projectId }}
            - { name: SANDBOX_VERCEL_PROJECT_ID, value: {{ .projectId | quote }} }
            {{- end }}
            {{- if .image }}
            - { name: SANDBOX_VERCEL_IMAGE, value: {{ .image | quote }} }
            {{- end }}
            {{- if .vcpus }}
            - { name: SANDBOX_VERCEL_VCPUS, value: {{ .vcpus | toString | quote }} }
            {{- end }}
            {{- if .timeoutMinutes }}
            - { name: SANDBOX_VERCEL_TIMEOUT_MINUTES, value: {{ .timeoutMinutes | toString | quote }} }
            {{- end }}
            {{- if ne (toString (.driveGiB | default "")) "" }}
            - { name: SANDBOX_VERCEL_DRIVE_GIB, value: {{ .driveGiB | toString | quote }} }
            {{- end }}
            {{- end }}
            {{- if .bridgeBinaryUrl }}
            - { name: SANDBOX_BRIDGE_BINARY_URL, value: {{ .bridgeBinaryUrl | quote }} }
            {{- end }}
            {{- if .bridgeBinarySha256 }}
            - { name: SANDBOX_BRIDGE_BINARY_SHA256, value: {{ .bridgeBinarySha256 | quote }} }
            {{- end }}
            {{- if .previewDomain }}
            - { name: SANDBOX_PREVIEW_DOMAIN, value: {{ .previewDomain | quote }} }
            {{- end }}
            {{- end }}
            {{- end }}
            {{- if .Values.fcBuilder.enabled }}
            - { name: FC_BUILDER_ENABLED, value: {{ .Values.fcBuilder.serverEnabled | quote }} }
            - name: FC_BUILDER_HOSTS
              value: {{ include "orchard.fcBuilderHosts" . | quote }}
            - name: FC_BUILDER_TOKEN
              valueFrom:
                secretKeyRef:
                  name: fc-builder-token
                  key: token
            - { name: MAX_CONCURRENT_FC_BUILDS, value: {{ .Values.fcBuilder.maxConcurrentBuilds | quote }} }
            - { name: MAX_CONCURRENT_FC_BUILDS_PER_VM, value: {{ .Values.fcBuilder.maxBuildsPerVm | default 2 | quote }} }
            {{- with .Values.fcBuilder.routing }}
            - { name: FAST_BUILDER_ROUTING_DEFAULT, value: {{ . | quote }} }
            {{- end }}
            {{- end }}
            {{- if and .Values.metrics.enabled (not (include "orchard.serverEnvHas" (dict "root" . "key" "VICTORIAMETRICS_URL"))) }}
            - { name: VICTORIAMETRICS_URL, value: {{ printf "http://victoriametrics.%s.svc.cluster.local:8428" .Values.metrics.namespace | quote }} }
            {{- end }}
            {{- if and .Values.logs.enabled (not (include "orchard.serverEnvHas" (dict "root" . "key" "VICTORIALOGS_URL"))) }}
            - { name: VICTORIALOGS_URL, value: {{ printf "http://victorialogs.%s.svc.cluster.local:9428" .Values.metrics.namespace | quote }} }
            {{- end }}
            {{- if and (ne .Values.metrics.namespace "orchard-metrics") (not (include "orchard.serverEnvHas" (dict "root" . "key" "PLATFORM_METRICS_NAMESPACE"))) }}
            - { name: PLATFORM_METRICS_NAMESPACE, value: {{ .Values.metrics.namespace | quote }} }
            {{- end }}
            {{- if .Values.trivy.enabled }}
            - { name: TRIVY_SERVER_URL, value: {{ printf "http://trivy.%s.svc.cluster.local:4954" .Values.trivy.namespace | quote }} }
            - { name: TRIVY_SCAN_NAMESPACE, value: {{ .Values.trivy.namespace | quote }} }
            - { name: TRIVY_IMAGE, value: {{ .Values.trivy.image | quote }} }
            - { name: TRIVY_MAX_CONCURRENT_SCANS, value: {{ .Values.trivy.maxConcurrentScans | quote }} }
            - { name: TRIVY_SCAN_TIMEOUT_SECONDS, value: {{ .Values.trivy.scanTimeoutSeconds | quote }} }
            - name: TRIVY_SERVER_TOKEN
              valueFrom:
                secretKeyRef:
                  name: trivy-server-token
                  key: token
            {{- if not (include "orchard.serverEnvHas" (dict "root" . "key" "ORCHARD_INTERNAL_URL")) }}
            - { name: ORCHARD_INTERNAL_URL, value: {{ printf "http://server.%s.svc.cluster.local:%v" .Values.namespace .Values.server.service.port | quote }} }
            {{- end }}
            {{- end }}
            {{- if include "orchard.localBackups" . }}
            - { name: LOCAL_STORE_ENDPOINT, value: {{ include "orchard.objectStorageEndpoint" . | quote }} }
            - { name: LOCAL_STORE_BACKUP_BUCKET, value: {{ .Values.objectStorage.local.bucket | quote }} }
            {{- with .Values.objectStorage.local.uploadsBucket }}
            - { name: LOCAL_STORE_UPLOADS_BUCKET, value: {{ . | quote }} }
            {{- end }}
            - { name: LOCAL_STORE_REGION, value: {{ .Values.objectStorage.local.region | quote }} }
            - name: LOCAL_STORE_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: orchard-object-storage
                  key: accessKey
            - name: LOCAL_STORE_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: orchard-object-storage
                  key: secretKey
            {{- end }}
            {{- if and .Values.updates.url (not (include "orchard.serverEnvHas" (dict "root" . "key" "UPDATES_URL"))) }}
            - { name: UPDATES_URL, value: {{ .Values.updates.url | quote }} }
            {{- end }}
            {{- if include "orchard.r2ProxyActive" . }}
            - { name: BACKUP_PROXY_ENABLED, value: "true" }
            {{- if .Values.r2Proxy.upstream.endpoint }}
            - { name: BACKUP_PROXY_CHART_UPSTREAM, value: "true" }
            {{- end }}
            {{- if and (ne .Values.r2Proxy.namespace "orchard-r2-proxy") (not (include "orchard.serverEnvHas" (dict "root" . "key" "PLATFORM_R2_PROXY_NAMESPACE"))) }}
            - { name: PLATFORM_R2_PROXY_NAMESPACE, value: {{ .Values.r2Proxy.namespace | quote }} }
            {{- end }}
            - name: BACKUP_PROXY_ENDPOINT
              value: {{ default (printf "http://r2-proxy.%s.svc.cluster.local:9000" .Values.r2Proxy.namespace) .Values.r2Proxy.serviceUrl | quote }}
            {{- end }}
            {{- if .Values.metrics.enabled }}
            - { name: INGRESS_METRICS_TRAEFIK_NAMESPACE, value: {{ join "," .Values.metrics.ingress.traefik.namespaces | quote }} }
            - { name: INGRESS_METRICS_HAPROXY_NAMESPACE, value: {{ join "," .Values.metrics.ingress.haproxy.namespaces | quote }} }
            {{- end }}
            {{- with .Values.publicTls }}
            {{- if .db }}
            - name: PUBLIC_DB_TLS_SOURCE_NAMESPACE
              value: {{ .db.sourceNamespace | default $.Values.certificates.namespace | quote }}
            - name: PUBLIC_DB_TLS_SOURCE_SECRET
              value: {{ .db.sourceSecret | default $.Values.certificates.wildcards.db.secretName | quote }}
            - name: PUBLIC_DB_TLS_LOCAL_SECRET
              value: {{ .db.localSecret | quote }}
            {{- if eq (.db.mode | default "wildcard") "perDatabase" }}
            - { name: PUBLIC_DB_TLS_MODE, value: "per-database" }
            - name: PUBLIC_DB_TLS_ISSUER_NAME
              value: {{ (.db.issuer | default dict).name | default $.Values.certificates.issuer.name | quote }}
            - name: PUBLIC_DB_TLS_ISSUER_KIND
              value: {{ (.db.issuer | default dict).kind | default $.Values.certificates.issuer.kind | quote }}
            {{- if .db.legacyHostnames }}
            - { name: PUBLIC_DB_TLS_LEGACY_HOSTNAMES, value: "true" }
            {{- end }}
            {{- end }}
            {{- end }}
            {{- end }}
            {{- if .Values.signupMode }}
            - { name: SIGNUP_MODE, value: {{ .Values.signupMode | quote }} }
            {{- end }}
            {{- if not .Values.mcp.enabled }}
            # Nothing is serving MCP on this instance, so the runtime toggle is
            # pinned off rather than left switchable from the admin panel.
            - { name: MCP_ENABLED, value: "false" }
            {{- end }}
            {{- /*
              The server needs the MCP's hostname too, not to serve it, but to
              report on it: the DNS check in the admin panel cannot tell an
              operator that mcp.example.com does not resolve without knowing it
              is supposed to.
            */}}
            {{- if not (or (include "orchard.serverEnvHas" (dict "root" . "key" "MCP_BASE_URL")) .Values.server.envFrom) }}
            {{- with (include "orchard.mcpUrl" .) }}
            - { name: MCP_BASE_URL, value: {{ . | quote }} }
            {{- end }}
            {{- end }}
            {{- with .Values.tenant }}
            {{- if .storageClass }}
            - { name: K8S_STORAGE_CLASS, value: {{ .storageClass | quote }} }
            {{- end }}
            {{- if .ingressClass }}
            - { name: K8S_INGRESS_CLASS, value: {{ .ingressClass | quote }} }
            {{- end }}
            {{- if .certClusterIssuer }}
            - { name: CERT_CLUSTER_ISSUER, value: {{ .certClusterIssuer | quote }} }
            {{- end }}
            {{- if .publicIp }}
            - { name: PUBLIC_EXPOSURE_IP, value: {{ .publicIp | quote }} }
            {{- end }}
            {{- if eq (toString .nodePortExposure) "false" }}
            - { name: TENANT_NODEPORT_EXPOSURE, value: "false" }
            {{- end }}
            {{- if .maxPublicPortsPerOrg }}
            - { name: MAX_PUBLIC_PORTS_PER_ORG, value: {{ .maxPublicPortsPerOrg | quote }} }
            {{- end }}
            {{- if .egressBandwidth }}
            - { name: TENANT_EGRESS_BANDWIDTH, value: {{ .egressBandwidth | quote }} }
            {{- end }}
            {{- if .newOrgCpu }}
            - { name: NEW_ORG_CPU, value: {{ .newOrgCpu | quote }} }
            {{- end }}
            {{- if .newOrgMemory }}
            - { name: NEW_ORG_MEMORY, value: {{ .newOrgMemory | quote }} }
            {{- end }}
            {{- if .maxProjectsPerOrg }}
            - { name: MAX_PROJECTS_PER_ORG, value: {{ .maxProjectsPerOrg | quote }} }
            {{- end }}
            {{- if .maxEnvironmentsPerOrg }}
            - { name: MAX_ENVIRONMENTS_PER_ORG, value: {{ .maxEnvironmentsPerOrg | quote }} }
            {{- end }}
            {{- if .maxDeploymentsPerOrg }}
            - { name: MAX_DEPLOYMENTS_PER_ORG, value: {{ .maxDeploymentsPerOrg | quote }} }
            {{- end }}
            {{- if .maxCustomDomainsPerOrg }}
            - { name: MAX_CUSTOM_DOMAINS_PER_ORG, value: {{ .maxCustomDomainsPerOrg | quote }} }
            {{- end }}
            {{- if .maxCustomDomainCreatesPerHour }}
            - { name: MAX_CUSTOM_DOMAIN_CREATES_PER_HOUR, value: {{ .maxCustomDomainCreatesPerHour | quote }} }
            {{- end }}
            {{- end }}
            {{- with (include "orchard.wildcardDomains" .) }}
            - { name: PLATFORM_WILDCARD_DOMAINS, value: {{ . | quote }} }
            {{- end }}
            {{- /*
              APP_DOMAIN is only injected when the operator hasn't supplied it
              themselves. A container `env` entry outranks every `envFrom`
              source, so emitting it unconditionally would silently shadow an
              APP_DOMAIN held in a Secret, which is how a GitOps install usually
              provides it.
            */}}
            {{- if not (or (include "orchard.serverEnvHas" (dict "root" . "key" "APP_DOMAIN")) .Values.server.envFrom) }}
            {{- with (include "orchard.appDomain" .) }}
            - { name: APP_DOMAIN, value: {{ . | quote }} }
            {{- end }}
            {{- end }}
            {{- /*
              Status pages and org vanity hosts are Ingresses the server creates
              onto the frontend. Same rule as APP_DOMAIN: with server.envFrom the
              operator owns these, and an env entry here would shadow their Secret.
            */}}
            {{- if and .Values.builders.enabled (not .Values.server.envFrom) }}
            {{- if not (include "orchard.serverEnvHas" (dict "root" . "key" "BUILDKIT_IMAGE")) }}
            - { name: BUILDKIT_IMAGE, value: {{ .Values.builders.buildkitImage | quote }} }
            {{- end }}
            {{- if and .Values.builders.buildkitRootlessImage (not (include "orchard.serverEnvHas" (dict "root" . "key" "BUILDKIT_ROOTLESS_IMAGE"))) }}
            - { name: BUILDKIT_ROOTLESS_IMAGE, value: {{ .Values.builders.buildkitRootlessImage | quote }} }
            {{- end }}
            {{- if and .Values.builders.allowPrivilegedOnHost (not (include "orchard.serverEnvHas" (dict "root" . "key" "BUILDER_ALLOW_PRIVILEGED_ON_HOST"))) }}
            - { name: BUILDER_ALLOW_PRIVILEGED_ON_HOST, value: "true" }
            {{- end }}
            {{- if not (include "orchard.serverEnvHas" (dict "root" . "key" "RAILPACK_VERSION")) }}
            - { name: RAILPACK_VERSION, value: {{ .Values.builders.railpackVersion | quote }} }
            {{- end }}
            {{- end }}
            {{- if and .Values.frontend.enabled (not .Values.server.envFrom) }}
            {{- if not (include "orchard.serverEnvHas" (dict "root" . "key" "PLATFORM_NAMESPACE")) }}
            - { name: PLATFORM_NAMESPACE, value: {{ .Values.namespace | quote }} }
            {{- end }}
            {{- if not (include "orchard.serverEnvHas" (dict "root" . "key" "PLATFORM_SERVICE_NAME")) }}
            - { name: PLATFORM_SERVICE_NAME, value: "frontend" }
            {{- end }}
            {{- if not (include "orchard.serverEnvHas" (dict "root" . "key" "PLATFORM_SERVICE_PORT")) }}
            - { name: PLATFORM_SERVICE_PORT, value: {{ .Values.frontend.service.port | quote }} }
            {{- end }}
            {{- end }}
            {{- with .Values.server.env }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
{{- end }}

{{/*
The vanity domain the frontend routes status and org hosts under, read from the
server's BASE_DOMAIN. Empty with server.envFrom, where only the operator knows it.
*/}}
{{- define "orchard.baseDomain" -}}
{{- if not .Values.server.envFrom -}}
{{- range .Values.server.env -}}
{{- if eq .name "BASE_DOMAIN" }}{{ .value }}{{ end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
One password for the proxy's postgres role, stable across upgrades: an
explicit value wins, then whatever the secret already holds, then a fresh
random one that every template in this render sees.
*/}}
{{- define "orchard.poolerEnv" }}
{{- if .Values.postgres.pooler.enabled }}
            - { name: DATABASE_POOLER_HOST, value: {{ printf "%s-pooler-rw.%s.svc.cluster.local" .Values.postgres.name .Values.namespace | quote }} }
            - { name: ORCHARD_DB_POOLER_CONNECTIONS, value: {{ mul .Values.postgres.pooler.instances .Values.postgres.pooler.defaultPoolSize | toString | quote }} }
{{- end }}
{{- end }}

{{- define "orchard.fcBuilderHosts" -}}
{{- $ns := .Values.fcBuilder.namespace -}}
{{- $hosts := list -}}
{{- range $i := until (int .Values.fcBuilder.replicas) -}}
{{- $hosts = append $hosts (printf "http://fc-builder-%d.fc-builder.%s.svc.cluster.local:8080" $i $ns) -}}
{{- end -}}
{{- join "," $hosts -}}
{{- end -}}

{{- define "orchard.fcBuilderToken" -}}
{{- if .Values.fcBuilder.token -}}
{{- .Values.fcBuilder.token -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Values.fcBuilder.namespace "fc-builder") -}}
{{- if and $existing $existing.data (index $existing.data "FC_BUILDER_TOKEN") -}}
{{- index $existing.data "FC_BUILDER_TOKEN" | b64dec -}}
{{- else -}}
{{- if not (index .Values.fcBuilder "generatedToken") -}}
{{- $_ := set .Values.fcBuilder "generatedToken" (randAlphaNum 48) -}}
{{- end -}}
{{- index .Values.fcBuilder "generatedToken" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "orchard.r2ProxyDbPassword" -}}
{{- if .Values.r2Proxy.databasePassword -}}
{{- .Values.r2Proxy.databasePassword -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Values.namespace "orchard-r2-proxy-db") -}}
{{- if and $existing $existing.data $existing.data.password -}}
{{- $existing.data.password | b64dec -}}
{{- else -}}
{{- if not (index .Values.r2Proxy "generatedDatabasePassword") -}}
{{- $_ := set .Values.r2Proxy "generatedDatabasePassword" (randAlphaNum 40) -}}
{{- end -}}
{{- index .Values.r2Proxy "generatedDatabasePassword" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "orchard.graftsOn" -}}
{{- if gt (len (default (list) .Values.grafts)) 0 }}true{{- end }}
{{- end }}

{{- define "orchard.graftEnv" }}
            - { name: ORCHARD_GRAFTS_DIR, value: /app/grafts }
            - { name: ORCHARD_GRAFTS, value: {{ toJson (default (list) .Values.grafts) | quote }} }
            - { name: ORCHARD_GRAFT_TRUST, value: {{ .Values.graftSettings.trust | default "listed" | quote }} }
            {{- with .Values.graftSettings.keys }}
            - { name: ORCHARD_GRAFT_KEYS, value: {{ join "," . | quote }} }
            {{- end }}
            {{- with .Values.graftSettings.taps }}
            - { name: ORCHARD_GRAFT_TAPS, value: {{ toJson . | quote }} }
            {{- end }}
            {{- with .Values.graftSettings.marketplaceUrl }}
            - { name: ORCHARD_GRAFT_MARKETPLACE_URL, value: {{ . | quote }} }
            {{- end }}
            {{- with .Values.graftSettings.registrySignature }}
            - { name: ORCHARD_REGISTRY_SIGNATURE, value: {{ . | quote }} }
            {{- end }}
            {{- if .Values.graftSettings.strict }}
            - { name: ORCHARD_GRAFTS_STRICT, value: "true" }
            {{- end }}
            {{- if .Values.graftSettings.safeMode }}
            - { name: ORCHARD_GRAFTS_SAFE_MODE, value: "true" }
            {{- end }}
            {{- with .Values.graftSettings.pools }}
            - { name: ORCHARD_GRAFT_POOLS, value: {{ toJson . | quote }} }
            {{- end }}
            - { name: ORCHARD_DB_SERVER_PODS, value: {{ ternary .Values.server.autoscaling.maxReplicas .Values.server.replicas .Values.server.autoscaling.enabled | toString | quote }} }
            {{- if .Values.server.workers.enabled }}
            - { name: ORCHARD_DB_WORKER_PODS, value: {{ ternary .Values.server.workers.autoscaling.maxReplicas .Values.server.workers.replicas .Values.server.workers.autoscaling.enabled | toString | quote }} }
            {{- end }}
{{- end }}

{{- define "orchard.graftAnnotations" }}
      annotations:
        orchard.my/grafts: {{ toJson (list (default (list) .Values.grafts) .Values.graftSettings) | sha256sum | quote }}
{{- end }}

{{- define "orchard.graftInit" }}
      initContainers:
        - name: graft-sync
          image: {{ include "orchard.image" (list . .Values.server.image.name .Values.server.image.tag) }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          workingDir: /app/apps/server
          command: ["node", "dist/scripts/graft-sync.js"]
          env:{{ include "orchard.graftEnv" . }}
            {{- if .Values.postgres.enabled }}
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.postgres.name }}-app
                  key: uri
            {{- else if (include "orchard.serverEnvHas" (dict "root" . "key" "DATABASE_URL")) }}
            {{- range .Values.server.env }}
            {{- if eq .name "DATABASE_URL" }}
            - {{ toJson . }}
            {{- end }}
            {{- end }}
            {{- end }}
          volumeMounts:
            - { name: grafts, mountPath: /app/grafts }
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { memory: 512Mi }
{{- end }}

{{- define "orchard.graftMount" }}
          volumeMounts:
            - { name: grafts, mountPath: /app/grafts, readOnly: true }
{{- end }}

{{- define "orchard.graftVolume" }}
      volumes:
        - name: grafts
          emptyDir: { sizeLimit: 2Gi }
{{- end }}

{{- define "orchard.trivyToken" -}}
{{- if .Values.trivy.token -}}
{{- .Values.trivy.token -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Values.namespace "trivy-server-token") -}}
{{- if and $existing $existing.data (index $existing.data "token") -}}
{{- index $existing.data "token" | b64dec -}}
{{- else -}}
{{- if not (index .Values.trivy "generatedToken") -}}
{{- $_ := set .Values.trivy "generatedToken" (randAlphaNum 48) -}}
{{- end -}}
{{- index .Values.trivy "generatedToken" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "orchard.r2ProxyActive" -}}
{{- if and .Values.r2Proxy.enabled (or .Values.r2Proxy.upstream.endpoint .Values.objectStorage.local.enabled .Values.postgres.enabled .Values.r2Proxy.databaseUrl) -}}
true
{{- end -}}
{{- end -}}

{{- define "orchard.localBackups" -}}
{{- if and .Values.objectStorage.local.enabled .Values.objectStorage.local.backups (not .Values.r2Proxy.upstream.endpoint) (not .Values.server.envFrom) (not (include "orchard.serverEnvHas" (dict "root" . "key" "R2_ACCOUNT_ID"))) -}}
true
{{- end -}}
{{- end -}}

{{- define "orchard.objectStorageEndpoint" -}}
{{- printf "http://object-storage.%s.svc.cluster.local:9000" .Values.objectStorage.local.namespace -}}
{{- end -}}

{{- define "orchard.objectStorageKey" -}}
{{- $root := .root -}}
{{- $field := .field -}}
{{- $local := $root.Values.objectStorage.local -}}
{{- if index $local $field -}}
{{- index $local $field -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" $root.Values.namespace "orchard-object-storage") -}}
{{- if and $existing $existing.data (index $existing.data $field) -}}
{{- index $existing.data $field | b64dec -}}
{{- else -}}
{{- $generated := printf "generated%s" (title $field) -}}
{{- if not (index $local $generated) -}}
{{- $length := ternary 20 40 (eq $field "accessKey") -}}
{{- $_ := set $local $generated (ternary (randAlphaNum $length | upper) (randAlphaNum $length) (eq $field "accessKey")) -}}
{{- end -}}
{{- index $local $generated -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "orchard.storageClass" -}}
{{- if .value -}}
{{- .value -}}
{{- else -}}
{{- $live := lookup .apiVersion .kind .namespace .name -}}
{{- if $live -}}
{{- if eq .kind "StatefulSet" -}}
{{- with (dig "spec" "volumeClaimTemplates" list $live) -}}
{{- dig "spec" "storageClassName" "" (first .) -}}
{{- end -}}
{{- else if eq .kind "Cluster" -}}
{{- dig "spec" "storage" "storageClass" "" $live -}}
{{- else -}}
{{- dig "spec" "storageClassName" "" $live -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "orchard.metricsIngressSelector" -}}
{{- $parts := list -}}
{{- range $k, $v := . -}}
{{- $parts = append $parts (printf "%s=%s" $k $v) -}}
{{- end -}}
{{- join "," $parts -}}
{{- end -}}

{{/*
IPv4 addresses a pod must not reach through the "public internet" egress rule:
every node address, the apiserver endpoints, node pod CIDRs and
tenant.extraDenyCidrs. Private ranges are already excepted, so only public
addresses are kept. lookup returns nothing under `helm template`, so a render
without a cluster yields an empty list. The server computes the same list for
the policies it owns and keeps them current when nodes change; this snapshot is
refreshed on every helm upgrade.
*/}}
{{- define "orchard.clusterExcepts" -}}
{{- $found := list -}}
{{- $nodes := lookup "v1" "Node" "" "" -}}
{{- if $nodes -}}
{{- range ($nodes.items | default list) -}}
{{- range (.status.addresses | default list) -}}
{{- if or (eq .type "InternalIP") (eq .type "ExternalIP") -}}{{- $found = append $found .address -}}{{- end -}}
{{- end -}}
{{- range (.spec.podCIDRs | default list) -}}{{- $found = append $found . -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- $eps := lookup "v1" "Endpoints" "default" "kubernetes" -}}
{{- if $eps -}}
{{- range ($eps.subsets | default list) -}}
{{- range (.addresses | default list) -}}{{- $found = append $found .ip -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- range (splitList "," (.Values.tenant.extraDenyCidrs | default "")) -}}
{{- with (trim .) -}}{{- $found = append $found . -}}{{- end -}}
{{- end -}}
{{- $out := list -}}
{{- range (uniq $found) -}}
{{- if and (regexMatch "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+(/[0-9]+)?$" .) (not (regexMatch "/([0-7])$" .)) (not (regexMatch "^(10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.)" .)) -}}
{{- $out = append $out (ternary . (printf "%s/32" .) (contains "/" .)) -}}
{{- end -}}
{{- end -}}
{{- toJson (uniq (sortAlpha $out)) -}}
{{- end -}}

{{/* The except list of an "internet minus the cluster" ipBlock, as YAML list items. */}}
{{- define "orchard.egressExceptList" -}}
{{- range (concat (list "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "169.254.0.0/16" "100.64.0.0/10") (include "orchard.clusterExcepts" . | fromJsonArray)) }}
- {{ . }}
{{- end }}
{{- end -}}

{{/*
Whether to render CiliumNetworkPolicies. cilium.enabled is the explicit switch;
otherwise the CRD being installed at render time is enough.
*/}}
{{- define "orchard.ciliumPolicies" -}}
{{- if or .Values.cilium.enabled (.Capabilities.APIVersions.Has "cilium.io/v2/CiliumNetworkPolicy") -}}true{{- end -}}
{{- end -}}

{{- define "orchard.redisPassword" -}}
{{- if .Values.redis.auth.password -}}
{{- .Values.redis.auth.password -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Values.namespace "redis-auth") -}}
{{- if and $existing $existing.data $existing.data.password -}}
{{- $existing.data.password | b64dec -}}
{{- else -}}
{{- if not (index .Values.redis "generatedPassword") -}}
{{- $_ := set .Values.redis "generatedPassword" (randAlphaNum 40) -}}
{{- end -}}
{{- index .Values.redis "generatedPassword" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Namespaces whose pods are not trusted with the control plane: the builders,
sandbox, fc-builder and image-scan namespaces, plus tenant.untrustedNamespaces.
Managed tenant namespaces are matched by label instead.
*/}}
{{- define "orchard.untrustedNamespaces" -}}
{{- $names := list .Values.builders.namespace .Values.sandbox.namespace .Values.fcBuilder.namespace .Values.trivy.namespace -}}
{{- $names = concat $names (.Values.networkPolicy.platform.untrustedNamespaces | default list) -}}
{{- toJson (uniq (compact $names)) -}}
{{- end -}}

{{/* namespaceSelector expressions that select every namespace except the untrusted ones. */}}
{{- define "orchard.trustedNamespaceExpressions" -}}
- { key: orchard.my/managed, operator: DoesNotExist }
- { key: orchard.dev/managed, operator: DoesNotExist }
- { key: kubernetes.io/metadata.name, operator: NotIn, values: {{ include "orchard.untrustedNamespaces" . }} }
{{- end -}}

{{- define "orchard.mapApiVersion" -}}
{{- if .Capabilities.APIVersions.Has "admissionregistration.k8s.io/v1/MutatingAdmissionPolicy" -}}
v1
{{- else if .Capabilities.APIVersions.Has "admissionregistration.k8s.io/v1beta1/MutatingAdmissionPolicy" -}}
v1beta1
{{- else -}}
v1
{{- end -}}
{{- end }}

{{/* Redis maxmemory in MiB: redis.maxmemory when set, else redis.maxmemoryPercent of the container memory limit (default 50, headroom for AOF rewrite and client buffers). */}}
{{- define "orchard.redisMaxmemory" -}}
{{- if .Values.redis.maxmemory -}}
{{- .Values.redis.maxmemory -}}
{{- else -}}
{{- $limit := toString (dig "limits" "memory" "512Mi" (.Values.redis.resources | default dict)) -}}
{{- $pct := int (.Values.redis.maxmemoryPercent | default 50) -}}
{{- $num := int64 (regexFind "^[0-9]+" $limit) -}}
{{- $mib := 384 -}}
{{- if hasSuffix "Gi" $limit -}}{{- $mib = div (mul $num 1024 $pct) 100 -}}
{{- else if hasSuffix "Mi" $limit -}}{{- $mib = div (mul $num $pct) 100 -}}
{{- end -}}
{{- printf "%dmb" (int $mib) -}}
{{- end -}}
{{- end }}

{{- define "orchard.priorityClass" -}}
{{- if .Values.priorityClasses.enabled }}
priorityClassName: orchard-platform
{{- end }}
{{- end }}
