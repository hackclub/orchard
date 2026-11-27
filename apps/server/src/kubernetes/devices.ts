import { Logger } from '@nestjs/common';
import { tenantRuntimeClassName } from './trusted-images';

export interface DeviceClass {
  resource: string;
  label: string;
  runtimeClassName?: string;
  max: number;
}

export type DeviceRequest = Record<string, number>;

const DEFAULT_MAX = 1;
const MAX_CEILING = 16;
const RESOURCE_NAME =
  /^(?=.{1,253}\/)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const RUNTIME_CLASS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export const isDeviceResource = (name: string): boolean => {
  if (!RESOURCE_NAME.test(name)) return false;
  const domain = name.slice(0, name.indexOf('/'));
  return domain !== 'kubernetes.io' && !domain.endsWith('.kubernetes.io');
};

const logger = new Logger('DeviceClasses');
const warnedFor = new Set<string>();

const describe = (entry: unknown): string => {
  try {
    return JSON.stringify(entry) ?? String(entry);
  } catch {
    return String(entry);
  }
};

export function parseDeviceClasses(
  raw: string | undefined,
  warn: (message: string) => void = (message) => logger.warn(message)
): DeviceClass[] {
  const text = raw?.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warn(
      `DEVICE_CLASSES is not valid JSON, so no devices are offered: ${(error as Error).message}`
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    warn(`DEVICE_CLASSES must be a JSON array, so no devices are offered. Got ${describe(parsed)}`);
    return [];
  }
  const out: DeviceClass[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warn(`DEVICE_CLASSES entry ${describe(entry)} is not an object and was dropped`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const resource = typeof e.resource === 'string' ? e.resource.trim() : '';
    if (!isDeviceResource(resource)) {
      warn(
        `DEVICE_CLASSES entry ${describe(entry)} was dropped: resource must be a domain-prefixed extended resource outside kubernetes.io, such as nvidia.com/gpu`
      );
      continue;
    }
    if (seen.has(resource)) {
      warn(`DEVICE_CLASSES entry ${describe(entry)} was dropped: ${resource} is listed twice`);
      continue;
    }
    let runtimeClassName: string | undefined;
    if (e.runtimeClassName != null && e.runtimeClassName !== '') {
      const candidate = typeof e.runtimeClassName === 'string' ? e.runtimeClassName.trim() : '';
      if (RUNTIME_CLASS_NAME.test(candidate)) {
        runtimeClassName = candidate;
      } else {
        warn(
          `DEVICE_CLASSES entry ${describe(entry)} was dropped: runtimeClassName ${describe(e.runtimeClassName)} is not a valid RuntimeClass name`
        );
        continue;
      }
    }
    let max = DEFAULT_MAX;
    if (e.max != null) {
      const asked = typeof e.max === 'string' && /^\d+$/.test(e.max.trim()) ? Number(e.max) : e.max;
      if (typeof asked === 'number' && Number.isInteger(asked) && asked >= 1) {
        max = Math.min(asked, MAX_CEILING);
        if (asked > MAX_CEILING) {
          warn(
            `DEVICE_CLASSES entry ${describe(entry)} has max ${asked}, above the ceiling of ${MAX_CEILING}, so it uses ${MAX_CEILING}`
          );
        }
      } else {
        warn(
          `DEVICE_CLASSES entry ${describe(entry)} has max ${describe(e.max)}, which is not a whole number of at least 1, so it uses ${DEFAULT_MAX}`
        );
      }
    }
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : resource;
    seen.add(resource);
    out.push({ resource, label, max, ...(runtimeClassName ? { runtimeClassName } : {}) });
  }
  return out;
}

export const deviceClasses = (env: NodeJS.ProcessEnv = process.env): DeviceClass[] => {
  const raw = env.DEVICE_CLASSES;
  const firstParse = raw != null && !warnedFor.has(raw);
  if (raw != null) warnedFor.add(raw);
  return parseDeviceClasses(raw, firstParse ? undefined : () => undefined);
};

export function validateDeviceRequest(
  input: unknown,
  classes: DeviceClass[] = deviceClasses(),
  stored: DeviceRequest = {}
): DeviceRequest {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Devices must be an object of resource name to count');
  }
  const out = new Map<string, number>();
  for (const [resource, count] of Object.entries(input as Record<string, unknown>)) {
    if (!isDeviceResource(resource)) {
      throw new Error(`${resource} isn't a device resource name, such as nvidia.com/gpu`);
    }
    const cls = classes.find((c) => c.resource === resource);
    const label = cls?.label ?? resource;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw new Error(`${label} takes a whole number of devices`);
    }
    if (count === 0) continue;
    if (!cls) {
      if (stored[resource] === count) {
        out.set(resource, count);
        continue;
      }
      throw new Error(`${resource} isn't a device this instance offers`);
    }
    if (count > cls.max && stored[resource] !== count) {
      throw new Error(`${label} takes a whole number from 0 to ${cls.max}`);
    }
    out.set(resource, count);
  }
  const runtimes = new Set(
    classes.filter((c) => out.has(c.resource)).map((c) => c.runtimeClassName ?? '')
  );
  if (runtimes.size > 1) {
    throw new Error(
      `${[...out.keys()].join(' and ')} need different runtimes, so they can't be attached together`
    );
  }
  return Object.fromEntries(out);
}

