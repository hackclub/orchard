import { z } from 'zod';
import type { RouteAttachment } from '../types';

const orgEventType = z.enum([
  'deployment.changed',
  'database.changed',
  'build.changed',
  'project.changed',
  'pod.changed',
  'membership.changed',
  'deployment.metrics',
  'job.changed',
  'jobrun.changed',
  'environment.changed',
  'sharedvars.changed',
  'engine.changed',
  'audit.created'
]);

export const auditCreatedPayload = z
  .object({
    action: z.string(),
    deploymentId: z.string().nullable(),
    projectId: z.string().nullable(),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    targetLabel: z.string().nullable(),
    actorUserId: z.string().nullable()
  })
  .passthrough()
  .describe('Payload for audit.created events; id on the envelope is the audit log row id');

export const buildChangedPayload = z
  .object({
    buildStatus: z.string().optional()
  })
  .passthrough()
  .describe(
    'Payload for build.changed events when the write carried a build status; absent for other build writes'
  );

export const jobRunChangedPayload = z
  .object({
    jobId: z.string(),
    runId: z.string(),
    number: z.number().int(),
    status: z.string(),
    currentStepOrder: z.number().int().nullable()
  })
  .passthrough()
  .describe('Payload for jobrun.changed events');

export const deploymentMetricsPayload = z
  .object({
    totalCpuUsage: z.number().describe('Total CPU usage across pods, millicores'),
    totalMemoryUsage: z.number().describe('Total memory usage across pods, bytes'),
    pods: z.record(
      z.string(),
      z.object({ cpuUsage: z.number(), memoryUsage: z.number() }).passthrough()
    )
  })
  .passthrough()
  .describe('Payload for deployment.metrics events, keyed by pod name');

export const orgEvent = z
  .object({
    organizationId: z.string(),
    type: orgEventType,
    id: z
      .string()
      .optional()
      .describe(
        'The changed entity id (deployment, database, job, run, environment, ...); the affected user id for membership.changed'
      ),
    projectId: z.string().optional(),
    ts: z.number().describe('Emit time, Unix epoch milliseconds'),
    payload: z
      .union([
        jobRunChangedPayload,
        deploymentMetricsPayload,
        auditCreatedPayload,
        buildChangedPayload,
        z.unknown()
      ])
      .optional()
      .describe(
        'Event-specific payload: structured for jobrun.changed, deployment.metrics, audit.created and build.changed, informer-derived data for pod.changed and database.changed, absent otherwise'
      )
  })
  .passthrough();

export const heartbeatEvent = z
  .object({
    type: z.literal('heartbeat'),
    ts: z.number()
  })
  .passthrough()
  .describe('Keepalive sent every 25s so proxies do not kill the stream');

export const orgEventStreamMessage = z
  .union([orgEvent, heartbeatEvent])
  .describe('The JSON-decoded data field of one SSE message on the org event stream');

export const terminalClientResizeFrame = z
  .object({
    type: z.literal('resize'),
    cols: z.number().int(),
    rows: z.number().int()
  })
  .passthrough()
  .describe('Terminal resize notification (JSON text frame, handled client-side)');

export const terminalClientInputFrame = z
  .string()
  .describe('Raw terminal input forwarded to the shell stdin (any non-resize text frame)');

export const terminalClientFrame = z
  .union([terminalClientResizeFrame, terminalClientInputFrame])
  .describe(
    'Client-to-server frame on ws(s)://host/apiv1/pods/:podName/exec?namespace=...&container=... (session cookie or Bearer API token with the exec scope; project edit access required)'
  );

export const terminalServerFrame = z
  .string()
  .describe(
    'Server-to-client frame: raw stdout/stderr bytes (binary), or a text notice before close. Close codes: 1000 shell exited, 4401 access revoked mid-session, 1011 exec error'
  );

const podFileQuery = (path: string) =>
  z.object({
    namespace: z.string().describe('Pod namespace'),
    path: z.string().optional().describe(path),
    container: z
      .string()
      .optional()
      .describe('Container name (defaults to the first container in the pod spec)')
  });

export const podFileEntry = z
  .object({
    name: z.string(),
    kind: z.enum(['file', 'dir', 'symlink', 'other']),
    size: z
      .number()
      .int()
      .nullable()
      .describe('Size in bytes for regular files and symlinks to files; null otherwise'),
    mtime: z.number().int().nullable().describe('Modification time in unix seconds'),
    mode: z.string().nullable().describe('ls -l style mode, such as drwxr-xr-x'),
    owner: z.string().nullable().describe('Owner name, or numeric uid'),
    group: z.string().nullable().describe('Group name, or numeric gid'),
    target: z
      .enum(['file', 'dir'])
      .nullable()
      .describe('What a symlink points at; null when it is dangling, neither, or not a symlink'),
    linkTo: z.string().nullable().describe('The symlink text, for symlinks')
  })
  .passthrough();

export const podMount = z
  .object({
    path: z.string(),
    volume: z.string(),
    type: z.enum(['persistent', 'temporary', 'config', 'secret', 'other']),
    readOnly: z.boolean(),
    claim: z.string().nullable().describe('PersistentVolumeClaim name, for persistent mounts')
  })
  .passthrough();

