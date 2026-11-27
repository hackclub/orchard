import type * as k8s from '@kubernetes/client-node';
import { hardenedSecurityContext } from './trusted-images';
import { deviceRuntimeClassName, holdsDevices, liveDeviceQuantities } from './devices';

export const ROLLOUT_MIN_READY_SECONDS = 10;

export const ROLLOUT_PROGRESS_DEADLINE_SECONDS = 600;

export const ROLLOUT_GATE_TIMEOUT_MS = 10 * 60 * 1000;

export const ROLLOUT_GATE_POLL_MS = 3000;

export type DeployStrategy = 'rollingUpdate' | 'recreate' | 'blueGreen';

export function rollingUpdateStrategy() {
  return {
    type: 'RollingUpdate' as const,
    rollingUpdate: { maxSurge: '25%', maxUnavailable: 0 }
  };
}

export function k8sStrategyFor(strategy: DeployStrategy): k8s.V1DeploymentStrategy {
  return strategy === 'recreate'
    ? ({ type: 'Recreate', rollingUpdate: null } as unknown as k8s.V1DeploymentStrategy)
    : rollingUpdateStrategy();
}

export type RolloutAssessment =
  | { state: 'ready' }
  | { state: 'progressing'; detail: string }
  | { state: 'failed'; reason: string };

const FATAL_WAITING_REASONS = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError'
]);

function podStartedAfter(pod: k8s.V1Pod, sinceMs: number): boolean {
  const created = pod.metadata?.creationTimestamp;
  if (!created) return true;
  return new Date(created).getTime() >= sinceMs - 1000;
}

function describeContainerFailure(status: k8s.V1ContainerStatus): string | null {
  const waiting = status.state?.waiting;
  if (waiting?.reason && FATAL_WAITING_REASONS.has(waiting.reason)) {
    const last = status.lastState?.terminated;
    const exit =
      last && typeof last.exitCode === 'number'
        ? ` (exit ${last.exitCode}${last.reason ? `, ${last.reason}` : ''})`
        : '';
    return `${waiting.reason}${exit}`;
  }
  const terminated = status.lastState?.terminated ?? status.state?.terminated;
  if (terminated && (status.restartCount ?? 0) >= 2) {
    return `restarting (exit ${terminated.exitCode}${terminated.reason ? `, ${terminated.reason}` : ''})`;
  }
  if (terminated?.reason === 'OOMKilled' && (status.restartCount ?? 0) >= 1) {
    return 'OOMKilled';
  }
  return null;
}

/**
 * Read a Deployment and the pods it owns and say whether the rollout that
 * started at `sinceMs` has landed, is still moving, or cannot land. Pods that
 * predate the rollout are the old ReplicaSet's and are ignored: a rolling
 * update keeps them serving on purpose while the new ones come up.
 */
export function assessRollout(
  dep: k8s.V1Deployment,
  pods: readonly k8s.V1Pod[],
  sinceMs: number
): RolloutAssessment {
  const wanted = dep.spec?.replicas ?? 1;
  if (wanted === 0) return { state: 'ready' };

  const generation = dep.metadata?.generation ?? 0;
  const observed = dep.status?.observedGeneration ?? 0;
  if (observed < generation) {
    return { state: 'progressing', detail: 'waiting for the controller to observe the change' };
  }

  for (const condition of dep.status?.conditions ?? []) {
    if (condition.type === 'ReplicaFailure' && condition.status === 'True') {
      return { state: 'failed', reason: condition.message || 'ReplicaFailure' };
    }
    if (
      condition.type === 'Progressing' &&
      condition.status === 'False' &&
      condition.reason === 'ProgressDeadlineExceeded'
    ) {
      return { state: 'failed', reason: 'pods never became ready before the deadline' };
    }
  }

  const fresh = pods.filter((pod) => podStartedAfter(pod, sinceMs));
  for (const pod of fresh) {
    for (const status of pod.status?.containerStatuses ?? []) {
      const failure = describeContainerFailure(status);
      if (failure) {
        return {
          state: 'failed',
          reason: `${pod.metadata?.name ?? 'pod'} is ${failure}`
        };
      }
    }
  }

  const status = dep.status ?? {};
  const updated = status.updatedReplicas ?? 0;
  const ready = status.readyReplicas ?? 0;
  const available = status.availableReplicas ?? 0;
  const total = status.replicas ?? 0;
  if (updated >= wanted && ready >= wanted && available >= wanted && total <= wanted) {
    return { state: 'ready' };
  }
  return {
    state: 'progressing',
    detail: `${ready}/${wanted} ready, ${updated}/${wanted} updated, ${total} total`
  };
}

