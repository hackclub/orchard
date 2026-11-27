const parseRef = (image: string): { repo: string; tag: string; host: string | null } => {
  const noDigest = image.split('@')[0];
  const slashIdx = noDigest.indexOf('/');
  let remainder = noDigest;
  let host: string | null = null;
  if (slashIdx > 0) {
    const maybeHost = noDigest.slice(0, slashIdx);
    if (maybeHost.includes('.') || maybeHost.includes(':') || maybeHost === 'localhost') {
      host = maybeHost.toLowerCase();
      remainder = noDigest.slice(slashIdx + 1);
    }
  }
  const colonIdx = remainder.lastIndexOf(':');
  if (colonIdx === -1) return { repo: remainder, tag: 'latest', host };
  return { repo: remainder.slice(0, colonIdx), tag: remainder.slice(colonIdx + 1), host };
};

export const imageRepo = (image: string): string => parseRef(image).repo;

// Tags that a registry can move under you. A deployment pinned to one of these
// will not pick up a new push unless its pull policy is Always, which is the
// single most common "why is it still serving the old build" report.
const MUTABLE_TAGS = new Set([
  'latest',
  'main',
  'master',
  'stable',
  'edge',
  'dev',
  'develop',
  'nightly',
  'prod',
  'production',
  'release'
]);

export const isMutableImageTag = (image: string | null | undefined): boolean => {
  const raw = String(image ?? '').trim();
  if (!raw) return false;
  // A digest pins the exact bytes, so nothing can move under it.
  if (raw.includes('@sha256:')) return false;
  const { tag } = parseRef(raw);
  if (MUTABLE_TAGS.has(tag.toLowerCase())) return true;
  // A floating version like `17` or `1.2` tracks the newest patch under it.
  return /^v?\d+(\.\d+)?$/.test(tag);
};

export type ImagePullPolicyValue = 'Always' | 'IfNotPresent';

// What the pull policy should be when nobody has said otherwise. A tag that can
// move only behaves the way people expect under Always: otherwise the node
// reuses its cached layer and pushing over the tag silently changes nothing.
export const defaultPullPolicyForImage = (
  image: string | null | undefined
): ImagePullPolicyValue => (isMutableImageTag(image) ? 'Always' : 'IfNotPresent');

// `override` is the stored column: null means "derive", anything else is the
// user's explicit choice and wins.
export const resolvePullPolicy = (
  override: string | null | undefined,
  image: string | null | undefined
): ImagePullPolicyValue =>
  override === 'Always' || override === 'IfNotPresent'
    ? override
    : defaultPullPolicyForImage(image);

export const hardenedSecurityContext = () => ({
  allowPrivilegeEscalation: false,
  capabilities: {
    drop: ['ALL'],
    add: ['SETUID', 'SETGID', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'SYS_CHROOT', 'NET_BIND_SERVICE']
  },
  seccompProfile: { type: 'RuntimeDefault' as const }
});

export const tenantRuntimeClassName = (): string | undefined =>
  process.env.TENANT_RUNTIME_CLASS || undefined;

export const EGRESS_BANDWIDTH_ANNOTATION = 'kubernetes.io/egress-bandwidth';

const BANDWIDTH_QUANTITY = /^[1-9]\d*(?:[kKMGT]i?)?$/;

export const tenantEgressBandwidth = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const raw = env.TENANT_EGRESS_BANDWIDTH?.trim();
  return raw && BANDWIDTH_QUANTITY.test(raw) ? raw : undefined;
};

export const tenantPodAnnotations = (
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> | undefined => {
  const bandwidth = tenantEgressBandwidth(env);
  return bandwidth ? { [EGRESS_BANDWIDTH_ANNOTATION]: bandwidth } : undefined;
};
