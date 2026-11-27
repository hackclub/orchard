import type { McpScope } from './client';

export const TOOLSETS = [
  'core',
  'deployments',
  'databases',
  'logs',
  'env',
  'domains',
  'jobs',
  'notifications',
  'templates',
  'dangerous'
] as const;

export type Toolset = (typeof TOOLSETS)[number];

export const DEFAULT_TOOLSETS: Toolset[] = [...TOOLSETS];

export const SENSITIVE_META_KEY = 'orchard/sensitive';

export const SCOPE_META_KEY = 'orchard/scope';

type Kind = 'read' | 'create' | 'update' | 'action' | 'destructive' | 'dangerous';

export interface ToolSpec {
  toolset: Toolset;
  kind: Kind;
  openWorld?: boolean;
  sensitive?: boolean;
  scope?: McpScope;
}

export interface ToolAnnotationSet {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const KIND_ANNOTATIONS: Record<Kind, Omit<ToolAnnotationSet, 'openWorldHint'>> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  action: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  dangerous: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
};

const t = (toolset: Toolset, kind: Kind, extra: Partial<ToolSpec> = {}): ToolSpec => ({
  toolset,
  kind,
  ...extra
});

export const TOOL_CATALOG: Record<string, ToolSpec> = {
  get_current_user: t('core', 'read'),
  list_organizations: t('core', 'read'),
  find: t('core', 'read'),
  get_resource_quota: t('core', 'read'),
  get_audit_log: t('core', 'read'),
  list_node_pools: t('core', 'read'),
  list_projects: t('core', 'read'),
  get_project: t('core', 'read'),
  create_project: t('core', 'create'),
  update_project: t('core', 'update'),
  list_deployments: t('core', 'read'),
  get_deployment: t('core', 'read'),
  get_deployment_next_steps: t('core', 'read'),
  list_environments: t('core', 'read'),
  get_github_status: t('core', 'read', { openWorld: true }),
  diagnose_database: t('core', 'read'),

  create_deployment: t('deployments', 'create'),
  list_github_deploy_targets: t('deployments', 'read', { openWorld: true }),
  deploy_from_github: t('deployments', 'create', { openWorld: true }),
  deploy_from_github_url: t('deployments', 'create', { openWorld: true }),
  update_deployment_resources: t('deployments', 'update'),
  restart_deployment: t('deployments', 'action'),
  rebuild_deployment: t('deployments', 'action', { openWorld: true }),
  scale_deployment: t('deployments', 'update'),
  stop_deployment: t('deployments', 'destructive'),
  start_deployment: t('deployments', 'update'),
  rename_deployment: t('deployments', 'update'),
  update_deployment_github_repo: t('deployments', 'update', { openWorld: true }),
  retry_deployment_apply: t('deployments', 'action'),
  update_deployment_placement: t('deployments', 'update'),
  update_deployment_disruption_budget: t('deployments', 'update'),
  rollback_deployment: t('deployments', 'action'),
  rollback_to_previous: t('deployments', 'action'),
  cancel_build: t('deployments', 'destructive'),
  list_deploy_webhook_tokens: t('deployments', 'read'),
  create_deploy_webhook_token: t('deployments', 'create', { sensitive: true }),
  enable_auto_deploy: t('deployments', 'update', { openWorld: true }),
  get_auto_deploy_status: t('deployments', 'read', { openWorld: true }),
  disable_auto_deploy: t('deployments', 'update'),
  get_image_history: t('deployments', 'read'),
  get_deployment_rollout: t('deployments', 'read'),
  diagnose_deployment: t('core', 'read'),
  get_changes: t('deployments', 'read'),
  get_deploy_verdict: t('deployments', 'read'),
  get_resource_recommendation: t('deployments', 'read'),
  get_attack_signals: t('deployments', 'read'),
  get_pod_health: t('deployments', 'read'),
  get_volumes: t('deployments', 'read'),
  get_build_history: t('deployments', 'read'),
  get_timeline: t('deployments', 'read'),
  get_anomalies: t('deployments', 'read'),
  get_alert_states: t('deployments', 'read'),
  get_observability_link: t('core', 'read'),
  list_build_runs: t('deployments', 'read'),
  list_releases: t('deployments', 'read'),
  update_deployment_health_check: t('deployments', 'update'),
  update_deployment_volumes: t('deployments', 'destructive'),
  get_deployment_volumes: t('deployments', 'read'),
  update_deployment_image: t('deployments', 'update'),
  update_deployment_strategy: t('deployments', 'update'),
  update_deployment_pull_policy: t('deployments', 'update'),
  update_deployment_devices: t('deployments', 'update'),
  update_deployment_build_config: t('deployments', 'update'),
  list_registry_credentials: t('deployments', 'read'),
  set_registry_credential: t('deployments', 'update', { openWorld: true }),
  list_github_repos: t('deployments', 'read', { openWorld: true }),
  get_repo_branches: t('deployments', 'read', { openWorld: true }),
  get_repo_dockerfiles: t('deployments', 'read', { openWorld: true }),
  detect_repo_config: t('deployments', 'read', { openWorld: true }),
  get_repo_contents: t('deployments', 'read', { openWorld: true }),
  list_compose_stacks: t('deployments', 'read'),
  get_compose_stack: t('deployments', 'read'),
  redeploy_compose_stack: t('deployments', 'action', { openWorld: true }),

  get_deployment_logs: t('logs', 'read'),
  search_logs: t('logs', 'read'),
  get_log_context: t('logs', 'read'),
  get_request_stats: t('logs', 'read'),
  get_deployment_http_metrics: t('logs', 'read'),
  get_build_logs: t('logs', 'read'),
  list_pods: t('logs', 'read'),
  get_pod_logs: t('logs', 'read'),
  list_killed_containers: t('logs', 'read'),
  get_killed_container_logs: t('logs', 'read'),
  list_deployment_errors: t('logs', 'read'),
  triage_deployment_error: t('logs', 'update'),
  get_pod_details: t('logs', 'read'),
  exec_in_pod: t('logs', 'dangerous', { sensitive: true, scope: 'exec' }),
  get_deployment_metrics: t('logs', 'read'),
  analyze_deployment_resources: t('logs', 'read'),

  get_env_vars: t('env', 'read'),
  set_env_vars: t('env', 'destructive'),
  add_env_vars: t('env', 'update'),
  delete_env_vars: t('env', 'destructive'),
  create_environment: t('env', 'create'),
  rename_environment: t('env', 'update'),
  set_default_environment: t('env', 'update'),
  get_shared_env_vars: t('env', 'read'),
  add_shared_env_vars: t('env', 'update'),
  set_shared_env_vars: t('env', 'destructive'),
  delete_shared_env_vars: t('env', 'destructive'),

  list_databases: t('databases', 'read'),
  get_database: t('databases', 'read'),
  get_database_connection: t('databases', 'read', { sensitive: true, scope: 'deploy' }),
  get_database_metrics: t('databases', 'read'),
  create_database: t('databases', 'create'),
  list_database_backups: t('databases', 'read'),
  create_database_backup: t('databases', 'create', { openWorld: true }),
  enable_database_public: t('databases', 'update'),
  disable_database_public: t('databases', 'update'),
  update_database_resources: t('databases', 'update'),
  get_database_limits: t('databases', 'read'),
  scale_database: t('databases', 'update'),
  stop_database: t('databases', 'destructive'),
  start_database: t('databases', 'update'),
  restart_database: t('databases', 'action'),
  rename_database: t('databases', 'update'),
  get_database_query_stats: t('databases', 'read'),
  reset_database_query_stats: t('databases', 'destructive'),
  expand_database_storage: t('databases', 'update'),
  list_database_extensions: t('databases', 'read'),
  install_database_extension: t('databases', 'update'),
  uninstall_database_extension: t('databases', 'destructive'),
  get_database_settings: t('databases', 'read'),
  update_database_settings: t('databases', 'destructive'),
  get_database_backup_schedule: t('databases', 'read'),
  set_database_backup_schedule: t('databases', 'update'),
  clear_database_backup_schedule: t('databases', 'destructive'),
  get_database_activity: t('databases', 'read', { scope: 'deploy' }),
  get_database_recovery_window: t('databases', 'read'),
  fork_database: t('databases', 'create'),
  create_checkpoint: t('databases', 'create'),
  list_checkpoints: t('databases', 'read'),
  get_database_operation: t('databases', 'read'),
  list_database_operations: t('databases', 'read'),
  cancel_database_operation: t('databases', 'destructive'),
  test_database_backup: t('databases', 'action'),
  list_database_restore_tests: t('databases', 'read'),
  set_database_protection: t('databases', 'update'),
  get_database_pooler: t('databases', 'read'),
  set_database_pooler: t('databases', 'update'),
  list_deleted_databases: t('databases', 'read'),
  undelete_database: t('databases', 'create'),
  get_database_replication: t('databases', 'read'),
  set_database_replication: t('databases', 'update'),
  list_database_users: t('databases', 'read'),
  create_database_user: t('databases', 'create', { sensitive: true, scope: 'deploy' }),
  delete_database_user: t('databases', 'destructive'),
  list_postgres_versions: t('databases', 'read'),
  get_database_security: t('databases', 'read'),
  get_project_database_security: t('databases', 'read'),
  update_database_minor: t('databases', 'update'),

  list_ingresses: t('domains', 'read'),
  get_ingress: t('domains', 'read'),
  validate_dns: t('domains', 'read', { openWorld: true, scope: 'deploy' }),
  list_services: t('domains', 'read'),
  create_ingress: t('domains', 'create'),
  update_ingress: t('domains', 'update'),
  update_service: t('domains', 'destructive'),
  set_service_exposure: t('domains', 'update'),
  set_service_port_public: t('domains', 'update'),
  get_ingress_protection: t('domains', 'read', { sensitive: true, scope: 'deploy' }),
  set_ingress_protection: t('domains', 'update'),
  create_service: t('domains', 'create'),

  list_jobs: t('jobs', 'read'),
  get_job: t('jobs', 'read'),
  create_job: t('jobs', 'create'),
  update_job: t('jobs', 'update'),
  replace_job_steps: t('jobs', 'destructive'),
  run_job: t('jobs', 'action'),
  list_job_runs: t('jobs', 'read'),
  get_job_run: t('jobs', 'read'),
  get_job_run_logs: t('jobs', 'read'),
  cancel_job_run: t('jobs', 'destructive'),

  list_notification_channels: t('notifications', 'read'),
  create_notification_channel: t('notifications', 'create', { sensitive: true }),
  update_notification_channel: t('notifications', 'update'),
  list_notification_rules: t('notifications', 'read'),
  create_notification_rule: t('notifications', 'create'),
  update_notification_rule: t('notifications', 'update'),
  test_notification_channel: t('notifications', 'action', { openWorld: true }),
  replay_notification_channel: t('notifications', 'action', { openWorld: true }),
  list_notification_deliveries: t('notifications', 'read'),

  list_templates: t('templates', 'read'),
  get_template: t('templates', 'read'),
  list_template_instances: t('templates', 'read'),
  get_template_instance: t('templates', 'read'),
  get_template_yaml_guide: t('templates', 'read'),
  deploy_template: t('templates', 'create'),

  delete_project: t('dangerous', 'destructive'),
  delete_deployment: t('dangerous', 'destructive'),
  delete_environment: t('dangerous', 'destructive'),
  delete_database: t('dangerous', 'destructive'),
  restore_database: t('dangerous', 'dangerous'),
  restore_checkpoint: t('dangerous', 'dangerous'),
  undo_database_restore: t('dangerous', 'dangerous'),
  disable_database_deletion_protection: t('dangerous', 'destructive'),
  upgrade_database: t('dangerous', 'destructive'),
  delete_ingress: t('dangerous', 'destructive'),
  delete_service: t('dangerous', 'destructive'),
  delete_template_instance: t('dangerous', 'destructive'),
  delete_deploy_webhook_token: t('dangerous', 'destructive'),
  delete_notification_channel: t('dangerous', 'destructive'),
  delete_notification_rule: t('dangerous', 'destructive'),
  delete_job: t('dangerous', 'destructive'),
  delete_registry_credential: t('dangerous', 'destructive')
};

