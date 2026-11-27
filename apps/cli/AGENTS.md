# orchard CLI: agent guide

This file is for AI coding agents driving the `orchard` binary. Humans should read `README.md` instead.

## What orchard is

Orchard is a self-hostable app platform: deployments, databases, domains, scheduled jobs, and logs on Kubernetes. The `orchard` CLI speaks the same `/apiv1` REST API as the web UI and the MCP server, so every platform capability is reachable from this one binary. When stdout is not a TTY (i.e. whenever you run it as a subprocess), it emits JSON on stdout and keeps human status chatter on stderr, so you can pipe it straight into a parser without any flags.

## Auth for headless use

Set the instance URL and a token in the environment and skip login entirely:

```sh
export ORCHARD_API_URL=https://orchard.example.com
export ORCHARD_API_TOKEN=orch_xxx
```

There is no built-in instance. With nothing saved and no `ORCHARD_API_URL`, a command run without a terminal or in CI never prompts: it exits 1 naming `--api-url` and `ORCHARD_API_URL`.

`ORCHARD_API_TOKEN` overrides any token stored in `~/.orchard/config.json`.

Several instances can be signed in at once, one context each. `orchard context list` shows them, `orchard context use <name>` switches, and `--context <name>` or `ORCHARD_CONTEXT` picks one for a single command without changing the saved choice.

Tokens carry scopes, and each higher scope includes the lower ones (read is a subset of deploy, deploy is a subset of exec):

| scope  | allows                                                                  |
| ------ | ----------------------------------------------------------------------- |
| read   | most GET / HEAD / OPTIONS; `orchard api describe <op>` shows exceptions |
| deploy | read, plus every mutation (create, update, delete, scale, restart)      |
| exec   | deploy, plus interactive terminals: `pod exec`, `pod shell`, `db psql`, and creating or editing sandboxes, sandbox credentials, SSH identities and `claude import` |

Mint a token from an already-authenticated CLI (the secret prints once, default scope read, lifetime capped at 90 days):

```sh
orchard auth token create --name agent --scope deploy --expires-in 30d
orchard auth token create --name ci --scope read --project my-app   # project-restricted
```

Or create one in the web UI under Settings, API Tokens. Interactive humans can also run `orchard auth login` (browser flow) or `orchard auth login --token orch_xxx`. The first login asks for the instance URL on a terminal; add `--api-url <url>` to skip the question or to add another instance.

Other env vars:

| var                       | effect                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `ORCHARD_API_URL`         | API base. Required wherever no context is saved; there is no built-in default                       |
| `ORCHARD_API_TOKEN`       | credential, skips login                                                                             |
| `ORCHARD_CONTEXT`         | instance context to use instead of the current one                                                 |
| `ORCHARD_JSON=1`          | force JSON output even on a TTY                                                                     |
| `ORCHARD_ORG`             | default org scope (id or slug)                                                                      |
| `ORCHARD_PROJECT`         | default project scope (id or slug)                                                                  |
| `ORCHARD_ENV`             | default environment scope (id or name)                                                              |
| `ORCHARD_IDEMPOTENCY_KEY` | `Idempotency-Key` to send instead of a fresh one per mutation (see Retrying mutations safely)       |
| `ORCHARD_TS_AUTHKEY`      | Tailscale auth key for `orchard tailscale link`, instead of `--auth-key` or stdin                   |
| `ORCHARD_TS_LOGIN_SERVER` | self-hosted control server URL for `orchard tailscale link`, instead of `--login-server`            |
| `ORCHARD_INGRESS_CNAME`   | CNAME target the CLI and TUI show for custom domains                                                |
| `ORCHARD_SPEC_CACHE_DIR`  | directory for the cached `agent-spec.json` (default `~/.orchard`)                                   |

## Output contract

Format resolution, in order: explicit `-o json|table` flag, then `ORCHARD_JSON=1`, then TTY detection (TTY gets tables, a pipe gets JSON).