export function greenName(name: string): string {
  return `${name}--green`;
}

export const APP_LABEL = 'orchard.my/app';

export const SLOT_LABEL = 'orchard.my/slot';

const NAME_LABEL = 'app.kubernetes.io/name';

function stripServerFields(meta: k8s.V1ObjectMeta | undefined): k8s.V1ObjectMeta {
  const out: k8s.V1ObjectMeta = { ...(meta ?? {}) };
  delete out.resourceVersion;
  delete out.uid;
  delete out.creationTimestamp;
  delete out.generation;
  delete out.managedFields;
  delete out.selfLink;
  if (out.annotations) {
    const annotations = { ...out.annotations };
    delete annotations['deployment.kubernetes.io/revision'];
    delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
    out.annotations = annotations;
  }
  return out;
}

/**
 * The green Deployment is the blue one cloned with a new name, its own
 * selector, and the candidate image. It shares the env Secret, the volumes
 * (which must not include a ReadWriteOnce claim, see `blueGreenBlocker`), the
 * placement and the resources, so what it proves is exactly what blue will
 * run once it settles.
 */
export function buildGreenDeployment(
  blue: k8s.V1Deployment,
  opts: { image: string; args?: string[] | null; progressDeadlineSeconds?: number }
): k8s.V1Deployment {
  const name = blue.metadata?.name ?? '';
  const green = greenName(name);
  const clone: k8s.V1Deployment = JSON.parse(JSON.stringify(blue));
  const metadata = stripServerFields(clone.metadata);
  metadata.name = green;
  metadata.labels = {
    ...(metadata.labels ?? {}),
    [NAME_LABEL]: green,
    [APP_LABEL]: name,
    [SLOT_LABEL]: 'green'
  };
  clone.metadata = metadata;
  delete clone.status;

  const spec: k8s.V1DeploymentSpec = clone.spec ?? { selector: {}, template: {} };
  spec.selector = { matchLabels: { [NAME_LABEL]: green } };
  spec.strategy = rollingUpdateStrategy();
  spec.progressDeadlineSeconds = opts.progressDeadlineSeconds ?? ROLLOUT_PROGRESS_DEADLINE_SECONDS;
  spec.minReadySeconds = ROLLOUT_MIN_READY_SECONDS;
  const template: k8s.V1PodTemplateSpec = spec.template ?? {};
  template.metadata = {
    ...(template.metadata ?? {}),
    labels: {
      ...(template.metadata?.labels ?? {}),
      [NAME_LABEL]: green,
      [APP_LABEL]: name,
      [SLOT_LABEL]: 'green'
    }
  };
  const containers = template.spec?.containers ?? [];
  if (containers[0]) {
    containers[0].image = opts.image;
    containers[0].securityContext = hardenedSecurityContext();
    if (opts.args !== undefined) {
      if (opts.args && opts.args.length) containers[0].args = opts.args;
      else delete containers[0].args;
    }
  }
  if (template.spec) {
    template.spec.runtimeClassName = deviceRuntimeClassName(
      Object.keys(liveDeviceQuantities(containers[0]?.resources))
    );
  }
  spec.template = template;
  clone.spec = spec;
  return clone;
}

export function blueGreenBlocker(blue: k8s.V1Deployment): string | null {
  const volumes = blue.spec?.template?.spec?.volumes ?? [];
  if (volumes.some((v) => v.persistentVolumeClaim?.claimName)) {
    return "blue/green can't run two copies of a ReadWriteOnce volume";
  }
  if ((blue.spec?.template?.spec?.containers ?? []).some((c) => holdsDevices(c.resources))) {
    return "blue/green can't run a second copy of an app that holds a device. Switch it to Recreate";
  }
  return null;
}