export function annotationsFor(spec: ToolSpec): ToolAnnotationSet {
  return { ...KIND_ANNOTATIONS[spec.kind], openWorldHint: spec.openWorld === true };
}

export function requiredScope(spec: ToolSpec): McpScope {
  if (spec.scope) return spec.scope;
  return spec.kind === 'read' ? 'read' : 'deploy';
}

const SCOPE_RANK: Record<McpScope, number> = { read: 0, deploy: 1, exec: 2 };

export function scopeAllows(granted: McpScope, required: McpScope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}

function isScope(value: unknown): value is McpScope {
  return value === 'read' || value === 'deploy' || value === 'exec';
}

export function graftToolScope(config: unknown): McpScope {
  const record = (config ?? {}) as {
    _meta?: Record<string, unknown>;
    annotations?: { readOnlyHint?: unknown };
  };
  const declared = record._meta?.[SCOPE_META_KEY];
  if (declared !== undefined) return isScope(declared) ? declared : 'exec';
  return record.annotations?.readOnlyHint === true ? 'read' : 'deploy';
}

export function titleFor(name: string): string {
  const words = name.split('_');
  const acronyms: Record<string, string> = {
    dns: 'DNS',
    url: 'URL',
    github: 'GitHub',
    yaml: 'YAML',
    http: 'HTTP',
    env: 'env'
  };
  return words
    .map((word, index) => {
      const mapped = acronyms[word] ?? word;
      return index === 0 ? mapped.charAt(0).toUpperCase() + mapped.slice(1) : mapped;
    })
    .join(' ');
}