- Data goes to stdout. Status, progress, and warnings go to stderr. Parse stdout only.
- `orchard events tail` emits NDJSON when piped: one JSON object per line, shaped `{"eventId","type","organizationId","id","projectId","ts","payload"}`.
- `--follow` log commands (`deploy logs -f`, `pod logs -f`, `job-run logs -f`) stream plain log lines to stdout, one per line, until interrupted (or, for job runs, until the run finishes). `observe logs --follow` does the same on a TTY; piped, it emits one JSON log entry per line. `deploy logs --build -f` ends when the build ends, and exits 9 if it failed.
- One-shot log fetches in JSON mode return structured arrays (e.g. `deploy logs` returns `[{"pod","container","logs"}]`).
- On failure in JSON mode, a single error line is printed to stderr:

```json
{"error":{"status":429,"code":6,"message":"..."}}
```

`status` is the HTTP status (0 when the failure was not an API response), `code` is the process exit code.

## Exit codes

| code | meaning                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- |
| 0    | success                                                                                                  |
| 1    | generic or network error, or no token configured                                                         |
| 2    | usage error, or a confirmation prompt was refused                                                        |
| 3    | authentication rejected (HTTP 401)                                                                       |
| 4    | not found (HTTP 404)                                                                                     |
| 5    | API rejected the request (other HTTP 4xx, including 403 missing scope)                                   |
| 6    | rate limited (HTTP 429)                                                                                  |
| 7    | server error (HTTP 5xx)                                                                                  |
| 8    | `--wait` gave up after `--timeout`                                                                       |
| 9    | `deploy-failed`: the build failed during a wait                                                          |
| 10   | `deploy-crashing`: pods crash-loop or the rollout is unhealthy, or `db diagnose` found the database down |
| 11   | `checks-failed`: `orchard doctor` found at least one failing check                                       |
| 130  | interrupted (Ctrl-C / SIGTERM)                                                                           |

## Scoping

Most commands need an org, project, or environment scope. Precedence, highest first:

1. flags: `--org`, `--project`, `--env`
2. env vars: `ORCHARD_ORG`, `ORCHARD_PROJECT`, `ORCHARD_ENV`
3. saved context: `orchard use org|project|env <id-or-slug>` (written to `~/.orchard/config.json`)

Values may be ids or slugs (environments: id or name); the CLI resolves them. Inspect or reset the saved context with `orchard context show` / `orchard context clear`. Prefer flags or env vars over `orchard use` when you might share the machine with other sessions: the saved context is global mutable state.

## Pagination

Cursor-paginated lists (`audit list`, `job runs <id>`) take:

- `--limit N` (page size, default 50)
- `--cursor C` (resume from a previous `nextCursor`)
- `--all` (fetch every page, safety-capped at 100 pages)

JSON output includes a `nextCursor` field when more pages remain; pass it back via `--cursor`. Other list commands return the full set in one response.

## --wait / --timeout

Commands that start async work accept `--wait` (block until a terminal state) and `--timeout` (default 10m; hitting it exits 8): `deploy create|scale|start|restart|rebuild|rollback`, `deploy image set`, `up`, `import`, `db create`, `db backup create|restore`, `db fork`, `db checkpoint restore|restore-group`, `db ops get|undo`, `db test-backup run`, `db trash restore`, `db upgrade`, `job run`. Without `--wait` they return as soon as the API accepts the request. Progress while waiting goes to stderr; stdout still carries only the data payload.

## Rollout flow: is it live, and if not, why

Every deployment `--wait` (and `up`, `import`) waits on `GET /deployments/:id/rollout`, which answers in one call:

```json
{"phase": "crashing", "terminal": true, "releaseId": "...", "url": "https://...",
 "build": {"status": "succeeded", "step": "complete", "error": null, "logTail": []},
 "pods": {"desired": 1, "ready": 0, "failing": [{"pod": "web-7c9", "reason": "CrashLoopBackOff",
   "exitCode": 1, "restarts": 4, "logTail": ["Error: DATABASE_URL is not set"]}]},
 "hint": "The app keeps exiting (exit code 1). ..."}
```

