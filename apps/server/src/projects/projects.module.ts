import { RegistryCredentialsModule } from '../projects/registry-credentials.module';
import { Module, forwardRef } from '@nestjs/common';
import { KubernetesModule } from '../kubernetes/kubernetes.module';
import { UsersModule } from '../users/users.module';
import { GitHubModule } from '../github/github.module';
import { DockerModule } from '../docker/docker.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { NodesModule } from '../nodes/nodes.module';
import { QuotasModule } from '../quotas/quotas.module';
import { TailscaleModule } from '../tailscale/tailscale.module';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../events/events.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RightsizingService } from '../rightsizing/rightsizing.service';
import { ProjectsService } from './projects.service';
import { ProjectAccessService } from './project-access.service';
import { EnvironmentsService } from './environments.service';
import { EnvironmentSharedVarsService } from './environment-shared-vars.service';
import { DatabasesService } from './databases.service';
import { BackupSyncService } from './backup-sync.service';
import { ImportSettleService } from './import-settle.service';
import { DeploymentsService } from './deployments.service';
import { ReleasesService } from './releases.service';
import { GitModule } from '../git/git.module';
import { ScoreModule } from '../score/score.module';
import { ResourceBindingsService } from './resource-bindings.service';
import { ResourceBindingsController } from './resource-bindings.controller';
import { BlueGreenSettleService } from './blue-green-settle.service';
import { ProjectOrgTransferService } from './project-org-transfer.service';
import { BuildQueueService } from './build-queue.service';
import { IngressService } from './ingress.service';
import { FaviconService } from './favicon.service';
import {
  ProjectsController,
  DeploymentsController,
  IngressesController,
  DatabasesController
} from './projects.controller';
import { EnvironmentsController } from './environments.controller';
import { OverviewController } from './overview.controller';
import { ProjectTransfersController } from './project-transfers.controller';
import { RegistryCredentialsController } from './registry-credentials.controller';
import { ImagePortsController } from './image-ports.controller';
import { ImageUpdatesController } from './image-updates.controller';
import { ImageUpdatesService } from './image-updates.service';
import { NamespaceTeardownService } from './namespace-teardown.service';
import { RolloutStatusService } from './rollout-status.service';
import { RolloutController, RolloutPinInterceptor } from './rollout.controller';

import { DatabaseOperationsService } from './database-operations.service';
import { DatabaseCheckpointsService } from './database-checkpoints.service';
import { DatabaseTrashService } from './database-trash.service';
import { DatabaseDrillsService } from './database-drills.service';
import { DatabasePluginMigrationService } from './database-plugin-migration.service';
import { DatabaseRecoveryService } from './database-recovery.service';
import { DatabaseCatalogService } from './database-catalog.service';
import { PostgresSecurityService } from './postgres-security.service';
import { DatabaseRecoveryController } from './database-recovery.controller';
import { DatabaseShellService } from './database-shell.service';
import { DatabaseShellController } from './database-shell.controller';
import { DatabaseAdminController } from './database-admin.controller';
@Module({
  imports: [
    RegistryCredentialsModule,
    forwardRef(() => GitModule),
    forwardRef(() => ScoreModule),
    KubernetesModule,
    UsersModule,
    forwardRef(() => GitHubModule),
    DockerModule,
    WebhooksModule,
    OrganizationsModule,
    forwardRef(() => NodesModule),
    forwardRef(() => QuotasModule),
    TailscaleModule,
    AuthModule,
    EventsModule,
    MetricsModule
  ],
  providers: [
    RightsizingService,
    ProjectsService,
    ProjectAccessService,
    EnvironmentsService,
    EnvironmentSharedVarsService,
    DatabasesService,
    DatabaseOperationsService,
    DatabaseCheckpointsService,
    DatabaseTrashService,
    DatabaseDrillsService,
    DatabasePluginMigrationService,
    DatabaseRecoveryService,
    DatabaseShellService,
    DatabaseCatalogService,
    PostgresSecurityService,
    BackupSyncService,
    ImportSettleService,
    DeploymentsService,
    ResourceBindingsService,
    ReleasesService,
    BlueGreenSettleService,
    ProjectOrgTransferService,
    BuildQueueService,
    IngressService,
    FaviconService,
    NamespaceTeardownService,
    RolloutStatusService,
    RolloutPinInterceptor,
    ImageUpdatesService
  ],
  controllers: [
    ProjectsController,
    DeploymentsController,
    ResourceBindingsController,
    IngressesController,
    DatabasesController,
    DatabaseRecoveryController,
    DatabaseShellController,
    DatabaseAdminController,
    EnvironmentsController,
    OverviewController,
    ProjectTransfersController,
    RegistryCredentialsController,
    ImagePortsController,
    ImageUpdatesController,
    RolloutController
  ],
  exports: [
    RegistryCredentialsModule,
    ResourceBindingsService,
    ProjectsService,
    ProjectAccessService,
    EnvironmentsService,
    EnvironmentSharedVarsService,
    DatabasesService,
    DatabaseCheckpointsService,
    DatabaseRecoveryService,
    DeploymentsService,
    IngressService,
    NamespaceTeardownService,
    RightsizingService
  ]
})
export class ProjectsModule {}