export interface ToolsetSelection {
  toolsets: Set<Toolset>;
  grafts: Set<string>;
  allGrafts: boolean;
}

export function parseToolsets(raw?: string | null): ToolsetSelection {
  const tokens = (raw ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0 || tokens.includes('all') || tokens.includes('default')) {
    return { toolsets: new Set(TOOLSETS), grafts: new Set(), allGrafts: true };
  }
  const toolsets = new Set<Toolset>();
  const grafts = new Set<string>();
  for (const token of tokens) {
    if ((TOOLSETS as readonly string[]).includes(token)) toolsets.add(token as Toolset);
    else grafts.add(token);
  }
  toolsets.add('core');
  return { toolsets, grafts, allGrafts: false };
}

export interface CatalogOptions {
  selection: ToolsetSelection;
  scope: McpScope;
}

type RegisterTool = (name: string, config: any, cb: any) => unknown;

export function withSensitiveMeta<T extends object>(result: T): T {
  if (!result || typeof result !== 'object') return result;
  const meta = (result as { _meta?: Record<string, unknown> })._meta ?? {};
  return { ...result, _meta: { ...meta, [SENSITIVE_META_KEY]: true } };
}

export function decorateToolConfig(name: string, config: any, spec: ToolSpec) {
  const description: string | undefined = config.description;
  return {
    ...config,
    title: config.title ?? titleFor(name),
    description:
      spec.sensitive && description && !description.endsWith('[sensitive]')
        ? `${description} [sensitive]`
        : description,
    annotations: annotationsFor(spec),
    ...(spec.sensitive ? { _meta: { ...(config._meta ?? {}), [SENSITIVE_META_KEY]: true } } : {})
  };
}

export function catalogServer<S extends object>(server: S, options: CatalogOptions): S {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'registerTool' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const register = value as RegisterTool;
      return (name: string, config: any, cb: any) => {
        const spec = TOOL_CATALOG[name];
        if (!spec) throw new Error(`MCP tool "${name}" has no entry in TOOL_CATALOG`);
        if (!options.selection.toolsets.has(spec.toolset)) return undefined;
        if (!scopeAllows(options.scope, requiredScope(spec))) return undefined;
        const handler = spec.sensitive
          ? async (...args: unknown[]) => withSensitiveMeta(await cb(...args))
          : cb;
        return register.call(target, name, decorateToolConfig(name, config, spec), handler);
      };
    }
  });
}
