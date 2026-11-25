import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AuditService, type AuditMetadataValue } from '../audit/audit.service';
import { GLOBAL_LEADER_LEASE, LeaseService } from '../coordination/lease.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { PrismaService } from '../prisma/prisma.service';
import { QuotasService } from '../quotas/quotas.service';
import { resolveImageDigest } from './image-ports';
import {
  IMAGE_CHECK_INTERVAL_MS,
  imageTrackingBlocker,
  imageUpdateStatus,
  runningDigestAgainst,
  shouldAutoUpdate,
  type ImageUpdateRow,
  type ImageUpdateStatus
} from './image-updates';
import { RegistryCredentialsService } from './registry-credentials.service';

const SWEEP_MS = 15 * 60 * 1000;
const SWEEP_BATCH = 50;
const SWEEP_PAGE = 200;
const SWEEP_MAX_PAGES = 25;

const CANDIDATE_WHERE = {
  image: { not: null },
  githubRepo: null,
  buildContextKey: null,
  gitConnectionId: null,
  stopped: false,
  NOT: { image: { contains: '@' } },
  AND: [{ OR: [{ imagePullPolicy: null }, { imagePullPolicy: 'Always' as const }] }]
};

const BLOCKER_MESSAGES = {
  no_image: 'This app has no image to update.',
  source: 'This app builds from source. Redeploy it to pick up changes.',
  platform: 'This image was built by Orchard. Redeploy the app to rebuild it.',
  digest: 'This image is pinned to a digest. Change the image to move to another version.',
  pull_policy:
    'This tag is pinned to a version. Change the image to update it, or set the pull policy to Always to follow the tag.'
} as const;

const ROW_SELECT = {
  id: true,
  name: true,
  namespace: true,
  projectId: true,
  image: true,
  imagePullPolicy: true,
  githubRepo: true,
  buildContextKey: true,
  gitConnectionId: true,
  stopped: true,
  replicas: true,
  cpuRequestMilli: true,
  memoryRequestBytes: true,
  imageAutoUpdate: true,
  imageCheckedRef: true,
  imageRunningDigest: true,
  imageLatestDigest: true,
  imageAttemptedDigest: true,
  imageCheckedAt: true,
  imageCheckError: true,
  imageUpdatedAt: true
} as const;

type Row = ImageUpdateRow & {
  id: string;
  name: string;
  namespace: string;
  projectId: string;
  replicas: number;
  cpuRequestMilli: number | null;
  memoryRequestBytes: bigint | null;
};

@Injectable()
export class ImageUpdatesService {
  private readonly logger = new Logger(ImageUpdatesService.name);

  private running = false;