- Phases: `queued`, `building`, `deploying` (keep waiting), then one terminal phase: `live` or `stopped` (success), `build_failed` (exit 9), `crashing` or `unhealthy` (exit 10). `unhealthy` means new pods fail while old ones keep serving; it is a failure, not a timeout.
- On failure the CLI prints `build.error` or each failing pod's reason, then the log tail, to stderr.
- With `--wait` in JSON mode, stdout carries the rollout result (`deploymentId`, `releaseId`, `phase`, `url`, `build`, `pods`, `hint`), including on exit 9/10, so an agent can read the diagnosis without a second call. `deploy create --wait` and `import --wait` merge it into their create payload under `rollout` and set `url`.
- Mutating deployment endpoints (rebuild, scale, start, restart, rollback, image set, build-context upload) return `rolloutSince` (and `releaseId` when the call recorded a release). Pass them back as `?since=` / `?release=` so a wait right after a restart can't read `live` off the old pods. The CLI does this for you.
- One-off check: `orchard deploy status <id>` (add `--wait` to block). Raw: `orchard api GET '/deployments/<id>/rollout?wait=1&timeout=60'` long-polls server-side for up to 120s.
- `orchard up` waits until the deploy is live by default. `--wait=false` returns when the build finishes. In JSON mode the build log streams to stderr and stdout gets one object: `{deploymentId, releaseId, phase, url, ...}`.

## Database recovery

