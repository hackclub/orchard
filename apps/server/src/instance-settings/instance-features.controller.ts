import { Controller, Get, Inject } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { loadedGrafts } from '../grafts/graft-registry';
import { InstanceSettingsService } from './instance-settings.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { FirecrackerClient } from '../docker/fc/fc-client';
import { storageFeatures } from '../instance-config/object-storage';
import { EmailService } from '../email/email.service';
import { deviceClasses } from '../kubernetes/devices';

@Controller('instance')
export class InstanceFeaturesController {
  constructor(
    private readonly settings: InstanceSettingsService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(EmailService) private readonly emailService: EmailService
  ) {}

  @Auth()
  @Get('features')
  async features() {
    const grafts = loadedGrafts().map((g) => g.id);
    return {
      mcp: await this.settings.isMcpEnabled(),
      grafts,
      sandboxes: grafts.includes('greenhouse'),
      earlyAccessOpen: !this.analytics.configured,
      fastBuilder: new FirecrackerClient().enabled,
      email: this.emailService.isConfigured(),
      superBuilds: Boolean(process.env.DEPOT_TOKEN),
      storage: storageFeatures(),
      resourceLimits: (await this.settings.getResourceLimitsState()).value,
      fastBuilderRouting: (await this.settings.getFastBuilderRoutingState()).value,
      devices: deviceClasses().map(({ resource, label, max }) => ({ resource, label, max }))
    };
  }
}
