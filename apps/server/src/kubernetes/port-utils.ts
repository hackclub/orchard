import * as k8s from '@kubernetes/client-node';
import type { DeploymentPortInput, SanitizedPortEntry } from './kubernetes.service';

/**
 * Convert k8s V1ServicePort[] back into our SanitizedPortEntry shape so
 * deployment updates can reconcile container ports against existing service
 * defs. `fallback` is the previously-sanitized port list: used to resolve
 * string-named targetPorts and to short-circuit when the service has no
 * ports defined.
 */
export function mapServicePorts(
  ports: k8s.V1ServicePort[] | undefined,
  fallback: SanitizedPortEntry[] = []
): SanitizedPortEntry[] {
  if (!ports || ports.length === 0) {
    return fallback;
  }
  const mapped: SanitizedPortEntry[] = [];
  ports.forEach((entry, index) => {
    const portNumber = Number(entry.port);
    if (!Number.isInteger(portNumber) || portNumber <= 0) {
      return;
    }
    let containerPort = portNumber;
    const target = entry.targetPort;
    if (typeof target === 'number' && Number.isInteger(target) && target > 0) {
      containerPort = target;
    } else if (typeof target === 'string') {
      const numericTarget = Number.parseInt(target, 10);
      if (Number.isInteger(numericTarget) && numericTarget > 0) {
        containerPort = numericTarget;
      } else {
        const match = fallback.find((port) => port.name === target);
        if (match) {
          containerPort = match.containerPort;
        }
      }
    }
    const protocol =
      entry.protocol && entry.protocol.trim().length > 0
        ? entry.protocol.trim().toUpperCase()
        : 'TCP';
    let name =
      entry.name && entry.name.trim().length > 0
        ? entry.name.trim().toLowerCase()
        : `port-${index + 1}`;
    if (name.length > 63) {
      name = name.substring(0, 63);
    }
    const nodePort =
      typeof entry.nodePort === 'number' && Number.isInteger(entry.nodePort) && entry.nodePort > 0
        ? entry.nodePort
        : undefined;
    mapped.push({
      name,
      containerPort,
      servicePort: portNumber,
      protocol,
      nodePort
    });
  });
  return mapped;
}

/**
 * Dedupe service-port names, generating DNS-safe suffixes for collisions.
 */
export function ensureUniqueServicePorts(ports: SanitizedPortEntry[]): SanitizedPortEntry[] {
  const counts = new Map<string, number>();
  return ports.map((entry, index) => {
    let baseName = entry.name?.trim().toLowerCase() || `port-${index + 1}`;
    baseName = baseName.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
    if (!baseName) {
      baseName = `port-${index + 1}`;
    }
    const currentCount = counts.get(baseName) ?? 0;
    counts.set(baseName, currentCount + 1);
    let name = baseName;
    if (currentCount > 0) {
      const suffixValue = `-${currentCount}`;
      const trimmedBase = baseName.substring(0, Math.max(1, 63 - suffixValue.length));
      name = `${trimmedBase}${suffixValue}`;
    }
    return {
      ...entry,
      name
    };
  });
}

export interface PublicPortState {
  publicEnabled: boolean;
  publicPort: number | null;
  preserveClientIp: boolean;
}

export function publicPortKey(port: number, protocol: string | null | undefined): string {
  return `${port}:${(protocol || 'TCP').toUpperCase()}`;
}

export function snapshotPublicPortState(
  ports: {
    port: number;
    protocol: string | null;
    publicEnabled: boolean;
    publicPort: number | null;
    preserveClientIp?: boolean;
  }[]
): Map<string, PublicPortState> {
  const snapshot = new Map<string, PublicPortState>();
  for (const port of ports) {
    if (!port.publicEnabled || !port.publicPort) continue;
    snapshot.set(publicPortKey(port.port, port.protocol), {
      publicEnabled: true,
      publicPort: port.publicPort,
      preserveClientIp: port.preserveClientIp === true
    });
  }
  return snapshot;
}

/**
 * Pure normalizer for user-supplied port specs into K8s-safe entries.
 * Drops invalid ports, generates unique DNS-safe names, defaults to TCP,
 * and falls back to a single `http:80` port if nothing valid was supplied.
 *
 * Lives standalone so both KubernetesService (for service CRUD) and
 * K8sWorkloadService (for createDeployment) can call it without circular DI.
 */
export function sanitizePortEntries(portInputs: DeploymentPortInput[]): SanitizedPortEntry[] {
  const usedNames = new Set<string>();
  let autoCounter = 1;
  const sanitized: SanitizedPortEntry[] = [];

  portInputs.forEach((input, index) => {
    const containerPort = Number(input.containerPort ?? input.servicePort ?? 0);
    const servicePort = Number(input.servicePort ?? input.containerPort ?? 0);

    if (!Number.isInteger(containerPort) || containerPort <= 0) {
      return;
    }

    if (!Number.isInteger(servicePort) || servicePort <= 0) {
      return;
    }

    const requestedProtocol =
      typeof input.protocol === 'string' ? input.protocol.trim().toUpperCase() : '';
    const protocol = requestedProtocol === 'UDP' ? 'UDP' : 'TCP';

    const rawName = typeof input.name === 'string' ? input.name : '';
    let baseName = rawName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    baseName = baseName.replace(/^-+|-+$/g, '');
    if (!baseName) {
      baseName = `port-${autoCounter++}`;
    }
    if (baseName.length > 63) {
      baseName = baseName.substring(0, 63);
    }
    if (!baseName) {
      baseName = `port-${index + 1}`;
    }

    let name = baseName;
    let suffixCounter = 1;
    while (usedNames.has(name) || name.length === 0) {
      const suffix = `-${suffixCounter++}`;
      const trimmedBase = baseName.substring(0, Math.max(1, 63 - suffix.length));
      name = `${trimmedBase}${suffix}`;
    }
    usedNames.add(name);

    sanitized.push({
      name,
      containerPort,
      servicePort,
      protocol,
      nodePort:
        typeof (input as any).nodePort === 'number' &&
        Number.isInteger((input as any).nodePort) &&
        (input as any).nodePort > 0
          ? (input as any).nodePort
          : undefined
    });
  });

  if (sanitized.length === 0) {
    sanitized.push({
      name: 'http',
      containerPort: 80,
      servicePort: 80,
      protocol: 'TCP',
      nodePort: undefined
    });
  }

  return sanitized;
}
