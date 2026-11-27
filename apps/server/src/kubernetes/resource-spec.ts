import { cpuMilliToK8s, cpuRequestFromLimitMilli, memoryBytesToK8s } from './quantity';
import { parsePgMemory } from './db-tuning';
import { isDeviceResource, liveDeviceQuantities, withDevices } from './devices';

const MiB = 1024 * 1024;

export const NO_LIMITS_ANNOTATION = 'orchard.my/no-limits';

export const NO_LIMITS_APP_REQUESTS = { cpuMilli: 50, memoryBytes: 64 * MiB };
export const NO_LIMITS_DATABASE_REQUESTS = { cpuMilli: 100, memoryBytes: 256 * MiB };

const SHARED_BUFFERS_REQUEST_HEADROOM = 1.25;

export interface PodSizing {
  cpuMilli: number;
  memoryBytes: number;
  noLimits?: { cpuMilli: number; memoryBytes: number };
}

export interface ContainerResources {
  requests: Record<string, string>;
  limits?: Record<string, string>;
}

export function containerResources(size: PodSizing): ContainerResources {
  if (size.noLimits) {
    return {
      requests: {
        cpu: cpuMilliToK8s(size.noLimits.cpuMilli),
        memory: memoryBytesToK8s(size.noLimits.memoryBytes)
      }
    };
  }
  const memory = memoryBytesToK8s(size.memoryBytes);
  return {
    requests: { cpu: cpuMilliToK8s(cpuRequestFromLimitMilli(size.cpuMilli)), memory },
    limits: { cpu: cpuMilliToK8s(size.cpuMilli), memory }
  };
}

export function containerResourcesPatch(size: PodSizing) {
  const resources = containerResources(size);
  return resources.limits ? resources : { ...resources, limits: null };
}

export function appResourcesPatch(size: PodSizing) {
  const resources = containerResources(size);
  return resources.limits ? resources : { ...resources, limits: { cpu: null, memory: null } };
}

export function noLimitsMetadataPatch(size: PodSizing) {
  return size.noLimits ? { metadata: { annotations: { [NO_LIMITS_ANNOTATION]: 'true' } } } : {};
}

export function applySizingTo(deployment: any, size: PodSizing): void {
  const container = deployment?.spec?.template?.spec?.containers?.[0];
  if (container) {
    container.resources = withDevices(
      containerResources(size),
      liveDeviceQuantities(container.resources)
    );
  }
  if (size.noLimits && deployment?.metadata) {
    deployment.metadata.annotations = {
      ...(deployment.metadata.annotations ?? {}),
      [NO_LIMITS_ANNOTATION]: 'true'
    };
  }
}

export function hasLimits(resources?: { limits?: Record<string, unknown> | null } | null): boolean {
  return Object.keys(resources?.limits ?? {}).some((key) => !isDeviceResource(key));
}

export function runsWithoutLimitsOnPurpose(
  annotations: Record<string, string> | null | undefined,
  resources?: { limits?: Record<string, unknown> | null } | null
): boolean {
  return annotations?.[NO_LIMITS_ANNOTATION] === 'true' && !hasLimits(resources);
}

export function isUnlimitedRow(row: {
  cpuRequestMilli: number | null;
  memoryRequestBytes: bigint | number | null;
}): boolean {
  return (
    row.cpuRequestMilli === 0 &&
    (row.memoryRequestBytes === null || Number(row.memoryRequestBytes) === 0)
  );
}

export function databaseSizing(size: PodSizing, sharedBuffers?: string | null): PodSizing {
  if (!size.noLimits) return size;
  const buffers = parsePgMemory(sharedBuffers ?? '');
  const needed = Math.ceil((buffers * SHARED_BUFFERS_REQUEST_HEADROOM) / MiB) * MiB;
  return {
    ...size,
    noLimits: {
      cpuMilli: size.noLimits.cpuMilli,
      memoryBytes: Math.max(size.noLimits.memoryBytes, needed)
    }
  };
}

export function liveMatchesMode(
  mode: 'on' | 'off',
  resources?: { limits?: Record<string, unknown> | null } | null
): boolean {
  return mode === 'off' ? !hasLimits(resources) : hasLimits(resources);
}