  private readonly rollingOut = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly lease: LeaseService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly quotas: QuotasService,
    private readonly registryCredentials: RegistryCredentialsService,
    private readonly audit: AuditService
  ) {}

  @Interval(SWEEP_MS)
  async sweep(): Promise<void> {
    if (!this.lease.canCoordinate || !this.lease.isHolder(GLOBAL_LEADER_LEASE) || this.running) {
      return;
    }
    this.running = true;
    try {
      const now = Date.now();
      await this.checkDue(now);
      await this.applyAutoUpdates();
    } finally {
      this.running = false;
    }
  }

  private async checkDue(now: number): Promise<void> {
    const cutoff = new Date(now - IMAGE_CHECK_INTERVAL_MS);
    const seen = new Set<string>();
    let checked = 0;
    for (let page = 0; page < SWEEP_MAX_PAGES && checked < SWEEP_BATCH; page++) {
      const rows = (await this.prisma.deployment.findMany({
        where: {
          ...CANDIDATE_WHERE,
          id: { notIn: [...seen] },
          OR: [{ imageCheckedAt: null }, { imageCheckedAt: { lt: cutoff } }]
        },
        select: ROW_SELECT,
        orderBy: { imageCheckedAt: { sort: 'asc', nulls: 'first' } },
        take: SWEEP_PAGE
      })) as Row[];
      if (rows.length === 0) return;
      const blocked: Row[] = [];
      for (const row of rows) {
        seen.add(row.id);
        if (imageTrackingBlocker(row)) {
          blocked.push(row);
          continue;
        }
        if (checked >= SWEEP_BATCH) continue;
        checked++;
        await this.check(row).catch(async (err: any) => {
          this.logger.warn(`image check for ${row.id} failed: ${err?.message ?? err}`);
          await this.prisma.deployment
            .update({
              where: { id: row.id },
              data: {
                imageCheckedAt: new Date(),
                imageCheckError: clipError(String(err?.message ?? err))
              }
            })
            .catch(() => undefined);
        });
      }
      await this.parkBlocked(blocked);
    }
  }

  private async parkBlocked(rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    await this.prisma.deployment.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: {
        imageCheckedAt: new Date(),
        imageCheckedRef: null,
        imageLatestDigest: null,
        imageRunningDigest: null,
        imageCheckError: null,
        imageAutoUpdate: false
      }
    });
  }

  private async applyAutoUpdates(): Promise<void> {
    const rows = (await this.prisma.deployment.findMany({
      where: { imageAutoUpdate: true },
      select: ROW_SELECT
    })) as Row[];
    const blocked = rows.filter((row) => imageTrackingBlocker(row));
    await this.parkBlocked(blocked);
    for (const row of rows) {
      if (!shouldAutoUpdate(row) || this.rollingOut.has(row.id)) continue;
      await this.rollout(row, null).catch((err: any) =>
        this.logger.warn(`image auto-update for ${row.id} failed: ${err?.message ?? err}`)
      );
    }
  }

  async status(deploymentId: string): Promise<ImageUpdateStatus> {
    let row = await this.load(deploymentId);
    if (row.imageAutoUpdate && imageTrackingBlocker(row)) {
      row = (await this.prisma.deployment.update({
        where: { id: row.id },
        data: { imageAutoUpdate: false },
        select: ROW_SELECT
      })) as Row;
    }
    if (!imageTrackingBlocker(row) && !row.stopped && row.imageCheckedRef !== row.image) {
      row = await this.check(row);
    }
    return imageUpdateStatus(row);
  }

  async checkNow(deploymentId: string): Promise<ImageUpdateStatus> {
    const row = await this.load(deploymentId);
    this.assertTracked(row);
    return imageUpdateStatus(await this.check(row));
  }

  async updateNow(deploymentId: string, userId: string): Promise<ImageUpdateStatus> {
    let row = await this.load(deploymentId);
    this.assertTracked(row);
    if (row.stopped) throw new BadRequestException('Start the app before updating its image');
    row = await this.check(row);
    if (row.imageCheckError && !row.imageLatestDigest) {
      throw new BadRequestException(
        `Couldn't reach the registry for ${row.image} (${row.imageCheckError})`
      );
    }
    return imageUpdateStatus(await this.rollout(row, userId));
  }

  async setAutoUpdate(
    deploymentId: string,
    enabled: boolean,
    userId: string
  ): Promise<ImageUpdateStatus> {
    if (typeof enabled !== 'boolean') throw new BadRequestException('autoUpdate must be a boolean');
    const row = await this.load(deploymentId);
    if (enabled) this.assertTracked(row);
    const updated = (await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { imageAutoUpdate: enabled, ...(enabled && { imageAttemptedDigest: null }) },
      select: ROW_SELECT
    })) as Row;
    if (row.imageAutoUpdate !== enabled) {
      void this.log(
        row,
        enabled ? 'deployment.image_auto_update.enabled' : 'deployment.image_auto_update.disabled',
        userId,
        { image: row.image }
      );
    }
    return imageUpdateStatus(updated);
  }

  private async load(deploymentId: string): Promise<Row> {
    const row = (await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: ROW_SELECT
    })) as Row | null;
    if (!row) throw new NotFoundException('Deployment not found');
    return row;
  }

  private assertTracked(row: Row): void {
    const blocker = imageTrackingBlocker(row);
    if (blocker) throw new BadRequestException(BLOCKER_MESSAGES[blocker]);
  }

  private async check(row: Row): Promise<Row> {
    const image = row.image as string;
    let failure: string | null = null;
    const latest = await this.resolveDigest(image, {
      credentialFor: (registry) =>
        this.registryCredentials.pullCredential({ projectId: row.projectId }, registry),
      onFailure: (reason) => {
        failure = reason;
      }
    });
    const running = await this.k8sWorkload
      .runningImageDigests(row.name, row.namespace)
      .catch((err: any) => {
        this.logger.debug(`running digest read for ${row.id} failed: ${err?.message ?? err}`);
        return null;
      });
    const sameImage = row.imageCheckedRef === image;
    const latestDigest = latest ?? (sameImage ? row.imageLatestDigest : null);
    const runningDigest =
      running && running.length > 0
        ? runningDigestAgainst(running, latestDigest)
        : sameImage
          ? row.imageRunningDigest
          : null;
    const restartFailed =
      sameImage &&
      row.imageCheckError?.startsWith('restart_failed') &&
      latestDigest === row.imageLatestDigest &&
      runningDigest !== latestDigest;
    const written = await this.prisma.deployment.updateMany({
      where: { id: row.id, imageUpdatedAt: row.imageUpdatedAt },
      data: {
        imageCheckedRef: image,
        imageLatestDigest: latestDigest,
        imageRunningDigest: runningDigest,
        imageCheckedAt: new Date(),
        imageCheckError: restartFailed
          ? row.imageCheckError
          : latest
            ? null
            : clipError(failure ?? 'unknown'),
        ...(!sameImage && { imageAttemptedDigest: null })
      }
    });
    return this.load(row.id).then((current) => {
      if (written.count === 0) this.logger.debug(`image check for ${row.id} lost to a rollout`);
      return current;
    });
  }

  protected resolveDigest(
    image: string,
    options: Parameters<typeof resolveImageDigest>[1]
  ): Promise<string | null> {
    return resolveImageDigest(image, options);
  }

  private async rollout(row: Row, userId: string | null): Promise<Row> {
    if (this.rollingOut.has(row.id)) {
      throw new ConflictException('This app is already pulling a new image');
    }
    this.rollingOut.add(row.id);
    try {
      return await this.restartOnLatest(row, userId);
    } finally {
      this.rollingOut.delete(row.id);
    }
  }

  private async restartOnLatest(row: Row, userId: string | null): Promise<Row> {
    const before = row.imageRunningDigest;
    await this.prisma.deployment.update({
      where: { id: row.id },
      data: { imageAttemptedDigest: row.imageLatestDigest }
    });
    try {
      await this.k8sWorkload.restartDeployment(
        row.name,
        row.namespace,
        await this.quotas.prepareRollout(row)
      );
    } catch (err) {
      await this.prisma.deployment
        .updateMany({
          where: {
            id: row.id,
            image: row.image,
            imageAttemptedDigest: row.imageLatestDigest
          },
          data: {
            imageAttemptedDigest: row.imageAttemptedDigest ?? null,
            imageCheckedAt: new Date(),
            imageCheckError: clipError(`restart_failed: ${String((err as any)?.message ?? err)}`)
          }
        })
        .catch(() => undefined);
      throw err;
    }
    const updated = (await this.prisma.deployment.update({
      where: { id: row.id },
      data: { imageUpdatedAt: new Date(), imageCheckedAt: null, imageCheckError: null },
      select: ROW_SELECT
    })) as Row;
    void this.log(row, 'deployment.image.pulled', userId, {
      image: row.image,
      digest: [shortDigest(before), shortDigest(row.imageLatestDigest)],
      automatic: userId == null
    });
    return updated;
  }

  private async log(
    row: Row,
    action: string,
    userId: string | null,
    metadata: Record<string, AuditMetadataValue>
  ): Promise<void> {
    const project = await this.prisma.project
      .findUnique({ where: { id: row.projectId }, select: { organizationId: true } })
      .catch(() => null);
    await this.audit
      .log({
        action,
        actorUserId: userId,
        organizationId: project?.organizationId ?? null,
        projectId: row.projectId,
        deploymentId: row.id,
        targetType: 'deployment',
        targetId: row.id,
        targetLabel: row.name,
        metadata
      })
      .catch(() => undefined);
  }
}

function clipError(message: string): string {
  return message.slice(0, 100);
}

function shortDigest(digest: string | null): string | null {
  return digest ? digest.replace(/^sha256:/, '').slice(0, 12) : null;
}
