package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The parity gate: every non-superadmin route in the server's auth-coverage
// snapshot must either be driven by a CLI command (routeCoverage) or carry an
// explicit exclusion with a reason (routeExclusions). When the server grows a
// route, this test fails until the CLI grows a command or an exclusion; when
// the server removes or renames a route, the inverse checks flag the stale
// map entry.
const authSnapshotPath = "../../server/test/auth-coverage.snapshot.json"

const graftManifests = "../../../grafts/*/graft.json"

// routeCoverage maps snapshot routes ("METHOD /path", verbatim) to the CLI
// command that drives them.
var routeCoverage = map[string]string{
	"GET /agent-spec.json": "api search / api describe / api <operationId> (cached spec)",

	// auth: tokens + sessions + identity
	"GET /auth/me":                   "auth status",
	"GET /auth/tokens":               "auth token list",
	"POST /auth/tokens":              "auth token create",
	"DELETE /auth/tokens/:id":        "auth token revoke",
	"GET /auth/sessions":             "auth session list",
	"DELETE /auth/sessions/:id":      "auth session revoke",
	"POST /auth/sessions/revoke-all": "auth session revoke-all",

	// user profile
	"PATCH /auth/me":         "user profile update",
	"POST /auth/me/avatar":   "user avatar set",
	"DELETE /auth/me/avatar": "user avatar delete",

	// org
	"GET /organizations/user":                "org list",
	"GET /organizations/:id":                 "org get",
	"GET /organizations/slug/:slug":          "org get (slug resolution)",
	"PATCH /organizations/:id":               "org update",
	"PATCH /organizations/:id/subdomain":     "org update --subdomain",
	"POST /organizations/:id/avatar":         "org avatar set",
	"DELETE /organizations/:id/avatar":       "org avatar delete",
	"GET /organizations/:id/backup-settings": "org backup-settings get",

	// org members + invitations
	"GET /organizations/:id/members":                           "member list",
	"POST /organizations/:id/members":                          "member invite",
	"DELETE /organizations/:id/members/:memberId":              "member remove",
	"POST /organizations/:id/members/:memberId/enable":         "member enable",
	"PATCH /organizations/:id/members/:memberId":               "member set-role",
	"GET /organizations/:id/invitations":                       "member invites list",
	"DELETE /organizations/:id/invitations/:invitationId":      "member invites cancel",
	"POST /organizations/:id/invitations/:invitationId/resend": "member invites resend",

	// my invitations
	"GET /invitations/pending":            "invitation list",
	"POST /invitations/by-id/:id/accept":  "invitation accept",
	"POST /invitations/by-id/:id/decline": "invitation decline",

	// projects
	"GET /projects":                                                  "project list",
	"POST /projects/import":                                          "import",
	"GET /projects/:id":                                              "project get",
	"GET /projects/slug/:slug":                                       "use project (slug resolution)",
	"POST /projects":                                                 "project create",
	"PATCH /projects/:id":                                            "project update",
	"DELETE /projects/:id":                                           "project delete",
	"GET /sync/:namespace":                                           "project sync",
	"POST /projects/:id/icon":                                        "project icon set",
	"POST /projects/:id/background-image":                            "project background set",
	"POST /projects/:id/members":                                     "project member add",
	"DELETE /projects/:id/members/:memberId":                         "project member remove",
	"PATCH /projects/:id/members/:memberId":                          "project member set-role",
	"POST /projects/:id/transfer-request":                            "project transfer request",
	"DELETE /projects/:id/transfer-request":                          "project transfer cancel",
	"GET /project-transfers":                                         "project transfer list",
	"POST /project-transfers/:id/accept":                             "project transfer accept",
	"POST /project-transfers/:id/decline":                            "project transfer decline",
	"DELETE /projects/:id/invitations/:invitationId":                 "project invitation revoke",
	"GET /organizations/:organizationId/registry-credentials":        "org registry list",
	"PUT /organizations/:organizationId/registry-credentials":        "org registry set",
	"DELETE /organizations/:organizationId/registry-credentials/:id": "org registry remove",
	"GET /projects/:projectId/image-ports":                           "deploy create --image (port autodetect)",
	"GET /projects/:projectId/registry-credentials":                  "project registry list",
	"PUT /projects/:projectId/registry-credentials":                  "project registry set",
	"DELETE /projects/:projectId/registry-credentials/:id":           "project registry remove",

	// environments + shared vars
	"GET /projects/:projectId/environments":  "env list",
	"POST /projects/:projectId/environments": "env create",
	"DELETE /environments/:id":               "env delete",
	"POST /environments/:id/set-default":     "env set-default",
	"GET /environments/:id/shared-vars":      "env vars get",
	"PUT /environments/:id/shared-vars":      "env vars set",

	// deployments: lifecycle
	"GET /deployments":                               "deploy list",
	"GET /projects/:id/deployments":                  "deploy list (project scope)",
	"GET /deployments/:id":                           "deploy get",
	"GET /deployments/:id/rollout":                   "deploy status, and every deploy --wait",
	"POST /projects/:id/deployments":                 "deploy create --image",
	"POST /projects/:id/deployments/from-github":     "deploy create --github",
	"POST /projects/:id/deployments/from-local":      "up (local directory deploy)",
	"POST /deployments/:id/build-context":            "up (local build context upload)",
	"DELETE /deployments/:id":                        "deploy delete",
	"POST /deployments/:id/scale":                    "deploy scale",
	"POST /deployments/:id/restart":                  "deploy restart",
	"POST /deployments/:id/icon":                     "deploy icon set",
	"POST /deployments/:id/stop":                     "deploy stop",
	"POST /deployments/:id/start":                    "deploy start",
	"POST /deployments/:id/rebuild":                  "deploy rebuild",
	"POST /deployments/:id/cancel":                   "deploy cancel",
	"POST /deployments/:id/rollback":                 "deploy rollback",
	"POST /deployments/:id/rollback/:imageHistoryId": "deploy rollback",
	"PATCH /deployments/:id/image":                   "deploy image set",

	// deployments: introspection
	"GET /deployments/:id/logs":                               "deploy logs --build",
	"GET /deployments/:id/pods":                               "deploy pods",
	"GET /deployments/:id/pods-live":                          "deploy pods --live",
	"GET /deployments/:id/metrics":                            "deploy metrics",
	"GET /deployments/:id/image-history":                      "deploy history",
	"GET /deployments/:id/image-history/:imageHistoryId/logs": "deploy history --logs",
	"GET /deployments/:id/killed-containers":                  "deploy killed list",
	"GET /deployments/:id/killed-containers/:entryId/logs":    "deploy killed logs",
	"GET /deployments/:id/github-deployments":                 "deploy github-deployments",

	// deployments: config
	"PUT /deployments/:id/env":                    "deploy env set",
	"PATCH /deployments/:id/resources":            "deploy resources set",
	"PUT /deployments/:id/volumes":                "deploy volumes set",
	"PATCH /deployments/:id/strategy":             "deploy strategy set",
	"GET /deployments/:id/releases":               "deploy releases",
	"GET /deployments/:id/bindings":               "deploy bindings list",
	"GET /deployments/:id/bindings/options":       "deploy bindings options",
	"POST /deployments/:id/bindings":              "deploy bindings add",
	"DELETE /deployments/:id/bindings/:bindingId": "deploy bindings remove",
	"POST /databases/:id/rotate-password":         "db rotate-password",
	"PATCH /deployments/:id/pull-policy":          "deploy pull-policy set",

	// databases: post-mortem capture
	"GET /databases/:id/killed-containers":               "db killed list",
	"GET /databases/:id/live":                            "top --db",
	"GET /databases/:id/query-stats":                     "top --db",
	"GET /databases/:id/killed-containers/:entryId/logs": "db killed logs",
	"PUT /deployments/:id/health-check":                  "deploy health-check set",
	"PUT /deployments/:id/build-config":                  "deploy build-root set",

	// deployments: auto-deploy + webhook tokens
	"GET /deployments/:id/auto-deploy":                "deploy auto-deploy status",
	"POST /deployments/:id/auto-deploy/enable":        "deploy auto-deploy enable",
	"POST /deployments/:id/auto-deploy/disable":       "deploy auto-deploy disable",
	"GET /deployments/:id/webhook-tokens":             "deploy webhook-token list",
	"POST /deployments/:id/webhook-tokens":            "deploy webhook-token create",
	"DELETE /deployments/:id/webhook-tokens/:tokenId": "deploy webhook-token delete",
	"POST /webhooks/deploy":                           "webhook deploy",

	// services
	"POST /deployments/:deploymentId/services":                                   "service create",
	"PUT /deployments/:deploymentId/services/:serviceId":                         "service update",
	"DELETE /deployments/:deploymentId/services/:serviceId":                      "service delete",
	"PATCH /deployments/:deploymentId/services/:serviceId/exposure":              "service exposure set",
	"POST /deployments/:deploymentId/services/:serviceId/ports/:portId/public":   "service port public enable",
	"DELETE /deployments/:deploymentId/services/:serviceId/ports/:portId/public": "service port public disable",

	// domains (ingresses)
	"GET /ingresses/:id":                                  "domain get",
	"POST /deployments/:id/ingresses":                     "domain create",
	"PUT /deployments/:deploymentId/ingresses/:ingressId": "domain update (deployment-linked)",
	"PUT /projects/:id/ingresses/:ingressId":              "domain update (project-scoped)",
	"DELETE /projects/:id/ingresses/:ingressId":           "domain delete",
	"GET /projects/:id/ingresses/:ingressId/protection":   "domain protection get",
	"PUT /projects/:id/ingresses/:ingressId/protection":   "domain protection set",
	"POST /projects/ingresses/validate-dns":               "domain validate-dns",

	// databases
	"GET /databases":                         "db list",
	"GET /projects/:id/databases":            "db list (project scope)",
	"GET /databases/:id":                     "db get",
	"POST /projects/:id/databases":           "db create",
	"DELETE /databases/:id":                  "db delete",
	"GET /databases/:id/provisioning":        "db create --wait",
	"GET /databases/:id/metrics":             "db metrics",
	"GET /databases/:id/connection":          "db connection",
	"POST /databases/:id/shell":              "db psql",
	"DELETE /databases/:id/shell/:pod":       "db psql",
	"GET /databases/:id/backups":             "db backup list",
	"POST /databases/:id/backups":            "db backup create",
	"POST /databases/:id/restore":            "db backup restore",
	"GET /databases/:id/backup-schedule":     "db backup-schedule get",
	"PUT /databases/:id/backup-schedule":     "db backup-schedule set",
	"DELETE /databases/:id/backup-schedule":  "db backup-schedule clear",
	"GET /databases/:id/extensions":          "db extension list",
	"POST /databases/:id/extensions":         "db extension install",
	"DELETE /databases/:id/extensions/:name": "db extension uninstall",
	"GET /databases/:id/settings":            "db settings get",
	"PATCH /databases/:id/settings":          "db settings set",
	"POST /databases/:id/public":             "db public enable",
	"DELETE /databases/:id/public":           "db public disable",
	"PATCH /databases/:id/resources":         "db resources set",
	"PATCH /databases/:id/storage":           "db storage expand",

	// databases: recovery, health and protection
	"GET /databases/:id/recovery":               "db recovery",
	"GET /databases/:id/diagnosis":              "db diagnose",
	"GET /databases/:id/activity":               "db activity",
	"POST /databases/:id/fork":                  "db fork",
	"GET /databases/:id/operations":             "db ops list",
	"GET /database-operations/:opId":            "db ops get, and every db recovery --wait",
	"POST /database-operations/:opId/cancel":    "db ops cancel",
	"POST /database-operations/:opId/undo":      "db ops undo",
	"GET /databases/:id/checkpoints":            "db checkpoint list",
	"POST /databases/:id/checkpoints":           "db checkpoint create <dbId>",
	"POST /checkpoints":                         "db checkpoint create (project or environment)",
	"GET /checkpoints/groups/:groupId":          "db checkpoint group",
	"POST /checkpoints/groups/:groupId/restore": "db checkpoint restore-group",
	"POST /checkpoints/:id/restore":             "db checkpoint restore",
	"DELETE /checkpoints/:id":                   "db checkpoint rm",
	"GET /databases/:id/restore-tests":          "db test-backup list",
	"POST /databases/:id/restore-tests":         "db test-backup run",
	"PATCH /databases/:id/protection":           "db protect",
	"GET /databases/:id/pooler":                 "db pooler get",
	"PUT /databases/:id/pooler":                 "db pooler set",
	"GET /projects/:id/deleted-databases":       "db trash list",
	"POST /deleted-databases/:id/restore":       "db trash restore",
	"GET /databases/:id/replication":            "db replication get",
	"PATCH /databases/:id/replication":          "db replication set",
	"GET /databases/:id/users":                  "db user list",
	"POST /databases/:id/users":                 "db user create",
	"DELETE /databases/:id/users/:name":         "db user rm",
	"GET /database-versions":                    "db versions",
	"GET /databases/:id/security":               "db security",
	"POST /databases/:id/upgrade":               "db upgrade",
	"POST /databases/:id/minor-update":          "db update",

	// pods
	"GET /pods":                "pod list",
	"GET /pods/:podName":       "pod get",
	"GET /pods/:podName/logs":  "pod logs",
	"DELETE /pods/:podName":    "pod delete",
	"POST /pods/:podName/exec": "pod exec",

	// sandboxes
	"GET /instance/features":                             "sandbox / ssh-identity (Greenhouse install check)",
	"GET /sandboxes":                                     "sandbox list",
	"POST /sandboxes":                                    "sandbox create",
	"GET /sandboxes/:id":                                 "sandbox get",
	"GET /sandboxes/:id/usage":                           "sandbox usage",
	"PATCH /sandboxes/:id":                               "sandbox update",
	"POST /sandboxes/:id/start":                          "sandbox start",
	"POST /sandboxes/:id/stop":                           "sandbox stop",
	"POST /sandboxes/:id/apply/retry":                    "sandbox retry",
	"DELETE /sandboxes/:id":                              "sandbox delete",
	"GET /sandboxes/:id/ssh":                             "sandbox ssh / sandbox proxy",
	"GET /sandboxes/:id/hostkey":                         "sandbox ssh / sandbox proxy (known_hosts refresh)",
	"POST /sandboxes/:id/chat":                           "sandbox chat",
	"GET /sandboxes/:id/changes":                         "sandbox diff --stat",
	"GET /sandboxes/:id/diff":                            "sandbox diff",
	"GET /sandboxes/:id/repos":                           "sandbox repo list",
	"GET /sandboxes/:id/boot":                            "sandbox create --wait (boot progress, web workspace)",
	"POST /sandboxes/:id/repos":                          "sandbox repo add",
	"PUT /sandboxes/:id/repos/:name/icon":                "sandbox repo icon",
	"GET /sandboxes/:id/conversations":                   "sandbox conversations",
	"POST /sandboxes/:id/conversations":                  "sandbox conversations --new",
	"PATCH /sandboxes/:id/conversations/:cid":            "sandbox conversations --rename",
	"DELETE /sandboxes/:id/conversations/:cid":           "sandbox conversations --delete",
	"GET /sandboxes/:id/conversations/:cid/history":      "sandbox conversations --history",
	"ALL /sandboxes/:id/opencode/{*splat}":               "sandbox chat (opencode workspace proxy, web UI)",
	"POST /sandboxes/:id/git/commit":                     "sandbox git commit (web workspace)",
	"POST /sandboxes/:id/git/push":                       "sandbox git push (web workspace)",
	"POST /sandboxes/:id/git/pr":                         "sandbox git pr (web workspace)",
	"POST /sandboxes/:id/git/fetch":                      "sandbox git fetch (web workspace)",
	"POST /sandboxes/:id/git/pull":                       "sandbox git pull (web workspace)",
	"POST /sandboxes/:id/git/uncommit":                   "sandbox git uncommit (web workspace)",
	"GET /sandboxes/:id/git/branches":                    "sandbox git branches (web workspace)",
	"GET /sandboxes/:id/git/identity":                    "sandbox git identity (web workspace push-as badge)",
	"POST /sandboxes/:id/git/checkout":                   "sandbox git checkout (web workspace)",
	"POST /sandboxes/:id/git/branch/delete":              "sandbox git branch delete (web workspace)",
	"GET /sandboxes/:id/file":                            "sandbox file read (web workspace editor)",
	"PUT /sandboxes/:id/file":                            "sandbox file write (web workspace editor)",
	"GET /sandboxes/:id/sessions":                        "sandbox session list",
	"POST /sandboxes/:id/sessions":                       "sandbox session create",
	"PATCH /sandboxes/:id/sessions/:sid":                 "sandbox session archive",
	"GET /sandboxes/:id/sessions/:sid":                   "sandbox session list (one session, web workspace)",
	"DELETE /sandboxes/:id/sessions/:sid":                "sandbox session delete (web workspace sidebar)",
	"GET /sandboxes/:id/sessions/:sid/chats":             "sandbox chat tabs (web workspace)",
	"POST /sandboxes/:id/sessions/:sid/chats":            "sandbox chat tabs new (web workspace)",
	"DELETE /sandboxes/:id/sessions/:sid/chats/:chatId":  "sandbox chat tabs delete (web workspace)",
	"GET /sandboxes/:id/sessions/:sid/scripts":           "sandbox setup/run scripts (web workspace dock)",
	"POST /sandboxes/:id/sessions/:sid/run":              "sandbox run script (web workspace dock)",
	"GET /sandboxes/:id/sessions/:sid/ports":             "sandbox ports (web workspace dock)",
	"GET /sandboxes/:id/sessions/:sid/checks":            "sandbox pr checks (web workspace inspector)",
	"POST /sandboxes/:id/sessions/:sid/git/merge":        "sandbox pr merge (web workspace toolbar)",
	"POST /sandboxes/:id/fs/mkdir":                       "sandbox file tree new folder (web workspace)",
	"POST /sandboxes/:id/fs/rename":                      "sandbox file tree rename (web workspace)",
	"POST /sandboxes/:id/fs/delete":                      "sandbox file tree delete (web workspace)",
	"GET /sandboxes/:id/members":                         "sandbox share sheet (web workspace)",
	"POST /sandboxes/:id/members":                        "sandbox share invite (web workspace)",
	"PATCH /sandboxes/:id/members/:userId":               "sandbox share role change (web workspace)",
	"DELETE /sandboxes/:id/members/:userId":              "sandbox share remove / leave (web workspace)",
	"DELETE /sandboxes/:id/repos/:name":                  "web workspace (repo menu)",
	"POST /sandboxes/:id/context/sync":                   "web workspace (syncs your context into your machine)",
	"GET /me/context":                                    "claude list",
	"POST /me/context/import":                            "claude import",
	"DELETE /me/context/:itemId":                         "claude remove",
	"GET /me/context/:itemId":                            "web settings (context editor)",
	"PUT /me/context":                                    "web settings (context editor)",
	"PATCH /me/context/:itemId":                          "web settings (context editor)",
	"GET /sandboxes/:id/sessions/:sid/comments":          "sandbox team chat (web workspace transcript)",
	"POST /sandboxes/:id/sessions/:sid/comments":         "sandbox team chat send (web workspace composer)",
	"GET /sandboxes/:id/sessions/:sid/authors":           "sandbox prompt authors (web workspace transcript)",
	"GET /sandboxes/:id/preview-token":                   "sandbox preview link (web workspace ports)",
	"GET /sandboxes/:id/links":                           "sandbox link list",
	"POST /sandboxes/:id/links":                          "sandbox link add",
	"DELETE /sandboxes/:id/links/:projectId":             "sandbox link remove",
	"POST /sandboxes/:id/sessions/:sid/preview-deploy":   "sandbox session preview",
	"DELETE /sandboxes/:id/sessions/:sid/preview-deploy": "sandbox session preview --remove",
	"POST /sandboxes/:id/sessions/:sid/prompt":           "sandbox session prompt",
	"GET /sandboxes/:id/sessions/:sid/transcript":        "sandbox session transcript",
	"POST /sandboxes/:id/fork":                           "sandbox fork",
	"GET /sandboxes/:id/share-links":                     "sandbox share list",
	"POST /sandboxes/:id/share-links":                    "sandbox share create",
	"DELETE /sandboxes/:id/share-links/:linkId":          "sandbox share revoke",
	"GET /sandboxes/credentials":                         "sandbox credentials status",
	"PUT /sandboxes/credentials":                         "sandbox credentials set",

	// ssh identities
	"GET /ssh-identities":                "ssh-identity list",
	"POST /ssh-identities":               "ssh-identity add",
	"POST /ssh-identities/import-github": "ssh-identity import-github",
	"DELETE /ssh-identities/:id":         "ssh-identity remove",

	// jobs + runs
	"GET /organizations/:orgId/jobs":         "job list (org scope)",
	"GET /projects/:projectId/jobs":          "job list (project scope)",
	"POST /projects/:projectId/jobs":         "job create",
	"GET /jobs/:id":                          "job get",
	"PATCH /jobs/:id":                        "job update",
	"DELETE /jobs/:id":                       "job delete",
	"PUT /jobs/:id/steps":                    "job steps set",
	"POST /jobs/:id/runs":                    "job run",
	"GET /jobs/:id/runs":                     "job runs",
	"GET /job-runs/:runId":                   "job-run get",
	"POST /job-runs/:runId/cancel":           "job-run cancel",
	"GET /job-runs/:runId/steps/:order/logs": "job-run logs",

	// templates
	"GET /templates":     "template list",
	"GET /templates/:id": "template get",
	"POST /projects/:projectId/template-instances": "template deploy",
	"GET /projects/:projectId/template-instances":  "template instance list",
	"GET /template-instances/:id":                  "template instance get",
	"DELETE /template-instances/:id":               "template instance delete",

	// compose stacks
	"GET /projects/:projectId/compose-stacks":              "compose list",
	"GET /compose-stacks/:id":                              "compose get",
	"POST /projects/:projectId/compose-stacks/from-github": "compose deploy",
	"POST /compose-stacks/:id/redeploy":                    "compose redeploy",
	"PUT /compose-stacks/:id/auto-deploy":                  "compose auto-deploy enable|disable",
	"DELETE /compose-stacks/:id":                           "compose delete",

	// github integration
	"GET /github/status":                                    "github status",
	"GET /github/link":                                      "github link (opens the browser here)",
	"DELETE /github/unlink":                                 "github unlink",
	"GET /github/app/install":                               "github install",
	"GET /github/app/installations":                         "github installations",
	"GET /github/repositories":                              "github repos",
	"GET /github/repositories/:owner/:repo/branches":        "github branches",
	"GET /github/repositories/:owner/:repo/contents":        "github contents",
	"GET /github/repositories/:owner/:repo/dockerfile-info": "github dockerfile-info",
	"GET /github/repositories/:owner/:repo/dockerfiles":     "github dockerfiles",

	// tailscale
	"GET /tailscale/status":                   "tailscale status",
	"POST /tailscale/link":                    "tailscale link",
	"DELETE /tailscale/unlink":                "tailscale unlink",
	"GET /tailscale/deployment/:deploymentId": "tailscale get",
	"POST /tailscale/expose/:deploymentId":    "tailscale expose",
	"POST /tailscale/unexpose/:deploymentId":  "tailscale unexpose",

	// observability
	"GET /events/orgs/:orgId":                        "events tail",
	"GET /observe/deployments/:id/overview":          "observe overview",
	"GET /observe/deployments/:id/logs/structured":   "observe logs",
	"GET /observe/deployments/:id/http-metrics":      "observe http",
	"GET /observe/deployments/:id/errors":            "observe errors",
	"GET /observe/deployments/:id/runtime":           "observe runtime",
	"GET /observe/deployments/:id/capabilities":      "observe capabilities",
	"GET /observe/deployments/:id/timeline":          "observe activity",
	"GET /observe/deployments/:id/logs/stream":       "deploy logs --follow (SSE)",
	"GET /observe/deployments/:id/build-logs/stream": "deploy logs --build --follow (SSE)",

	// notification channels
	"GET /organizations/:id/notification-channels":                       "notify channel list",
	"POST /organizations/:id/notification-channels":                      "notify channel create",
	"PATCH /organizations/:id/notification-channels/:channelId":          "notify channel update",
	"DELETE /organizations/:id/notification-channels/:channelId":         "notify channel delete",
	"POST /organizations/:id/notification-channels/:channelId/test":      "notify channel test",
	"GET /organizations/:id/notification-channels/:channelId/deliveries": "notify deliveries",

	// metric alerts
	"GET /organizations/:id/metric-alerts":            "alert list",
	"GET /organizations/:id/metric-alerts/catalogue":  "alert metrics",
	"GET /organizations/:id/metric-alerts/states":     "alert status",
	"POST /organizations/:id/metric-alerts":           "alert create",
	"PATCH /organizations/:id/metric-alerts/:ruleId":  "alert update",
	"DELETE /organizations/:id/metric-alerts/:ruleId": "alert delete",

	// status pages
	"GET /status/resolve":                            "status-page show --host",
	"GET /status/:slug":                              "status-page show",
	"GET /organizations/:id/status-pages":            "status-page list",
	"GET /organizations/:id/status-pages/options":    "status-page options",
	"POST /organizations/:id/status-pages":           "status-page create",
	"PATCH /organizations/:id/status-pages/:pageId":  "status-page update",
	"DELETE /organizations/:id/status-pages/:pageId": "status-page delete",

	// git providers
	"GET /users/me/git-connections":                              "git list",
	"GET /users/me/git-connections/oauth":                        "git list",
	"POST /users/me/git-connections":                             "git add",
	"PATCH /users/me/git-connections/:connectionId":              "git add (rotate via API)",
	"DELETE /users/me/git-connections/:connectionId":             "git remove",
	"GET /users/me/git-connections/:connectionId/webhook-secret": "git webhook",
	"GET /users/me/git-connections/:connectionId/repositories":   "git repos",
	"GET /users/me/git-connections/:connectionId/branches":       "git branches",
	"GET /users/me/git-connections/:connectionId/detect":         "git detect",

	// audit
	"GET /audit-logs/organization/:id": "audit list",
	"GET /audit-logs/deployment/:id":   "audit list --deployment",

	// quota
	"GET /organizations/:orgId/quota":          "quota show",
	"GET /organizations/:orgId/quota/me":       "quota me",
	"GET /organizations/:orgId/quota/members":  "quota members",
	"GET /organizations/:orgId/quota/projects": "quota projects",

	// overview
	"GET /overview":                      "overview --all",
	"GET /overview/orgs/:orgSlug":        "overview",
	"GET /overview/orgs/:orgSlug/builds": "overview --builds",
}

