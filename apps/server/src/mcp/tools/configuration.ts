import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { OrchardClient, path } from '../client';
import { json } from './reply';

interface EnvVarInput {
  key: string;
  value: string | null;
  secret?: boolean;
}

export function registerConfigurationTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'set_env_vars',
    {
      description: `Replace the ENTIRE environment of a deployment with the list you pass. Anything you leave out is deleted. Restarts the deployment.

**This is almost never the tool you want.** Reach for it only when you are deliberately declaring the whole environment, e.g. seeding a brand new deployment.
- Changing or adding a few vars → \`add_env_vars\` (merges, leaves everything else alone).
- Removing a few vars → \`delete_env_vars\`.
- Seeing what is there now → \`get_env_vars\`.

Secrets read back with a null value, so you cannot round-trip them through this tool by hand: pass \`value: null\` with \`secret: true\` to keep the stored value, or omit the key entirely to delete the secret.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        envVars: z
          .array(
            z.object({
              key: z.string().describe('Environment variable name'),
              value: z
                .string()
                .nullable()
                .describe(
                  'Environment variable value. Null keeps whatever is already stored under this key. This is the only way to carry an existing secret through a full replace.'
                ),
              secret: z
                .boolean()
                .optional()
                .describe(
                  'Store in the deployment Kubernetes Secret. Write-only: reads never return it'
                )
            })
          )
          .max(1000)
          .describe('The complete environment. Omitted keys are deleted.')
      }
    },
    async ({ deploymentId, envVars }) => {
      const result = await client.put(path`/deployments/${deploymentId}/env`, { env: envVars });
      return json(result);
    }
  );

  server.registerTool(
    'add_env_vars',
    {
      description: `**The default way to change environment variables.** Adds or overwrites the keys you pass and leaves every other var on the deployment untouched. The deployment restarts to pick them up.

Fixing one typo'd value, adding a new key, flipping a var to secret: all of them are this tool. You do not need to read the current env first; the merge happens here.

Related: \`delete_env_vars\` to remove keys, \`get_env_vars\` to read, \`set_env_vars\` only when you mean to replace the whole environment.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        envVars: z
          .array(
            z.object({
              key: z.string().describe('Environment variable name'),
              value: z
                .string()
                .nullable()
                .describe(
                  'Environment variable value. Null keeps the stored value. Use it to flip an existing secret without knowing it.'
                ),
              secret: z
                .boolean()
                .optional()
                .describe(
                  'Store in the deployment Kubernetes Secret. Write-only: reads never return it'
                )
            })
          )
          .max(1000)
          .describe('Array of environment variable key-value pairs to add or update')
      }
    },
    async ({ deploymentId, envVars }) => {
      const deployment = await client.get(path`/deployments/${deploymentId}`);
      // A secret reads back with no value and its flag intact. Carrying both
      // over is what keeps this a merge: a null value tells the server to keep
      // what is stored, and dropping the flag would ask it to republish a
      // secret in the clear, which it refuses.
      const existing: EnvVarInput[] = (deployment.envVars || []).map((v: EnvVarInput) => ({
        key: v.key,
        value: v.value ?? null,
        secret: v.secret
      }));

      const newKeys = new Set(envVars.map((v) => v.key));
      const merged = [...existing.filter((v) => !newKeys.has(v.key)), ...envVars];

      const result = await client.put(path`/deployments/${deploymentId}/env`, { env: merged });
      return json(result);
    }
  );

  server.registerTool(
    'update_deployment_health_check',
    {
      description: `Configure the health probes Kubernetes runs against a deployment.

Every field is optional and merges into what is already stored, so turning a check on is one field. You do not have to restate the timings. Read the current values off \`get_deployment\` (the \`healthCheck*\`, \`livenessEnabled\`, \`readinessEnabled\`, \`startupEnabled\` fields).

The three probes do different jobs:
- **readiness** keeps an unhealthy pod out of the load balancer without killing it. Turn this on first; it is what makes a rolling deploy zero-downtime.
- **liveness** restarts a pod that fails. Powerful and dangerous: a liveness probe that is stricter than the app's real startup time turns a slow boot into a crash loop.
- **startup** suspends liveness until the app has come up, which is how you give a slow starter room without loosening liveness forever. \`startupFailureThreshold × healthCheckInterval\` is the grace period.

If the image's Dockerfile declares its own HEALTHCHECK, that wins unless you set \`healthCheckOverride: true\`.

Applies immediately and rolls the pods.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        healthCheckEnabled: z.boolean().optional().describe('Master switch for probes'),
        healthCheckType: z
          .enum(['http', 'tcp', 'exec'])
          .optional()
          .describe('http hits a path, tcp opens the port, exec runs a command in the container'),
        healthCheckPath: z
          .string()
          .nullable()
          .optional()
          .describe('HTTP path to probe, e.g. /health (http type only)'),
        healthCheckPort: z
          .number()
          .int()
          .nullable()
          .optional()
          .describe("Container port to probe. Defaults to the deployment's port."),
        healthCheckCommand: z
          .string()
          .nullable()
          .optional()
          .describe('Command to run inside the container (exec type only)'),
        livenessEnabled: z.boolean().optional().describe('Restart the pod when the probe fails'),
        readinessEnabled: z
          .boolean()
          .optional()
          .describe('Pull the pod out of the load balancer when the probe fails'),
        startupEnabled: z
          .boolean()
          .optional()
          .describe('Hold liveness off until the app has started once'),
        healthCheckInterval: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Seconds between probes (default 30)'),
        healthCheckTimeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Seconds to wait for a response (default 5)'),
        healthCheckRetries: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Consecutive failures before the probe is considered failed (default 3)'),
        startupFailureThreshold: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Startup probe attempts before giving up (default 30)'),
        healthCheckOverride: z
          .boolean()
          .optional()
          .describe("Use this config instead of the image's own Dockerfile HEALTHCHECK")
      }
    },
    async ({ deploymentId, ...patch }) => {
      // The API is a full replace across thirteen fields. Reading the current
      // record and merging here is what lets a caller flip one switch without
      // silently resetting the other twelve to defaults.
      const current = await client.get(path`/deployments/${deploymentId}`);
      const pick = <T>(next: T | undefined, stored: T, fallback: T): T =>
        next !== undefined ? next : (stored ?? fallback);

      const body = {
        healthCheckEnabled: pick(patch.healthCheckEnabled, current.healthCheckEnabled, false),
        healthCheckType: pick(patch.healthCheckType, current.healthCheckType, 'http'),
        healthCheckPath: pick(patch.healthCheckPath, current.healthCheckPath, null),
        healthCheckPort: pick(patch.healthCheckPort, current.healthCheckPort, null),
        healthCheckCommand: pick(patch.healthCheckCommand, current.healthCheckCommand, null),
        livenessEnabled: pick(patch.livenessEnabled, current.livenessEnabled, true),
        readinessEnabled: pick(patch.readinessEnabled, current.readinessEnabled, true),
        startupEnabled: pick(patch.startupEnabled, current.startupEnabled, false),
        healthCheckInterval: pick(patch.healthCheckInterval, current.healthCheckInterval, 30),
        healthCheckTimeout: pick(patch.healthCheckTimeout, current.healthCheckTimeout, 5),
        healthCheckRetries: pick(patch.healthCheckRetries, current.healthCheckRetries, 3),
        startupFailureThreshold: pick(
          patch.startupFailureThreshold,
          current.startupFailureThreshold,
          30
        ),
        healthCheckOverride: pick(patch.healthCheckOverride, current.healthCheckOverride, false)
      };

      const result = await client.put(path`/deployments/${deploymentId}/health-check`, body);
      return json(result);
    }
  );

  server.registerTool(
    'update_deployment_volumes',
    {
      description: `Update the volumes for a deployment. This replaces all existing volumes with the provided list.
Supported volume types:
- pvc: Persistent Volume Claim - persistent storage that survives pod restarts. Requires pvcName and optional storageSize (default: 1Gi). The PVC is automatically created in Kubernetes with the longhorn storage class.
- hostPath: Mount a file or directory from the host node's filesystem. Requires hostPath.
- emptyDir: Temporary storage that is created when a pod is assigned to a node and deleted when the pod is removed.

To remove all volumes, pass an empty array.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        volumes: z
          .array(
            z.object({
              name: z.string().describe('Volume name (unique within deployment)'),
              type: z.enum(['pvc', 'hostPath', 'emptyDir']).describe('Volume type'),
              mountPath: z.string().describe('Path inside the container to mount the volume'),
              pvcName: z
                .string()
                .optional()
                .describe(
                  'PVC name (required for pvc type). The PVC will be auto-created if it does not exist.'
                ),
              storageSize: z
                .string()
                .optional()
                .describe('Storage size for PVC (e.g. 1Gi, 5Gi, 10Gi). Default: 1Gi'),
              hostPath: z.string().optional().describe('Host path (required for hostPath type)'),
              readOnly: z.boolean().optional().describe('Mount as read-only (default: false)')
            })
          )
          .max(256)
          .describe('List of volumes to attach')
      }
    },
    async ({ deploymentId, volumes }) => {
      const result = await client.put(path`/deployments/${deploymentId}/volumes`, { volumes });
      return json(result);
    }
  );

  server.registerTool(
    'update_deployment_image',
    {
      description: `Change the Docker image of an image-source deployment (one created from an image reference, not built from a GitHub repo). Pods will roll to pull the new image. If the image lives in a private registry, add the registry's credential to the project first with \`set_registry_credential\`; the pull secret is attached automatically whenever the image host matches.
Only valid for non-GitHub deployments. For GitHub deployments use \`rebuild_deployment\` so the image is rebuilt from source. The backend rejects this on a GitHub-built deployment with a clear error.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        image: z
          .string()
          .describe('New Docker image reference (e.g. nginx:1.27, ghcr.io/org/app:v2.1.0)')
      }
    },
    async ({ deploymentId, image }) => {
      const result = await client.patch(path`/deployments/${deploymentId}/image`, { image });
      return json(result);
    }
  );

  server.registerTool(
    'update_deployment_strategy',
    {
      description: `Set the Kubernetes update strategy for a deployment.
- \`rollingUpdate\`: bring up new pods before draining old ones, with zero downtime.
- \`recreate\`: tear down all pods first, then start new ones, with brief downtime. Required for ReadWriteOnce PVCs.
- \`blueGreen\`: the new image runs beside the old one and takes traffic only once every pod is ready; if it never is, nothing moves.

A deployment with a PVC attached only accepts \`recreate\`. Every strategy waits for the new pods to be ready and rolls back if they never are.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        strategy: z
          .enum(['rollingUpdate', 'recreate', 'blueGreen'])
          .describe('The new update strategy')
      }
    },
    async ({ deploymentId, strategy }) => {
      const result = await client.patch(path`/deployments/${deploymentId}/strategy`, { strategy });
      return json(result);
    }
  );

  server.registerTool(
    'update_deployment_pull_policy',
    {
      description: `Override whether Kubernetes re-pulls the container image every time a pod starts.

You usually do not need this. By default the policy is derived from the tag: a tag that can move (\`latest\`, \`main\`, \`stable\`, a floating major like \`17\`, or no tag at all) gets \`Always\`, and a pinned tag or digest gets \`IfNotPresent\`. Change the image and it re-derives.

Set it only to override that:
- \`Always\`: re-pull on every pod start, so push-then-\`restart_deployment\` picks up a new build.
- \`IfNotPresent\`: reuse the layer cached on the node. On a moving tag this means a restart will NOT show a new push.
- \`null\`: clear the override and go back to deriving it from the tag.

An explicit value here survives an image change, which is the point: it is your call, not a guess.

Changing this rolls the pods on its own; no separate restart is needed.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        imagePullPolicy: z
          .enum(['Always', 'IfNotPresent'])
          .nullable()
          .describe('The pull policy to pin, or null to go back to automatic')
      }
    },
    async ({ deploymentId, imagePullPolicy }) => {
      const result = await client.patch(path`/deployments/${deploymentId}/pull-policy`, {
        imagePullPolicy
      });
      return json(result);
    }
  );

  server.registerTool(
    'update_deployment_devices',
    {
      description: `Attach host devices, such as a GPU, to every pod of a deployment.

Devices are extended resources a device plugin advertises on the node, for example \`nvidia.com/gpu\` or \`squat.ai/dri\` for /dev/dri. Only the devices the instance operator offers are accepted; \`GET /instance/features\` lists them under \`devices\` with a per-app \`max\`.

Pass the full set you want. A name left out or set to 0 is detached, and null detaches everything. A device the instance no longer offers can stay at its current count or be detached, but not added or changed. Pods restart to pick up the change and only schedule on a node with a free device, so a pod stuck in Pending with "Insufficient nvidia.com/gpu" means every one is taken.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        devices: z
          .record(z.string(), z.number().int().min(0))
          .nullable()
          .describe('Extended resource name to count, for example {"nvidia.com/gpu": 1}')
      }
    },
    async ({ deploymentId, devices }) => {
      const result = await client.patch(path`/deployments/${deploymentId}/devices`, { devices });
      return json(result);
    }
  );

  server.registerTool(
    'list_registry_credentials',
    {
      description: `List the container registries a project can pull private images from. Passwords and tokens are never returned, only the registry host and username.

A deployment or job whose image comes from one of these registries (ghcr.io/org/app, docker.io/user/app, a bare \`user/app\` for Docker Hub) gets the credential attached automatically. Use this to work out why an image is stuck in ImagePullBackOff: if the registry is not listed, the pull is anonymous.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID')
      }
    },
    async ({ projectId }) => {
      const result = await client.get(path`/projects/${projectId}/registry-credentials`);
      return json(result);
    }
  );

  server.registerTool(
    'set_registry_credential',
    {
      description: `Add or replace the credential a project uses to pull private images from one registry. One credential per registry per project; setting it again overwrites the old one.

The credential is checked against the registry before it is stored, so a wrong token fails here instead of as ImagePullBackOff later. Once saved it is attached to every app and job in the project whose image is hosted on that registry, existing ones included, and those pods roll to pick it up.

What to pass per registry:
- \`ghcr.io\` (GitHub Packages): the GitHub username and a personal access token (classic) with the \`read:packages\` scope. Fine-grained tokens cannot read packages.
- \`docker.io\` (Docker Hub): the Docker Hub username and an access token.
- \`registry.gitlab.com\`: a deploy token (username starts with \`gitlab+deploy-token\`) or a personal access token with \`read_registry\`.
- \`quay.io\`: a robot account name and token.
- anything else that speaks the Docker registry v2 API with basic or bearer auth.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
        registry: z
          .string()
          .describe('Registry host such as ghcr.io, docker.io or registry.gitlab.com'),
        username: z.string().describe('Registry username'),
        password: z.string().describe('Password or access token for that username')
      }
    },
    async ({ projectId, registry, username, password }) => {
      const result = await client.put(path`/projects/${projectId}/registry-credentials`, {
        registry,
        username,
        password
      });
      return json(result);
    }
  );

  server.registerTool(
    'delete_registry_credential',
    {
      description: `Remove a registry credential from a project. Apps and jobs pulling from that registry lose the credential and roll; if their images are private the new pods will fail to pull.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
        credentialId: z.guid().describe('The credential UUID from list_registry_credentials')
      }
    },
    async ({ projectId, credentialId }) => {
      const result = await client.delete(
        path`/projects/${projectId}/registry-credentials/${credentialId}`
      );
      return json(result);
    }
  );

  server.registerTool(
    'update_deployment_build_config',
    {
      description: `Change how an existing deployment is built, without recreating it.

Every field is optional and only what you pass is changed, so you can set one thing without restating the rest. Pass null to clear a value.

- \`dockerfileTarget\`: the stage a multi-stage Dockerfile stops at, as \`docker build --target\`. Null builds the final stage, which is what a single-stage Dockerfile produces anyway. Use this to run several images out of one repo, such as a web stage and a worker stage, instead of maintaining a Dockerfile per process.
- \`startCommand\`: on a \`dockerfile\` build this runs instead of the image's CMD, like a command passed to \`docker run\`, and takes effect on save without a rebuild. On a \`railpack\` build it is baked in by the next build instead.
- \`dockerfilePath\`, \`buildType\`: as at create time. Switching build type clears the settings that only make sense for the other one.
- \`rootDirectory\`, \`installCommand\`, \`buildCommand\`, \`outputDirectory\`: Railpack-only overrides; null hands the decision back to detection.

Everything except \`startCommand\` applies on the next build, so follow up with \`rebuild_deployment\` if you want it live now.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        buildType: z
          .enum(['dockerfile', 'railpack'])
          .optional()
          .describe(
            '"dockerfile" builds the repo Dockerfile; "railpack" detects and builds itself'
          ),
        dockerfilePath: z
          .string()
          .nullable()
          .optional()
          .describe('Path to the Dockerfile relative to the repo root'),
        dockerfileTarget: z
          .string()
          .nullable()
          .optional()
          .describe('Multi-stage build target, or null to build the final stage'),
        startCommand: z
          .string()
          .nullable()
          .optional()
          .describe("Command to run instead of the image's CMD, or null to use the image's own"),
        rootDirectory: z
          .string()
          .nullable()
          .optional()
          .describe('Railpack: app directory in the repo'),
        installCommand: z
          .string()
          .nullable()
          .optional()
          .describe('Railpack: install step override'),
        buildCommand: z.string().nullable().optional().describe('Railpack: build step override'),
        outputDirectory: z
          .string()
          .nullable()
          .optional()
          .describe('Railpack: built static files directory, which makes the app a static site')
      }
    },
    async ({ deploymentId, ...body }) => {
      const result = await client.put(path`/deployments/${deploymentId}/build-config`, body);
      return json(result);
    }
  );

  server.registerTool(
    'create_ingress',
    {
      description: `Create a public ingress (domain route) for a deployment. This makes the deployment accessible via a domain name with automatic TLS.
The user must point their domain's DNS to the cluster before creating the ingress. Use validate_dns to check.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID to route traffic to'),
        host: z.string().describe('The domain name (e.g. myapp.example.com)'),
        path: z.string().optional().describe('URL path prefix (default: /)'),
        servicePort: z.number().optional().describe('The service port to route to (default: 80)')
      }
    },
    async ({ deploymentId, host, path: routePath, servicePort }) => {
      const ingress = await client.post(path`/deployments/${deploymentId}/ingresses`, {
        host,
        path: routePath ?? '/',
        servicePort: servicePort ?? 80
      });
      return json(ingress);
    }
  );

  server.registerTool(
    'update_ingress',
    {
      description: 'Update an existing ingress configuration',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        ingressId: z.guid().describe('The ingress UUID to update'),
        host: z.string().describe('The domain name (e.g. myapp.example.com)'),
        path: z.string().optional().describe('URL path prefix'),
        servicePort: z.number().optional().describe('The service port to route to'),
        redirectTarget: z
          .string()
          .optional()
          .describe('For a redirect domain: the domain it sends visitors to'),
        redirectStatus: z
          .number()
          .optional()
          .describe('For a redirect domain: 301, 302, 307 or 308')
      }
    },
    async ({
      deploymentId,
      ingressId,
      host,
      path: routePath,
      servicePort,
      redirectTarget,
      redirectStatus
    }) => {
      if (redirectTarget !== undefined || redirectStatus !== undefined) {
        const current = (await client.get(path`/ingresses/${ingressId}`)) as { projectId?: string };
        if (!current?.projectId) throw new Error('Ingress has no project');
        const body: Record<string, any> = { host };
        if (redirectTarget !== undefined) body.redirectTarget = redirectTarget;
        if (redirectStatus !== undefined) body.redirectStatus = redirectStatus;
        return json(
          await client.put(path`/projects/${current.projectId}/ingresses/${ingressId}`, body)
        );
      }
      const body: Record<string, any> = { host };
      if (routePath !== undefined) body.path = routePath;
      if (servicePort !== undefined) body.servicePort = servicePort;
      const ingress = await client.put(
        path`/deployments/${deploymentId}/ingresses/${ingressId}`,
        body
      );
      return json(ingress);
    }
  );

  server.registerTool(
    'update_service',
    {
      description: `Change the ports a service exposes, or the internal domain it answers on.

\`ports\` is a full replace of that service's port list. A port you leave out is removed, so restate the ones you want to keep (read them off \`list_services\`). Pass \`domain: null\` to clear the internal domain. At least one of \`ports\` / \`domain\` is required.

To change whether a service is external use \`set_service_exposure\`, not this.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        serviceId: z.guid().describe('The service UUID (from list_services)'),
        ports: z
          .array(
            z.object({
              name: z.string().optional().describe('Port name'),
              containerPort: z.number().describe('Port the container listens on'),
              servicePort: z.number().describe('Port the service exposes'),
              protocol: z.string().optional().describe('TCP or UDP (default TCP)'),
              nodePort: z
                .number()
                .optional()
                .describe('Fixed node port, for an externally exposed service')
            })
          )
          .max(1000)
          .optional()
          .describe('The complete port list for this service. Omitted ports are removed.'),
        domain: z
          .string()
          .nullable()
          .optional()
          .describe('Internal domain for the service, or null to clear it')
      }
    },
    async ({ deploymentId, serviceId, ports, domain }) => {
      const body: Record<string, unknown> = {};
      if (ports !== undefined) body.ports = ports;
      if (domain !== undefined) body.domain = domain;
      const result = await client.put(
        path`/deployments/${deploymentId}/services/${serviceId}`,
        body
      );
      return json(result);
    }
  );

  server.registerTool(
    'set_service_exposure',
    {
      description:
        'Flip a service between internal (ClusterIP, reachable only inside the cluster) and external (a NodePort or LoadBalancer on the service). This changes the Service type only. It does not make a domain public: a domain keeps whatever login is on it, so a protected app still answers with a redirect to sign in. To open a domain to everyone use `set_ingress_protection` with mode `none`; to add a domain use `create_ingress`.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        serviceId: z.guid().describe('The service UUID (from list_services)'),
        exposePublic: z
          .boolean()
          .describe(
            'true for an external Service (NodePort/LoadBalancer), false for cluster-internal. Domain login is separate, see set_ingress_protection'
          )
      }
    },
    async ({ deploymentId, serviceId, exposePublic }) => {
      const result = await client.patch(
        path`/deployments/${deploymentId}/services/${serviceId}/exposure`,
        { exposePublic }
      );
      return json(result);
    }
  );

  server.registerTool(
    'set_service_port_public',
    {
      description:
        'Expose or unexpose a single port on a service, for the case where a service carries several ports and only some should be reachable from outside. To expose the whole service use `set_service_exposure`.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        serviceId: z.guid().describe('The service UUID (from list_services)'),
        portId: z.guid().describe('The port UUID (from list_services)'),
        public: z.boolean().describe('true to expose this port, false to take it private')
      }
    },
    async ({ deploymentId, serviceId, portId, public: isPublic }) => {
      const route = path`/deployments/${deploymentId}/services/${serviceId}/ports/${portId}/public`;
      const result = isPublic ? await client.post(route) : await client.delete(route);
      return json(result);
    }
  );

  server.registerTool(
    'get_ingress_protection',
    {
      description:
        'Read the access protection on a domain: which mode is active, the basic-auth username if any, and the bypass secret that lets automated callers through a protected domain. Requires edit access on the project.',
      inputSchema: {
        projectId: z.guid().describe('The project UUID that owns the ingress'),
        ingressId: z.guid().describe('The ingress UUID')
      }
    },
    async ({ projectId, ingressId }) => {
      const result = await client.get(
        path`/projects/${projectId}/ingresses/${ingressId}/protection`
      );
      return json(result);
    }
  );

  server.registerTool(
    'set_ingress_protection',
    {
      description: `Put a domain behind a login, or take it back off.

Modes:
- \`none\`: public.
- \`password\`: one shared password, no username. Requires \`password\`.
- \`basic\`: HTTP basic auth. Requires \`username\` and \`password\`.
- \`orchard\`: sign in with an Orchard account that has access to the project. No credential to share or leak, so prefer it for internal tools, but the instance can have it disabled, in which case the call fails and says so.

\`bypassPaths\` stay reachable without auth, which is how you keep a webhook endpoint or \`/health\` working behind protection.

Each path on a domain is protected on its own. The reply lists the other paths on this domain that are still public in \`openPaths\`.

Not available on redirect domains. Switching away from \`password\`/\`basic\` discards the stored credential, so re-enabling means setting a new one.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID that owns the ingress'),
        ingressId: z.guid().describe('The ingress UUID'),
        mode: z.enum(['none', 'basic', 'password', 'orchard']).describe('Protection mode to apply'),
        username: z.string().optional().describe('Basic-auth username (required for `basic`)'),
        password: z.string().optional().describe('Password (required for `basic` and `password`)'),
        bypassPaths: z
          .array(z.string())
          .max(1000)
          .optional()
          .describe('Path prefixes that stay public, e.g. ["/api/webhooks", "/health"]')
      }
    },
    async ({ projectId, ingressId, mode, username, password, bypassPaths }) => {
      const result = await client.put(
        path`/projects/${projectId}/ingresses/${ingressId}/protection`,
        {
          mode,
          ...(username !== undefined ? { username } : {}),
          ...(password !== undefined ? { password } : {}),
          ...(bypassPaths !== undefined ? { bypassPaths } : {})
        }
      );
      return json(result);
    }
  );

  server.registerTool(
    'create_service',
    {
      description:
        'Create an internal or external service for a deployment to expose ports. Use `update_service` to change an existing one; creating a second service for the same port will not replace the first.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        name: z.string().describe('Service name'),
        type: z
          .enum(['internal', 'external'])
          .describe('Service type: internal (ClusterIP) or external (NodePort/LoadBalancer)'),
        port: z.number().describe('Service port (the port exposed by the service)'),
        targetPort: z.number().describe('Container port to route to')
      }
    },
    async ({ deploymentId, name, type, port, targetPort }) => {
      const service = await client.post(path`/deployments/${deploymentId}/services`, {
        name,
        exposePublic: type === 'external',
        ports: [
          {
            containerPort: Number(targetPort),
            servicePort: Number(port),
            protocol: 'TCP'
          }
        ]
      });
      return json(service);
    }
  );
}