Restores, forks, undeletes and restore tests are durable operations. The starting command prints the operation id on stderr and the operation object on stdout; `--wait` long-polls `GET /database-operations/:id?wait=1` until `status` is `succeeded` or `failed` (failed exits 1 with the server's `error`), and stdout then carries the final operation.

```sh
orchard db diagnose <dbId> -o json        # verdict, reasons, backups window, last restore test, log tail; exit 10 when down
orchard db recovery <dbId>                # how far back it can be restored
orchard db checkpoint create <dbId> --label before-migration
orchard db checkpoint create --project my-app --env production   # every database at once, one group id
orchard db backup restore <dbId> --yes --wait                    # in place, latest recoverable point
orchard db backup restore <dbId> --at 2026-10-30T09:00:00Z --fork --name scratch --wait
orchard db checkpoint restore <checkpointId> --yes --wait
orchard db ops undo <operationId> --yes   # swap back to the copy from before an in-place restore (24h)
orchard db fork <dbId> --name copy --env staging --wait          # live copy, original untouched
orchard db test-backup run <dbId> --wait  # restore the latest backup into a throwaway copy and check it
orchard db trash list --project my-app && orchard db trash restore <deletedId> --wait
```

Postgres versions and CVEs:

```sh
orchard db versions                       # majors on offer (from the CloudNativePG catalog), default marked
orchard db security <dbId> -o json        # running version, CVEs with fixedInVersion, action, minorUpdate, upgrades
orchard db upgrade <dbId> --to 18 --yes --wait   # rehearsal on a copy, then in place; Postgres is offline during the real step
```

`db security` exits 0 whatever it finds; branch on the JSON (`jq -e '.action != "major_upgrade"'`). Minor versions roll automatically (`minorUpdate.automatic`). A failed upgrade is reverted to the old version; `--no-rehearse` skips the copy.

An in-place restore takes a checkpoint first and keeps the previous copy stopped for 24 hours. `db delete` moves a database with a completed backup to the trash for 30 days; `db protect <dbId> --deletion on` makes the server refuse the delete.

## Retrying mutations safely

Create, deploy, rebuild, restart, rollback, database create and job run endpoints honour an `Idempotency-Key` header for 24 hours. The same key with the same body replays the first response (header `Idempotent-Replayed: true`) instead of doing the work twice. The same key with a different body is a 422, and a request still in flight with that key is a 409. The CLI sends a fresh key on every mutation; to make a retried command safe after a timeout or a dropped connection, set `ORCHARD_IDEMPOTENCY_KEY` to a value you reuse for that one command:

```sh
key=$(uuidgen)
ORCHARD_IDEMPOTENCY_KEY=$key orchard deploy rebuild <deploymentId> --wait
ORCHARD_IDEMPOTENCY_KEY=$key orchard deploy rebuild <deploymentId> --wait   # retry after a dropped connection: replays, no second build
```

Generate a new key for each intended action. Reusing one for a deliberate second rebuild within 24 hours replays the first response instead of rebuilding.

## Destructive commands and --yes

Delete/revoke/restore style commands ask for confirmation. With stdin or stdout not a TTY the CLI never prompts: it fails immediately with exit 2 unless you pass `--yes` (`-y`). Always pass `--yes` explicitly when you intend a destructive operation.

## Rate limits

Requests authenticated with an `orch_` token get 600 requests per 60 seconds per token; everything else gets 200 per 60 seconds per IP. Exceeding it returns HTTP 429 (exit 6) with a `Retry-After` header in seconds; read-only CLI calls retry on their own after that delay. A long-polling `rollout?wait=1` call counts once however long it waits. Do not poll in a tight loop; long-poll or subscribe instead:

```sh
orchard events tail --types deployment.changed,build.changed
```

`events tail` reconnects automatically and can resume from a known point with `--since-id`.

## Escape hatch: orchard api

Any `/apiv1` endpoint is reachable directly, so you are never blocked on a missing wrapper command:

```sh
orchard api GET /projects
orchard api POST /deployments/<id>/scale --data '{"replicas":3}'
echo '{"replicas":3}' | orchard api POST /deployments/<id>/scale --data -
```

The complete route list (method + path for every endpoint) lives in the repo at `apps/server/test/auth-coverage.snapshot.json`. The MCP tool sources at `apps/server/src/mcp/tools/*.ts` map capabilities to REST paths 1:1.

## Recipes

One-shot import (creates the project, detects the build, deploys, returns the URL):

```sh
orchard import owner/repo --wait
```

Deploy from GitHub and wait for it to come up (exit 9 if the build fails, 10 if it crashes):

```sh
export ORCHARD_PROJECT=my-app
orchard deploy create --name web --github owner/repo#main --port 3000 --wait --timeout 15m
```

Ship a fix and branch on the result:

```sh
orchard deploy rebuild <deploymentId> --wait -o json > rollout.json
case $? in
  0) jq -r .url rollout.json ;;
  9) jq -r .build.error rollout.json ;;
  10) jq -r '.pods.failing[] | .reason, .logTail[]' rollout.json ;;
esac
```

Roll back to the previous release (with no history id, `POST /deployments/:id/rollback` picks the previous image):

```sh
orchard deploy rollback <deploymentId> --yes --wait
```

Deployments with a port get an auto-generated platform URL (org-protected;
`--auto-url=false` to skip). The create response carries it as `url`.

Deploy a local directory (requires server-side build-context storage):

```sh
orchard link --project my-app   # once per checkout; writes .orchard/project.json
orchard up                      # pack, upload, build, follow logs
orchard up --wait -o json | jq -r .url   # block until live; exit 9/10 on failure
```

Pull environment variables into a local dotenv file (secrets come out as
commented placeholders, values are write-only):

```sh
orchard env pull                # writes .env.orchard
orchard env pull -o json        # prints [{key, value, secret}] instead; secrets have value null
```

Tail logs:

```sh
orchard logs <deploymentId> -f                       # shortcut for deploy logs
orchard deploy logs <deploymentId> --follow          # runtime logs, all pods
orchard deploy logs <deploymentId> --build --follow  # build logs
orchard pod logs <podName> -f --tail 200             # one pod
```

Set env vars from a dotenv file:

```sh
orchard env vars set --file .env                 # shared vars on the scoped environment
orchard env vars set STRIPE_KEY=sk_x --secret    # write-only, encrypted at rest
orchard deploy env set <deploymentId> --file .env  # per-deployment vars (pods restart)
```

Run a job and follow it:

```sh
run_id=$(orchard job run <jobId> --wait --timeout 30m | jq -r .id)
orchard job-run logs "$run_id"
```

Import your Claude Code setup (CLAUDE.md, agents, commands, skills, MCP servers from
`~/.claude` and `~/.claude.json`) into your account, encrypted at rest. Off a TTY it
needs `--yes`; `--dry-run` lists what would be sent, including which MCP env/header keys
carry values, without uploading:

```sh
orchard claude import --dry-run
orchard claude import --yes --only agent,skill
orchard claude list
orchard claude remove command/git:commit --yes
```

Subscribe to org events (NDJSON, one event per line):

```sh
ORCHARD_ORG=my-org orchard events tail --types deployment.changed --since-id <lastEventId>
```

## Write a script

For anything a wrapper command does not cover, or a job that chains several calls, discover the operation and call it by `operationId`. The spec comes from `/apiv1/agent-spec.json` and is cached in `~/.orchard/agent-spec.json` (ETag-revalidated at most hourly, used offline when the server is unreachable; `--refresh` forces a revalidation).

```sh
orchard api search "rollout status"              # ranked operationIds, -o json for jq
orchard api describe deployments_rollout_get     # params, body + response schema, scope, flags
orchard api deployments_rollout_get -p id=<uuid> -q wait=1 -q timeout=120
orchard api deployments_env_set -p id=<uuid> -d @env.json --yes
```

- `-p name=value` fills path params, `-q name=value` adds query params (both repeatable), `-d` takes JSON, `@file` or `-` for stdin.
- Operations flagged destructive (deletes, whole-list replaces like `deployments_env_set`, stops) need `--yes` off a TTY. Sensitive ones (`databases_connection_get`, webhook token creation) return secrets: keep them out of logs.
- `orchard api METHOD /path` still works and skips the spec.

Deploy and wait for it to be live:

```sh
release=$(orchard api deployments_rebuild -p id=$APP | jq -r .releaseId)
orchard api deployments_rollout_get -p id=$APP -q wait=1 -q timeout=120 -q release=$release | jq '{phase,url,hint}'
```

Find crashing deployments across a project:

```sh
for id in $(orchard api projects_deployments_list -p id=$PROJECT | jq -r '.[].id'); do
  orchard api deployments_rollout_get -p id=$id | jq -c --arg id $id 'select(.phase=="crashing" or .phase=="build_failed") | {id:$id,phase,hint}'
done
```

Bulk env update that keeps every other var (secrets read back `null`, and `null` keeps the stored value):

```sh
for id in $(orchard api projects_deployments_list -p id=$PROJECT | jq -r '.[].id'); do
  orchard api deployments_get -p id=$id \
    | jq '{env: ([.envVars[] | {key,value,secret}] | map(select(.key!="LOG_LEVEL")) + [{key:"LOG_LEVEL",value:"info"}])}' \
    | orchard api deployments_env_set -p id=$id -d - --yes
done
```

From Node, with the same token:

```js
const base = process.env.ORCHARD_API_URL;
const api = (p) => fetch(`${base}/apiv1${p}`, { headers: { Authorization: `Bearer ${process.env.ORCHARD_API_TOKEN}` } }).then((r) => r.json());
for (const d of await api(`/projects/${process.env.PROJECT}/deployments`)) {
  const r = await api(`/deployments/${d.id}/rollout`);
  if (!['live', 'stopped'].includes(r.phase)) console.log(d.name, r.phase, r.hint);
}
```

Agents without a shell get the same API through the compact MCP (`https://mcp.<domain>/compact`: `search_api`, `describe_operation`, `call_api`).
