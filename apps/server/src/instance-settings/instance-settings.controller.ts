import { BadRequestException, Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import {
  DATABASE_TOGGLES,
  FAST_BUILDER_ROUTINGS,
  InstanceSettingsService,
  parseFastBuilderRouting,
  type DatabaseToggle
} from './instance-settings.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { FirecrackerClient } from '../docker/fc/fc-client';

// Superadmin-only (default-deny: no @Auth()/@SuperAdmin() decorator, so the
// global SuperAdminGuard requires a superadmin).
@Controller('admin/instance-settings')
export class InstanceSettingsController {
  constructor(
    private readonly settings: InstanceSettingsService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService
  ) {}

  @Get('userspace-scheduling')
  async getUserspaceScheduling() {
    return this.settings.getUserspaceSchedulingState();
  }

  @Patch('userspace-scheduling')
  async setUserspaceScheduling(@Body() body: { enabled?: boolean }) {
    await this.settings.setUserspaceScheduling(Boolean(body?.enabled));
    return this.settings.getUserspaceSchedulingState();
  }

  @Get('mcp')
  async getMcp() {
    return this.settings.getMcpState();
  }

  @Patch('mcp')
  async setMcp(@Body() body: { enabled?: boolean }) {
    await this.settings.setMcp(Boolean(body?.enabled));
    return this.settings.getMcpState();
  }

  @Get('custom-domain-verification')
  async getCustomDomainVerification() {
    return this.settings.getCustomDomainVerificationState();
  }

  @Patch('custom-domain-verification')
  async setCustomDomainVerification(@Body() body: { enabled?: boolean }) {
    await this.settings.setCustomDomainVerification(Boolean(body?.enabled));
    return this.settings.getCustomDomainVerificationState();
  }

  @Get('public-ip-sharing')
  async getPublicIpSharing() {
    return this.settings.getPublicIpSharingState();
  }

  @Patch('public-ip-sharing')
  async setPublicIpSharing(@Body() body: { enabled?: boolean }) {
    await this.settings.setPublicIpSharing(Boolean(body?.enabled));
    return this.settings.getPublicIpSharingState();
  }

  @Get('databases')
  async getDatabaseToggles() {
    return this.settings.databaseTogglesView();
  }

  @Patch('databases')
  async setDatabaseToggle(@Body() body: { toggle?: string; enabled?: boolean }) {
    const toggle = String(body?.toggle ?? '') as DatabaseToggle;
    if (!(toggle in DATABASE_TOGGLES)) throw new BadRequestException('Unknown database setting');
    await this.settings.setDatabaseToggle(toggle, Boolean(body?.enabled));
    return this.settings.databaseTogglesView();
  }

  private async fastBuilderView() {
    return {
      ...(await this.settings.getFastBuilderRoutingState()),
      available: new FirecrackerClient().enabled,
      flagConfigured: this.analytics.configured
    };
  }

  @Get('fast-builder')
  async getFastBuilder() {
    return this.fastBuilderView();
  }

  @Patch('fast-builder')
  async setFastBuilder(@Body() body: { value?: unknown }) {
    const value = parseFastBuilderRouting(typeof body?.value === 'string' ? body.value : null);
    if (!value)
      throw new BadRequestException(`value must be one of ${FAST_BUILDER_ROUTINGS.join(', ')}`);
    await this.settings.setFastBuilderRouting(value);
    return this.fastBuilderView();
  }
}
