import {
  ENTITLEMENT_HINT,
  ROOTLESS_UNSUPPORTED_HINT,
  ROOTLESS_UNSUPPORTED_MARKER
} from './build-posture';

const DISK_FULL_RE = /no space left on device|low on resource: ephemeral-storage/i;

export const DISK_FULL_HINT =
  'The build node ran out of disk space. Free some on the node, for example by pruning the build cache under Admin > Build cache, or give it a larger disk, then redeploy.';

const REGISTRY_SERVER_ERROR_RE = /unexpected HTTP status: 5\d\d/;

export const REGISTRY_SERVER_ERROR_HINT =
  'The image registry failed while storing the image. The most common cause is the registry running out of disk; its own logs name the cause.';

const ENTITLEMENT_RE =
  /(security\.insecure|network\.host)[^\n]*not allowed|not allowed[^\n]*(security\.insecure|network\.host)|insecure entitlement/i;

// Step ids are BuildKit's own `#12` counter on plain output, or the stable
// digest-derived hex id the rawjson transcoder assigns.
const STEP_ERROR_RE = /^#([0-9a-f]{8}|\d+) ERROR:/;
const STEP_ERROR_PREFIX_RE = /^#(?:[0-9a-f]{8}|\d+) ERROR: /;

/**
 * Distill a failed build's log dump into the few lines a user needs. The full
 * logs already stream into buildLogs; the summary must stay short because the
 * UI surfaces it as the headline failure reason.
 */
export function summarizeBuildFailure(logs?: string | null, pusherLogs?: string | null): string {
  const parts: string[] = [];

  const lintMatch = (logs ?? '').match(/lint violation found for rules: ([A-Za-z0-9, ]+)/);
  if (lintMatch) {
    const rules = lintMatch[1].trim();
    parts.push(
      `Dockerfile lint check failed (${rules}). Your Dockerfile sets "# check=error=true", which turns Dockerfile lint warnings into build failures. Remove that line, or change it to "# check=skip=${rules.replace(/,\s*/g, ',')}" to skip these rules.`
    );
  }

  if ((logs ?? '').includes(ROOTLESS_UNSUPPORTED_MARKER)) parts.push(ROOTLESS_UNSUPPORTED_HINT);
  if (ENTITLEMENT_RE.test(logs ?? '')) parts.push(ENTITLEMENT_HINT);
  if (DISK_FULL_RE.test(`${logs ?? ''}\n${pusherLogs ?? ''}`)) parts.push(DISK_FULL_HINT);
  else if (REGISTRY_SERVER_ERROR_RE.test(pusherLogs ?? '')) parts.push(REGISTRY_SERVER_ERROR_HINT);

  const lines = (logs ?? '').split('\n');
  const solveError = lines.filter((l) => l.startsWith('error: failed to solve:')).pop();
  const stepErrors = lines.filter((l) => STEP_ERROR_RE.test(l)).slice(-2);
  parts.push(...stepErrors);

  // The "#N ERROR: process ... exit code: 1" line says a step failed, never why.
  // The why is in that step's own output, a few lines above it: "pnpm run build
  // did not complete successfully" says nothing about the Vite error that
  // actually broke the build. Carry the tail of the failing step's output so the
  // headline says the cause.
  const failingStep = stepErrors[stepErrors.length - 1]?.match(STEP_ERROR_RE)?.[1];
  if (failingStep) {
    const prefix = new RegExp(`^#${failingStep} (?:\\d+\\.\\d+ )?`);
    const own = lines
      .filter((l) => prefix.test(l) && !STEP_ERROR_RE.test(l))
      .map((l) => l.replace(prefix, '').trimEnd())
      .filter((l) => l.trim().length > 0);
    parts.push(...own.slice(-6));
  }

  if (
    solveError &&
    !stepErrors.some((e) => solveError.includes(e.replace(STEP_ERROR_PREFIX_RE, '')))
  ) {
    parts.push(solveError);
  }

  const reasonsMatch = (logs ?? '').match(
    /Build job failed with the following reasons:\n([\s\S]*?)(?:\n\n|$)/
  );
  if (reasonsMatch) {
    parts.push(
      ...reasonsMatch[1].split('\n').filter((l) => l.trim() && !l.endsWith(' - No message'))
    );
  }

  const pusherError = (pusherLogs ?? '')
    .split('\n')
    .filter((l) => /^(FATA|Error)\b|level=fatal/.test(l))
    .pop();
  if (pusherError) parts.push(`Pusher: ${pusherError}`);

  if (parts.length === 0) {
    const tail = lines.filter((l) => l.trim() && !l.startsWith('time=')).slice(-4);
    parts.push(...tail);
  }

  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    const key = p.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.join('\n').slice(0, 800);
}
