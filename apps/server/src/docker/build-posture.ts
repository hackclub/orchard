import type * as k8s from '@kubernetes/client-node';
import { DEFAULT_BUILDKIT_IMAGE, DEFAULT_BUILDKIT_ROOTLESS_IMAGE } from './buildkit-image';

export type BuildPosture = 'vm-sandbox' | 'rootless' | 'privileged-host';

export const ROOTLESS_UID = 1000;
export const ROOTLESS_HOME = '/home/user';
export const ROOTLESS_STATE_PATH = `${ROOTLESS_HOME}/.local/share/buildkit`;
export const ROOTLESS_DOCKER_CONFIG = `${ROOTLESS_HOME}/.docker`;
export const ROOTLESS_CONFIG_KEY = 'buildkitd.rootless.toml';
export const ROOTLESS_CONFIG_PATH = `/etc/buildkit/${ROOTLESS_CONFIG_KEY}`;
export const ROOTLESS_RUNTIME_DIR = '/tmp/orchard-run';
export const ROOTLESS_BIN_DIR = '/tmp/orchard-bin';
export const ROOTLESS_UNSUPPORTED_MARKER = 'ORCHARD_ROOTLESS_UNSUPPORTED';

export interface PostureEnv {
  [key: string]: string | undefined;
  BUILDER_RUNTIME_CLASS?: string;
  BUILDER_ALLOW_PRIVILEGED_ON_HOST?: string;
  BUILDER_SIDECAR_PUSH?: string;
  BUILDKIT_IMAGE?: string;
  BUILDKIT_ROOTLESS_IMAGE?: string;
}

export function resolveBuildPosture(env: PostureEnv = process.env): BuildPosture {
  if ((env.BUILDER_RUNTIME_CLASS || '').trim()) return 'vm-sandbox';
  if ((env.BUILDER_ALLOW_PRIVILEGED_ON_HOST || '').trim().toLowerCase() === 'true') {
    return 'privileged-host';
  }
  return 'rootless';
}

export function effectiveSidecarPush(
  posture: BuildPosture,
  env: PostureEnv = process.env
): boolean {
  if (posture === 'rootless') return true;
  return env.BUILDER_SIDECAR_PUSH !== 'false';
}

export function rootlessImageFor(image: string, override?: string): string {
  const explicit = (override || '').trim();
  if (explicit) return explicit;
  const base = image.split('@')[0];
  const slash = base.lastIndexOf('/');
  const colon = base.indexOf(':', slash + 1);
  if (colon === -1) return `${base}:rootless`;
  const tag = base.slice(colon + 1);
  if (tag.endsWith('rootless')) return base;
  return `${base}-rootless`;
}

export function buildkitImageFor(posture: BuildPosture, env: PostureEnv = process.env): string {
  const image = env.BUILDKIT_IMAGE || DEFAULT_BUILDKIT_IMAGE;
  if (posture !== 'rootless') return image;
  if (image === DEFAULT_BUILDKIT_IMAGE && !(env.BUILDKIT_ROOTLESS_IMAGE || '').trim()) {
    return DEFAULT_BUILDKIT_ROOTLESS_IMAGE;
  }
  return rootlessImageFor(image, env.BUILDKIT_ROOTLESS_IMAGE);
}

export function rootlessContainerSecurityContext(): k8s.V1SecurityContext {
  return {
    privileged: false,
    runAsNonRoot: true,
    runAsUser: ROOTLESS_UID,
    runAsGroup: ROOTLESS_UID,
    allowPrivilegeEscalation: true,
    seccompProfile: { type: 'Unconfined' },
    appArmorProfile: { type: 'Unconfined' }
  } as k8s.V1SecurityContext;
}

export function builderContainerSecurityContext(
  posture: BuildPosture
): k8s.V1SecurityContext | undefined {
  if (posture === 'rootless') return rootlessContainerSecurityContext();
  return { privileged: true };
}