// routeExclusions lists non-superadmin routes the CLI deliberately does not
// call, with the reason. "no CLI command yet" entries are honest gaps: they
// stay visible here instead of silently rotting.
var routeExclusions = map[string]string{
	"GET /pods/:podName/files":          "web Files tab first; CLI command to follow",
	"GET /pods/:podName/files/download": "web Files tab first; CLI command to follow",
	// dashboard affordance: returns booleans that drive a dismissible card, and
	// every underlying setting already has its own CLI command
	"GET /deployments/:id/next-steps":                  "UI-only checklist card",
	"GET /deployments/:id/security":                    "web security tab first; CLI command to follow",
	"POST /deployments/:id/security/scan":              "web security tab first; CLI command to follow",
	"GET /projects/:id/database-security":              "project security tab summary; db security covers each database, agents use MCP",
	"GET /observe/deployments/:id/pod-health":          "dashboard series; CLI command to follow",
	"GET /observe/deployments/:id/volumes":             "dashboard series; CLI command to follow",
	"GET /observe/deployments/:id/builds":              "dashboard series; CLI command to follow",
	"GET /observe/deployments/:id/changes":             "dashboard chart markers; exposed to agents over MCP",
	"GET /observe/deployments/:id/findings":            "dashboard findings; exposed to agents over MCP",
	"GET /observe/deployments/:id/logs/search":         "stored log search; CLI keeps observe logs, agents use MCP search_logs",
	"GET /observe/deployments/:id/logs/levels":         "dashboard series; CLI command to follow",
	"GET /observe/deployments/:id/logs/context":        "log context; exposed to agents over MCP",
	"GET /observe/deployments/:id/logs/export":         "browser download; CLI pipes observe logs",
	"GET /observe/deployments/:id/requests":            "request data from access logs; exposed to agents over MCP",
	"GET /observe/deployments/:id/requests/stream":     "live request tail (SSE); dashboard only",
	"GET /deployments/:id/releases/:releaseId/verdict": "deploy verdict; shown in deploy releases and over MCP",
	"GET /deployments/:id/rightsizing":                 "resource suggestion; applied through deploy resources, exposed over MCP",
	"GET /deployments/:id/diagnosis":                   "one-call diagnosis for agents; exposed over MCP as diagnose_deployment",
	"GET /deployments/:id/security/attacks":            "attack signals from access logs; exposed over MCP",
	"GET /sandboxes/:id/connect":                       "UI-only open-in-editor readiness; the CLI writes ssh config itself",

	"GET /share/sandbox/:token":                          "share link viewer, web UI only",
	"GET /share/sandbox/:token/sessions/:sid/transcript": "share link viewer, web UI only",
	"GET /share/sandbox/:token/sessions/:sid/changes":    "share link viewer, web UI only",
	"GET /share/sandbox/:token/sessions/:sid/diff":       "share link viewer, web UI only",
	"GET /share/sandbox":                                 "share link viewer (token in header), web UI only",
	"GET /share/sandbox/sessions/:sid/transcript":        "share link viewer (token in header), web UI only",
	"GET /share/sandbox/sessions/:sid/changes":           "share link viewer (token in header), web UI only",
	"GET /share/sandbox/sessions/:sid/diff":              "share link viewer (token in header), web UI only",

	// forge to server, signed with the connection secret; never driven by a person
	"POST /git/webhooks/:connectionId":  "webhook receiver for git providers",
	"GET /git/oauth/:provider/start":    "browser OAuth ceremony for GitLab and Bitbucket",
	"GET /git/oauth/:provider/callback": "browser OAuth ceremony (callback)",

	// browser login ceremonies: driven by redirects and cookies, not tokens
	"GET /auth/config":        "browser login ceremony (which methods the login page offers)",
	"GET /auth/methods":       "browser login ceremony (which methods the login page offers)",
	"POST /auth/password":     "browser login ceremony (password sign-in; the CLI signs in with a token or OAuth)",
	"POST /auth/password/set": "browser account settings (setting a password happens in the app)",
	"GET /auth/login":         "browser login ceremony",
	"GET /auth/callback":      "browser login ceremony (OAuth callback)",
	"POST /auth/logout":       "browser logout (CLI logout deletes the local token)",
	"POST /auth/otp/request":  "browser OTP login ceremony",
	"POST /auth/otp/verify":   "browser OTP login ceremony",

	// WebAuthn: the ceremony requires a browser authenticator
	"GET /auth/passkey/check":                 "WebAuthn ceremony, browser only",
	"POST /auth/passkey/authenticate/options": "WebAuthn ceremony, browser only",
	"POST /auth/passkey/authenticate/verify":  "WebAuthn ceremony, browser only",
	"POST /auth/passkey/register/options":     "WebAuthn ceremony, browser only",
	"POST /auth/passkey/register/verify":      "WebAuthn ceremony, browser only",
	"GET /auth/passkeys":                      "passkey management: no CLI command yet (registration needs a browser)",
	"DELETE /auth/passkeys/:id":               "passkey management: no CLI command yet",
	"POST /auth/passkeys/:id/rename":          "passkey management: no CLI command yet",
	"POST /auth/mcp-token":                    "MCP session token minted during the web MCP handshake",

	// ingress protection: spoken by the protection proxy and the visitor's browser
	"GET /auth/protect/check":              "ingress protection proxy endpoint",
	"GET /auth/protect/info":               "ingress protection proxy endpoint",
	"POST /auth/protect/exchange/orchard":  "ingress protection browser exchange",
	"POST /auth/protect/exchange/password": "ingress protection browser exchange",

	// SSO + SCIM: IdP-driven enterprise endpoints, configured from the web UI
	"GET /sso/providers":                                              "SSO login page data",
	"GET /sso/org/:slug":                                              "SSO login page data",
	"POST /sso/discover":                                              "SSO login page email-domain routing",
	"GET /sso/start/:providerId":                                      "SSO browser flow",
	"GET /sso/callback/:providerId":                                   "SSO IdP callback",
	"POST /sso/callback/:providerId":                                  "SSO IdP callback",
	"GET /sso/providers/:providerId/metadata":                         "SAML SP metadata for IdPs",
	"GET /sso/:orgId/login":                                           "SSO browser flow (pre-rework URL)",
	"GET /sso/:orgId/callback/oidc":                                   "SSO IdP callback (pre-rework URL)",
	"POST /sso/:orgId/callback/saml":                                  "SSO IdP callback (pre-rework URL)",
	"GET /sso/subdomain/:subdomain":                                   "SSO vanity subdomain resolver",
	"GET /organizations/:id/sso":                                      "SSO admin config, web UI only",
	"PATCH /organizations/:id/sso/settings":                           "SSO admin config, web UI only",
	"GET /organizations/:id/sso/domains":                              "SSO admin config, web UI only",
	"POST /organizations/:id/sso/domains":                             "SSO admin config, web UI only",
	"POST /organizations/:id/sso/domains/:domainId/verify":            "SSO admin config, web UI only",
	"DELETE /organizations/:id/sso/domains/:domainId":                 "SSO admin config, web UI only",
	"GET /organizations/:id/sso/providers":                            "SSO admin config, web UI only",
	"POST /organizations/:id/sso/providers":                           "SSO admin config, web UI only",
	"GET /organizations/:id/sso/providers/:providerId":                "SSO admin config, web UI only",
	"PATCH /organizations/:id/sso/providers/:providerId":              "SSO admin config, web UI only",
	"DELETE /organizations/:id/sso/providers/:providerId":             "SSO admin config, web UI only",
	"POST /organizations/:id/sso/providers/:providerId/test":          "SSO admin config, web UI only",
	"POST /organizations/:id/sso/providers/:providerId/icon":          "SSO admin config, web UI only",
	"DELETE /organizations/:id/sso/providers/:providerId/icon":        "SSO admin config, web UI only",
	"GET /organizations/:id/sso/providers/:providerId/rules":          "SSO admin config, web UI only",
	"PUT /organizations/:id/sso/providers/:providerId/rules":          "SSO admin config, web UI only",
	"POST /organizations/:id/sso/providers/:providerId/rules/preview": "SSO admin config, web UI only",
	"GET /organizations/:id/scim/tokens":                              "SCIM admin config, web UI only",
	"POST /organizations/:id/scim/tokens":                             "SCIM admin config, web UI only",
	"DELETE /organizations/:id/scim/tokens/:tokenId":                  "SCIM admin config, web UI only",
	"GET /scim/v2/Users":                                              "SCIM protocol endpoint for IdPs",
	"GET /scim/instance/v2/Users":                                     "SCIM protocol endpoint for IdPs",
	"GET /scim/instance/v2/Users/:id":                                 "SCIM protocol endpoint for IdPs",
	"POST /scim/instance/v2/Users":                                    "SCIM protocol endpoint for IdPs",
	"PUT /scim/instance/v2/Users/:id":                                 "SCIM protocol endpoint for IdPs",
	"PATCH /scim/instance/v2/Users/:id":                               "SCIM protocol endpoint for IdPs",
	"DELETE /scim/instance/v2/Users/:id":                              "SCIM protocol endpoint for IdPs",
	"GET /scim/instance/v2/ServiceProviderConfig":                     "SCIM protocol endpoint for IdPs",
	"GET /organizations/:id/sso/providers/:providerId/project-rules":  "SSO admin config, web UI only",
	"PUT /organizations/:id/sso/providers/:providerId/project-rules":  "SSO admin config, web UI only",
	"GET /auth/links":                                                 "linked work organizations, web UI only",
	"DELETE /auth/links/:id":                                          "linked work organizations, web UI only",
	"DELETE /organizations/:id/members/:memberId/link":                "linked work organizations, web UI only",
	"GET /scim/v2/Users/:id":                                          "SCIM protocol endpoint for IdPs",
	"POST /scim/v2/Users":                                             "SCIM protocol endpoint for IdPs",
	"PUT /scim/v2/Users/:id":                                          "SCIM protocol endpoint for IdPs",
	"PATCH /scim/v2/Users/:id":                                        "SCIM protocol endpoint for IdPs",
	"DELETE /scim/v2/Users/:id":                                       "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/Groups":                                             "SCIM protocol endpoint for IdPs",
	"POST /scim/v2/Groups":                                            "SCIM protocol endpoint for IdPs",
	"PUT /scim/v2/Groups/:id":                                         "SCIM protocol endpoint for IdPs",
	"PATCH /scim/v2/Groups/:id":                                       "SCIM protocol endpoint for IdPs",
	"DELETE /scim/v2/Groups/:id":                                      "SCIM protocol endpoint for IdPs",
	"POST /scim/v2/Groups/.search":                                    "SCIM protocol endpoint for IdPs",
	"POST /scim/v2/Users/.search":                                     "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/Groups/:id":                                         "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/ResourceTypes":                                      "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/ResourceTypes/:id":                                  "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/Schemas":                                            "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/Schemas/:id":                                        "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/ServiceProviderConfig":                              "SCIM protocol endpoint for IdPs",
	"ALL /scim/v2/Me":                                                 "SCIM protocol endpoint for IdPs",
	"ALL /scim/v2/{*splat}":                                           "SCIM protocol endpoint for IdPs",

	// github plumbing
	"GET /github/callback":                  "GitHub OAuth callback, browser only",
	"POST /github/link":                     "GitHub OAuth code exchange for the browser flow (CLI opens GET /github/link)",
	"POST /github/app/webhook":              "webhook receiver for GitHub, not a client route",
	"POST /internal/image-scans/:id/result": "result callback for in-cluster scan jobs, not a client route",

	"POST /integrations/linear/webhook":                             "webhook receiver for Linear, signed with the instance webhook secret",
	"POST /integrations/slack/commands":                             "Slack slash command receiver, signed with the Slack app signing secret",
	"POST /integrations/slack/events":                               "Slack Events API receiver, signed with the Slack app signing secret",
	"GET /sandboxes/:id/issues":                                     "web composer issue picker; the CLI passes an issue ref straight to session create",
	"GET /integrations/linear/issues":                               "web composer Linear issue picker",
	"GET /users/me/integrations/linear":                             "web user settings (Linear connection status); no CLI command yet",
	"PUT /users/me/integrations/linear":                             "web user settings (connect a Linear API key); no CLI command yet",
	"DELETE /users/me/integrations/linear":                          "web user settings (disconnect Linear); no CLI command yet",
	"GET /users/me/integrations":                                    "web user settings (linked accounts list); no CLI command yet",
	"POST /integrations/slack/link":                                 "browser confirmation page for the one-time link from /greenhouse link in Slack",
	"POST /integrations/slack/link/preview":                         "web-only: shows the Slack account on the link confirm page",
	"POST /sandboxes/:id/repos/init":                                "web-only: start a session from an empty repository",
	"POST /sandboxes/:id/repos/link":                                "web-only: open a folder on the machine as a repository from the add repository sheet",
	"GET /sandboxes/:id/dirs":                                       "web-only: folder browser in the add repository sheet",
	"GET /sandboxes/:id/agent/usage":                                "web composer context popover (host Claude subscription limits)",
	"GET /sandboxes/:id/agents":                                     "web workspace: which coding agents the machine has; no CLI command yet",
	"GET /sandboxes/:id/sessions/:sid/agent-chats":                  "web workspace agent chats (Claude Code, Codex, fx, opencode); no CLI command yet",
	"POST /sandboxes/:id/sessions/:sid/agent-chats":                 "web workspace agent chats; no CLI command yet",
	"PATCH /sandboxes/:id/sessions/:sid/agent-chats/:cid":           "web workspace agent chats (rename); no CLI command yet",
	"DELETE /sandboxes/:id/sessions/:sid/agent-chats/:cid":          "web workspace agent chats (close); no CLI command yet",
	"GET /sandboxes/:id/sessions/:sid/agent-chats/:cid/events":      "web workspace agent chats (history); no CLI command yet",
	"GET /sandboxes/:id/sessions/:sid/agent-chats/:cid/stream":      "web workspace agent chats (live stream); no CLI command yet",
	"POST /sandboxes/:id/sessions/:sid/agent-chats/:cid/prompt":     "web workspace agent chats (send); no CLI command yet",
	"POST /sandboxes/:id/sessions/:sid/agent-chats/:cid/cancel":     "web workspace agent chats (stop); no CLI command yet",
	"POST /sandboxes/:id/sessions/:sid/agent-chats/:cid/config":     "web workspace agent chats (model and mode); no CLI command yet",
	"POST /sandboxes/:id/sessions/:sid/agent-chats/:cid/permission": "web workspace agent chats (answer a permission prompt); no CLI command yet",
	"POST /sandboxes/:id/sessions/:sid/agent-chats/:cid/revert":     "web workspace agent chats (revert a turn); no CLI command yet",
	"GET /sandboxes/:id/agents/logins":                              "web settings: agent sign-in methods; run the agent's own login in orchard sandbox ssh",
	"POST /sandboxes/:id/agents/logins":                             "web settings: start an agent sign-in on the machine; run the agent's own login in orchard sandbox ssh",
	"GET /sandboxes/:id/agents/logins/:loginId":                     "web settings: agent sign-in progress",
	"POST /sandboxes/:id/agents/logins/:loginId/answer":             "web settings: paste a sign-in code or callback address",
	"DELETE /sandboxes/:id/agents/logins/:loginId":                  "web settings: cancel an agent sign-in",
	"DELETE /users/me/integrations/slack":                           "web user settings (unlink Slack); /greenhouse unlink in Slack does the same",

	// server plumbing
	"GET /health":                  "health probe",
	"GET /openapi.json":            "full OpenAPI document for external tooling; the CLI reads the trimmed /agent-spec.json instead",
	"POST /webhooks/deploy/:token": "CLI sends the token via the Authorization header on POST /webhooks/deploy instead (the URL form leaks the secret into proxy logs); deploy webhook-token create prints this URL for curl-only CI",

	// web-UI-only conveniences
	"GET /deployments/favicon":                       "web UI favicon proxy for deployment URLs",
	"GET /deployments/recent-builds":                 "web dashboard widget (CLI: overview --builds)",
	"GET /projects/by-slugs/:orgSlug/:projectSlug":   "web URL resolver (CLI resolves via GET /projects/slug/:slug)",
	"GET /organizations/:id/members/me":              "web UI permission preflight (CLI reads the members list)",
	"GET /organizations/:orgId/metrics/provisioning": "web UI provisioning banner",

	// browser invite landing (CLI acts by invitation id, not token)
	"GET /invitations/:token":          "browser invite landing page",
	"POST /invitations/:token/accept":  "browser invite landing page",
	"POST /invitations/:token/decline": "browser invite landing page",
	"POST /invitations/:token/sign-up": "browser invite landing page",
	"POST /invitations/accept-pending": "deliberately non-bulk endpoint; invitation accept-all loops the by-id route",

	// superadmin in disguise: guard says authenticated, service requires superadmin
	"POST /organizations/:id/members/join": "superadmin-gated in the service layer",
	"POST /organizations/:id/leave":        "signed-in browser only, API tokens are refused",

	// honest gaps: no CLI command yet (reachable via `orchard api` meanwhile)
	"GET /audit-logs/global": "no CLI command yet: cross-org audit feed",
	"GET /endpoints":         "no CLI command yet: raw k8s endpoint listing per namespace",
	"GET /github/repositories/:owner/:repo/dockerfile-stages":    "no CLI command yet: dockerfile stage introspection",
	"GET /github/repositories/search":                            "web repo picker search-as-you-type; github repos lists them",
	"GET /organizations/:organizationId/image-ports":             "web new-app form before a project exists; the CLI always deploys into one",
	"PATCH /environments/:id":                                    "no CLI command yet: environment rename",
	"GET /projects/:id/ingresses/:ingressId":                     "duplicate read: CLI uses GET /ingresses/:id",
	"DELETE /deployments/:deploymentId/ingresses/:ingressId":     "duplicate delete: CLI uses the project-scoped route",
	"GET /projects/:id/anomalies":                                "dashboard aggregate: the facts are already in deploy get, db get and observe",
	"GET /deployments/:id/anomalies":                             "dashboard aggregate: the facts are already in deploy get, db get and observe",
	"GET /databases/:id/anomalies":                               "dashboard aggregate: the facts are already in deploy get, db get and observe",
	"POST /projects/:id/ingresses":                               "project-level ingress create: CLI creates domains on deployments",
	"PATCH /organizations/:orgId/quota/default-member-allowance": "no CLI command yet: quota mutations",
	"PATCH /organizations/:orgId/quota/members/:userId":          "no CLI command yet: quota mutations",
	"PATCH /organizations/:orgId/quota/projects/:projectId":      "no CLI command yet: quota mutations",

	// honest gaps from the ui 2.0 wave (reachable via `orchard api` meanwhile)
	"GET /forum/categories":                                           "no CLI command yet: web UI community forum",
	"GET /forum/threads":                                              "no CLI command yet: web UI community forum",
	"GET /forum/threads/:id":                                          "no CLI command yet: web UI community forum",
	"POST /forum/threads":                                             "no CLI command yet: web UI community forum",
	"DELETE /forum/threads/:id":                                       "no CLI command yet: web UI community forum",
	"POST /forum/threads/:id/replies":                                 "no CLI command yet: web UI community forum",
	"DELETE /forum/threads/:id/replies/:replyId":                      "no CLI command yet: web UI community forum",
	"POST /forum/threads/:id/vote":                                    "no CLI command yet: web UI community forum",
	"DELETE /forum/threads/:id/vote":                                  "no CLI command yet: web UI community forum",
	"POST /forum/uploads":                                             "no CLI command yet: web UI community forum",
	"GET /organizations/:id/notification-rules":                       "no CLI command yet: notification rules",
	"POST /organizations/:id/notification-rules":                      "no CLI command yet: notification rules",
	"PATCH /organizations/:id/notification-rules/:ruleId":             "no CLI command yet: notification rules",
	"DELETE /organizations/:id/notification-rules/:ruleId":            "no CLI command yet: notification rules",
	"POST /organizations/:id/notification-channels/:channelId/replay": "no CLI command yet: notification delivery replay",
	"GET /users/me/notification-destinations":                         "no CLI command yet: personal notification destinations",
	"POST /users/me/notification-destinations":                        "no CLI command yet: personal notification destinations",
	"PUT /users/me/notification-destinations/:destinationId":          "no CLI command yet: personal notification destinations",
	"DELETE /users/me/notification-destinations/:destinationId":       "no CLI command yet: personal notification destinations",
	"POST /users/me/notification-destinations/:destinationId/test":    "no CLI command yet: personal notification destinations",
	"GET /users/me/notification-settings":                             "no CLI command yet: personal notification settings",
	"PUT /users/me/notification-settings":                             "no CLI command yet: personal notification settings",
	"GET /users/me/notification-settings/:scopeType/:scopeId":         "no CLI command yet: personal notification settings",
	"PUT /users/me/notification-settings/:scopeType/:scopeId":         "no CLI command yet: personal notification settings",
	"DELETE /users/me/notification-settings/:scopeType/:scopeId":      "no CLI command yet: personal notification settings",
	"POST /databases/:id/query-stats/reset":                           "no CLI command yet: database query stats",
	"POST /databases/:id/start":                                       "no CLI command yet: database lifecycle start/stop",
	"POST /databases/:id/stop":                                        "no CLI command yet: database lifecycle start/stop",
	"POST /databases/:id/restart":                                     "no CLI command yet: database lifecycle start/stop",
	"GET /deployments/:id/build-runs":                                 "no CLI command yet: build run history (CLI: deploy history)",
	"GET /deployments/:id/build-runs/:runId/logs":                     "no CLI command yet: build run history (CLI: deploy history --logs)",
	"GET /github/repositories/:owner/:repo/detect":                    "no CLI command yet: repo framework detection preview",
	"PATCH /observe/deployments/:id/errors/:fingerprint":              "no CLI command yet: error triage state mutations",
	"PATCH /deployments/:id/name":                                     "no CLI command yet: rename mutations",
	"PATCH /databases/:id/name":                                       "no CLI command yet: rename mutations",
	"PATCH /compose-stacks/:id/name":                                  "no CLI command yet: rename mutations",
	"PATCH /template-instances/:id/name":                              "no CLI command yet: rename mutations",
	"PATCH /auth/tokens/:id":                                          "no CLI command yet: token rename",
	"POST /auth/me/seen-updates":                                      "web UI changelog seen marker",
	"GET /updates/latest":                                             "web UI release notes pop-up",
	"PUT /deployments/:id/github-repo":                                "no CLI command yet: relink the github repo",

	// first-run installer flow: a browser ceremony against an instance that has
	// no user, and therefore no token for the CLI to authenticate with
	"GET /setup/status":              "first-run setup, before any account exists",
	"GET /uploads/*path":             "serves uploaded images to browsers",
	"GET /setup/github-app/callback": "first-run setup (GitHub App callback redirect)",
	"POST /setup/claim":              "first-run setup, claims the instance from a browser",
	"GET /setup/state":               "first-run setup wizard state, read by the browser",
	"GET /setup/certificate":         "first-run setup, hands the browser the cluster certificate",
	"POST /setup/skip":               "first-run setup, dismisses a wizard step",
	"POST /setup/bootstrap":          "first-run setup, claims and signs in a browser in one step",

	// form-support reads: the create form asks so it can validate before
	// submitting. The CLI just submits and lets the server rule on it.
	"GET /databases/limits": "create-form bounds check; the CLI relies on server-side validation",
	"GET /engine/health":    "no CLI command yet: dashboard engine health widget",

	"GET /node-pools":                   "no CLI command yet: node pool listing",
	"PATCH /databases/:id/replicas":     "no CLI command yet: database replica scaling",
	"PATCH /deployments/:id/placement":  "no CLI command yet: node pool placement",
	"POST /deployments/:id/retry-apply": "no CLI command yet: retry a failed cluster apply",

	"PATCH /deployments/:id/disruption-budget": "no CLI command yet: disruption budget",
	"GET /projects/:id/transfer-org/preview":   "no CLI command yet: move a project between orgs",
	"POST /projects/:id/transfer-org":          "no CLI command yet: move a project between orgs",

	"GET /grafts":                      "web UI graft bootstrap: which installed grafts the browser should load",
	"GET /announcements/announcements": "announcements graft banner, web UI only",
}