export function storedDevices(value: unknown): DeviceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: DeviceRequest = {};
  for (const [resource, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = Math.trunc(Number(raw));
    if (isDeviceResource(resource) && Number.isFinite(count) && count > 0) out[resource] = count;
  }
  return out;
}

export function deviceQuantities(devices: DeviceRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [resource, count] of Object.entries(devices)) {
    if (count > 0) out[resource] = String(count);
  }
  return out;
}

export function liveDeviceQuantities(
  resources?: { limits?: Record<string, unknown> | null } | null
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(resources?.limits ?? {})) {
    if (isDeviceResource(key) && value != null) out[key] = String(value);
  }
  return out;
}

export class DeviceNotOfferedError extends Error {
  constructor(readonly resource: string) {
    super(
      `${resource} is attached to this app, but the instance no longer offers it. Detach it in Settings > Resources, or ask an admin to add it back to DEVICE_CLASSES.`
    );
    this.name = 'DeviceNotOfferedError';
  }
}

export function deviceRuntimeClassName(
  resources: Iterable<string>,
  classes: DeviceClass[] = deviceClasses()
): string | undefined {
  let runtimeClassName: string | undefined;
  for (const resource of resources) {
    const cls = classes.find((c) => c.resource === resource);
    if (!cls) throw new DeviceNotOfferedError(resource);
    runtimeClassName ??= cls.runtimeClassName;
  }
  return runtimeClassName ?? tenantRuntimeClassName();
}

export function deviceRuntimeClassPatch(
  resources: Iterable<string>,
  classes: DeviceClass[] = deviceClasses()
): { runtimeClassName?: string | null } {
  const all = [...resources];
  const offered = all.filter((r) => classes.some((c) => c.resource === r));
  const explicit = offered
    .map((r) => classes.find((c) => c.resource === r)?.runtimeClassName)
    .find(Boolean);
  if (offered.length < all.length && !explicit) return {};
  return { runtimeClassName: deviceRuntimeClassName(offered, classes) ?? null };
}

export const holdsDevices = (
  resources?: { limits?: Record<string, unknown> | null } | null
): boolean => Object.keys(liveDeviceQuantities(resources)).length > 0;

export function deviceResourcesPatch(
  desired: DeviceRequest,
  live: Record<string, string>
): { requests: Record<string, string | null>; limits: Record<string, string | null> } {
  const quantities: Record<string, string | null> = {};
  for (const key of Object.keys(live)) quantities[key] = null;
  Object.assign(quantities, deviceQuantities(desired));
  return { requests: { ...quantities }, limits: { ...quantities } };
}

export function withDevices<
  T extends { requests?: Record<string, string>; limits?: Record<string, string> }
>(resources: T | undefined, devices: Record<string, string>): T | undefined {
  if (Object.keys(devices).length === 0) return resources;
  return {
    ...(resources ?? ({} as T)),
    requests: { ...(resources?.requests ?? {}), ...devices },
    limits: { ...(resources?.limits ?? {}), ...devices }
  };
}

export function sameDevices(a: DeviceRequest, b: DeviceRequest): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  return true;
}