export function rootlessAppArmorAnnotations(containerNames: string[]): Record<string, string> {
  return Object.fromEntries(
    containerNames.map((name) => [
      `container.apparmor.security.beta.kubernetes.io/${name}`,
      'unconfined'
    ])
  );
}

export function rootlessBuildkitdFlags(root?: string): string {
  return `--config ${ROOTLESS_CONFIG_PATH} --oci-worker-no-process-sandbox${root ? ` --root ${root}` : ''}`;
}

export function rootlessPreflightScript(onFail = ''): string {
  return `
if command -v unshare >/dev/null 2>&1 && ! unshare -Ur true >/dev/null 2>&1; then
  echo "${ROOTLESS_UNSUPPORTED_MARKER}: this node does not allow unprivileged user namespaces, which rootless builds need."
${onFail ? `  ${onFail}\n` : ''}  exit 78
fi
`;
}

export function rootlessDaemonlessWrapper(innerScript: string): string {
  return `export XDG_RUNTIME_DIR=${ROOTLESS_RUNTIME_DIR}
mkdir -p "$XDG_RUNTIME_DIR/buildkit" ${ROOTLESS_BIN_DIR}
chmod 700 "$XDG_RUNTIME_DIR"
ORCHARD_BUILDKIT_ADDR="unix://$XDG_RUNTIME_DIR/buildkit/buildkitd.sock"
printf '#!/bin/sh\\nexec buildctl --addr "%s" "$@"\\n' "$ORCHARD_BUILDKIT_ADDR" > ${ROOTLESS_BIN_DIR}/buildctl-daemonless.sh
chmod +x ${ROOTLESS_BIN_DIR}/buildctl-daemonless.sh
export PATH=${ROOTLESS_BIN_DIR}:$PATH
${innerScript}`;
}

export function rootlessDaemonStart(): string {
  return `$BUILDKITD_ENV rootlesskit buildkitd $BUILDKITD_FLAGS --addr "$ORCHARD_BUILDKIT_ADDR" &
DAEMON_PID=$!
for i in $(seq 1 100); do
  buildctl --addr "$ORCHARD_BUILDKIT_ADDR" debug workers >/dev/null 2>&1 && break
  sleep 0.1
done`;
}

export function postureSummary(posture: BuildPosture, runtimeClass?: string): string {
  switch (posture) {
    case 'vm-sandbox':
      return `builds run in a privileged BuildKit container inside the "${runtimeClass}" sandbox runtime (VM-isolated from the node kernel)`;
    case 'rootless':
      return 'builds run in rootless BuildKit (unprivileged, uid 1000, user namespaces, seccomp/AppArmor unconfined) on the node runtime; install a sandbox runtime (builderSandbox.enabled) for stronger isolation';
    case 'privileged-host':
      return 'WARNING: builds run in a PRIVILEGED BuildKit container on the node runtime (builders.allowPrivilegedOnHost=true); a malicious Dockerfile RUN step is root on the node. Only use this for clusters where every builder is trusted';
  }
}

export function logBuildPosture(
  posture: BuildPosture,
  runtimeClass: string | undefined,
  log: Pick<Console, 'log' | 'warn'> = console
): void {
  const line = `[ImageBuilder] build posture: ${posture}: ${postureSummary(posture, runtimeClass)}`;
  if (posture === 'privileged-host') log.warn(line);
  else log.log(line);
}

export const ROOTLESS_UNSUPPORTED_HINT =
  'This cluster cannot run rootless builds because its nodes do not allow unprivileged user namespaces (for example Ubuntu 24.04 with kernel.apparmor_restrict_unprivileged_userns=1, or user.max_user_namespaces=0). Ask the operator to allow them, enable a sandbox runtime (builderSandbox.enabled), or explicitly set builders.allowPrivilegedOnHost=true.';

export const ENTITLEMENT_HINT =
  'This Dockerfile uses RUN --security=insecure or RUN --network=host. Orchard does not grant those BuildKit entitlements to builds, because they break out of the build sandbox. Remove the flag.';