func loadAuthSnapshot(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(authSnapshotPath))
	if err != nil {
		t.Fatalf("read auth-coverage snapshot: %v", err)
	}
	var snapshot map[string]string
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatalf("parse auth-coverage snapshot: %v", err)
	}
	if len(snapshot) < 200 {
		t.Fatalf("snapshot has only %d routes; expected the full route table", len(snapshot))
	}
	return viaGraftAliases(t, snapshot)
}

func viaGraftAliases(t *testing.T, snapshot map[string]string) map[string]string {
	t.Helper()
	paths, err := filepath.Glob(filepath.FromSlash(graftManifests))
	if err != nil {
		t.Fatalf("find graft manifests: %v", err)
	}
	type alias struct{ prefix, alias string }
	var aliases []alias
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		var manifest struct {
			ID     string `json:"id"`
			Claims struct {
				APIAliases []string `json:"apiAliases"`
			} `json:"claims"`
		}
		if err := json.Unmarshal(raw, &manifest); err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		for _, a := range manifest.Claims.APIAliases {
			a = strings.Trim(a, "/")
			aliases = append(aliases, alias{prefix: "/" + manifest.ID + "/" + a, alias: "/" + a})
		}
	}
	out := make(map[string]string, len(snapshot))
	for route, auth := range snapshot {
		method, path, ok := strings.Cut(route, " ")
		if ok {
			for _, a := range aliases {
				if path == a.prefix || strings.HasPrefix(path, a.prefix+"/") {
					path = a.alias + strings.TrimPrefix(path, a.prefix)
					break
				}
			}
			route = method + " " + path
		}
		out[route] = auth
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// TestServerRouteParity is the forward gate: every in-scope server route must
// be mapped to a command or explicitly excluded.
func TestServerRouteParity(t *testing.T) {
	snapshot := loadAuthSnapshot(t)

	var total, superadmin, excluded, mapped int
	unmapped := []string{}
	for _, route := range sortedKeys(snapshot) {
		total++
		if snapshot[route] == "superadmin" {
			superadmin++
			continue
		}
		if _, ok := routeExclusions[route]; ok {
			excluded++
			continue
		}
		if _, ok := routeCoverage[route]; ok {
			mapped++
			continue
		}
		unmapped = append(unmapped, route+" ("+snapshot[route]+")")
	}
	t.Logf("routes: %d total, %d superadmin (skipped), %d excluded, %d mapped", total, superadmin, excluded, mapped)
	if len(unmapped) > 0 {
		t.Fatalf("new server route(s) without CLI parity: add a CLI command (and map it in routeCoverage) or an explicit routeExclusions entry in cmd/parity_test.go:\n  %s",
			strings.Join(unmapped, "\n  "))
	}
}

// TestParityMapsMatchSnapshot is the inverse gate: no stale or conflicting
// map entries survive a server route removal or rename.
func TestParityMapsMatchSnapshot(t *testing.T) {
	snapshot := loadAuthSnapshot(t)

	stale := []string{}
	for _, route := range sortedKeys(routeCoverage) {
		auth, ok := snapshot[route]
		switch {
		case !ok:
			stale = append(stale, route+" (mapped to `"+routeCoverage[route]+"` but gone from the snapshot: server route removed or renamed)")
		case auth == "superadmin":
			stale = append(stale, route+" (mapped to `"+routeCoverage[route]+"` but the snapshot marks it superadmin)")
		}
		if _, both := routeExclusions[route]; both {
			stale = append(stale, route+" (listed in both routeCoverage and routeExclusions)")
		}
	}
	for _, route := range sortedKeys(routeExclusions) {
		if _, ok := snapshot[route]; !ok {
			stale = append(stale, route+" (excluded but gone from the snapshot: drop the exclusion)")
		}
	}
	if len(stale) > 0 {
		t.Fatalf("stale parity map entrie(s) in cmd/parity_test.go:\n  %s", strings.Join(stale, "\n  "))
	}
}
