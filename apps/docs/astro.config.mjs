import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import rehypeWrapTables from './src/lib/rehype-wrap-tables.mjs';

export default defineConfig({
  site: 'https://docs.orchard.hackclub.com',
  redirects: {
    '/run/sandboxes': '/greenhouse/',
    '/operate/node-pools': '/operate/nodes/',
    '/operate/tenancy-and-isolation': '/operate/security/'
  },
  markdown: { processor: unified({ rehypePlugins: [rehypeWrapTables] }) },
  scopedStyleStrategy: 'where',
  server: { port: 5174, host: true },
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: 'Hack Club Orchard Docs',
      description:
        'Install Orchard on a Linux server or a Kubernetes cluster, then deploy your apps.',
      favicon: '/favicon/favicon.ico',
      customCss: [
        './src/styles/palette.css',
        '../frontend/src/lib/design/tokens.css',
        './src/styles/orchard.css'
      ],
      lastUpdated: true,
      credits: false,
      components: {
        Footer: './src/overrides/Footer.astro',
        Head: './src/overrides/Head.astro',
        Header: './src/overrides/Header.astro',
        MobileMenuFooter: './src/overrides/MobileMenuFooter.astro',
        PageSidebar: './src/overrides/PageSidebar.astro',
        PageTitle: './src/overrides/PageTitle.astro',
        Sidebar: './src/overrides/Sidebar.astro',
        SiteTitle: './src/overrides/SiteTitle.astro',
        ThemeProvider: './src/overrides/ThemeProvider.astro',
        ThemeSelect: './src/overrides/ThemeSelect.astro'
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/hackclub/orchard'
        }
      ],
      editLink: {
        baseUrl: 'https://github.com/hackclub/orchard/edit/main/apps/docs/'
      },
      plugins: [
        starlightOpenAPI([
          {
            base: 'api',
            label: 'API reference',
            schema: './openapi.generated.json',
            sidebar: { collapsed: true }
          }
        ])
      ],
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Overview', link: '/' },
            { label: 'What is Orchard', slug: 'start/what-is-orchard' },
            { label: 'Features', slug: 'start/features' },
            { label: 'Install', slug: 'start/install' },
            { label: 'First deploy', slug: 'start/first-deploy' },
            { label: 'Concepts', slug: 'start/concepts' },
            { label: 'Known limitations', slug: 'start/limitations' },
            { label: 'FAQ', slug: 'start/faq' },
            { label: 'Directory', link: '/directory/' }
          ]
        },
        {
          label: 'Apps',
          items: [
            {
              label: 'Deploy',
              collapsed: true,
              items: [
                { label: 'From GitHub', slug: 'deploy/github' },
                { label: 'From GitLab, Gitea and others', slug: 'deploy/git-providers' },
                { label: 'From an image', slug: 'deploy/image' },
                { label: 'From your terminal', slug: 'deploy/deploy-from-terminal' },
                { label: 'Compose stacks', slug: 'run/compose' },
                { label: 'Templates', slug: 'run/templates' },
                { label: 'Game servers', slug: 'run/game-servers' },
                { label: 'Builds', slug: 'deploy/builds' },
                { label: 'score.yaml', slug: 'deploy/score' }
              ]
            },
            {
              label: 'Configure',
              collapsed: true,
              items: [
                { label: 'Variables and environments', slug: 'run/environments' },
                { label: 'Connect to a database or app', slug: 'deploy/connect-resources' },
                { label: 'Scaling and resources', slug: 'deploy/scaling' },
                { label: 'Resource suggestions', slug: 'deploy/resource-suggestions' },
                { label: 'Volumes', slug: 'deploy/storage' }
              ]
            },
            {
              label: 'Networking',
              collapsed: true,
              items: [
                { label: 'Ports and internal addresses', slug: 'deploy/networking' },
                { label: 'Domains and HTTPS', slug: 'deploy/domains' },
                { label: 'Protect an app', slug: 'deploy/protection' },
                { label: 'Tailscale', slug: 'deploy/tailscale' }
              ]
            },
            {
              label: 'Releases',
              collapsed: true,
              items: [
                { label: 'Update strategies', slug: 'deploy/update-strategies' },
                { label: 'Rollbacks', slug: 'deploy/rollbacks' },
                { label: 'Update with a webhook', slug: 'run/webhooks' }
              ]
            },
            {
              label: 'Jobs',
              collapsed: true,
              items: [{ label: 'Jobs and pipelines', slug: 'run/jobs' }]
            },
            {
              label: 'Monitoring',
              collapsed: true,
              items: [
                { label: 'Monitor an app', slug: 'run/monitor-an-app' },
                { label: 'Logs and shell', slug: 'run/logs' },
                { label: 'Metrics and problems', slug: 'run/observability' },
                { label: 'Alert rules', slug: 'run/alerts' },
                { label: 'Notifications', slug: 'run/notifications' },
                { label: 'Status pages', slug: 'run/status-pages' },
                { label: 'App security', slug: 'deploy/security-tab' }
              ]
            }
          ]
        },
        {
          label: 'Databases',
          items: [
            {
              label: 'Create and connect',
              collapsed: true,
              items: [
                { label: 'Create a database', slug: 'data/databases' },
                { label: 'Database users', slug: 'data/users' },
                { label: 'Connection pooler', slug: 'data/connection-pooler' }
              ]
            },
            {
              label: 'Backups and availability',
              collapsed: true,
              items: [
                { label: 'Backups and restore', slug: 'data/backups' },
                { label: 'Protect a database', slug: 'data/protection' },
                { label: 'High availability', slug: 'data/high-availability' },
                { label: 'Read replicas', slug: 'data/replicas' }
              ]
            },
            {
              label: 'Maintain',
              collapsed: true,
              items: [
                { label: 'Upgrade Postgres', slug: 'data/upgrades' },
                { label: 'Postgres parameters', slug: 'data/parameters' },
                { label: 'Extensions', slug: 'data/extensions' },
                { label: 'Grow storage', slug: 'data/storage' },
                { label: 'Monitor a database', slug: 'data/monitoring' }
              ]
            }
          ]
        },
        {
          label: 'Greenhouse',
          items: [
            {
              label: 'Start',
              collapsed: true,
              items: [
                { label: 'Overview', slug: 'greenhouse' },
                { label: 'Get started', slug: 'greenhouse/getting-started' },
                { label: 'Machines', slug: 'greenhouse/machines' }
              ]
            },
            {
              label: 'Work in a session',
              collapsed: true,
              items: [
                { label: 'The workspace', slug: 'greenhouse/workspace' },
                { label: 'Open in your editor', slug: 'greenhouse/editors' },
                { label: 'Setup and run scripts', slug: 'greenhouse/scripts' },
                { label: 'Previews and ports', slug: 'greenhouse/previews' }
              ]
            },
            {
              label: 'Ship and collaborate',
              collapsed: true,
              items: [
                { label: 'Pull requests and checks', slug: 'greenhouse/pull-requests' },
                { label: 'Attach an Orchard project', slug: 'greenhouse/projects' },
                { label: 'Sharing and multiplayer', slug: 'greenhouse/sharing' },
                { label: 'GitHub, Linear and Slack', slug: 'greenhouse/integrations' },
                { label: 'Automating Greenhouse', slug: 'greenhouse/automation' }
              ]
            },
            {
              label: 'Help',
              collapsed: true,
              items: [{ label: 'Troubleshooting', slug: 'greenhouse/troubleshooting' }]
            }
          ]
        },
        {
          label: 'Grafts',
          items: [
            {
              label: 'Use grafts',
              collapsed: true,
              items: [
                { label: 'Overview', slug: 'grafts/overview' },
                { label: 'Install grafts', slug: 'grafts/install' },
                { label: 'Upgrades and rollback', slug: 'grafts/upgrades' },
                { label: 'Announcements', slug: 'grafts/announcements' },
                { label: 'The Grove', slug: 'run/grove' },
                { label: 'Troubleshooting', slug: 'grafts/troubleshooting' }
              ]
            },
            {
              label: 'Build a graft',
              collapsed: true,
              items: [
                { label: 'Quickstart', slug: 'grafts/build/quickstart' },
                { label: 'graft.json', slug: 'grafts/build/manifest' },
                { label: 'Server code and doors', slug: 'grafts/build/server' },
                { label: 'UI islands and slots', slug: 'grafts/build/ui' },
                { label: 'Database', slug: 'grafts/build/database' },
                { label: 'Publishing', slug: 'grafts/build/publishing' }
              ]
            },
            {
              label: 'Graft reference',
              collapsed: true,
              items: [
                { label: 'Graft API versions', slug: 'reference/graft-api' },
                { label: 'Graft UI slots', slug: 'reference/graft-slots' }
              ]
            }
          ]
        },
        {
          label: 'CLI',
          items: [
            { label: 'Overview', slug: 'cli' },
            { label: 'Command reference', slug: 'reference/cli' },
            { label: 'Terminal dashboard', slug: 'run/terminal-dashboard' },
            { label: 'Terraform and OpenTofu', slug: 'run/terraform' }
          ]
        },
        {
          label: 'Agents and MCP',
          items: [
            { label: 'Agent setup', link: '/agent-setup/' },
            { label: 'MCP', slug: 'mcp' },
            { label: 'MCP tools', slug: 'reference/mcp-tools' },
            { label: 'Code mode', slug: 'agents-code-mode' },
            { label: 'Docs for agents', slug: 'for-agents' }
          ]
        },
        {
          label: 'Account and teams',
          items: [
            {
              label: 'Your account',
              collapsed: true,
              items: [
                { label: 'Profile', slug: 'account/profile' },
                { label: 'Sign-in and sessions', slug: 'account/security' },
                { label: 'API tokens', slug: 'account/tokens' },
                { label: 'SSH identities', slug: 'account/ssh-identities' },
                { label: 'Preferences', slug: 'account/preferences' },
                { label: 'Shortcuts and search', slug: 'account/command-palette' }
              ]
            },
            {
              label: 'Organizations',
              collapsed: true,
              items: [
                { label: 'Organizations and roles', slug: 'teams/organizations' },
                { label: 'Manage a project', slug: 'teams/projects' },
                { label: 'Quotas', slug: 'teams/quotas' },
                { label: 'Usage', slug: 'teams/usage' }
              ]
            },
            {
              label: 'Sign-in and compliance',
              collapsed: true,
              items: [
                { label: 'SSO', slug: 'teams/sso' },
                { label: 'SCIM provisioning', slug: 'teams/scim' },
                { label: 'Audit logs', slug: 'teams/audit-logs' }
              ]
            }
          ]
        },
        {
          label: 'Self-hosting',
          items: [
            {
              label: 'Set up',
              collapsed: true,
              items: [
                { label: 'Finish setup', slug: 'operate/finishing-setup' },
                { label: 'Add S3 storage', slug: 'operate/storage' },
                { label: 'Resource limits', slug: 'operate/resource-limits' },
                { label: 'Small servers', slug: 'operate/small-servers' },
                { label: 'Wildcard certificates', slug: 'operate/wildcard-certificates' },
                { label: 'Going to production', slug: 'operate/production' },
                { label: 'Compatibility', slug: 'operate/compatibility' }
              ]
            },
            {
              label: 'Settings',
              collapsed: true,
              items: [
                { label: 'Where settings live', slug: 'operate/configuration' },
                { label: 'Environment variables', slug: 'reference/configuration' },
                { label: 'Instance admin', slug: 'operate/instance-admin' },
                { label: 'Host commands', slug: 'operate/host-commands' }
              ]
            },
            {
              label: 'People',
              collapsed: true,
              items: [
                { label: 'Manage users', slug: 'operate/manage-users' },
                { label: 'Manage organizations', slug: 'operate/manage-organizations' },
                { label: 'Map groups and bridge LDAP', slug: 'operate/identity-bridge' }
              ]
            },
            {
              label: 'Cluster',
              collapsed: true,
              items: [
                { label: 'Architecture', slug: 'operate/architecture' },
                { label: 'Nodes and pools', slug: 'operate/nodes' },
                { label: 'GPUs and devices', slug: 'operate/devices' },
                { label: 'Upgrades', slug: 'operate/upgrades' },
                { label: 'Free disk space', slug: 'operate/disk-space' },
                { label: 'Scale the control plane', slug: 'operate/scale-control-plane' },
                { label: 'Size older workloads', slug: 'operate/backfill' },
                { label: 'Run Greenhouse', slug: 'operate/greenhouse' },
                { label: 'Run the fast builder', slug: 'operate/fast-builder' }
              ]
            },
            {
              label: 'Security',
              collapsed: true,
              items: [
                { label: 'Security and isolation', slug: 'operate/security' },
                { label: 'Cluster settings to review', slug: 'operate/cluster-settings' },
                { label: 'Bot protection', slug: 'operate/bot-protection' },
                { label: 'Rate limits and client addresses', slug: 'operate/client-addresses' },
                { label: 'Image scanning', slug: 'operate/image-scanning' },
                { label: 'Check isolation', slug: 'operate/doctor' }
              ]
            },
            {
              label: 'Data and logs',
              collapsed: true,
              items: [
                { label: 'Back up and restore', slug: 'operate/backup-and-restore' },
                { label: 'Database dumps', slug: 'operate/database-dumps' },
                { label: 'Logs and request data', slug: 'operate/logs' },
                { label: 'Usage reports', slug: 'operate/telemetry' },
                { label: 'Outbound connections', slug: 'operate/outbound-connections' }
              ]
            },
            {
              label: 'Help',
              collapsed: true,
              items: [
                { label: 'Troubleshooting', slug: 'operate/troubleshooting' },
                { label: 'Licenses', slug: 'operate/licenses' }
              ]
            }
          ]
        },
        ...openAPISidebarGroups
      ]
    }),
    mdx()
  ]
});
