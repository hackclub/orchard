import { isPlatformBuiltImage } from '../docker/build-platform';
import { resolvePullPolicy } from '../kubernetes/trusted-images';

export const IMAGE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type ImageTrackingBlocker = 'no_image' | 'source' | 'platform' | 'digest' | 'pull_policy';

export interface ImageTrackingRow {
  image: string | null;
  imagePullPolicy: string | null;
  githubRepo: string | null;
  buildContextKey: string | null;
  gitConnectionId: string | null;
}

export interface ImageUpdateRow extends ImageTrackingRow {
  stopped: boolean;
  imageAutoUpdate: boolean;
  imageCheckedRef: string | null;
  imageRunningDigest: string | null;
  imageLatestDigest: string | null;
  imageAttemptedDigest: string | null;
  imageCheckedAt: Date | null;
  imageCheckError: string | null;
  imageUpdatedAt: Date | null;
}

export interface ImageUpdateStatus {
  image: string | null;
  tracked: boolean;
  blocker: ImageTrackingBlocker | null;
  autoUpdate: boolean;
  runningDigest: string | null;
  latestDigest: string | null;
  updateAvailable: boolean;
  pending: boolean;
  checkedAt: string | null;
  error: string | null;
  updatedAt: string | null;
}

export function imageTrackingBlocker(row: ImageTrackingRow): ImageTrackingBlocker | null {
  const image = row.image?.trim();
  if (!image) return 'no_image';
  if (row.githubRepo || row.buildContextKey || row.gitConnectionId) return 'source';
  if (isPlatformBuiltImage(image)) return 'platform';
  if (image.includes('@')) return 'digest';
  if (resolvePullPolicy(row.imagePullPolicy, image) !== 'Always') return 'pull_policy';
  return null;
}

export function runningDigestAgainst(running: string[], latest: string | null): string | null {
  if (running.length === 0) return null;
  if (!latest) return running[0];
  return running.find((digest) => digest !== latest) ?? latest;
}

function checkedForCurrentImage(row: ImageUpdateRow): boolean {
  return row.imageCheckedRef != null && row.imageCheckedRef === row.image;
}

export function rolloutPending(row: ImageUpdateRow): boolean {
  if (!row.imageUpdatedAt) return false;
  return !row.imageCheckedAt || row.imageCheckedAt < row.imageUpdatedAt;
}

export function isUpdateAvailable(row: ImageUpdateRow): boolean {
  if (imageTrackingBlocker(row) || row.stopped || !checkedForCurrentImage(row)) return false;
  if (rolloutPending(row)) return false;
  return (
    row.imageLatestDigest != null &&
    row.imageRunningDigest != null &&
    row.imageLatestDigest !== row.imageRunningDigest
  );
}

export function shouldAutoUpdate(row: ImageUpdateRow): boolean {
  return (
    row.imageAutoUpdate &&
    isUpdateAvailable(row) &&
    !row.imageCheckError?.startsWith('restart_failed') &&
    row.imageAttemptedDigest !== row.imageLatestDigest
  );
}

export function needsCheck(row: ImageUpdateRow, now: number): boolean {
  if (imageTrackingBlocker(row) || row.stopped) return false;
  if (!checkedForCurrentImage(row) || !row.imageCheckedAt) return true;
  return now - row.imageCheckedAt.getTime() >= IMAGE_CHECK_INTERVAL_MS;
}

export function imageUpdateStatus(row: ImageUpdateRow): ImageUpdateStatus {
  const blocker = imageTrackingBlocker(row);
  const current = !blocker && checkedForCurrentImage(row);
  return {
    image: row.image,
    tracked: blocker === null,
    blocker,
    autoUpdate: row.imageAutoUpdate,
    runningDigest: current ? row.imageRunningDigest : null,
    latestDigest: current ? row.imageLatestDigest : null,
    updateAvailable: isUpdateAvailable(row),
    pending: !blocker && rolloutPending(row),
    checkedAt: current ? (row.imageCheckedAt?.toISOString() ?? null) : null,
    error: current ? row.imageCheckError : null,
    updatedAt: row.imageUpdatedAt?.toISOString() ?? null
  };
}