const writtenPodFile = z
  .object({
    path: z.string(),
    size: z.number().int().nullable(),
    mtime: z.number().int().nullable()
  })
  .passthrough();

const podPathResult = z.object({ path: z.string() }).passthrough();

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'GET /events/orgs/:orgId': {
    summary:
      'Server-sent events stream of org changes, scoped to projects the caller can see; each SSE message data field is one JSON event, resumable via Last-Event-ID',
    request: z.object({
      lastEventId: z
        .string()
        .optional()
        .describe(
          'Resume after this event id (Redis stream id); the Last-Event-ID header takes precedence'
        )
    }),
    response: orgEventStreamMessage
  },
  'GET /pods/:podName/files': {
    summary: 'List a directory inside a running pod, with its mounts',
    scope: 'exec',
    request: podFileQuery('Absolute directory path (default /)'),
    response: z
      .object({
        path: z.string().describe('The normalized directory that was listed'),
        writable: z.boolean().describe('Whether the directory accepts new files'),
        truncated: z
          .boolean()
          .describe('True when the folder held more than 10,000 entries or 2 MiB of listing'),
        entries: z.array(podFileEntry),
        mounts: z.array(podMount)
      })
      .passthrough()
  },
  'GET /pods/:podName/files/content': {
    summary: 'Read up to 1 MiB of a file inside a running pod as text',
    scope: 'exec',
    request: podFileQuery('Absolute path of a readable regular file'),
    response: z
      .object({
        path: z.string(),
        size: z.number().int().nullable(),
        mtime: z.number().int().nullable(),
        binary: z.boolean().describe('True when the file holds NUL bytes or is not UTF-8'),
        truncated: z.boolean().describe('True when the file is longer than 1 MiB'),
        content: z.string().nullable().describe('The text, or null for binary files')
      })
      .passthrough()
  },
  'PUT /pods/:podName/files/content': {
    summary:
      'Replace a text file inside a running pod (query: namespace, path, container), keeping its mode and owner',
    scope: 'exec',
    query: podFileQuery('Absolute path of the file to write'),
    request: z
      .object({
        content: z.string().describe('New UTF-8 content, at most 1 MiB'),
        expectedMtime: z
          .number()
          .int()
          .nullable()
          .optional()
          .describe('mtime the file had when it was opened; a mismatch answers 409 modified')
      })
      .passthrough(),
    response: writtenPodFile
  },
  'GET /pods/:podName/files/download': {
    summary:
      'Download a file from a running pod, or a folder as .tar.gz; inline=1 shows raster images inline',
    scope: 'exec',
    request: podFileQuery('Absolute path of a readable file or folder').extend({
      inline: z
        .enum(['0', '1'])
        .optional()
        .describe('1 to display a png, jpeg, gif, webp, avif, bmp or ico image inline')
    })
  },
  'PUT /pods/:podName/files/upload': {
    summary:
      'Upload a file into a running pod; the raw request body is the file (Content-Length required, at most 512 MiB)',
    scope: 'exec',
    binaryBody: true,
    query: podFileQuery('Absolute path of the file to create').extend({
      overwrite: z
        .enum(['0', '1'])
        .optional()
        .describe('1 to replace an existing file; otherwise an existing file answers 409 exists')
    }),
    response: writtenPodFile
  },
  'POST /pods/:podName/files/mkdir': {
    summary: 'Create a folder, and any missing parents, inside a running pod',
    scope: 'exec',
    query: podFileQuery('Absolute path of the folder to create'),
    response: podPathResult
  },
  'POST /pods/:podName/files/move': {
    summary: 'Rename or move a file or folder inside a running pod',
    scope: 'exec',
    query: podFileQuery('Absolute path to move').extend({
      to: z.string().describe('Absolute destination path; must not exist yet')
    }),
    response: podPathResult
  },
  'DELETE /pods/:podName/files': {
    summary: 'Delete a file, or a folder and everything in it, inside a running pod',
    scope: 'exec',
    query: podFileQuery('Absolute path to delete'),
    response: z.object({ path: z.string(), kind: z.enum(['file', 'dir']) }).passthrough()
  },
  'POST /pods/:podName/exec': {
    summary: 'Run a one-shot command in a pod (synchronous, non-streaming)',
    scope: 'exec',
    request: z
      .object({
        namespace: z
          .string()
          .optional()
          .describe('Pod namespace; required here or as a ?namespace= query param'),
        command: z
          .union([z.string(), z.array(z.string())])
          .describe("Command to run; a string is wrapped as ['/bin/sh', '-c', command]"),
        container: z
          .string()
          .optional()
          .describe('Container name (defaults to the first container in the pod spec)'),
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe('Timeout in milliseconds, clamped to 1000..300000 (default 60000)')
      })
      .passthrough(),
    response: z
      .object({
        stdout: z.string(),
        stderr: z.string(),
        success: z.boolean(),
        container: z.string().describe('The container the command ran in')
      })
      .passthrough()
  }
};