export function slotSelector(name: string, slot: 'blue' | 'green'): Record<string, string> {
  return { [NAME_LABEL]: slot === 'green' ? greenName(name) : name };
}

export function selectorPointsAt(
  service: k8s.V1Service,
  name: string,
  slot: 'blue' | 'green'
): boolean {
  const want = slotSelector(name, slot)[NAME_LABEL];
  return service.spec?.selector?.[NAME_LABEL] === want;
}

export type RolloutRevision = {
  hash: string;
  number: number;
  image: string | null;
  createdAt: string | null;
  replicas: number;
  ready: number;
};

export type RolloutSummary = {
  currentRevision: string | null;
  revisions: RolloutRevision[];
  previous: RolloutRevision | null;
  desired: number;
  updated: number;
  ready: number;
  available: number;
  state: 'stable' | 'progressing' | 'failed';
  reason: string | null;
};

export function revisionOf(obj: { metadata?: k8s.V1ObjectMeta } | undefined): string | null {
  return obj?.metadata?.labels?.['pod-template-hash'] ?? null;
}

export function summarizeRollout(
  dep: k8s.V1Deployment,
  replicaSets: readonly k8s.V1ReplicaSet[]
): RolloutSummary {
  const revisions = replicaSets
    .map((rs): RolloutRevision | null => {
      const hash = revisionOf(rs);
      if (!hash) return null;
      return {
        hash,
        number: Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0),
        image: rs.spec?.template?.spec?.containers?.[0]?.image ?? null,
        createdAt: rs.metadata?.creationTimestamp
          ? new Date(rs.metadata.creationTimestamp).toISOString()
          : null,
        replicas: rs.status?.replicas ?? 0,
        ready: rs.status?.readyReplicas ?? 0
      };
    })
    .filter((r): r is RolloutRevision => r !== null)
    .sort((a, b) => b.number - a.number);

  const current = revisions[0] ?? null;
  const live = revisions.filter((r) => r === current || r.replicas > 0);
  const previous =
    revisions.find((r) => r !== current && r.ready > 0) ??
    revisions.find((r) => r !== current) ??
    null;
  const desired = dep.spec?.replicas ?? 0;
  const status = dep.status ?? {};
  const updated = status.updatedReplicas ?? 0;
  const ready = status.readyReplicas ?? 0;
  const available = status.availableReplicas ?? 0;
  const total = status.replicas ?? 0;

  let state: RolloutSummary['state'] = 'stable';
  let reason: string | null = null;
  for (const condition of status.conditions ?? []) {
    if (
      condition.type === 'Progressing' &&
      condition.status === 'False' &&
      condition.reason === 'ProgressDeadlineExceeded'
    ) {
      state = 'failed';
      reason = 'ProgressDeadlineExceeded';
    }
    if (condition.type === 'ReplicaFailure' && condition.status === 'True' && !reason) {
      reason = condition.message || 'ReplicaFailure';
    }
  }
  if (state !== 'failed') {
    const behind = (dep.metadata?.generation ?? 0) > (status.observedGeneration ?? 0);
    const settled = updated >= desired && available >= desired && total <= desired;
    const finished = (status.conditions ?? []).some(
      (c) => c.type === 'Progressing' && c.reason === 'NewReplicaSetAvailable'
    );
    if (behind || live.length > 1 || (!settled && !finished)) state = 'progressing';
  }

  return {
    currentRevision: current?.hash ?? null,
    revisions: live,
    previous,
    desired,
    updated,
    ready,
    available,
    state,
    reason
  };
}

export function summarizeBlueGreen(
  blue: RolloutSummary,
  green: k8s.V1Deployment,
  greenSets: readonly k8s.V1ReplicaSet[]
): RolloutSummary {
  const next = summarizeRollout(green, greenSets);
  const current = next.revisions[0];
  if (!current) return blue;
  const previous = blue.revisions.find((r) => r.hash === blue.currentRevision);
  const number = Math.max(current.number, (previous?.number ?? 0) + 1);
  return {
    ...next,
    currentRevision: current.hash,
    revisions: [{ ...current, number }, ...(previous ? [previous] : [])],
    previous: previous ?? null,
    state: next.state === 'failed' ? 'failed' : 'progressing'
  };
}
